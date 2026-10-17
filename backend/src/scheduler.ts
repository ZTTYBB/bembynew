import {
  db,
  getDefaultTgApiCredentials,
  getDefaultTimezone,
  FALLBACK_TIMEZONE,
} from "./db/database";
import { decryptSecret } from "./db/secretColumns";
import type { Job, TgAccount } from "./types";
import { DateTime, IANAZone } from "luxon";
import {
  executeManagedJob,
  readExecutionJob,
  refreshExecutionSlots,
  onExecutionFinished,
  getExecutionStatus,
} from "./jobs/execution";
import { toMinutes, pickNextRun } from "./scheduler-utils";
import { JobScheduleStore, scheduleInstant, type JobSchedule } from "./db/jobSchedules";
import { JobRecoveryStore } from "./db/jobRecovery";
import { removeLogShots, sweepOrphanedLogShots, startLogShotMigration } from "./jobs/logShots";

export { getMaxConcurrentJobs } from "./jobs/execution";

type ScheduleEntry = {
  job: Job;
  account: TgAccount | null;
  /** Timezone the nextRun was computed in, after resolving the default. */
  timezone: string;
  nextRun: Date;
  timer?: ReturnType<typeof setTimeout>;
  plan: JobSchedule;
};

const schedule = new Map<number, ScheduleEntry>();
onExecutionFinished((jobId, result) => {
  const job = readExecutionJob(jobId);
  const entry = schedule.get(jobId);
  if (result.status === "success" && job?.runOnce && !job.enabled) {
    if (entry?.timer) clearTimeout(entry.timer);
    schedule.delete(jobId);
  } else {
    // The in-memory entry can lag behind a claim made by another process.
    // Consult SQLite before re-arming: reusing a stale pending snapshot here
    // could schedule a second run while the durable plan is dispatching.
    const persisted = entry ? scheduleStore().get(jobId) : undefined;
    if (persisted?.state !== "pending" ||
      entry?.timer ||
      recoveryStore().activeForJob(jobId)) return;
    const eligible = loadEligibleJobs().find(({ job: candidate }) => candidate.id === jobId);
    if (eligible) attachPlan(eligible.job, eligible.account, persisted);
  }
});
let store: JobScheduleStore | undefined;
let storeDatabase: unknown;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let retentionTimer: ReturnType<typeof setInterval> | undefined;
let stopLogShotMigration: (() => void) | undefined;
let recoveries: JobRecoveryStore | undefined;
let recoveryDatabase: unknown;
const recoveryDispatches = new Set<number>();

function scheduleStore(): JobScheduleStore {
  if (!store || storeDatabase !== db) {
    store = new JobScheduleStore(db);
    storeDatabase = db;
  }
  return store;
}

function recoveryStore(): JobRecoveryStore {
  if (!recoveries || recoveryDatabase !== db) {
    recoveries = new JobRecoveryStore(db);
    recoveryDatabase = db;
  }
  return recoveries;
}

/** Node's setTimeout delay is a 32-bit signed int; larger values overflow and
 * fire almost immediately (coerced to 1ms). See issue #25. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * setTimeout for delays that may exceed Node's 32-bit limit (~24.8 days).
 * Chains timers, re-arming until the remaining delay fits. `onTimer` is called
 * with each armed timer handle so the caller can keep a clearable reference to
 * the currently-pending timer.
 */
function armLongTimeout(
  delayMs: number,
  callback: () => void,
  onTimer: (timer: ReturnType<typeof setTimeout>) => void,
): void {
  if (delayMs <= MAX_TIMEOUT_MS) {
    onTimer(setTimeout(callback, delayMs));
    return;
  }
  onTimer(
    setTimeout(
      () => armLongTimeout(delayMs - MAX_TIMEOUT_MS, callback, onTimer),
      MAX_TIMEOUT_MS,
    ),
  );
}

export const DEFAULT_SCHEDULE_GAP_MINUTES = 2;
const MAX_SCHEDULE_GAP_MINUTES = 30;

/** Minimum minutes between scheduled runs. 0 disables staggering. */
export function getScheduleGapMinutes(): number {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'schedule_min_gap_minutes'")
    .get() as { value: string } | undefined;
  if (row?.value == null || row.value === "")
    return DEFAULT_SCHEDULE_GAP_MINUTES;
  const n = Number(row.value);
  if (!Number.isFinite(n)) return DEFAULT_SCHEDULE_GAP_MINUTES;
  return Math.min(MAX_SCHEDULE_GAP_MINUTES, Math.max(0, Math.floor(n)));
}

export function refreshRunSlots(): void {
  refreshExecutionSlots();
}

/**
 * Resolves a job's timezone for scheduling. Empty means "follow the
 * default_timezone setting"; invalid zones fall back rather than producing
 * NaN timers.
 */
export function resolveJobTimezone(jobTimezone: string | null | undefined): string {
  const tz = jobTimezone || getDefaultTimezone();
  if (IANAZone.isValidZone(tz)) return tz;
  const fallback = getDefaultTimezone();
  return IANAZone.isValidZone(fallback) ? fallback : FALLBACK_TIMEZONE;
}

function checkDailyRunEnabled(): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'check_daily_run'")
    .get() as { value: string } | undefined;
  return row?.value !== "false";
}

// Small deterministic PRNG (FNV-1a hash seed -> mulberry32 step) so a run-every
// range resolves to a value that is stable for a given seed, not re-rolled on
// every scheduler refresh.
function seededRandom(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = (h + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Resolve the effective interval from a [min, max] range for a given seed. A
// null/absent max (or max <= min) yields the fixed min, preserving the old
// single-value behaviour exactly.
function intervalFromSeed(
  min: number,
  max: number | null | undefined,
  seed: string,
): number {
  const lo = Math.max(1, Math.floor(min));
  const hi = max != null ? Math.floor(max) : lo;
  if (hi <= lo) return lo;
  return lo + Math.floor(seededRandom(seed) * (hi - lo + 1));
}

/**
 * Timestamp of a job's last successful run, or null if it has never succeeded.
 *
 * Reads `jobs.last_success_at`, the durable stamp written on every success.
 * Deriving this from `job_logs` looks equivalent but is not: that table is
 * pruned by `log_retention_days`, so enabling retention would empty the history
 * and silently reset every job's cadence (a pruned job reads as "never ran",
 * which makes it due immediately). The `job_logs` lookup stays as a fallback
 * for rows that predate the stamp and have not run since it was introduced.
 */
function lastSuccessAt(jobId: number): string | null {
  const durable = db
    .prepare("SELECT last_success_at FROM jobs WHERE id = ?")
    .get(jobId) as { last_success_at: string | null } | undefined;
  if (durable?.last_success_at) return durable.last_success_at;

  const legacy = db
    .prepare(
      "SELECT ran_at FROM job_logs WHERE job_id = ? AND status = 'success' ORDER BY ran_at DESC LIMIT 1",
    )
    .get(jobId) as { ran_at: string } | undefined;
  return legacy?.ran_at ?? null;
}

/**
 * Whether any run of this job was already attempted today (in the job's own
 * zone), regardless of outcome.
 *
 * Guards the catch-up path: a job that failed today is overdue but must not be
 * re-run on the next refresh -- failures retry tomorrow, so without this the
 * five-minute refresh would keep firing it all evening.
 */
function hasRunToday(jobId: number, tz: string): boolean {
  const startOfDay = DateTime.now().setZone(tz).startOf("day").toUTC().toISO();
  const row = db
    .prepare("SELECT 1 AS x FROM job_logs WHERE job_id = ? AND ran_at >= ? LIMIT 1")
    .get(jobId, startOfDay);
  return row !== undefined;
}

function hasAttempted(jobId: number): boolean {
  const durable = db.prepare("SELECT last_attempt_at FROM jobs WHERE id = ?").get(jobId) as
    { last_attempt_at: string | null } | undefined;
  if (durable?.last_attempt_at) return true;
  return lastSuccessAt(jobId) !== null ||
    db.prepare("SELECT 1 FROM job_logs WHERE job_id = ? LIMIT 1").get(jobId) !== undefined;
}

function firstRunDays(job: Job): number {
  const lo = Math.max(0, Math.min(3650, Math.floor(job.firstRunMinDays ?? 0)));
  const hi = Math.max(lo, Math.min(3650, Math.floor(job.firstRunMaxDays ?? lo)));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * The interval to defer by after a run, resolved from the range. Seeded by the
 * job's last successful run so the value stays stable across refreshes/restarts
 * within a cycle and re-rolls only once a new successful run is recorded.
 */
export function resolveRunEveryDays(
  jobId: number,
  min: number,
  max?: number | null,
): number {
  return intervalFromSeed(min, max, `${jobId}:${lastSuccessAt(jobId) ?? "first"}`);
}

export function daysUntilNextRun(
  jobId: number,
  tz: string,
  runEveryDays: number,
  runEveryDaysMax?: number | null,
): number {
  const lastSuccess = lastSuccessAt(jobId);
  if (!lastSuccess) return 0;
  // Same seed as resolveRunEveryDays so the scheduled date is consistent whether
  // it was set after a run or recomputed on restart.
  const runEvery = intervalFromSeed(
    runEveryDays,
    runEveryDaysMax,
    `${jobId}:${lastSuccess}`,
  );
  const lastRun = DateTime.fromISO(lastSuccess, { zone: "utc" })
    .setZone(tz)
    .startOf("day");
  const today = DateTime.now().setZone(tz).startOf("day");
  const daysSince = Math.floor(today.diff(lastRun, "days").days);
  return daysSince >= runEvery ? 0 : runEvery - daysSince;
}

export function loadEligibleJobs(): Array<{
  job: Job;
  account: TgAccount | null;
}> {
  const rows = db
    .prepare(
      `
    SELECT j.*,
           a.api_id, a.api_hash, a.session_string, a.auth_status, a.proxy_id AS account_proxy_id,
           a.name AS account_name, a.phone_number, a.created_at AS account_created_at, a.disabled AS account_disabled,
           a.app_client_id AS account_app_client_id
    FROM jobs j
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    WHERE j.enabled = 1
      AND j.retired IS NULL
      AND (j.account_id IS NULL OR (a.id IS NOT NULL AND a.disabled = 0))
      AND (
        (j.job_type NOT IN ('checkin', 'custom', 'autoreg'))
        OR (a.auth_status = 'authenticated' AND a.session_string IS NOT NULL)
      )
  `,
    )
    .all() as any[];

  return rows.map((row) => ({
    job: {
      id: row.id,
      name: row.name,
      accountId: row.account_id ?? null,
      jobType: row.job_type,
      botUsername: row.bot_username,
      scheduleWindowStart: row.schedule_window_start,
      scheduleWindowEnd: row.schedule_window_end,
      timezone: row.timezone,
      replyTimeoutMs: row.reply_timeout_ms,
      retryMax: row.retry_max,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      config: row.config ?? null,
      startCommand: row.start_command || "/start",
      checkinButton: row.checkin_button || "签到",
      templateId: row.template_id ?? null,
      runEveryDays: row.run_every_days ?? 1,
      runEveryDaysMax: row.run_every_days_max ?? null,
      runOnce: Boolean(row.run_once),
      rerunOnRestart: Boolean(row.rerun_on_restart),
      firstRunMinDays: row.first_run_min_days ?? 0,
      firstRunMaxDays: row.first_run_max_days ?? 0,
      lastAttemptAt: row.last_attempt_at ?? null,
    } as Job,
    account:
      row.account_id != null
        ? (() => {
            // Credentials resolve as a pair: the account's own if complete, else global defaults
            const ownApiHash = decryptSecret(row.api_hash as string | null);
            const ownCredentials =
              row.api_id && ownApiHash
                ? { apiId: row.api_id, apiHash: ownApiHash }
                : null;
            const credentials =
              ownCredentials ?? getDefaultTgApiCredentials();
            return {
              id: row.account_id,
              name: row.account_name,
              phoneNumber: row.phone_number,
              apiId: credentials?.apiId ?? null,
              apiHash: credentials?.apiHash ?? null,
              sessionString: decryptSecret(row.session_string),
              authStatus: row.auth_status,
              proxyId: row.account_proxy_id ?? null,
              disabled: Boolean(row.account_disabled),
              appClientId: row.account_app_client_id ?? null,
              createdAt: row.account_created_at,
            } as TgAccount;
          })()
        : null,
  }));
}

export async function executeJob(
  job: Job,
  _account: TgAccount | null,
): Promise<void> {
  const result = await executeManagedJob(job.id, { source: "scheduler" });
  if (result.status !== "skipped") scheduleAfterRun(job.id);
}

/** Stable fingerprint for auto plans; backup/import can recompute it after remapping IDs. */
export function buildScheduleKey(job: Job, timezone: string): string {
  let avoidPeakHours = false;
  if (job.jobType === "embywatch" && job.config) {
    try {
      const parsed = typeof job.config === "string" ? JSON.parse(job.config) : job.config;
      avoidPeakHours = Boolean(parsed.avoidPeakHours);
    } catch {}
  }
  const common = [job.scheduleWindowStart, job.scheduleWindowEnd, timezone, job.botUsername, job.accountId, avoidPeakHours];
  return JSON.stringify(job.runOnce
    ? [...common, "once", job.firstRunMinDays ?? 0, job.firstRunMaxDays ?? 0]
    : [...common, job.runEveryDays, job.runEveryDaysMax, checkDailyRunEnabled()]);
}

function attachPlan(job: Job, account: TgAccount | null, plan: JobSchedule): void {
  const existing = schedule.get(job.id);
  if (existing?.timer) clearTimeout(existing.timer);
  const entry: ScheduleEntry = {
    job, account, plan, timezone: plan.timezone, nextRun: new Date(plan.nextRun),
  };
  schedule.set(job.id, entry);
  if (plan.state !== "pending" || recoveryStore().activeForJob(job.id)) return;
  armLongTimeout(
    Math.max(0, entry.nextRun.getTime() - Date.now()),
    () => { void dispatchPlan(entry); },
    (timer) => { entry.timer = timer; },
  );
}

function scheduleAfterRun(jobId: number, expectedRevision?: number): void {
  const eligible = loadEligibleJobs().find(({ job }) => job.id === jobId);
  const job = eligible?.job ?? readExecutionJob(jobId);
  if (!job) {
    if (expectedRevision !== undefined) scheduleStore().remove(jobId, expectedRevision);
    const entry = schedule.get(jobId);
    if (entry?.timer) clearTimeout(entry.timer);
    schedule.delete(jobId);
    return;
  }
  // A successful one-time run disables its job. Do not leave a pending plan
  // behind in SQLite: re-enabling the job later must create a fresh first-run
  // plan rather than replaying the completed one-time schedule.
  if (job.runOnce && !job.enabled && job.lastSuccessAt) {
    const staleRevision = expectedRevision ?? scheduleStore().get(jobId)?.revision;
    if (staleRevision !== undefined) scheduleStore().remove(jobId, staleRevision);
    const entry = schedule.get(jobId);
    if (entry?.timer) clearTimeout(entry.timer);
    schedule.delete(jobId);
    return;
  }
  const plan = scheduleOne(job, eligible?.account ?? null,
    job.runOnce ? 1 : resolveRunEveryDays(job.id, job.runEveryDays ?? 1, job.runEveryDaysMax),
    false, { expectedRevision, arm: !!eligible });
  if (plan && !eligible) {
    const entry = schedule.get(jobId);
    if (entry?.timer) clearTimeout(entry.timer);
    schedule.delete(jobId);
  }
}

export function rescheduleAfterOutcome(jobId: number): void {
  const existing = schedule.get(jobId);
  if (existing?.timer) clearTimeout(existing.timer);
  schedule.delete(jobId);
  const plans = scheduleStore();
  const prior = plans.get(jobId);
  const eligible = loadEligibleJobs().find(({ job }) => job.id === jobId);
  const job = eligible?.job ?? readExecutionJob(jobId);
  if (!job) return;
  const timezone = resolveJobTimezone(job.timezone);
  const latest = db.prepare(`
    SELECT ran_at, status FROM job_logs
    WHERE job_id = ? AND status IN ('success', 'failed')
    ORDER BY julianday(ran_at) DESC, id DESC LIMIT 1
  `).get(jobId) as { ran_at: string; status: string } | undefined;
  let latestTime = latest ? DateTime.fromISO(latest.ran_at, { zone: "utc" }) : null;
  if (latest && !latestTime?.isValid) latestTime = DateTime.fromSQL(latest.ran_at, { zone: "utc" });
  const failedToday = latest?.status === "failed" &&
    latestTime?.setZone(timezone).toISODate() ===
      DateTime.now().setZone(timezone).toISODate();
  let daysAhead = 0;
  let catchUp = false;
  if (failedToday) {
    daysAhead = 1;
  } else if (job.runOnce) {
    daysAhead = hasAttempted(jobId) ? 1 : firstRunDays(job);
    catchUp = daysAhead === 0;
  } else if (checkDailyRunEnabled()) {
    daysAhead = daysUntilNextRun(jobId, timezone, job.runEveryDays ?? 1, job.runEveryDaysMax);
    catchUp = daysAhead === 0 && lastSuccessAt(jobId) !== null && !hasRunToday(jobId, timezone);
  }
  const plan = scheduleOne(job, eligible?.account ?? null, daysAhead, catchUp, {
    expectedRevision: prior?.revision, arm: !!eligible,
  });
  if (!plan) {
    const authoritative = plans.get(jobId);
    if (eligible && authoritative) attachPlan(eligible.job, eligible.account, authoritative);
    throw new ScheduleConflictError("Schedule changed while correcting the result; refresh and try again");
  }
}

async function dispatchPlan(entry: ScheduleEntry): Promise<void> {
  entry.timer = undefined;
  const plans = scheduleStore();
  if (!plans.claim(entry.job.id, entry.plan.revision)) return;
  entry.plan = { ...entry.plan, state: "dispatching" };
  try {
    await executeManagedJob(entry.job.id, { source: "scheduler" });
    // Keep the row so revisions cannot repeat across execution cycles.
    // The CAS also leaves any concurrent explicit edit authoritative.
    scheduleAfterRun(entry.job.id, entry.plan.revision);
  } catch (error) {
    console.error("[scheduler] dispatch failed; plan requires review:", error);
    try {
      const interrupted = plans.save({
        ...entry.plan, state: "interrupted",
      }, entry.plan.revision);
      if (interrupted) attachPlan(entry.job, entry.account, interrupted);
    } catch (persistError) {
      console.error("[scheduler] could not persist interrupted plan:", persistError);
    }
  }
}

function scheduleOne(
  job: Job,
  account: TgAccount | null,
  daysAhead = 0,
  catchUp = false,
  options: { expectedRevision?: number; arm?: boolean } = {},
): JobSchedule | undefined {
  // Stagger away from every other job's slot so runs don't pile into the
  // same minute (issue #10)
  const occupied = Array.from(schedule.values())
    .filter((entry) => entry.job.id !== job.id)
    .map((entry) => entry.nextRun.getTime());

  let avoidPeakHours = false;
  if (job.jobType === "embywatch" && job.config) {
    try {
      const parsed = typeof job.config === "string" ? JSON.parse(job.config) : job.config;
      avoidPeakHours = Boolean(parsed.avoidPeakHours);
    } catch {}
  }

  const timezone = resolveJobTimezone(job.timezone);
  const nextRun = pickNextRun(
    job.scheduleWindowStart,
    job.scheduleWindowEnd,
    timezone,
    daysAhead,
    { occupied, gapMinutes: getScheduleGapMinutes(), catchUp, avoidPeakHours },
  );
  const plan = scheduleStore().save({
    jobId: job.id, nextRun: nextRun.toUTC().toISO()!, timezone, pinned: false,
    state: "pending", origin: "auto", scheduleKey: buildScheduleKey(job, timezone), skippedAt: null,
  }, options.expectedRevision);
  if (plan && options.arm !== false) attachPlan(job, account, plan);
  return plan;
}

function refreshJobs(): void {
  const eligible = loadEligibleJobs();
  const eligibleIds = new Set(eligible.map((e) => e.job.id));

  // Remove jobs no longer eligible
  for (const [id, entry] of schedule) {
    if (!eligibleIds.has(id)) {
      if (entry.timer) clearTimeout(entry.timer);
      schedule.delete(id);
      console.log(`[scheduler] Unscheduled job ${id}`);
    }
  }

  const dailyCheckOn = checkDailyRunEnabled();

  const planRun = (
    job: Job,
    tz: string,
  ): { daysAhead: number; catchUp: boolean } => {
    if (job.runOnce) {
      const daysAhead = hasAttempted(job.id) ? 1 : firstRunDays(job);
      return { daysAhead, catchUp: daysAhead === 0 };
    }
    if (!dailyCheckOn) return { daysAhead: 0, catchUp: false };
    const daysAhead = daysUntilNextRun(
      job.id,
      tz,
      job.runEveryDays ?? 1,
      job.runEveryDaysMax,
    );
    // Due now, and it has succeeded before: it was due earlier today and the
    // window closed without it running (process down, or a restart that landed
    // after the window). Make it up now rather than losing a whole cycle.
    // hasRunToday keeps a *failed* run from being retried on every refresh.
    const catchUp =
      daysAhead === 0 &&
      lastSuccessAt(job.id) !== null &&
      !hasRunToday(job.id, tz);
    return { daysAhead, catchUp };
  };

  // Add newly eligible jobs, or re-schedule if config changed
  for (const { job, account } of eligible) {
    const existing = schedule.get(job.id);
    const resolvedTz = resolveJobTimezone(job.timezone);
    const persisted = scheduleStore().get(job.id);
    // A recovered execution owns this occurrence until it finishes.  Do not
    // create a fresh auto plan (or leave an already-armed timer alive) while
    // the recovery is pending; doing so can run the same job twice at startup.
    const activeRecovery = recoveryStore().activeForJob(job.id);
    if (activeRecovery) {
      if (existing?.timer) {
        clearTimeout(existing.timer);
        existing.timer = undefined;
      }
      // Refresh the in-memory entry as well: an operator may edit a future
      // pinned plan while the recovery is running. `attachPlan` deliberately
      // does not arm a timer while the recovery remains active.
      if (persisted) attachPlan(job, account, persisted);
      continue;
    }
    if (persisted) {
      const changed = persisted.scheduleKey !== buildScheduleKey(job, resolvedTz);
      if (persisted.state === "pending" && changed && !persisted.pinned && persisted.origin === "auto") {
        const { daysAhead, catchUp } = planRun(job, resolvedTz);
        scheduleOne(job, account, daysAhead, catchUp);
      } else if (!existing || existing.plan.revision !== persisted.revision ||
        existing.plan.state !== persisted.state ||
        (persisted.state === "pending" && !existing.timer && !recoveryStore().activeForJob(job.id))) {
        attachPlan(job, account, persisted);
      } else {
        existing.job = job;
        existing.account = account;
      }
    } else {
      const { daysAhead, catchUp } = planRun(job, resolvedTz);
      scheduleOne(job, account, daysAhead, catchUp);
    }
  }
}

export function refreshScheduler(): void {
  refreshJobs();
}

/** Deletes job logs older than the configured retention window. 0 keeps everything. */
export function purgeOldLogs(): void {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'log_retention_days'")
    .get() as { value: string } | undefined;
  const days = Number(row?.value ?? 0);
  const liveLogIds = (): Set<number> | undefined => {
    try {
      return new Set(
        (db.prepare("SELECT id FROM job_logs").all() as Array<{ id: number }>)
          .map((item) => Number(item.id))
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      );
    } catch {
      // Fail closed when the database is temporarily unavailable. An empty
      // set would make every screenshot directory look orphaned.
      return undefined;
    }
  };
  if (!Number.isFinite(days) || days <= 0) {
    // Even with retention disabled, an interrupted migration or a manually
    // removed log can leave an unreferenced screenshot directory behind.
    const ids = liveLogIds();
    if (ids) sweepOrphanedLogShots(ids);
    return;
  }

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const hasRecoveries = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_run_recoveries'",
  ).get());
  const protectRecovery = hasRecoveries ? ` AND NOT EXISTS (
    SELECT 1 FROM job_run_recoveries r WHERE r.state IN ('pending', 'started')
      AND (r.interrupted_log_id = job_logs.id OR r.rerun_log_id = job_logs.id)
  )` : "";
  const oldRows = db.prepare(
    `SELECT id FROM job_logs WHERE ran_at < ? AND status != 'running'${protectRecovery}`,
  ).all(cutoff) as Array<{ id: number }>;
  const { changes } = db
    .prepare(`DELETE FROM job_logs WHERE ran_at < ? AND status != 'running'${protectRecovery}`)
    .run(cutoff);
  for (const row of oldRows) removeLogShots(Number(row.id));
  const ids = liveLogIds();
  if (ids) sweepOrphanedLogShots(ids);
  if (changes > 0) {
    console.log(
      `[scheduler] Purged ${changes} job log(s) older than ${days} day(s)`,
    );
    try {
      // DELETE only makes pages reusable in WAL mode; checkpoint + VACUUM is
      // what actually returns the reclaimed screenshot metadata space.
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
    } catch (error) {
      console.warn("[scheduler] database vacuum after log purge failed:", error);
    }
  }
}

/**
 * Mark any job_logs still in 'running' state as failed. On a fresh process
 * start nothing is actually running, so a leftover 'running' row means the
 * previous process was killed mid-run (e.g. during an upgrade), leaving the
 * log stuck and un-stoppable. (issue #18)
 */
export function reconcileOrphanedRuns(): void {
  const activeLogIds = new Set(getExecutionStatus().running.flatMap((entry) =>
    entry.logId == null ? [] : [entry.logId]));
  const changes = recoveryStore().captureInterruptedRuns(activeLogIds);
  if (changes > 0) {
    console.log(`[scheduler] Marked ${changes} interrupted run(s) as failed`);
  }
}

function resumeInterruptedRuns(): void {
  for (const recovery of recoveryStore().completedSchedulerRuns()) {
    if (recoveryStore().activeForJob(recovery.jobId)) continue;
    const prior = scheduleStore().get(recovery.jobId);
    if (prior?.state === "interrupted" && prior.revision === recovery.planRevision) {
      scheduleAfterRun(recovery.jobId, prior.revision);
    }
  }
  for (const recovery of recoveryStore().pending()) {
    if (recovery.owner === "batch" || recoveryDispatches.has(recovery.interruptedLogId)) continue;
    const job = readExecutionJob(recovery.jobId);
    const prior = scheduleStore().get(recovery.jobId);
    const expectedRevision = recovery.owner === "scheduler" && prior &&
      ((prior.state === "interrupted" && recovery.planRevision != null &&
        prior.revision === recovery.planRevision) ||
        (recovery.planRevision == null && prior.origin === "auto" && !prior.pinned))
      ? prior.revision : undefined;
    recoveryDispatches.add(recovery.interruptedLogId);
    void executeManagedJob(recovery.jobId, {
      source: recovery.owner === "scheduler" && job?.enabled ? "scheduler" : "manual",
      recovery: { interruptedLogId: recovery.interruptedLogId, owner: recovery.owner },
    }).then((result) => {
      recoveryStore().finish(recovery.interruptedLogId, result.status,
        result.status === "success" ? undefined : result.message);
      if (expectedRevision !== undefined && result.status !== "skipped") {
        scheduleAfterRun(recovery.jobId, expectedRevision);
      }
    }).catch((error) => {
      recoveryStore().finish(recovery.interruptedLogId, "failed",
        error instanceof Error ? error.message : String(error));
      console.error("[scheduler] restart recovery failed:", error);
    }).finally(() => recoveryDispatches.delete(recovery.interruptedLogId));
  }
}

export function startScheduler(): void {
  if (refreshTimer) return;
  console.log("[scheduler] Starting");
  reconcileOrphanedRuns();
  scheduleStore().interruptDispatching();
  refreshJobs();
  resumeInterruptedRuns();
  // Re-check every 5 minutes to pick up new/changed jobs
  refreshTimer = setInterval(refreshJobs, 5 * 60 * 1000);
  purgeOldLogs();
  stopLogShotMigration?.();
  stopLogShotMigration = startLogShotMigration(db);
  // Retention sweep is cheap, so hourly keeps the table tidy without load
  retentionTimer = setInterval(purgeOldLogs, 60 * 60 * 1000);
}

export function stopScheduler(): void {
  for (const entry of schedule.values()) if (entry.timer) clearTimeout(entry.timer);
  schedule.clear();
  if (refreshTimer) clearInterval(refreshTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  stopLogShotMigration?.();
  stopLogShotMigration = undefined;
  refreshTimer = undefined;
  retentionTimer = undefined;
}

export function getSchedulerStatus(): Array<{
  jobId: number;
  jobName: string;
  jobType: string;
  nextRun: string;
  timezone: string;
  pinned: boolean;
  state: JobSchedule["state"];
  revision: number;
}> {
  return Array.from(schedule.values()).map(({ job, nextRun, plan }) => ({
    jobId: job.id,
    jobName: job.name,
    jobType: job.jobType,
    nextRun: nextRun.toISOString(),
    timezone: plan.timezone,
    pinned: plan.pinned,
    state: plan.state,
    revision: plan.revision,
  }));
}

/**
 * Drops a job's pending run and arms the one after it, which is how an operator calls off a
 * run they can see coming without disabling the job. The job keeps its schedule; only this
 * occurrence is given up, so the list shows it again on its next eligible day.
 */
export function skipNextRun(jobId: number): { ok: boolean; nextRun?: string } {
  const entry = schedule.get(jobId);
  if (!entry || entry.plan.state !== "pending") return { ok: false };

  // Counted from the pending run's own day, not from today: that run may already be days out
  // (its window has passed today), and a day counted from today would land on or before it --
  // rescheduling the very run being called off, sometimes to an earlier minute.
  const pendingDay = DateTime.fromJSDate(entry.nextRun)
    .setZone(entry.timezone)
    .startOf("day");
  const today = DateTime.now().setZone(entry.timezone).startOf("day");
  const daysUntilPending = Math.max(0, Math.round(pendingDay.diff(today, "days").days));

  // Past that day, the next opportunity is one interval on -- one day for a daily job
  const interval = !entry.job.runOnce && checkDailyRunEnabled()
    ? Math.max(
        1,
        resolveRunEveryDays(jobId, entry.job.runEveryDays ?? 1, entry.job.runEveryDaysMax),
      )
    : 1;
  const daysAhead = daysUntilPending + interval;

  scheduleOne(entry.job, entry.account, daysAhead);
  const replacement = scheduleStore().get(jobId)!;
  const skipped = scheduleStore().save({
    ...replacement, origin: "skip", skippedAt: new Date().toISOString(),
  }, replacement.revision)!;
  attachPlan(entry.job, entry.account, skipped);
  const nextRun = schedule.get(jobId)?.nextRun.toISOString();
  console.log(`[scheduler] "${entry.job.name}" run skipped by operator; next run: ${nextRun}`);
  return { ok: true, nextRun };
}

export class ScheduleConflictError extends Error {}

export function setNextRun(
  jobId: number,
  input: { nextRun: string; timezone?: string; pinned?: boolean; expectedRevision?: number },
): JobSchedule {
  if (input.expectedRevision !== undefined &&
    (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0)) {
    throw new Error("Invalid expectedRevision");
  }
  const store = scheduleStore();
  const prior = store.get(jobId);
  if (input.expectedRevision !== undefined && prior?.revision !== input.expectedRevision) {
    throw new ScheduleConflictError("Schedule changed or no longer exists; refresh and try again");
  }
  const job = readExecutionJob(jobId);
  if (!job || job.retired) throw new Error("Job not found");
  if (prior?.state === "dispatching") throw new ScheduleConflictError("Job plan is already dispatching");
  const nextRun = scheduleInstant(input.nextRun);
  if (new Date(nextRun).getTime() <= Date.now()) throw new Error("nextRun must be in the future");
  const timezone = input.timezone ?? resolveJobTimezone(job.timezone);
  const plan = store.save({
    jobId, nextRun, timezone, pinned: input.pinned ?? prior?.pinned ?? false,
    state: "pending", origin: "manual", scheduleKey: buildScheduleKey(job, timezone),
    skippedAt: prior?.skippedAt ?? null,
  }, input.expectedRevision ?? prior?.revision);
  if (!plan) throw new ScheduleConflictError("Schedule changed or no longer exists; refresh and try again");
  refreshJobs();
  return plan;
}

export function setSchedulePinned(jobId: number, pinned: boolean): JobSchedule | undefined {
  const prior = scheduleStore().get(jobId);
  if (!prior || prior.state !== "pending") return undefined;
  const plan = scheduleStore().save({ ...prior, pinned }, prior.revision);
  const entry = schedule.get(jobId);
  if (entry && plan) attachPlan(entry.job, entry.account, plan);
  return plan;
}

export function shuffleSchedules(date?: string): { moved: number; protected: number } {
  if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !DateTime.fromISO(date).isValid)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  refreshJobs();
  const rows = [...schedule.values()].filter((entry) =>
    date === undefined || DateTime.fromJSDate(entry.nextRun).setZone(entry.timezone).toISODate() === date);
  const movable = rows.filter((entry) => entry.plan.state === "pending" &&
    !entry.plan.pinned && entry.nextRun.getTime() - Date.now() > 60_000);
  const movableIds = new Set(movable.map((entry) => entry.job.id));
  const occupied = [...schedule.values()].filter((entry) => !movableIds.has(entry.job.id))
    .map((entry) => entry.nextRun.getTime());
  let moved = 0;
  for (const entry of movable) {
    const now = DateTime.now().setZone(entry.timezone);
    const redrawDay = entry.job.runOnce && !hasAttempted(entry.job.id);
    const day = DateTime.fromJSDate(entry.nextRun).setZone(entry.timezone);
    const daysAhead = redrawDay ? firstRunDays(entry.job)
      : Math.round(day.startOf("day").diff(now.startOf("day"), "days").days);
    if (daysAhead < 0) continue;
    const start = Math.max(toMinutes(entry.job.scheduleWindowStart),
      daysAhead === 0 ? now.hour * 60 + now.minute + 2 : 0);
    const catchUp = redrawDay && daysAhead === 0 && start >= toMinutes(entry.job.scheduleWindowEnd);
    if (start >= toMinutes(entry.job.scheduleWindowEnd) && !catchUp) continue;
    const next = pickNextRun(catchUp ? entry.job.scheduleWindowStart : Math.floor(start / 60) * 100 + start % 60,
      entry.job.scheduleWindowEnd, entry.timezone, daysAhead,
      { occupied, gapMinutes: getScheduleGapMinutes(), catchUp });
    if ((!redrawDay && next.toISODate() !== day.toISODate()) ||
      (!catchUp && next.toMillis() - Date.now() <= 60_000)) continue;
    const plan = scheduleStore().save({
      ...entry.plan, nextRun: next.toUTC().toISO()!, origin: "shuffle",
    }, entry.plan.revision);
    if (!plan) continue;
    occupied.push(next.toMillis());
    if (plan.nextRun !== entry.plan.nextRun) moved++;
    attachPlan(entry.job, entry.account, plan);
  }
  return { moved, protected: rows.length - movable.length };
}
