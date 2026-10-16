import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { insertManagedJob, managedDb, setSetting } from "./helpers/managedDb";
import { normalizeJobOptions } from "../jobs/jobOptions";

let testDb: Database.Database;
let directory: string | undefined;
const { runJob } = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../db/database", () => ({
  get db() { return testDb; },
  getDefaultTgApiCredentials: () => null,
  getDefaultTimezone: () => "UTC",
  FALLBACK_TIMEZONE: "UTC",
}));
vi.mock("../jobs/runner", () => ({ runJob }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: vi.fn(), buildSuccessMessage: () => "Success", buildFailureMessage: () => "Failed",
}));
import {
  startScheduler, stopScheduler, refreshScheduler, getSchedulerStatus,
  setNextRun, setSchedulePinned, shuffleSchedules, skipNextRun,
} from "../scheduler";
import { executeManagedJob, cancelManagedJob, getExecutionStatus } from "../jobs/execution";
import { JobScheduleStore } from "../db/jobSchedules";

function oneTime(min = 0, max = min) {
  const id = insertManagedJob(testDb);
  testDb.prepare(`UPDATE jobs SET run_once = 1, first_run_min_days = ?, first_run_max_days = ?,
    run_every_days = 20 WHERE id = ?`).run(min, max, id);
  return id;
}
function stored(id: number) {
  return testDb.prepare("SELECT enabled, last_success_at FROM jobs WHERE id = ?").get(id) as any;
}
function plan(id: number) { return new JobScheduleStore(testDb).get(id)!; }
function localDay(id: number) { return DateTime.fromISO(plan(id).nextRun).setZone(plan(id).timezone).toISODate(); }
async function drain() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2024-06-15T08:00:00Z");
  testDb = managedDb();
  setSetting(testDb, "schedule_min_gap_minutes", "0");
  vi.clearAllMocks();
  runJob.mockResolvedValue(undefined);
});
afterEach(async () => {
  await drain();
  stopScheduler();
  expect(getExecutionStatus().running).toHaveLength(0);
  expect(getExecutionStatus().queued).toHaveLength(0);
  testDb.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("one-time job options", () => {
  it("preserves old recurring defaults and partial updates", () => {
    expect(normalizeJobOptions({})).toEqual({
      runOnce: false, firstRunMinDays: 0, firstRunMaxDays: 0, rerunOnRestart: false,
    });
    expect(normalizeJobOptions({ firstRunMaxDays: 5 }, {
      runOnce: true, firstRunMinDays: 2, firstRunMaxDays: 4,
    })).toEqual({ runOnce: true, firstRunMinDays: 2, firstRunMaxDays: 5, rerunOnRestart: false });
  });
  it.each([
    { runOnce: "false" }, { firstRunMinDays: -1 }, { firstRunMaxDays: 3651 },
    { firstRunMinDays: 0.5 }, { firstRunMaxDays: "2" }, { firstRunMinDays: null },
    { firstRunMinDays: 2, firstRunMaxDays: 1 },
  ])("rejects invalid explicit options %j", (options) => {
    expect(() => normalizeJobOptions(options)).toThrow();
  });
});

describe("one-time execution and scheduling", () => {
  it.each([["minimum", 0, "2024-06-17"], ["maximum", 0.99999, "2024-06-20"]] as const)(
    "includes the %s first-run day even with daily checks off", (_name, random, day) => {
      setSetting(testDb, "check_daily_run", "false");
      vi.spyOn(Math, "random").mockReturnValue(random);
      const id = oneTime(2, 5);
      refreshScheduler();
      expect(localDay(id)).toBe(day);
      const original = plan(id);
      setSetting(testDb, "check_daily_run", "true");
      refreshScheduler();
      expect(plan(id)).toEqual(original);
    },
  );
  it("keeps the selected date and minute across a real SQLite close and reopen", () => {
    testDb.close();
    directory = mkdtempSync(join(tmpdir(), "bemby-once-restart-"));
    const filename = join(directory, "test.db");
    testDb = managedDb(filename);
    const id = oneTime(0, 10);
    refreshScheduler();
    const original = plan(id);
    stopScheduler();
    testDb.close();
    testDb = managedDb(filename);
    startScheduler();
    expect(plan(id)).toEqual(original);
    expect(getSchedulerStatus()[0].nextRun).toBe(original.nextRun);
  });
  it("keeps a zero-day task on today even after its window closes", () => {
    vi.setSystemTime("2024-06-15T22:00:00Z");
    const id = oneTime();
    refreshScheduler();
    expect(localDay(id)).toBe("2024-06-15");
    expect(Date.parse(plan(id).nextRun) - Date.now()).toBe(30_000);
  });
  it.each(["scheduler", "manual", "batch"] as const)(
    "disables only after a successful %s execution and removes active timers", async (source) => {
      const id = oneTime(2, 4);
      refreshScheduler();
      expect(getSchedulerStatus()).toHaveLength(1);
      expect((await executeManagedJob(id, { source })).status).toBe("success");
      expect(stored(id)).toEqual({ enabled: 0, last_success_at: "2024-06-15T08:00:00.000Z" });
      expect(getSchedulerStatus()).toHaveLength(0);
      refreshScheduler();
      expect(getSchedulerStatus()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("does not stop recurring jobs after success", async () => {
    const id = insertManagedJob(testDb);
    expect((await executeManagedJob(id, { source: "manual" })).status).toBe("success");
    expect(stored(id).enabled).toBe(1);
  });
  it("retries a failed one-time schedule tomorrow, not after the recurring interval or first range", async () => {
    const id = oneTime(5, 10);
    runJob.mockRejectedValueOnce(new Error("not completed"));
    setNextRun(id, { nextRun: "2024-06-15T08:00:01Z" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(runJob).toHaveBeenCalledOnce();
    expect(stored(id)).toEqual({ enabled: 1, last_success_at: null });
    expect(localDay(id)).toBe("2024-06-16");
    const retry = plan(id);
    stopScheduler();
    startScheduler();
    expect(plan(id)).toEqual(retry);
  });
  it("does not disable or stamp a cooperatively cancelled task", async () => {
    const id = oneTime();
    runJob.mockImplementationOnce((_job, _account, _detail, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Job cancelled")), { once: true })));
    const running = executeManagedJob(id, { source: "batch" });
    cancelManagedJob(id);
    expect((await running).status).toBe("cancelled");
    expect(stored(id)).toEqual({ enabled: 1, last_success_at: null });
  });
  it("respects an option changed to recurring before the in-flight task succeeds", async () => {
    const id = oneTime();
    runJob.mockImplementationOnce(async () => { testDb.prepare("UPDATE jobs SET run_once = 0 WHERE id = ?").run(id); });
    await executeManagedJob(id, { source: "manual" });
    expect(stored(id).enabled).toBe(1);
  });
  it("re-draws only unattempted one-time dates while shuffling all schedules", () => {
    const once = oneTime(0, 5);
    const recurring = insertManagedJob(testDb);
    const pinned = oneTime(0, 5);
    const imminent = oneTime(0, 5);
    setNextRun(once, { nextRun: "2024-06-16T10:10:00Z" });
    setNextRun(recurring, { nextRun: "2024-06-18T10:10:00Z" });
    setNextRun(pinned, { nextRun: "2024-06-16T10:10:00Z" });
    setSchedulePinned(pinned, true);
    setNextRun(imminent, { nextRun: "2024-06-15T08:00:30Z" });
    const protectedPlans = [plan(pinned), plan(imminent)];
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(shuffleSchedules()).toEqual({ moved: 2, protected: 2 });
    expect(localDay(once)).toBe("2024-06-20");
    expect(localDay(recurring)).toBe("2024-06-18");
    expect(plan(pinned)).toEqual(protectedPlans[0]);
    expect(plan(imminent)).toEqual(protectedPlans[1]);
    const revision = plan(once).revision;
    stopScheduler();
    startScheduler();
    expect(plan(once).revision).toBe(revision);
    expect(localDay(once)).toBe("2024-06-20");
  });
  it("preserves a failed task's retry date when shuffling", () => {
    const id = oneTime(0, 10);
    testDb.prepare("INSERT INTO job_logs(job_id, ran_at, status) VALUES (?, ?, 'failed')").run(id, "2024-06-15T07:00:00Z");
    setNextRun(id, { nextRun: "2024-06-16T10:10:00Z" });
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    shuffleSchedules();
    expect(localDay(id)).toBe("2024-06-16");
  });
  it("keeps attempted state after failed logs are purged and through restart", async () => {
    const id = oneTime(5, 10);
    runJob.mockRejectedValueOnce(new Error("failed"));
    setNextRun(id, { nextRun: "2024-06-15T08:00:01Z" });
    await vi.advanceTimersByTimeAsync(1000);
    testDb.prepare("DELETE FROM job_logs").run();
    stopScheduler();
    startScheduler();
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    shuffleSchedules();
    expect(localDay(id)).toBe("2024-06-16");
  });
  it("skips one-time occurrences by one day without using the recurring interval", () => {
    const id = oneTime(5, 10);
    setNextRun(id, { nextRun: "2024-06-20T10:10:00Z" });
    expect(skipNextRun(id).ok).toBe(true);
    expect(localDay(id)).toBe("2024-06-21");
  });
});
