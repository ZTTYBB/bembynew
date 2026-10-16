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
import { refreshScheduler, getSchedulerStatus } from "../scheduler";

// Window 10:00-12:00 UTC; the "missed" tests run at 13:00, after it closed.
const BASE_DATE = "2024-06-15";
const TZ = "UTC";
const AFTER_WINDOW = `${BASE_DATE}T13:00:00Z`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL DEFAULT '',
    phone_number  TEXT    NOT NULL DEFAULT '',
    api_id        INTEGER NOT NULL DEFAULT 0,
    api_hash      TEXT    NOT NULL DEFAULT '',
    session_string TEXT,
    auth_status   TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    disabled      INTEGER NOT NULL DEFAULT 0,
    proxy_id      TEXT,
    app_client_id TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS job_templates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL DEFAULT '',
    run_every_days INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL DEFAULT 'Job',
    account_id            INTEGER,
    job_type              TEXT    NOT NULL DEFAULT 'embywatch',
    bot_username          TEXT    NOT NULL DEFAULT '',
    schedule_window_start INTEGER NOT NULL DEFAULT 1000,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1200,
    timezone              TEXT    NOT NULL DEFAULT 'UTC',
    reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
    retry_max             INTEGER NOT NULL DEFAULT 5,
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    config                TEXT,
    start_command         TEXT    NOT NULL DEFAULT '/start',
    checkin_button        TEXT    NOT NULL DEFAULT '签到',
    template_id           INTEGER,
    run_every_days        INTEGER NOT NULL DEFAULT 1,
    run_every_days_max    INTEGER,
    retired               TEXT,
    last_success_at       TEXT
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

function insertJob(fields: { runEveryDays?: number } = {}): number {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO jobs (job_type, run_every_days) VALUES ('embywatch', ?)")
    .run(fields.runEveryDays ?? 1);
  return Number(lastInsertRowid);
}

/** A successful run N days before the fake clock, recorded durably. */
function stampSuccess(jobId: number, daysAgo: number) {
  const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  testDb
    .prepare("UPDATE jobs SET last_success_at = ? WHERE id = ?")
    .run(ts, jobId);
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(SCHEMA);
  testDb
    .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    .run("check_daily_run", "true");
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${BASE_DATE}T08:00:00Z`));
  vi.spyOn(Math, "random").mockReturnValue(0); // deterministic window start
  testDb.exec("DELETE FROM job_logs; DELETE FROM jobs;");
  refreshScheduler();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("catching up a run missed earlier today", () => {
  it("runs shortly from now when an overdue job's window has already closed", () => {
    vi.setSystemTime(new Date(AFTER_WINDOW));
    const id = insertJob({ runEveryDays: 1 });
    stampSuccess(id, 3); // due today, but nothing ran

    refreshScheduler();

    const [s] = getSchedulerStatus();
    expect(s.jobId).toBe(id);
    // Made up today, ~30s out -- not deferred to tomorrow
    const delta = new Date(s.nextRun).getTime() - Date.now();
    expect(delta).toBe(30_000);
    expect(s.nextRun.startsWith(BASE_DATE)).toBe(true);
  });

  it("does not make up a run that was already attempted today", () => {
    vi.setSystemTime(new Date(AFTER_WINDOW));
    const id = insertJob({ runEveryDays: 1 });
    stampSuccess(id, 3);
    // Today's attempt failed; failures retry tomorrow, so this must not re-fire
    // on every five-minute refresh.
    testDb
      .prepare("INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, 'failed')")
      .run(id, new Date().toISOString());

    refreshScheduler();

    expect(getSchedulerStatus()[0].nextRun.startsWith("2024-06-16")).toBe(true);
  });

  it("leaves a brand-new job on tomorrow when its window has passed", () => {
    vi.setSystemTime(new Date(AFTER_WINDOW));
    insertJob();

    refreshScheduler();

    // No prior success means it is not overdue, just newly created
    expect(getSchedulerStatus()[0].nextRun.startsWith("2024-06-16")).toBe(true);
  });

  it("does not catch up a job whose interval has not elapsed", () => {
    vi.setSystemTime(new Date(AFTER_WINDOW));
    const id = insertJob({ runEveryDays: 10 });
    stampSuccess(id, 1); // 1 of 10 days elapsed

    refreshScheduler();

    expect(getSchedulerStatus()[0].nextRun.startsWith("2024-06-24")).toBe(true); // +9
  });

  it("still schedules inside the window when it has not closed yet", () => {
    // 08:00, window 10:00-12:00 -- the window is ahead, so catch-up is irrelevant
    const id = insertJob({ runEveryDays: 1 });
    stampSuccess(id, 3);

    refreshScheduler();

    const [s] = getSchedulerStatus();
    expect(s.nextRun.startsWith(BASE_DATE)).toBe(true);
    expect(s.nextRun).toContain("T10:00:00");
  });

  it("does not catch up when one-run-per-day enforcement is off", () => {
    vi.setSystemTime(new Date(AFTER_WINDOW));
    testDb
      .prepare("UPDATE settings SET value = 'false' WHERE key = 'check_daily_run'")
      .run();
    const id = insertJob({ runEveryDays: 1 });
    stampSuccess(id, 3);

    refreshScheduler();

    // Enforcement off bypasses the overdue branch entirely, so the closed
    // window falls through to the plain "schedule tomorrow" path
    expect(getSchedulerStatus()[0].nextRun.startsWith("2024-06-16")).toBe(true);
  });
});
