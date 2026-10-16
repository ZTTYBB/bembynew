import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { decryptSecret, encryptSecret } from "../db/secretColumns";
import { JobRecoveryStore, type RecoveryOwner } from "../db/jobRecovery";

export type TaskResult = {
  status: "success" | "failed" | "cancelled" | "skipped";
  logId: number | null;
  message?: string;
};
export type TaskExecutor = (
  jobId: number,
  options: {
    source: "batch";
    signal: AbortSignal;
    onLogId: (logId: number) => void;
    recovery?: { interruptedLogId: number; owner: RecoveryOwner };
  },
) => Promise<TaskResult>;
export type SuccessTags = Record<string, string | number | boolean | null>;
export type TaskBatchState = "running" | "paused" | "completed" | "cancelled";
export type TaskItemStatus = "pending" | "running" | TaskResult["status"];
export type TaskCapacity = boolean | { allowed: boolean; skip?: boolean; reason?: string };

type BatchRow = {
  id: string;
  state: TaskBatchState;
  concurrency: number;
  start_interval_ms: number;
  next_start_at: number;
  success_tags: string;
  created_at: string;
  updated_at: string;
};
type ItemRow = {
  id: number;
  batch_id: string;
  job_id: number;
  job_name: string;
  account_id: number | null;
  account_name: string | null;
  status: TaskItemStatus;
  log_id: number | null;
  error: string | null;
  attempts: number;
};

export function ensureTaskQueueSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_batches (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      concurrency INTEGER NOT NULL,
      start_interval_ms INTEGER NOT NULL,
      next_start_at INTEGER NOT NULL DEFAULT 0,
      success_tags TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_queue_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL REFERENCES task_batches(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL,
      job_name TEXT NOT NULL,
      account_id INTEGER,
      account_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      log_id INTEGER,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_queue_active_job
      ON task_queue_items(job_id) WHERE status IN ('pending', 'running');
    CREATE INDEX IF NOT EXISTS idx_task_queue_batch_status
      ON task_queue_items(batch_id, status, id);
  `);
}

export function hasActiveBatchJob(db: Database.Database, jobId: number): boolean {
  ensureTaskQueueSchema(db);
  return Boolean(db.prepare(
    "SELECT 1 FROM task_queue_items WHERE job_id = ? AND status IN ('pending', 'running') LIMIT 1",
  ).get(jobId));
}

function ids(input: unknown, label: string): number[] {
  if (
    !Array.isArray(input) || !input.length || input.length > 2000 ||
    input.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new Error(`${label} must contain 1 to 2000 positive integer ids`);
  }
  return [...new Set(input as number[])];
}

export function validateSuccessTags(input: unknown): SuccessTags {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("successTags must be an object");
  }
  const entries = Object.entries(input);
  if (entries.length > 128) throw new Error("Too many success tags");
  const result: SuccessTags = {};
  for (const [key, value] of entries) {
    if (
      !key.trim() || key !== key.trim() || key.length > 96 ||
      ["__proto__", "constructor", "prototype"].includes(key)
    ) throw new Error("Invalid success tag name");
    if (
      value !== null && typeof value !== "string" &&
      typeof value !== "boolean" && typeof value !== "number"
    ) throw new Error("Invalid success tag value");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid success tag number");
    if (typeof value === "string" && value.length > 512) throw new Error("Success tag value is too long");
    result[key] = value as SuccessTags[string];
  }
  return result;
}

export class TaskQueue {
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private recovered = false;
  private pumping = false;
  private active = new Map<number, { batchId: string; controller: AbortController }>();
  private awaitingStart = new Map<string, number>();

  constructor(
    private db: Database.Database,
    private execute: TaskExecutor,
    private options: {
      applySuccessTags: (accountId: number, tags: SuccessTags) => void;
      isJobActive?: (jobId: number) => boolean;
      hasCapacity?: (accountId: number | null, exclusiveAccount: boolean) => TaskCapacity;
    },
  ) {
    ensureTaskQueueSchema(db);
  }

  start(): void {
    if (this.started) return;
    if (!this.recovered) {
      this.recoverInterruptedItems();
      this.recovered = true;
    }
    this.started = true;
    this.wake();
  }

  private recoverInterruptedItems(): void {
    const recoveries = new JobRecoveryStore(this.db);
    const items = this.db.prepare("SELECT * FROM task_queue_items WHERE status = 'running'").all() as ItemRow[];
    const hasLogs = Boolean(this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_logs'",
    ).get());
    if (hasLogs) {
      const interruptedLogIds = new Set(items.filter((item) =>
        item.log_id != null && !this.options.isJobActive?.(item.job_id)).map((item) => item.log_id!));
      recoveries.captureInterruptedRuns(new Set(), interruptedLogIds);
    }
    this.db.transaction(() => {
      for (const item of items) {
        if (this.options.isJobActive?.(item.job_id)) continue;
        const batch = this.db.prepare("SELECT * FROM task_batches WHERE id = ?").get(item.batch_id) as BatchRow | undefined;
        const recovery = recoveries.activeForJob(item.job_id);
        const ownsRecovery = recovery?.owner === "batch" && recovery.batchItemId === item.id &&
          recovery.state === "pending";
        const blocked = ownsRecovery ? recoveries.blockedReason(recovery.interruptedLogId) : null;
        if (ownsRecovery && !blocked && batch && ["running", "paused"].includes(batch.state)) {
          this.db.prepare("UPDATE task_queue_items SET status = 'pending', error = ? WHERE id = ?")
            .run("Interrupted by server restart; rerun pending", item.id);
          continue;
        }
        if (ownsRecovery) recoveries.skip(recovery.interruptedLogId, blocked ?? "Batch is no longer active");
        const log = !hasLogs || item.log_id == null ? undefined : this.db.prepare(
          "SELECT status, message FROM job_logs WHERE id = ? AND job_id = ?",
        ).get(item.log_id, item.job_id) as { status: string; message: string | null } | undefined;
        if (log?.status === "success" && batch) {
          let error: string | null = null;
          try {
            this.db.transaction(() => this.applyTags(batch, item))();
          } catch (failure) {
            error = `Post-processing failed: ${failure instanceof Error ? failure.message : String(failure)}`;
          }
          this.db.prepare("UPDATE task_queue_items SET status = 'success', error = ? WHERE id = ?")
            .run(error, item.id);
          continue;
        }
        const job = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(item.job_id) as
          { rerun_on_restart?: number; retired?: string | null; run_once?: number; last_success_at?: string | null } | undefined;
        if (item.log_id == null && job?.rerun_on_restart === 1 && job.retired == null &&
          !(job.run_once === 1 && job.last_success_at) && batch && ["running", "paused"].includes(batch.state)) {
          this.db.prepare("UPDATE task_queue_items SET status = 'pending', error = ? WHERE id = ?")
            .run("Interrupted by server restart before execution started; rerun pending", item.id);
          continue;
        }
        this.db.prepare("UPDATE task_queue_items SET status = 'failed', error = ? WHERE id = ?")
          .run(blocked ?? log?.message ?? "Interrupted by server restart; review before retrying", item.id);
      }
    }).immediate();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const item of this.active.values()) item.controller.abort();
  }

  enqueue(input: {
    accountIds?: unknown;
    templateIds?: unknown;
    jobIds?: unknown;
    concurrency?: unknown;
    startIntervalSeconds?: unknown;
    successTags?: unknown;
  }): { batchId: string; queued: number; skipped: number } {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("A batch object is required");
    }
    const concurrency = input.concurrency === undefined ? 1 : input.concurrency;
    const interval = input.startIntervalSeconds === undefined ? 0 : input.startIntervalSeconds;
    if (!Number.isInteger(concurrency) || Number(concurrency) < 1 || Number(concurrency) > 20) {
      throw new Error("concurrency must be an integer from 1 to 20");
    }
    if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 0 || interval > 3600) {
      throw new Error("startIntervalSeconds must be between 0 and 3600");
    }
    const tags = validateSuccessTags(input.successTags);
    const explicitIds = input.jobIds !== undefined ? ids(input.jobIds, "jobIds") : null;
    const accountIds = explicitIds ? null : ids(input.accountIds, "accountIds");
    const templateIds = explicitIds ? null : ids(input.templateIds, "templateIds");
    if (explicitIds && (input.accountIds !== undefined || input.templateIds !== undefined)) {
      throw new Error("Choose jobIds or accountIds with templateIds, not both");
    }
    const conditions = explicitIds
      ? `j.id IN (${explicitIds.map(() => "?").join(",")})`
      : `j.account_id IN (${accountIds!.map(() => "?").join(",")})
         AND j.template_id IN (${templateIds!.map(() => "?").join(",")})`;
    const params = explicitIds ?? [...accountIds!, ...templateIds!];
    const candidates = this.db.prepare(`
      SELECT j.id, j.name, j.account_id, j.job_type, j.retired,
        a.id AS existing_account_id, a.name AS account_name, a.disabled, a.auth_status, a.session_string
      FROM jobs j LEFT JOIN tg_accounts a ON a.id = j.account_id
      WHERE ${conditions} ORDER BY j.id LIMIT 5001
    `).all(...params) as Array<{
      id: number; name: string; account_id: number | null; job_type: string;
      retired: string | null; existing_account_id: number | null;
      account_name: string | null; disabled: number | null;
      auth_status: string | null; session_string: string | null;
    }>;
    if (candidates.length > 5000) throw new Error("A batch may contain at most 5000 tasks");
    const batchId = randomUUID();
    const now = new Date().toISOString();
    let queued = 0;
    let skipped = explicitIds ? explicitIds.length - candidates.length : 0;
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO task_batches
          (id, state, concurrency, start_interval_ms, success_tags, created_at, updated_at)
        VALUES (?, 'running', ?, ?, ?, ?, ?)
      `).run(batchId, concurrency, Math.round(interval * 1000), encryptSecret(JSON.stringify(tags)), now, now);
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO task_queue_items
          (batch_id, job_id, job_name, account_id, account_name) VALUES (?, ?, ?, ?, ?)
      `);
      for (const job of candidates) {
        const requiresTg = ["checkin", "custom", "autoreg"].includes(job.job_type);
        if (
          job.retired != null ||
          (job.account_id != null && (job.existing_account_id == null || Boolean(job.disabled))) ||
          (requiresTg && (job.auth_status !== "authenticated" || !decryptSecret(job.session_string))) ||
          this.options.isJobActive?.(job.id)
        ) {
          skipped++;
          continue;
        }
        const result = insert.run(batchId, job.id, job.name, job.account_id, job.account_name);
        if (result.changes) queued++;
        else skipped++;
      }
      if (!queued) this.db.prepare("UPDATE task_batches SET state = 'completed' WHERE id = ?").run(batchId);
    })();
    this.wake();
    return { batchId, queued, skipped };
  }

  list(): ReturnType<TaskQueue["get"]>[] {
    const rows = this.db.prepare("SELECT id FROM task_batches ORDER BY created_at DESC, rowid DESC LIMIT 100")
      .all() as Array<{ id: string }>;
    return rows.map((row) => this.get(row.id, false));
  }

  get(batchId: string, includeItems = true) {
    const batch = this.db.prepare("SELECT * FROM task_batches WHERE id = ?").get(batchId) as BatchRow | undefined;
    if (!batch) return null;
    const rows = this.db.prepare("SELECT * FROM task_queue_items WHERE batch_id = ? ORDER BY id")
      .all(batchId) as ItemRow[];
    return {
      id: batch.id,
      state: batch.state,
      concurrency: batch.concurrency,
      startIntervalSeconds: batch.start_interval_ms / 1000,
      nextStartAt: batch.next_start_at ? new Date(batch.next_start_at).toISOString() : null,
      createdAt: batch.created_at,
      updatedAt: batch.updated_at,
      total: rows.length,
      done: rows.filter((row) => ["success", "failed", "cancelled", "skipped"].includes(row.status)).length,
      failed: rows.filter((row) => row.status === "failed").length,
      running: rows.filter((row) => row.status === "running").length,
      pending: rows.filter((row) => row.status === "pending").length,
      ...(includeItems ? { items: rows.map((row) => ({
        id: row.id, jobId: row.job_id, jobName: row.job_name,
        accountId: row.account_id, accountName: row.account_name,
        status: row.status, logId: row.log_id, error: row.error, attempts: row.attempts,
      })) } : {}),
    };
  }

  control(batchId: string, action: "pause" | "resume" | "cancel" | "retry-failed"): boolean {
    const batch = this.db.prepare("SELECT * FROM task_batches WHERE id = ?").get(batchId) as BatchRow | undefined;
    if (!batch) return false;
    if (batch.state === "cancelled" && action !== "cancel") {
      throw new Error("Cancelled batches cannot be resumed or retried");
    }
    if (batch.state === "completed" && !["retry-failed", "cancel"].includes(action)) {
      throw new Error("Completed batches cannot be paused or resumed");
    }
    this.db.transaction(() => {
      if (action === "retry-failed") {
        const failed = this.db.prepare(
          "SELECT id, job_id FROM task_queue_items WHERE batch_id = ? AND status = 'failed'",
        ).all(batchId) as Array<{ id: number; job_id: number }>;
        for (const item of failed) {
          const other = this.db.prepare(
            "SELECT 1 FROM task_queue_items WHERE job_id = ? AND status IN ('pending','running')",
          ).get(item.job_id);
          if (!other && !this.options.isJobActive?.(item.job_id)) {
            this.db.prepare("UPDATE task_queue_items SET status = 'pending', error = NULL, log_id = NULL WHERE id = ?")
              .run(item.id);
          }
        }
      }
      const state: TaskBatchState = action === "cancel" ? "cancelled"
        : action === "pause" ? (batch.state === "running" ? "paused" : batch.state)
        : batch.state === "cancelled" ? "cancelled" : "running";
      this.db.prepare("UPDATE task_batches SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, new Date().toISOString(), batchId);
      if (action === "cancel") {
        const recoveries = new JobRecoveryStore(this.db);
        const pendingItems = this.db.prepare(
          "SELECT id FROM task_queue_items WHERE batch_id = ? AND status IN ('pending', 'running')",
        ).all(batchId) as Array<{ id: number }>;
        for (const item of pendingItems) {
          const recovery = recoveries.pendingBatchItem(item.id);
          if (recovery) recoveries.skip(recovery.interruptedLogId, "Batch was cancelled");
        }
        this.db.prepare("UPDATE task_queue_items SET status = 'cancelled' WHERE batch_id = ? AND status = 'pending'")
          .run(batchId);
      }
    })();
    if (action === "cancel") {
      for (const item of this.active.values()) if (item.batchId === batchId) item.controller.abort();
    }
    this.wake();
    return true;
  }

  private wake(delayMs = 0): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, delayMs);
    this.timer.unref?.();
  }

  private pump(): void {
    if (!this.started || this.pumping) return;
    this.pumping = true;
    let wait = 1000;
    try {
      const batches = this.db.prepare("SELECT * FROM task_batches WHERE state = 'running' ORDER BY created_at, rowid")
        .all() as BatchRow[];
      // One launch per batch per pass keeps a large batch from starving later ones.
      for (const batch of batches) {
        const running = [...this.active.values()].filter((item) => item.batchId === batch.id).length;
        const pending = this.db.prepare(
          "SELECT * FROM task_queue_items WHERE batch_id = ? AND status = 'pending' ORDER BY id",
        ).all(batch.id) as ItemRow[];
        if (!pending.length) {
          if (!running) this.finish(batch.id);
          continue;
        }
        const delay = batch.next_start_at - Date.now();
        if (delay > 0) { wait = Math.min(wait, delay); continue; }
        if (running >= batch.concurrency || this.awaitingStart.has(batch.id)) continue;
        let selected: ItemRow | undefined;
        for (const candidate of pending) {
          const currentJob = this.db.prepare(`
            SELECT j.*, a.name AS account_name
            FROM jobs j LEFT JOIN tg_accounts a ON a.id = j.account_id
            WHERE j.id = ?
          `).get(candidate.job_id) as {
            account_id: number | null; exclusive_account?: number | null; account_name: string | null;
          } | undefined;
          const accountId = currentJob?.account_id ?? null;
          const capacity = this.options.hasCapacity?.(accountId, Boolean(currentJob?.exclusive_account));
          const allowed = capacity === undefined || (typeof capacity === "boolean" ? capacity : capacity.allowed);
          if (!allowed) {
            if (typeof capacity !== "boolean" && capacity?.skip) {
              this.db.prepare("UPDATE task_queue_items SET status = 'skipped', error = ? WHERE id = ?")
                .run(capacity.reason ?? "Skipped because another exclusive job is running for this account", candidate.id);
            }
            continue;
          }
          const claimed = this.db.prepare(
            `UPDATE task_queue_items
             SET status = 'running', attempts = attempts + 1, account_id = ?, account_name = ?
             WHERE id = ? AND status = 'pending'`,
          ).run(accountId, currentJob?.account_name ?? null, candidate.id);
          if (claimed.changes) {
            // Account links can be edited while an item waits in the durable
            // queue. Apply post-processing to the same account that passed the
            // capacity check, not the snapshot captured at enqueue time.
            candidate.account_id = accountId;
            selected = candidate;
            break;
          }
        }
        if (!selected) continue;
        const item = selected;
        const controller = new AbortController();
        this.active.set(item.id, { batchId: batch.id, controller });
        if (batch.start_interval_ms) this.awaitingStart.set(batch.id, item.id);
        void this.runItem(batch, item, controller);
        wait = 0;
      }
    } catch (error) {
      console.error("[task-queue] Worker failed:", error);
    } finally {
      this.pumping = false;
      this.wake(wait);
    }
  }

  private async runItem(batch: BatchRow, item: ItemRow, controller: AbortController): Promise<void> {
    let result: TaskResult;
    const recoveries = new JobRecoveryStore(this.db);
    const pendingRecovery = recoveries.activeForJob(item.job_id);
    const recovery = pendingRecovery?.owner === "batch" && pendingRecovery.batchItemId === item.id
      ? pendingRecovery : undefined;
    try {
      const blocked = recovery ? recoveries.blockedReason(recovery.interruptedLogId) : null;
      if (blocked) throw new Error(blocked);
      result = await this.execute(item.job_id, {
        source: "batch",
        signal: controller.signal,
        ...(recovery ? { recovery: { interruptedLogId: recovery.interruptedLogId, owner: "batch" as const } } : {}),
        onLogId: (logId) => {
          this.db.prepare("UPDATE task_queue_items SET log_id = ? WHERE id = ?").run(logId, item.id);
          this.db.prepare("UPDATE task_batches SET next_start_at = ?, updated_at = ? WHERE id = ?")
            .run(Date.now() + batch.start_interval_ms, new Date().toISOString(), batch.id);
          if (this.awaitingStart.get(batch.id) === item.id) this.awaitingStart.delete(batch.id);
          this.wake();
        },
      });
    } catch (error) {
      result = {
        status: controller.signal.aborted ? "cancelled" : "failed",
        logId: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      this.db.transaction(() => {
        // A cancellation arriving after completion does not undo an external
        // success. The executor's result, not the current button state, wins.
        if (result.status === "success") this.applyTags(batch, item);
        this.db.prepare("UPDATE task_queue_items SET status = ?, log_id = COALESCE(?, log_id), error = ? WHERE id = ?")
          .run(result.status, result.logId, result.status === "success" ? null : result.message ?? null, item.id);
        this.db.prepare("UPDATE task_batches SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), batch.id);
      })();
    } catch (error) {
      // Do not turn a completed external action into a retryable task if only
      // post-processing failed: retrying the job could repeat its side effects.
      this.db.prepare("UPDATE task_queue_items SET status = ?, log_id = COALESCE(?, log_id), error = ? WHERE id = ?")
        .run(result.status, result.logId, `Post-processing failed: ${error instanceof Error ? error.message : String(error)}`, item.id);
    } finally {
      if (recovery) {
        try {
          recoveries.finish(recovery.interruptedLogId, result.status,
            result.status === "success" ? undefined : result.message);
        } catch (error) {
          console.error("[task-queue] could not persist restart recovery result:", error);
        }
      }
      this.active.delete(item.id);
      if (this.awaitingStart.get(batch.id) === item.id) this.awaitingStart.delete(batch.id);
      this.finish(batch.id);
      this.wake();
    }
  }

  private applyTags(batch: BatchRow, item: ItemRow): void {
    if (item.account_id == null) return;
    const plaintext = decryptSecret(batch.success_tags);
    if (plaintext == null) throw new Error("Success tags could not be decrypted");
    const tags = validateSuccessTags(JSON.parse(plaintext));
    if (Object.keys(tags).length) this.options.applySuccessTags(item.account_id, tags);
  }

  private finish(batchId: string): void {
    const remaining = this.db.prepare(
      "SELECT 1 FROM task_queue_items WHERE batch_id = ? AND status IN ('pending','running') LIMIT 1",
    ).get(batchId);
    if (!remaining) {
      this.db.prepare(
        "UPDATE task_batches SET state = 'completed', updated_at = ? WHERE id = ? AND state IN ('running','paused')",
      ).run(new Date().toISOString(), batchId);
    }
  }
}
