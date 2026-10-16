let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({ get db() { return testDb; } }));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/cancellation", () => ({
  cancelJob: vi.fn(),
  registerJob: vi.fn().mockReturnValue(new AbortController().signal),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock("../jobs/notify", () => ({
  getNotifyConfig: vi.fn().mockReturnValue({ events: [], username: null }),
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildSuccessMessage: vi.fn(),
  buildFailureMessage: vi.fn(),
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { daysUntilNextRun, resolveRunEveryDays } from "../scheduler";

const TZ = "UTC";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT    NOT NULL DEFAULT 'Job',
    account_id         INTEGER,
    job_type           TEXT    NOT NULL DEFAULT 'embywatch',
    bot_username       TEXT    NOT NULL DEFAULT '',
    schedule_window_start INTEGER NOT NULL DEFAULT 1000,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1200,
    timezone           TEXT    NOT NULL DEFAULT 'UTC',
    reply_timeout_ms   INTEGER NOT NULL DEFAULT 40000,
    retry_max          INTEGER NOT NULL DEFAULT 5,
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    config             TEXT,
    start_command      TEXT    NOT NULL DEFAULT '/start',
    checkin_button     TEXT    NOT NULL DEFAULT '签到',
    template_id        INTEGER,
    run_every_days     INTEGER NOT NULL DEFAULT 1,
    run_every_days_max INTEGER,
    retired            TEXT,
    last_success_at    TEXT
  );
  CREATE TABLE IF NOT EXISTS job_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    ran_at  TEXT    NOT NULL,
    status  TEXT    NOT NULL,
    message TEXT,
    detail  TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function insertJob(fields: { runEveryDays?: number; runEveryDaysMax?: number | null } = {}): number {
  const { lastInsertRowid } = testDb
    .prepare(
      "INSERT INTO jobs (job_type, run_every_days, run_every_days_max) VALUES ('embywatch', ?, ?)",
    )
    .run(fields.runEveryDays ?? 1, fields.runEveryDaysMax ?? null);
  return Number(lastInsertRowid);
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-06-15T08:00:00Z"));
  testDb.exec("DELETE FROM job_logs; DELETE FROM jobs;");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("scheduling reads the durable last_success_at stamp", () => {
  it("derives the cadence from jobs.last_success_at when job_logs is empty", () => {
    // The state a retention sweep leaves behind: the durable stamp survives,
    // the log history does not.
    const id = insertJob({ runEveryDays: 1 });
    testDb
      .prepare("UPDATE jobs SET last_success_at = ? WHERE id = ?")
      .run(daysAgo(0), id);
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM job_logs").get()).toEqual({ n: 0 });

    // Ran today, interval 1 day -> due tomorrow, NOT immediately
    expect(daysUntilNextRun(id, TZ, 1)).toBe(1);
  });

  it("does not treat a purged job as never-run", () => {
    const id = insertJob({ runEveryDays: 10 });
    testDb
      .prepare("UPDATE jobs SET last_success_at = ? WHERE id = ?")
      .run(daysAgo(3), id);

    // 3 of 10 days elapsed -> 7 to go
    expect(daysUntilNextRun(id, TZ, 10)).toBe(7);
  });

  it("falls back to job_logs for rows written before the stamp existed", () => {
    const id = insertJob({ runEveryDays: 1 });
    testDb
      .prepare("INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, 'success')")
      .run(id, daysAgo(0));

    expect(daysUntilNextRun(id, TZ, 1)).toBe(1);
  });

  it("prefers the durable stamp over a stale log row", () => {
    const id = insertJob({ runEveryDays: 1 });
    // Log says it ran 5 days ago; the stamp says today. The stamp wins.
    testDb
      .prepare("INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, 'success')")
      .run(id, daysAgo(5));
    testDb
      .prepare("UPDATE jobs SET last_success_at = ? WHERE id = ?")
      .run(daysAgo(0), id);

    expect(daysUntilNextRun(id, TZ, 1)).toBe(1);
  });

  it("still treats a job that has never succeeded as due now", () => {
    const id = insertJob();
    expect(daysUntilNextRun(id, TZ, 1)).toBe(0);
  });

  it("seeds the interval range from the durable stamp", () => {
    const id = insertJob({ runEveryDays: 7, runEveryDaysMax: 15 });
    testDb
      .prepare("UPDATE jobs SET last_success_at = ? WHERE id = ?")
      .run(daysAgo(0), id);

    const interval = resolveRunEveryDays(id, 7, 15);
    expect(interval).toBeGreaterThanOrEqual(7);
    expect(interval).toBeLessThanOrEqual(15);
    // Same seed as daysUntilNextRun, so the two agree
    expect(daysUntilNextRun(id, TZ, 7, 15)).toBe(interval);
  });

  it("re-rolls the interval once a newer success is stamped", () => {
    const id = insertJob({ runEveryDays: 1, runEveryDaysMax: 60 });
    testDb
      .prepare("UPDATE jobs SET last_success_at = ? WHERE id = ?")
      .run(daysAgo(5), id);
    const first = resolveRunEveryDays(id, 1, 60);

    testDb
      .prepare("UPDATE jobs SET last_success_at = ? WHERE id = ?")
      .run(daysAgo(1), id);
    expect(resolveRunEveryDays(id, 1, 60)).not.toBe(first);
  });
});
