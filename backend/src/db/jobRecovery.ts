import type Database from "better-sqlite3";

export type RecoveryOwner = "scheduler" | "manual" | "batch";
export type RecoveryState = "pending" | "started" | "finished" | "skipped";
export type JobRecovery = {
  interruptedLogId: number;
  jobId: number;
  owner: RecoveryOwner;
  state: RecoveryState;
  batchItemId: number | null;
  planRevision: number | null;
  rerunLogId: number | null;
  message: string;
};

type RecoveryRow = {
  interrupted_log_id: number;
  job_id: number;
  owner: RecoveryOwner;
  state: RecoveryState;
  batch_item_id: number | null;
  plan_revision: number | null;
  rerun_log_id: number | null;
  message: string;
};
type InterruptedRow = {
  log_id: number;
  job_id: number;
  source: string;
  rerun_on_restart?: number;
  retired?: string | null;
  run_once?: number;
  last_success_at?: string | null;
};

const INTERRUPTED = "Interrupted by server restart";

export function ensureJobRecoverySchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS job_run_recoveries (
      interrupted_log_id INTEGER PRIMARY KEY REFERENCES job_logs(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      owner TEXT NOT NULL CHECK (owner IN ('scheduler', 'manual', 'batch')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'started', 'finished', 'skipped')),
      batch_item_id INTEGER,
      plan_revision INTEGER,
      rerun_log_id INTEGER REFERENCES job_logs(id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_recovery_active_job
      ON job_run_recoveries(job_id) WHERE state IN ('pending', 'started');
    CREATE INDEX IF NOT EXISTS idx_job_recovery_pending
      ON job_run_recoveries(state, owner, interrupted_log_id);
  `);
}

function fromRow(row: RecoveryRow): JobRecovery {
  return {
    interruptedLogId: row.interrupted_log_id,
    jobId: row.job_id,
    owner: row.owner,
    state: row.state,
    batchItemId: row.batch_item_id,
    planRevision: row.plan_revision,
    rerunLogId: row.rerun_log_id,
    message: row.message,
  };
}

export class JobRecoveryStore {
  constructor(private readonly database: Database.Database) {
    ensureJobRecoverySchema(database);
  }

  private hasTable(table: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }

  get(interruptedLogId: number): JobRecovery | undefined {
    const row = this.database.prepare(
      "SELECT * FROM job_run_recoveries WHERE interrupted_log_id = ?",
    ).get(interruptedLogId) as RecoveryRow | undefined;
    return row && fromRow(row);
  }

  pending(owner?: RecoveryOwner): JobRecovery[] {
    const rows = owner === undefined
      ? this.database.prepare("SELECT * FROM job_run_recoveries WHERE state = 'pending' ORDER BY interrupted_log_id").all()
      : this.database.prepare(
        "SELECT * FROM job_run_recoveries WHERE state = 'pending' AND owner = ? ORDER BY interrupted_log_id",
      ).all(owner);
    return (rows as RecoveryRow[]).map(fromRow);
  }

  completedSchedulerRuns(): JobRecovery[] {
    return (this.database.prepare(`
      SELECT * FROM job_run_recoveries WHERE owner = 'scheduler' AND state = 'finished'
        AND rerun_log_id IS NOT NULL AND plan_revision IS NOT NULL
      ORDER BY interrupted_log_id
    `).all() as RecoveryRow[]).map(fromRow);
  }

  activeForJob(jobId: number): JobRecovery | undefined {
    const row = this.database.prepare(
      "SELECT * FROM job_run_recoveries WHERE job_id = ? AND state IN ('pending', 'started')",
    ).get(jobId) as RecoveryRow | undefined;
    return row && fromRow(row);
  }

  pendingBatchItem(batchItemId: number): JobRecovery | undefined {
    const row = this.database.prepare(
      "SELECT * FROM job_run_recoveries WHERE batch_item_id = ? AND owner = 'batch' AND state = 'pending'",
    ).get(batchItemId) as RecoveryRow | undefined;
    return row && fromRow(row);
  }

  private blocked(job: InterruptedRow | undefined): string | null {
    if (!job) return "Job no longer exists";
    if (job.rerun_on_restart !== 1) return "Automatic rerun is disabled";
    if (job.retired != null) return "Job is retired";
    if (job.run_once === 1 && job.last_success_at) return "One-time job has already succeeded";
    return null;
  }

  blockedReason(interruptedLogId: number): string | null {
    const recovery = this.get(interruptedLogId);
    if (!recovery || recovery.state !== "pending") return "Recovery is no longer pending";
    const job = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(recovery.jobId) as
      InterruptedRow | undefined;
    return this.blocked(job);
  }

  private pruneInvalidPending(): void {
    const hasBatches = this.hasTable("task_queue_items") && this.hasTable("task_batches");
    for (const recovery of this.pending()) {
      let reason = this.blockedReason(recovery.interruptedLogId);
      if (recovery.owner === "batch") {
        const item = !hasBatches || recovery.batchItemId == null ? undefined : this.database.prepare(`
          SELECT i.job_id, i.status, b.state FROM task_queue_items i
          JOIN task_batches b ON b.id = i.batch_id WHERE i.id = ?
        `).get(recovery.batchItemId) as { job_id: number; status: string; state: string } | undefined;
        if (!item || item.job_id !== recovery.jobId) reason = "Batch item no longer exists";
        else if (item.state === "cancelled") reason = "Batch was cancelled";
        else if (!["running", "paused"].includes(item.state) || !["pending", "running"].includes(item.status)) {
          reason = "Batch item is no longer pending";
        }
      }
      if (reason) this.skip(recovery.interruptedLogId, reason);
    }
  }

  captureInterruptedRuns(
    activeLogIds: ReadonlySet<number> = new Set(),
    onlyLogIds?: ReadonlySet<number>,
  ): number {
    return this.database.transaction(() => {
      const now = new Date().toISOString();
      this.pruneInvalidPending();
      const started = this.database.prepare(
        "SELECT * FROM job_run_recoveries WHERE state = 'started'",
      ).all() as RecoveryRow[];
      for (const recovery of started) {
        if (onlyLogIds && (recovery.rerun_log_id == null || !onlyLogIds.has(recovery.rerun_log_id))) continue;
        if (recovery.rerun_log_id != null && activeLogIds.has(recovery.rerun_log_id)) continue;
        const rerun = recovery.rerun_log_id == null ? undefined : this.database.prepare(
          "SELECT status, message FROM job_logs WHERE id = ?",
        ).get(recovery.rerun_log_id) as { status: string; message: string | null } | undefined;
        const message = rerun?.status === "running"
          ? `${INTERRUPTED}; rerun #${recovery.rerun_log_id} was interrupted again`
          : `${INTERRUPTED}; rerun #${recovery.rerun_log_id ?? "unknown"} ${rerun?.status ?? "is no longer available"}`;
        this.database.prepare(
          "UPDATE job_run_recoveries SET state = 'finished', message = ?, updated_at = ? WHERE interrupted_log_id = ?",
        ).run(message, now, recovery.interrupted_log_id);
        this.database.prepare("UPDATE job_logs SET message = ? WHERE id = ? AND status = 'failed'")
          .run(message, recovery.interrupted_log_id);
      }
      const rows = this.database.prepare(`
        SELECT j.*, l.id AS log_id, l.job_id, l.source
        FROM job_logs l JOIN jobs j ON j.id = l.job_id
        WHERE l.status = 'running' ORDER BY l.ran_at DESC, l.id DESC
      `).all() as InterruptedRow[];
      const hasBatches = this.hasTable("task_queue_items") && this.hasTable("task_batches");
      const hasPlans = this.hasTable("job_schedules");
      const seen = new Set<number>();
      let captured = 0;
      for (const row of rows) {
        if (onlyLogIds && !onlyLogIds.has(row.log_id)) continue;
        if (activeLogIds.has(row.log_id)) continue;
        const batch = hasBatches ? this.database.prepare(`
          SELECT i.id, b.state FROM task_queue_items i
          JOIN task_batches b ON b.id = i.batch_id
          WHERE i.job_id = ? AND i.status IN ('pending', 'running')
            AND (i.log_id = ? OR ? = 'batch')
          ORDER BY (i.log_id = ?) DESC, i.id DESC LIMIT 1
        `).get(row.job_id, row.log_id, row.source, row.log_id) as
          { id: number; state: string } | undefined : undefined;
        const owner: RecoveryOwner = batch || row.source === "batch" ? "batch"
          : row.source === "scheduler" ? "scheduler" : "manual";
        const plan = hasPlans && owner === "scheduler" ? this.database.prepare(
          "SELECT revision, state FROM job_schedules WHERE job_id = ? AND state IN ('dispatching', 'interrupted')",
        ).get(row.job_id) as { revision: number; state: string } | undefined : undefined;
        // Startup increments dispatch claims once; an interrupted replay keeps that revision.
        const planRevision = plan ? plan.revision + (plan.state === "dispatching" ? 1 : 0) : null;
        let reason = this.blocked(row);
        if (!["scheduler", "manual", "batch"].includes(row.source)) reason = "Unknown execution source";
        if (owner === "batch" && !batch) reason = "Batch execution has no recoverable batch item";
        if (batch && !["running", "paused"].includes(batch.state)) {
          reason = batch.state === "cancelled" ? "Batch was cancelled" : "Batch is no longer active";
        }
        if (seen.has(row.job_id)) reason = "A newer interrupted run owns recovery";
        else {
          const previous = this.activeForJob(row.job_id);
          if (previous) this.skip(previous.interruptedLogId, "A newer interrupted run owns recovery");
          seen.add(row.job_id);
        }
        const message = reason
          ? `${INTERRUPTED}; not rerun: ${reason}`
          : `${INTERRUPTED}; rerun pending (${owner})`;
        this.database.prepare(`
          INSERT OR IGNORE INTO job_run_recoveries
            (interrupted_log_id, job_id, owner, state, batch_item_id, plan_revision,
             message, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(row.log_id, row.job_id, owner, reason ? "skipped" : "pending",
          batch?.id ?? null, planRevision, message, now, now);
        captured += this.database.prepare("UPDATE job_logs SET status = 'failed', message = ? WHERE id = ? AND status = 'running'")
          .run(message, row.log_id).changes;
      }
      return captured;
    }).immediate();
  }

  claim(interruptedLogId: number, owner: RecoveryOwner, rerunLogId: number): boolean {
    if (!this.database.inTransaction) throw new Error("Recovery claim must share the new execution log transaction");
    const recovery = this.get(interruptedLogId);
    if (!recovery || recovery.owner !== owner || this.blockedReason(interruptedLogId)) return false;
    const log = this.database.prepare("SELECT job_id, status FROM job_logs WHERE id = ?").get(rerunLogId) as
      { job_id: number; status: string } | undefined;
    if (!log || log.job_id !== recovery.jobId || log.status !== "running" || rerunLogId === interruptedLogId) {
      throw new Error("Recovery requires a new running log for the same job");
    }
    const message = `${INTERRUPTED}; rerun as log #${rerunLogId}`;
    const { changes } = this.database.prepare(`
      UPDATE job_run_recoveries SET state = 'started', rerun_log_id = ?, message = ?, updated_at = ?
      WHERE interrupted_log_id = ? AND owner = ? AND state = 'pending'
    `).run(rerunLogId, message, new Date().toISOString(), interruptedLogId, owner);
    if (changes) this.database.prepare("UPDATE job_logs SET message = ? WHERE id = ? AND status = 'failed'")
      .run(message, interruptedLogId);
    return changes === 1;
  }

  skip(interruptedLogId: number, reason: string): boolean {
    const message = `${INTERRUPTED}; not rerun: ${reason}`;
    const { changes } = this.database.prepare(`
      UPDATE job_run_recoveries SET state = 'skipped', message = ?, updated_at = ?
      WHERE interrupted_log_id = ? AND state = 'pending'
    `).run(message, new Date().toISOString(), interruptedLogId);
    if (changes) this.database.prepare("UPDATE job_logs SET message = ? WHERE id = ? AND status = 'failed'")
      .run(message, interruptedLogId);
    return changes === 1;
  }

  finish(interruptedLogId: number, status: string, reason?: string): void {
    const recovery = this.get(interruptedLogId);
    if (!recovery || !["pending", "started"].includes(recovery.state)) return;
    const message = recovery.rerunLogId == null
      ? `${INTERRUPTED}; not rerun: ${reason ?? status}`
      : `${INTERRUPTED}; rerun #${recovery.rerunLogId} ${status}${reason ? `: ${reason}` : ""}`;
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE job_run_recoveries SET state = ?, message = ?, updated_at = ?
        WHERE interrupted_log_id = ? AND state IN ('pending', 'started')
      `).run(recovery.rerunLogId == null ? "skipped" : "finished", message,
        new Date().toISOString(), interruptedLogId);
      this.database.prepare("UPDATE job_logs SET message = ? WHERE id = ? AND status = 'failed'")
        .run(message, interruptedLogId);
    })();
  }
}
