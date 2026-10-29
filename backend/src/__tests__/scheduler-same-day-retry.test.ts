import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { DateTime } from "luxon";
import { managedDb, insertManagedJob, setSetting } from "./helpers/managedDb";

let testDb: Database.Database;
const { runJob } = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../db/database", () => ({
  get db() { return testDb; },
  getDefaultTgApiCredentials: () => null,
  FALLBACK_TIMEZONE: "UTC",
  getDefaultTimezone: () => "UTC",
}));
vi.mock("../jobs/runner", () => ({ runJob }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: vi.fn(),
  notify: vi.fn(),
  buildSuccessMessage: vi.fn(() => "Success"),
  buildFailureMessage: vi.fn(() => "Failed"),
}));

import { stopScheduler, refreshScheduler, getSchedulerStatus, setNextRun } from "../scheduler";
import { getExecutionStatus } from "../jobs/execution";

// Window 10:00-12:00 UTC by default (managedDb defaults); the clock starts at 08:00.
const DAY = "2024-06-15";

async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function status(jobId: number) {
  return getSchedulerStatus().find((entry) => entry.jobId === jobId)!;
}

/** Make a job due now, let the scheduler run it once, and return when it is next planned. */
async function runOnceAt(jobId: number, time: string) {
  vi.setSystemTime(`${DAY}T${time}Z`);
  refreshScheduler();
  setNextRun(jobId, { nextRun: new Date(Date.now() + 1000).toISOString() });
  await vi.advanceTimersByTimeAsync(1500);
  await drain();
  return DateTime.fromISO(status(jobId).nextRun, { zone: "utc" });
}

function setRetry(jobId: number, hours: number) {
  testDb.prepare("UPDATE jobs SET retry_same_day_hours = ? WHERE id = ?").run(hours, jobId);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(`${DAY}T08:00:00.000Z`);
  testDb = managedDb();
  vi.clearAllMocks();
  runJob.mockResolvedValue(undefined);
  setSetting(testDb, "schedule_min_gap_minutes", "0");
});

afterEach(async () => {
  await drain();
  stopScheduler();
  expect(getExecutionStatus().running).toHaveLength(0);
  testDb.close();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("same-day retry after a failed run", () => {
  it("plans the next run hours later today when the run failed", async () => {
    const id = insertManagedJob(testDb);
    setRetry(id, 6);
    runJob.mockRejectedValue(new Error("bot did not answer"));

    const next = await runOnceAt(id, "09:00:00");

    expect(runJob).toHaveBeenCalledOnce();
    expect(next.toISODate()).toBe(DAY);
    const hoursLater = next.diff(DateTime.fromISO(`${DAY}T09:00:01Z`, { zone: "utc" }), "hours").hours;
    expect(hoursLater).toBeGreaterThanOrEqual(5.9);
    expect(hoursLater).toBeLessThanOrEqual(6.4);
  });

  it("ignores the job's own time window for the retry", async () => {
    const id = insertManagedJob(testDb);
    setRetry(id, 6);
    runJob.mockRejectedValue(new Error("down"));

    const next = await runOnceAt(id, "09:00:00");

    // The window is 10:00-12:00; 15:00 is outside it and still wanted.
    expect(next.hour).toBeGreaterThanOrEqual(15);
  });

  it("falls back to the last hour of the day when the interval would cross midnight", async () => {
    const id = insertManagedJob(testDb);
    setRetry(id, 6);
    runJob.mockRejectedValue(new Error("down"));

    const next = await runOnceAt(id, "20:00:00");

    expect(next.toISODate()).toBe(DAY);
    expect(next.hour).toBe(23);
  });

  it("does not retry a failure in the last hour; the next run is tomorrow", async () => {
    const id = insertManagedJob(testDb);
    setRetry(id, 6);
    runJob.mockRejectedValue(new Error("down"));

    const next = await runOnceAt(id, "23:10:00");

    expect(next.toISODate()).toBe("2024-06-16");
  });

  it("keeps the normal schedule when the setting is off", async () => {
    const id = insertManagedJob(testDb);
    setRetry(id, 0);
    runJob.mockRejectedValue(new Error("down"));

    const next = await runOnceAt(id, "09:00:00");

    expect(next.toISODate()).toBe("2024-06-16");
  });

  it("keeps the normal schedule after a success", async () => {
    const id = insertManagedJob(testDb);
    setRetry(id, 6);
    runJob.mockResolvedValue(undefined);

    const next = await runOnceAt(id, "09:00:00");

    expect(next.toISODate()).toBe("2024-06-16");
  });

  it("does not retry a run the user stopped", async () => {
    const id = insertManagedJob(testDb);
    setRetry(id, 6);
    runJob.mockImplementation(async () => { throw new Error("Job cancelled"); });

    const next = await runOnceAt(id, "09:00:00");

    expect(next.toISODate()).toBe("2024-06-16");
  });

  it("does not retry when the job is disabled", async () => {
    const id = insertManagedJob(testDb);
    setRetry(id, 6);
    runJob.mockImplementation(async () => {
      testDb.prepare("UPDATE jobs SET enabled = 0 WHERE id = ?").run(id);
      throw new Error("down");
    });

    vi.setSystemTime(`${DAY}T09:00:00Z`);
    refreshScheduler();
    setNextRun(id, { nextRun: new Date(Date.now() + 1000).toISOString() });
    await vi.advanceTimersByTimeAsync(1500);
    await drain();

    // A disabled job is dropped from the schedule rather than retried.
    expect(runJob).toHaveBeenCalledOnce();
    expect(getSchedulerStatus().find((entry) => entry.jobId === id)).toBeUndefined();
  });

  it("stops retrying once a retry succeeds", async () => {
    const id = insertManagedJob(testDb);
    setRetry(id, 2);
    runJob.mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);

    const first = await runOnceAt(id, "09:00:00");
    expect(first.toISODate()).toBe(DAY);

    // The retry comes due and succeeds.
    vi.setSystemTime(first.toMillis() + 1000);
    setNextRun(id, { nextRun: new Date(Date.now() + 1000).toISOString() });
    await vi.advanceTimersByTimeAsync(1500);
    await drain();

    expect(runJob).toHaveBeenCalledTimes(2);
    expect(DateTime.fromISO(status(id).nextRun, { zone: "utc" }).toISODate()).toBe("2024-06-16");
  });
});
