import type Database from "better-sqlite3";
import { DateTime, IANAZone } from "luxon";

export type ScheduleState = "pending" | "dispatching" | "interrupted";
export type ScheduleOrigin = "auto" | "manual" | "skip" | "shuffle";
export type JobSchedule = {
  jobId: number;
  nextRun: string;
  timezone: string;
  pinned: boolean;
  state: ScheduleState;
  origin: ScheduleOrigin;
  scheduleKey: string;
  revision: number;
  skippedAt: string | null;
  updatedAt: string;
};

type ScheduleRow = {
  job_id: number;
  next_run: string;
  timezone: string;
  pinned: number;
  state: ScheduleState;
  origin: ScheduleOrigin;
  schedule_key: string;
  revision: number;
  skipped_at: string | null;
  updated_at: string;
};

export function ensureJobSchedulesSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS job_schedules (
      job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      next_run TEXT NOT NULL,
      timezone TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'dispatching', 'interrupted')),
      origin TEXT NOT NULL DEFAULT 'auto'
        CHECK (origin IN ('auto', 'manual', 'skip', 'shuffle')),
      schedule_key TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      skipped_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_schedules_due
      ON job_schedules(state, next_run);
  `);
}

export function scheduleInstant(value: string): string {
  if (typeof value !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error("nextRun must be an ISO timestamp with an explicit offset");
  }
  const instant = DateTime.fromISO(value, { setZone: true });
  if (!instant.isValid) throw new Error("Invalid nextRun timestamp");
  return instant.toUTC().toISO()!;
}

function fromRow(row: ScheduleRow): JobSchedule {
  return {
    jobId: row.job_id,
    nextRun: row.next_run,
    timezone: row.timezone,
    pinned: Boolean(row.pinned),
    state: row.state,
    origin: row.origin,
    scheduleKey: row.schedule_key,
    revision: row.revision,
    skippedAt: row.skipped_at,
    updatedAt: row.updated_at,
  };
}

export class JobScheduleStore {
  constructor(private readonly database: Database.Database) {
    ensureJobSchedulesSchema(database);
  }

  get(jobId: number): JobSchedule | undefined {
    const row = this.database.prepare("SELECT * FROM job_schedules WHERE job_id = ?").get(jobId) as
      ScheduleRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(): JobSchedule[] {
    return (this.database.prepare("SELECT * FROM job_schedules ORDER BY next_run, job_id").all() as
      ScheduleRow[]).map(fromRow);
  }

  save(
    plan: Omit<JobSchedule, "revision" | "updatedAt">,
    expectedRevision?: number,
  ): JobSchedule | undefined {
    if (!Number.isSafeInteger(plan.jobId) || plan.jobId <= 0) throw new Error("Invalid job id");
    if (!IANAZone.isValidZone(plan.timezone)) throw new Error("Invalid schedule timezone");
    const nextRun = scheduleInstant(plan.nextRun);
    const now = new Date().toISOString();
    if (expectedRevision !== undefined) {
      const { changes } = this.database.prepare(`
        UPDATE job_schedules SET next_run = ?, timezone = ?, pinned = ?, state = ?,
          origin = ?, schedule_key = ?, revision = revision + 1, skipped_at = ?, updated_at = ?
        WHERE job_id = ? AND revision = ?
      `).run(nextRun, plan.timezone, plan.pinned ? 1 : 0, plan.state, plan.origin,
        plan.scheduleKey, plan.skippedAt, now, plan.jobId, expectedRevision);
      return changes ? this.get(plan.jobId) : undefined;
    }
    this.database.prepare(`
      INSERT INTO job_schedules
        (job_id, next_run, timezone, pinned, state, origin, schedule_key, skipped_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        next_run = excluded.next_run, timezone = excluded.timezone, pinned = excluded.pinned,
        state = excluded.state, origin = excluded.origin, schedule_key = excluded.schedule_key,
        skipped_at = excluded.skipped_at, updated_at = excluded.updated_at,
        revision = job_schedules.revision + 1
    `).run(plan.jobId, nextRun, plan.timezone, plan.pinned ? 1 : 0, plan.state,
      plan.origin, plan.scheduleKey, plan.skippedAt, now);
    return this.get(plan.jobId);
  }

  claim(jobId: number, revision: number, now = new Date().toISOString()): boolean {
    return this.database.prepare(`
      UPDATE job_schedules SET state = 'dispatching', updated_at = ?
      WHERE job_id = ? AND revision = ? AND state = 'pending' AND next_run <= ?
    `).run(scheduleInstant(now), jobId, revision, scheduleInstant(now)).changes === 1;
  }

  remove(jobId: number, revision?: number): boolean {
    const stmt = revision === undefined
      ? this.database.prepare("DELETE FROM job_schedules WHERE job_id = ?")
      : this.database.prepare("DELETE FROM job_schedules WHERE job_id = ? AND revision = ?");
    return (revision === undefined ? stmt.run(jobId) : stmt.run(jobId, revision)).changes > 0;
  }

  interruptDispatching(): number {
    return this.database.prepare(`
      UPDATE job_schedules SET state = 'interrupted', revision = revision + 1, updated_at = ?
      WHERE state = 'dispatching'
    `).run(new Date().toISOString()).changes;
  }
}
