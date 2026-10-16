import { db, getDefaultTgApiCredentials } from "../db/database";
import { decryptAccountRow } from "../db/secretColumns";
import { runJob, type JobDetailLog } from "./runner";
import { registerJob, unregisterJob, registerLiveDetail, clearLiveDetail, cancelJob } from "./cancellation";
import { notifyJobEvent, buildFailureMessage, buildSuccessMessage } from "./notify";
import { collectRunWarnings, completedMessage } from "./runWarnings";
import { positiveEnvNumber } from "../util/env";
import { JobRecoveryStore, type RecoveryOwner } from "../db/jobRecovery";
import { hasActiveBatchJob } from "./taskQueue";
import { persistLogDetailScreenshots } from "./logShots";
import type { Job, TgAccount } from "../types";

export type ExecutionSource = "scheduler" | "manual" | "batch";
export type ExecutionResult = {
  status: "success" | "failed" | "cancelled" | "skipped";
  logId: number | null;
  message?: string;
};
export type ExecutionOptions = {
  source: ExecutionSource;
  signal?: AbortSignal;
  onLogId?: (logId: number) => void;
  recovery?: { interruptedLogId: number; owner: RecoveryOwner };
};
export const EXCLUSIVE_ACCOUNT_WAIT_MS = 30 * 60_000;
export type ExecutionInfo = {
  jobId: number;
  jobName: string;
  accountId: number | null;
  exclusiveAccount: boolean;
  source: ExecutionSource;
  queuedAt: string;
  startedAt: string | null;
  logId: number | null;
  cancellationRequested: boolean;
  timedOut: boolean;
};
type Entry = ExecutionInfo & {
  state: "queued" | "running";
  options: ExecutionOptions;
  resolve: (result: ExecutionResult) => void;
  detach?: () => void;
};

const entries = new Map<number, Entry>();
const queue: Entry[] = [];
const finishedListeners = new Set<(jobId: number, result: ExecutionResult) => void>();
// Read this at launch time so test suites and operators can change the
// watchdog without relying on module import order.
function watchdogMs(): number {
  return positiveEnvNumber("JOB_WATCHDOG_MS", 60 * 60_000);
}

function logScreenshotBudget(): { maxCount?: number } {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'log_screenshot_max_count'")
      .get() as { value?: string } | undefined;
    const count = Number(row?.value);
    return Number.isSafeInteger(count) && count > 0 && count <= 10_000
      ? { maxCount: count }
      : {};
  } catch {
    // Older databases and isolated test stores may not have the setting yet.
    return {};
  }
}

function jobWatchdogMs(job: Job): number {
  let value = watchdogMs();
  if (job.jobType !== "custom") return value;
  try {
    const configs: unknown[] = job.config ? [JSON.parse(job.config)] : [];
    if (job.templateId != null) {
      const template = db.prepare("SELECT config FROM job_templates WHERE id = ?").get(job.templateId) as
        { config: string | null } | undefined;
      if (template?.config) configs.push(JSON.parse(template.config));
    }
    const find = (actions: unknown): void => {
      if (!Array.isArray(actions)) return;
      for (const action of actions as Array<Record<string, unknown>>) {
        if (action.type === "watch_buttons" || action.type === "watch_codes") {
          const budget = typeof action.maxWaitMs === "number" && action.maxWaitMs > 0
            ? action.maxWaitMs
            : 15 * 60 * 60_000;
          value = Math.max(value, Math.min(24 * 60 * 60_000, budget + 60_000));
        }
        find(action.thenActions);
        find(action.elseActions);
        find(action.actions);
      }
    };
    for (const config of configs) {
      find((config as { actions?: unknown } | null)?.actions);
    }
  } catch {
    // The runner validates malformed custom JSON and reports the useful error.
  }
  return value;
}

export function onExecutionFinished(listener: (jobId: number, result: ExecutionResult) => void): () => void {
  finishedListeners.add(listener);
  return () => { finishedListeners.delete(listener); };
}

export function getMaxConcurrentJobs(): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'max_concurrent_jobs'").get() as
    { value: string } | undefined;
  if (!row?.value) return 2;
  const value = Number(row.value);
  return Number.isFinite(value) ? Math.max(1, Math.min(20, Math.floor(value))) : 2;
}

export function readExecutionJob(jobId: number): Job | undefined {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  if (!row) return undefined;
  return {
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
    checkinButton: row.checkin_button || "\u7b7e\u5230",
    templateId: row.template_id ?? null,
    runEveryDays: row.run_every_days ?? 1,
    runEveryDaysMax: row.run_every_days_max ?? null,
    runOnce: Boolean(row.run_once),
    rerunOnRestart: Boolean(row.rerun_on_restart),
    firstRunMinDays: row.first_run_min_days ?? 0,
    firstRunMaxDays: row.first_run_max_days ?? 0,
    retired: row.retired ?? null,
    lastSuccessAt: row.last_success_at ?? null,
    lastAttemptAt: row.last_attempt_at ?? null,
    exclusiveAccount: Boolean(row.exclusive_account),
  };
}

function readAccount(job: Job): TgAccount | null {
  const requiresAccount = ["checkin", "custom", "autoreg"].includes(job.jobType);
  const row = job.accountId == null ? undefined
    : db.prepare("SELECT * FROM tg_accounts WHERE id = ?").get(job.accountId) as any;
  if (row?.disabled) throw new Error("Account is disabled");
  if (!row) {
    if (job.accountId != null) throw new Error("Linked account no longer exists");
    if (requiresAccount) throw new Error("No account linked to this job");
    return null;
  }
  decryptAccountRow(row);
  const ownCredentials = row.api_id && row.api_hash
    ? { apiId: row.api_id, apiHash: row.api_hash }
    : null;
  const credentials = ownCredentials ?? getDefaultTgApiCredentials();
  if (requiresAccount && (row.auth_status !== "authenticated" || !row.session_string)) {
    throw new Error("Account is not authenticated");
  }
  if (requiresAccount && !credentials) throw new Error("No API credentials available for this account");
  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone_number,
    apiId: credentials?.apiId ?? null,
    apiHash: credentials?.apiHash ?? null,
    sessionString: row.session_string,
    authStatus: row.auth_status,
    proxyId: row.proxy_id ?? null,
    disabled: Boolean(row.disabled),
    appClientId: row.app_client_id ?? null,
    createdAt: row.created_at,
  };
}

function info(entry: Entry): ExecutionInfo {
  const {
    jobId, jobName, accountId, exclusiveAccount, source, queuedAt, startedAt, logId,
    cancellationRequested, timedOut,
  } = entry;
  return {
    jobId, jobName, accountId, exclusiveAccount, source, queuedAt, startedAt, logId,
    cancellationRequested, timedOut,
  };
}

export function getExecutionStatus(): {
  running: ExecutionInfo[];
  queued: ExecutionInfo[];
  maxConcurrent: number;
} {
  return {
    running: [...entries.values()].filter((entry) => entry.state === "running").map(info),
    queued: queue.map(info),
    maxConcurrent: getMaxConcurrentJobs(),
  };
}

function runningAccountEntries(accountId: number | null): Entry[] {
  if (accountId == null) return [];
  return [...entries.values()].filter((entry) =>
    entry.state === "running" && entry.accountId === accountId,
  );
}

/** Returns the active account lock that would prevent a requested job from starting. */
export function getExclusiveConflict(jobId: number): ExecutionInfo | null {
  const job = readExecutionJob(jobId);
  if (!job?.accountId) return null;
  const conflict = runningAccountEntries(job.accountId).find((entry) =>
    entry.jobId !== jobId && (job.exclusiveAccount === true || entry.exclusiveAccount),
  );
  return conflict ? info(conflict) : null;
}

function notify(event: "success" | "failed", job: Job, account: TgAccount | null, message: string): void {
  void Promise.resolve().then(() => notifyJobEvent(
    event,
    event === "success"
      ? buildSuccessMessage(job.name, job.jobType)
      : buildFailureMessage(job.name, job.jobType, message),
    account,
  )).catch((error) => console.warn("[execution] notification failed:", error));
}

async function perform(entry: Entry): Promise<ExecutionResult> {
  const details: JobDetailLog[] = [];
  let job: Job | undefined;
  let account: TgAccount | null = null;
  let run: Promise<void> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let detachTermination: (() => void) | undefined;
  let result: ExecutionResult = { status: "failed", logId: null };
  try {
    job = readExecutionJob(entry.jobId);
    if (!job || job.retired || (entry.source === "scheduler" && !job.enabled)) {
      return { status: "skipped", logId: null, message: "Job is missing, retired, or no longer scheduled" };
    }
    // A queued job may have been reassigned while waiting. The scheduler refresh
    // also updates this field before selecting an item, but keeping the value in
    // sync here closes the same-tick handoff boundary.
    entry.accountId = job.accountId;
    entry.exclusiveAccount = job.exclusiveAccount === true;
    if (entry.cancellationRequested) return { status: "cancelled", logId: null, message: "Cancelled" };
    const recovery = entry.options.recovery;
    const recoveries = recovery ? new JobRecoveryStore(db) : undefined;
    const blocked = recovery && recoveries!.blockedReason(recovery.interruptedLogId);
    if (blocked) return { status: "skipped", logId: null, message: blocked };
    entry.jobName = job.name;
    const ranAt = new Date().toISOString();
    entry.startedAt = ranAt;
    const messages = { scheduler: "Scheduled", manual: "Manual run", batch: "Batch run" };
    entry.logId = db.transaction(() => {
      const logId = Number(db.prepare(`
        INSERT INTO job_logs (job_id, ran_at, status, message, source)
        VALUES (?, ?, 'running', ?, ?)
      `).run(job!.id, ranAt, messages[entry.source], entry.source).lastInsertRowid);
      db.prepare("UPDATE jobs SET last_attempt_at = ? WHERE id = ?").run(ranAt, job!.id);
      if (recovery && !recoveries!.claim(recovery.interruptedLogId, recovery.owner, logId)) {
        throw new Error("Recovery is no longer pending or owned by this execution source");
      }
      return logId;
    })();
    const signal = registerJob(entry.logId);
    registerLiveDetail(entry.logId, details);
    try {
      entry.options.onLogId?.(entry.logId);
    } catch (error) {
      console.warn("[execution] log observer failed:", error);
    }
    account = readAccount(job);
    if (entry.options.signal?.aborted || entry.cancellationRequested || signal.aborted) {
      cancelJob(entry.logId);
      throw new Error("Job cancelled");
    }
    const currentWatchdogMs = jobWatchdogMs(job);
    const termination = new Promise<never>((_resolve, reject) => {
      const abort = () => {
        entry.cancellationRequested = true;
        reject(new Error(entry.timedOut
          ? `Watchdog: run exceeded ${currentWatchdogMs} ms`
          : "Job cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      detachTermination = () => signal.removeEventListener("abort", abort);
    });
    watchdog = setTimeout(() => {
      entry.timedOut = true;
      entry.cancellationRequested = true;
      cancelJob(entry.logId!);
    }, currentWatchdogMs);
    run = runJob(job, account, details, signal);
    run.catch(() => {});
    await Promise.race([run, termination]);
    if (signal.aborted) throw new Error("Job cancelled");
    const warnings = collectRunWarnings(job.jobType, details);
    const message = completedMessage(warnings);
    const persistedDetails = details.length
      ? JSON.stringify(persistLogDetailScreenshots(details, entry.logId!, logScreenshotBudget()))
      : null;
    db.transaction(() => {
      db.prepare("UPDATE job_logs SET status = 'success', message = ?, detail = ? WHERE id = ?")
        .run(message, persistedDetails, entry.logId);
      db.prepare(`
        UPDATE jobs SET
          last_success_at = CASE WHEN last_success_at IS NULL OR last_success_at < ? THEN ? ELSE last_success_at END,
          enabled = CASE WHEN run_once = 1 THEN 0 ELSE enabled END
        WHERE id = ?
      `).run(ranAt, ranAt, entry.jobId);
    })();
    notify("success", job, account, message);
    result = { status: "success", logId: entry.logId, message };
  } catch (error) {
    const message = entry.timedOut
      ? `Watchdog: run exceeded ${watchdogMs()} ms`
      : error instanceof Error ? error.message : String(error);
    const cancelled = !entry.timedOut && (entry.cancellationRequested || message === "Job cancelled");
    result = { status: cancelled ? "cancelled" : "failed", logId: entry.logId,
      message: cancelled ? "Cancelled" : message };
    if (entry.logId != null) {
      const persistedDetails = details.length
        ? JSON.stringify(persistLogDetailScreenshots(details, entry.logId!, logScreenshotBudget()))
        : null;
      db.prepare("UPDATE job_logs SET status = 'failed', message = ?, detail = ? WHERE id = ?")
        .run(result.message, persistedDetails, entry.logId);
    }
    if (job && !cancelled) notify("failed", job, account, message);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    // The caller's queue also waits here: a timeout is not proof that work stopped.
    if (run) await run.catch(() => {});
    detachTermination?.();
    if (entry.logId != null) {
      unregisterJob(entry.logId);
      clearLiveDetail(entry.logId);
    }
  }
  return result;
}

export function refreshExecutionSlots(): void {
  let running = [...entries.values()].filter((entry) => entry.state === "running").length;
  const limit = getMaxConcurrentJobs();
  while (queue.length && running < limit) {
    // Only an explicitly exclusive job owns an account lock. Ordinary jobs can
    // run together, but they cannot start while an exclusive owner is running.
    let index = -1;
    for (let i = 0; i < queue.length; i++) {
      const candidate = queue[i];
      const current = readExecutionJob(candidate.jobId);
      candidate.accountId = current?.accountId ?? null;
      candidate.exclusiveAccount = current?.exclusiveAccount === true;
      const conflict = runningAccountEntries(candidate.accountId).some((entry) =>
        candidate.exclusiveAccount || entry.exclusiveAccount,
      );
      if (conflict) {
        const waitedMs = Date.now() - Date.parse(candidate.queuedAt);
        if (!candidate.exclusiveAccount && candidate.options.source === "scheduler") {
          queue.splice(i, 1);
          entries.delete(candidate.jobId);
          candidate.detach?.();
          candidate.resolve({
            status: "skipped", logId: null,
            message: "Skipped because another exclusive job is running for this account",
          });
          i--;
        } else if (
          candidate.exclusiveAccount &&
          candidate.options.source === "scheduler" &&
          waitedMs >= EXCLUSIVE_ACCOUNT_WAIT_MS
        ) {
          queue.splice(i, 1);
          entries.delete(candidate.jobId);
          candidate.detach?.();
          candidate.resolve({
            status: "skipped", logId: null,
            message: "Skipped after waiting 30 minutes for the account to become available",
          });
          i--;
        }
        continue;
      }
      index = i;
      break;
    }
    if (index < 0) break;
    const [entry] = queue.splice(index, 1);
    entry.state = "running";
    running++;
    const finish = (result: ExecutionResult) => {
      entries.delete(entry.jobId);
      entry.detach?.();
      finishRecovery(entry, result);
      for (const listener of finishedListeners) {
        try { listener(entry.jobId, result); }
        catch (error) { console.warn("[execution] completion observer failed:", error); }
      }
      entry.resolve(result);
      refreshExecutionSlots();
    };
    void perform(entry).then(finish, (error) => finish({
      status: "failed", logId: entry.logId,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

function finishRecovery(entry: Entry, result: ExecutionResult): void {
  if (!entry.options.recovery) return;
  try {
    new JobRecoveryStore(db).finish(
      entry.options.recovery.interruptedLogId, result.status, result.status === "success" ? undefined : result.message,
    );
  } catch (error) {
    console.error("[execution] could not persist restart recovery result:", error);
  }
}

export function cancelManagedJob(jobId: number): boolean {
  const entry = entries.get(jobId);
  if (!entry) return false;
  entry.cancellationRequested = true;
  if (entry.state === "queued") {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    entries.delete(jobId);
    entry.detach?.();
    const result: ExecutionResult = { status: "cancelled", logId: null, message: "Cancelled before starting" };
    finishRecovery(entry, result);
    entry.resolve(result);
    refreshExecutionSlots();
  } else if (entry.logId != null) {
    cancelJob(entry.logId);
  }
  return true;
}

export function executeManagedJob(jobId: number, options: ExecutionOptions): Promise<ExecutionResult> {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    return Promise.resolve({ status: "skipped", logId: null, message: "Invalid job id" });
  }
  if (options.signal?.aborted) {
    return Promise.resolve({ status: "cancelled", logId: null, message: "Cancelled before starting" });
  }
  const duplicate = entries.get(jobId);
  if (duplicate) {
    return Promise.resolve({ status: "skipped", logId: duplicate.logId,
      message: `Job is already ${duplicate.state}` });
  }
  if (options.source !== "batch" && hasActiveBatchJob(db, jobId)) {
    return Promise.resolve({ status: "skipped", logId: null,
      message: "Job is already pending in a batch" });
  }
  const summary = readExecutionJob(jobId);
  if (!summary) {
    return Promise.resolve({ status: "skipped", logId: null, message: "Job not found" });
  }
  const conflict = getExclusiveConflict(jobId);
  if (conflict && !(options.source === "scheduler" && summary.exclusiveAccount === true)) {
    return Promise.resolve({
      status: "skipped",
      logId: null,
      message: options.source === "manual"
        ? "Another exclusive job is already running for this account"
        : "Skipped because another exclusive job is running for this account",
    });
  }
  return new Promise<ExecutionResult>((resolve) => {
    const entry: Entry = {
      jobId, jobName: summary.name, accountId: summary.accountId ?? null,
      exclusiveAccount: summary.exclusiveAccount === true,
      source: options.source, queuedAt: new Date().toISOString(),
      startedAt: null, logId: null, cancellationRequested: false, timedOut: false,
      state: "queued", options, resolve,
    };
    const abort = () => cancelManagedJob(jobId);
    options.signal?.addEventListener("abort", abort, { once: true });
    entry.detach = () => options.signal?.removeEventListener("abort", abort);
    entries.set(jobId, entry);
    queue.push(entry);
    if (options.source === "scheduler" && summary.exclusiveAccount === true) {
      const timer = setTimeout(() => refreshExecutionSlots(), EXCLUSIVE_ACCOUNT_WAIT_MS + 50);
      timer.unref?.();
    }
    refreshExecutionSlots();
  });
}
