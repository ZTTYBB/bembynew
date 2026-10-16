import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { DateTime } from "luxon";

export type JobOutcomePreview = {
  jobId: number;
  revision: string;
  latestLog: { id: number; ranAt: string; status: string; message: string | null } | null;
};
type OutcomeJob = {
  id: number; run_once: number; enabled: number;
  last_success_at: string | null; last_attempt_at: string | null;
};
type OutcomeLog = { id: number; ran_at: string; status: string; message: string | null };

export class JobOutcomeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function timestamp(value: string): number {
  const parsed = DateTime.fromISO(value, { zone: "utc" });
  const time = parsed.isValid ? parsed : DateTime.fromSQL(value, { zone: "utc" });
  if (!time.isValid) throw new JobOutcomeError("Stored run timestamp is invalid", 409);
  return time.toMillis();
}

function snapshot(database: Database.Database, jobId: number) {
  const job = database.prepare(
    "SELECT id, run_once, enabled, last_success_at, last_attempt_at FROM jobs WHERE id = ? AND retired IS NULL",
  ).get(jobId) as OutcomeJob | undefined;
  if (!job) throw new JobOutcomeError("Job not found", 404);
  const log = database.prepare(
    "SELECT id, ran_at, status, message FROM job_logs WHERE job_id = ? ORDER BY julianday(ran_at) DESC, id DESC LIMIT 1",
  ).get(jobId) as OutcomeLog | undefined;
  const revision = createHash("sha256").update(JSON.stringify([job, log ?? null])).digest("hex");
  return { job, log, revision };
}

export function getJobOutcome(database: Database.Database, jobId: number): JobOutcomePreview {
  const { log, revision } = snapshot(database, jobId);
  return {
    jobId, revision,
    latestLog: log ? { id: log.id, ranAt: log.ran_at, status: log.status, message: log.message } : null,
  };
}

function ensureOutcomeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS job_outcome_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER NOT NULL REFERENCES job_logs(id) ON DELETE CASCADE,
      prior_status TEXT NOT NULL,
      next_status TEXT NOT NULL,
      prior_message TEXT,
      changed_at TEXT NOT NULL
    )
  `);
}

export function markJobOutcome(
  database: Database.Database,
  jobId: number,
  input: { status?: unknown; expectedRevision?: unknown },
): { logId: number; created: boolean; status: "success" | "failed" } {
  if (input.status !== "success" && input.status !== "failed") {
    throw new JobOutcomeError("status must be success or failed");
  }
  if (typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    throw new JobOutcomeError("expectedRevision is required");
  }
  const status: "success" | "failed" = input.status;
  ensureOutcomeSchema(database);
  return database.transaction(() => {
    const { job, log, revision } = snapshot(database, jobId);
    if (database.prepare("SELECT 1 FROM job_logs WHERE job_id = ? AND status = 'running' LIMIT 1").get(jobId)) {
      throw new JobOutcomeError("Job is still running", 409);
    }
    if (revision !== input.expectedRevision) {
      throw new JobOutcomeError("Job results changed; refresh and confirm again", 409);
    }
    const now = new Date().toISOString();
    const message = `Manually marked ${status} at ${now}`;
    const ranAt = log?.ran_at ?? now;
    const logId = log?.id ?? Number(database.prepare(`
      INSERT INTO job_logs(job_id, ran_at, status, message, source)
      VALUES (?, ?, ?, ?, 'manual')
    `).run(jobId, ranAt, status, message).lastInsertRowid);
    if (log) {
      database.prepare(`
        INSERT INTO job_outcome_changes(log_id, prior_status, next_status, prior_message, changed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(logId, log.status, status, log.message, now);
      database.prepare("UPDATE job_logs SET status = ?, message = ? WHERE id = ?").run(status, message, logId);
    }
    const retained = database.prepare(
      "SELECT ran_at AS value FROM job_logs WHERE job_id = ? AND status = 'success' ORDER BY julianday(ran_at) DESC, id DESC LIMIT 1",
    ).get(jobId) as { value: string } | undefined;
    // Keep a pruned success stamp unless this is the very success being reversed.
    const durable = log?.status === "success" && job.last_success_at &&
      timestamp(job.last_success_at) === timestamp(ranAt)
      ? null : job.last_success_at;
    const lastSuccess = [durable, retained?.value].filter((value): value is string => value != null)
      .sort((a, b) => timestamp(a) - timestamp(b)).at(-1) ?? null;
    const enabled = job.run_once
      ? lastSuccess ? 0 : log?.status === "success" && status === "failed" ? 1 : job.enabled
      : job.enabled;
    const lastAttempt = !job.last_attempt_at || timestamp(job.last_attempt_at) < timestamp(ranAt)
      ? ranAt : job.last_attempt_at;
    database.prepare(`
      UPDATE jobs SET last_success_at = ?, enabled = ?, last_attempt_at = ?
      WHERE id = ?
    `).run(lastSuccess, enabled, lastAttempt, jobId);
    // Invalidate the old plan atomically, even if the process exits before re-arming it.
    database.prepare(`
      UPDATE job_schedules SET schedule_key = '', pinned = 0, state = 'pending',
        origin = 'auto', revision = revision + 1, updated_at = ?
      WHERE job_id = ?
    `).run(now, jobId);
    return { logId, created: !log, status };
  }).immediate();
}
