import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { managedDb, insertManagedJob, setSetting } from "./helpers/managedDb";

let testDb: Database.Database;
let directory: string | undefined;
const { runJob } = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../db/database", () => ({
  get db() { return testDb; },
  getDefaultTgApiCredentials: () => null,
  FALLBACK_TIMEZONE: "UTC",
  getDefaultTimezone: () => {
    const row = testDb.prepare("SELECT value FROM settings WHERE key = 'default_timezone'").get() as any;
    return row?.value || "UTC";
  },
}));
vi.mock("../jobs/runner", () => ({ runJob }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: vi.fn(),
  buildSuccessMessage: vi.fn(() => "Success"),
  buildFailureMessage: vi.fn(() => "Failed"),
}));

import {
  startScheduler, stopScheduler, refreshScheduler, getSchedulerStatus,
  setNextRun, setSchedulePinned, skipNextRun, shuffleSchedules, rescheduleAfterOutcome,
} from "../scheduler";
import { JobScheduleStore } from "../db/jobSchedules";
import { executeManagedJob, getExecutionStatus } from "../jobs/execution";
import { getJobOutcome, markJobOutcome } from "../jobs/outcome";

async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function plan(jobId: number) {
  return new JobScheduleStore(testDb).get(jobId)!;
}

function status(jobId: number) {
  return getSchedulerStatus().find((entry) => entry.jobId === jobId)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2024-06-15T08:00:00.000Z");
  testDb = managedDb();
  vi.clearAllMocks();
  runJob.mockResolvedValue(undefined);
  setSetting(testDb, "schedule_min_gap_minutes", "0");
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

describe("persistent scheduler", () => {
  it("keeps randomized auto times stable through refresh and a real SQLite reopen", () => {
    testDb.close();
    directory = mkdtempSync(join(tmpdir(), "bemby-scheduler-restart-"));
    const filename = join(directory, "test.db");
    testDb = managedDb(filename);
    const id = insertManagedJob(testDb);
    startScheduler();
    const before = status(id);
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    refreshScheduler();
    expect(status(id)).toEqual(before);
    stopScheduler();
    testDb.close();
    testDb = managedDb(filename);
    startScheduler();
    expect(status(id)).toEqual(before);
    expect(plan(id).origin).toBe("auto");
  });

  it("persists exact manual offset and timezone without window or settings recalculation", () => {
    const id = insertManagedJob(testDb);
    const exact = setNextRun(id, {
      nextRun: "2024-06-16T01:23:45+09:00", timezone: "Asia/Tokyo", pinned: true,
    });
    expect(exact).toMatchObject({
      nextRun: "2024-06-15T16:23:45.000Z", timezone: "Asia/Tokyo", origin: "manual", pinned: true,
    });
    testDb.prepare("UPDATE jobs SET schedule_window_start = 500, timezone = '' WHERE id = ?").run(id);
    setSetting(testDb, "default_timezone", "America/New_York");
    setSetting(testDb, "check_daily_run", "false");
    stopScheduler();
    startScheduler();
    refreshScheduler();
    expect(status(id)).toMatchObject({ nextRun: exact.nextRun, timezone: exact.timezone, pinned: true });
  });

  it("recomputes changed ordinary auto plans but preserves a pinned auto plan", () => {
    const id = insertManagedJob(testDb);
    refreshScheduler();
    const first = plan(id);
    testDb.prepare("UPDATE jobs SET schedule_window_start = 1400, schedule_window_end = 1500 WHERE id = ?").run(id);
    refreshScheduler();
    expect(plan(id).revision).toBeGreaterThan(first.revision);
    expect(DateTime.fromISO(plan(id).nextRun, { zone: "utc" }).hour).toBe(14);
    setSchedulePinned(id, true);
    const pinned = plan(id);
    testDb.prepare("UPDATE jobs SET schedule_window_start = 1600, schedule_window_end = 1700 WHERE id = ?").run(id);
    refreshScheduler();
    expect(plan(id)).toEqual(pinned);
    stopScheduler();
    startScheduler();
    expect(status(id).nextRun).toBe(pinned.nextRun);
    expect(status(id).pinned).toBe(true);
  });

  it("uses revision CAS if another writer updates after the manual edit was read", () => {
    const id = insertManagedJob(testDb);
    const original = setNextRun(id, { nextRun: "2024-06-15T10:00:00Z" });
    const save = JobScheduleStore.prototype.save;
    const competingTime = "2024-06-15T12:00:00.000Z";
    vi.spyOn(JobScheduleStore.prototype, "save").mockImplementationOnce(function (this: JobScheduleStore, input, expectedRevision) {
      expect(expectedRevision).toBe(original.revision);
      save.call(this, { ...input, nextRun: competingTime }, expectedRevision);
      return save.call(this, input, expectedRevision);
    });
    expect(() => setNextRun(id, {
      nextRun: "2024-06-15T11:00:00Z", expectedRevision: original.revision,
    })).toThrow("Schedule changed or no longer exists");
    expect(plan(id)).toMatchObject({ nextRun: competingTime, revision: original.revision + 1 });
  });

  it("keeps a skipped interval and its audit stamp across refresh and restart", () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET run_every_days = 3 WHERE id = ?").run(id);
    refreshScheduler();
    const original = status(id).nextRun;
    expect(skipNextRun(id).ok).toBe(true);
    const skipped = plan(id);
    expect(skipped.origin).toBe("skip");
    expect(skipped.skippedAt).toBe("2024-06-15T08:00:00.000Z");
    expect(DateTime.fromISO(skipped.nextRun).startOf("day")
      .diff(DateTime.fromISO(original).startOf("day"), "days").days).toBe(3);
    refreshScheduler();
    stopScheduler();
    startScheduler();
    expect(plan(id)).toEqual(skipped);
    expect(status(id).nextRun).toBe(skipped.nextRun);
  });

  it("shuffles only the selected local date and protects pinned and imminent plans", () => {
    const ids = ["Pinned", "Imminent", "Movable", "Tomorrow"].map((name) => insertManagedJob(testDb, name));
    setNextRun(ids[0], { nextRun: "2024-06-15T10:20:00Z", pinned: true });
    setNextRun(ids[1], { nextRun: "2024-06-15T08:00:30Z" });
    setNextRun(ids[2], { nextRun: "2024-06-15T10:15:00Z" });
    setNextRun(ids[3], { nextRun: "2024-06-16T10:15:00Z" });
    const before = ids.map((id) => plan(id));
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    expect(shuffleSchedules("2024-06-15")).toEqual({ moved: 1, protected: 2 });
    expect(plan(ids[0])).toEqual(before[0]);
    expect(plan(ids[1])).toEqual(before[1]);
    expect(plan(ids[3])).toEqual(before[3]);
    expect(plan(ids[2])).toMatchObject({ origin: "shuffle", nextRun: "2024-06-15T11:30:00.000Z" });
    stopScheduler();
    startScheduler();
    expect(status(ids[2]).nextRun).toBe("2024-06-15T11:30:00.000Z");
  });

  it("compares shuffle dates in each persisted plan's own timezone", () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET schedule_window_start = 0, schedule_window_end = 100, timezone = 'Asia/Tokyo' WHERE id = ?").run(id);
    const exact = setNextRun(id, { nextRun: "2024-06-16T00:30:00+09:00", timezone: "Asia/Tokyo" });
    expect(shuffleSchedules("2024-06-15").moved).toBe(0);
    expect(plan(id)).toEqual(exact);
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    expect(shuffleSchedules("2024-06-16").moved).toBe(1);
    expect(DateTime.fromISO(plan(id).nextRun).setZone("Asia/Tokyo").toISODate()).toBe("2024-06-16");
  });

  it("claims before side effects and prevents an edited-away timer from firing", async () => {
    const id = insertManagedJob(testDb);
    setNextRun(id, { nextRun: "2024-06-15T08:00:10Z" });
    setNextRun(id, { nextRun: "2024-06-15T08:00:20Z" });
    runJob.mockImplementation(async () => {
      expect(plan(id).state).toBe("dispatching");
      expect(testDb.prepare("SELECT COUNT(*) AS n FROM job_logs").get()).toEqual({ n: 1 });
    });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(runJob).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(runJob).toHaveBeenCalledOnce();
    expect(plan(id).state).toBe("pending");
    expect(plan(id).nextRun).toMatch(/^2024-06-16/);
  });

  it("marks a prior dispatch interrupted on startup and never automatically replays it", async () => {
    const id = insertManagedJob(testDb);
    const store = new JobScheduleStore(testDb);
    const saved = store.save({
      jobId: id, nextRun: "2024-06-15T07:59:00Z", timezone: "UTC", pinned: false,
      state: "dispatching", origin: "manual", scheduleKey: "old", skippedAt: null,
    })!;
    startScheduler();
    expect(plan(id)).toMatchObject({ state: "interrupted", revision: saved.revision + 1 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    refreshScheduler();
    expect(runJob).not.toHaveBeenCalled();
    expect(status(id).state).toBe("interrupted");
    setNextRun(id, { nextRun: "2024-06-15T08:06:00Z" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runJob).toHaveBeenCalledOnce();
  });

  it("keeps revisions increasing across execution cycles and rejects a prior cycle's edit", async () => {
    const id = insertManagedJob(testDb);
    const old = setNextRun(id, { nextRun: "2024-06-15T08:00:01Z" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(runJob).toHaveBeenCalledOnce();
    const next = plan(id);
    expect(next).toMatchObject({ state: "pending", revision: old.revision + 1 });
    expect(next.nextRun).toMatch(/^2024-06-16/);
    expect(() => setNextRun(id, {
      nextRun: "2024-06-17T10:00:00Z", expectedRevision: old.revision,
    })).toThrow("Schedule changed or no longer exists");
    expect(plan(id)).toEqual(next);
  });

  it("does not replace a concurrent newer plan when an earlier execution completes", async () => {
    const id = insertManagedJob(testDb);
    setNextRun(id, { nextRun: "2024-06-15T08:00:01Z" });
    let edited: ReturnType<typeof plan>;
    runJob.mockImplementationOnce(async () => {
      const store = new JobScheduleStore(testDb);
      const prior = store.get(id)!;
      edited = store.save({
        ...prior, nextRun: "2024-06-17T10:00:00Z", state: "pending", origin: "manual", pinned: true,
      }, prior.revision)!;
      refreshScheduler();
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(runJob).toHaveBeenCalledOnce();
    expect(plan(id)).toEqual(edited!);
    expect(status(id)).toMatchObject({ nextRun: edited!.nextRun, revision: edited!.revision, pinned: true });
  });

  it("keeps a future pending plan without a timer when disabled during execution", async () => {
    const id = insertManagedJob(testDb);
    const original = setNextRun(id, { nextRun: "2024-06-15T08:00:01Z" });
    runJob.mockImplementationOnce(async () => {
      testDb.prepare("UPDATE jobs SET enabled = 0 WHERE id = ?").run(id);
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(runJob).toHaveBeenCalledOnce();
    const next = plan(id);
    expect(next).toMatchObject({ state: "pending", revision: original.revision + 1 });
    expect(next.nextRun).toMatch(/^2024-06-16/);
    expect(status(id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(Date.parse(next.nextRun) - Date.now() + 1000);
    expect(runJob).toHaveBeenCalledOnce();
    expect(plan(id)).toEqual(next);
  });

  it.each(["disabled job", "retired job", "disabled account", "expired account"])(
    "preserves the revision after recovering an execution-time %s",
    async (reason) => {
      const id = insertManagedJob(testDb);
      const accountId = Number(testDb.prepare(`
        INSERT INTO tg_accounts (api_id, api_hash, session_string) VALUES (123, 'hash', 'session')
      `).run().lastInsertRowid);
      testDb.prepare("UPDATE jobs SET account_id = ?, job_type = 'checkin' WHERE id = ?").run(accountId, id);
      const original = setNextRun(id, { nextRun: "2024-06-15T08:00:01Z" });
      runJob.mockImplementationOnce(async () => {
        if (reason === "disabled job") testDb.prepare("UPDATE jobs SET enabled = 0 WHERE id = ?").run(id);
        else if (reason === "retired job") testDb.prepare("UPDATE jobs SET retired = 'paused' WHERE id = ?").run(id);
        else if (reason === "disabled account") testDb.prepare("UPDATE tg_accounts SET disabled = 1 WHERE id = ?").run(accountId);
        else testDb.prepare("UPDATE tg_accounts SET auth_status = 'session_expired' WHERE id = ?").run(accountId);
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(runJob).toHaveBeenCalledOnce();
      const next = plan(id);
      expect(next).toMatchObject({ state: "pending", revision: original.revision + 1 });
      expect(status(id)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      testDb.prepare("UPDATE jobs SET enabled = 1, retired = NULL WHERE id = ?").run(id);
      testDb.prepare("UPDATE tg_accounts SET disabled = 0, auth_status = 'authenticated' WHERE id = ?").run(accountId);
      refreshScheduler();
      expect(plan(id)).toEqual(next);
      expect(status(id)).toMatchObject({ nextRun: next.nextRun, revision: next.revision });
      expect(() => setNextRun(id, {
        nextRun: "2024-06-17T10:00:00Z", expectedRevision: original.revision,
      })).toThrow("Schedule changed or no longer exists");
      expect(plan(id)).toEqual(next);
    },
  );

  it("cleans up a physically deleted job without recreating its cascaded plan", async () => {
    const id = insertManagedJob(testDb);
    setNextRun(id, { nextRun: "2024-06-15T08:00:01Z" });
    runJob.mockImplementationOnce(async () => {
      testDb.prepare("DELETE FROM jobs WHERE id = ?").run(id);
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(runJob).toHaveBeenCalledOnce();
    expect(plan(id)).toBeUndefined();
    expect(status(id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs an unclaimed overdue pending occurrence once, then creates the next cycle", async () => {
    const id = insertManagedJob(testDb);
    startScheduler();
    const before = plan(id);
    stopScheduler();
    vi.setSystemTime(new Date(Date.parse(before.nextRun) + 1000));
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(runJob).toHaveBeenCalledOnce();
    expect(plan(id).nextRun).toMatch(/^2024-06-16/);
    refreshScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(runJob).toHaveBeenCalledOnce();
  });

  it("does not re-arm a stale pending snapshot after another process claims it", async () => {
    const id = insertManagedJob(testDb);
    const pending = setNextRun(id, { nextRun: "2024-06-15T08:00:01Z" });
    expect(new JobScheduleStore(testDb).claim(
      id, pending.revision, "2024-06-15T08:00:02Z",
    )).toBe(true);

    // The local timer observes the durable claim and gives up, leaving the
    // in-memory entry pending with no timer, as it would after a peer process
    // dispatches the same occurrence.
    await vi.advanceTimersByTimeAsync(1000);
    expect(runJob).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await executeManagedJob(id, { source: "manual" });
    await drain();

    expect(runJob).toHaveBeenCalledOnce();
    expect(new JobScheduleStore(testDb).get(id)?.state).toBe("dispatching");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains disabled plans without timers and cascades plans for deleted jobs", async () => {
    const id = insertManagedJob(testDb);
    setNextRun(id, { nextRun: "2024-06-15T08:00:10Z" });
    testDb.prepare("UPDATE jobs SET enabled = 0 WHERE id = ?").run(id);
    refreshScheduler();
    expect(status(id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runJob).not.toHaveBeenCalled();
    expect(plan(id).state).toBe("pending");
    testDb.prepare("UPDATE jobs SET enabled = 1 WHERE id = ?").run(id);
    refreshScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(runJob).toHaveBeenCalledOnce();
    testDb.prepare("DELETE FROM jobs WHERE id = ?").run(id);
    refreshScheduler();
    expect(plan(id)).toBeUndefined();
    expect(status(id)).toBeUndefined();
  });

  it("does not arm manually edited plans linked to a disabled account", async () => {
    const accountId = Number(testDb.prepare("INSERT INTO tg_accounts (disabled) VALUES (1)").run().lastInsertRowid);
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id = ?").run(accountId, id);
    setNextRun(id, { nextRun: "2024-06-15T08:00:10Z" });
    expect(status(id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runJob).not.toHaveBeenCalled();
    expect(plan(id).state).toBe("pending");
  });

  it("turns a dispatch bookkeeping exception into an interrupted, non-replayed plan", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = insertManagedJob(testDb);
    setNextRun(id, { nextRun: "2024-06-15T08:00:01Z" });
    vi.spyOn(JobScheduleStore.prototype, "save").mockImplementationOnce(() => { throw new Error("store temporarily unavailable"); });
    await vi.advanceTimersByTimeAsync(1000);
    expect(plan(id).state).toBe("interrupted");
    expect(status(id).state).toBe("interrupted");
    refreshScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(runJob).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalled();
  });

  it("replans only the corrected job, clears its pin, and increments its revision once", () => {
    const corrected = insertManagedJob(testDb, "Corrected");
    const untouched = insertManagedJob(testDb, "Untouched");
    setNextRun(corrected, { nextRun: "2024-06-15T08:00:10Z", pinned: true });
    setNextRun(untouched, { nextRun: "2024-06-16T11:00:00Z", pinned: true });
    const before = plan(corrected);
    const otherPlan = plan(untouched);
    const otherStatus = status(untouched);
    testDb.prepare("UPDATE jobs SET run_every_days = 5, last_success_at = ? WHERE id = ?")
      .run("2024-06-15T07:00:00Z", corrected);
    testDb.prepare("INSERT INTO job_logs(job_id, ran_at, status) VALUES (?, ?, 'success')")
      .run(corrected, "2024-06-15T07:00:00Z");
    rescheduleAfterOutcome(corrected);
    expect(plan(corrected)).toMatchObject({
      revision: before.revision + 1, pinned: false, origin: "auto", state: "pending",
    });
    expect(plan(corrected).nextRun).toMatch(/^2024-06-20/);
    expect(plan(untouched)).toEqual(otherPlan);
    expect(status(untouched)).toEqual(otherStatus);
  });

  it("retries today's corrected failure tomorrow regardless of a longer success cadence", async () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET run_every_days = 20, last_success_at = ? WHERE id = ?")
      .run("2024-06-14T07:00:00Z", id);
    setNextRun(id, { nextRun: "2024-06-15T08:00:10Z", pinned: true });
    testDb.prepare("INSERT INTO job_logs(job_id, ran_at, status) VALUES (?, ?, 'failed')")
      .run(id, "2024-06-15T07:00:00Z");
    rescheduleAfterOutcome(id);
    expect(plan(id).nextRun).toMatch(/^2024-06-16/);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(runJob).not.toHaveBeenCalled();
  });

  it.each(["2024-06-15 07:00:00", "2024-06-15T15:00:00+08:00"])(
    "replans the actual latest corrected failure across timestamp formats: %s", (ranAt) => {
      const id = insertManagedJob(testDb);
      testDb.prepare("UPDATE jobs SET run_every_days = 20, last_success_at = ? WHERE id = ?")
        .run("2024-06-14T07:00:00Z", id);
      testDb.prepare("INSERT INTO job_logs(job_id, ran_at, status) VALUES (?, ?, 'success')")
        .run(id, "2024-06-15T20:00:00+14:00");
      testDb.prepare("INSERT INTO job_logs(job_id, ran_at, status) VALUES (?, ?, 'failed')").run(id, ranAt);
      const preview = getJobOutcome(testDb, id);
      expect(preview.latestLog?.ranAt).toBe(ranAt);
      markJobOutcome(testDb, id, { status: "failed", expectedRevision: preview.revision });
      rescheduleAfterOutcome(id);
      expect(plan(id).nextRun).toMatch(/^2024-06-16/);
    },
  );

  it("evaluates the corrected failure day in the job's timezone", () => {
    vi.setSystemTime("2024-06-15T23:00:00Z");
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET timezone = 'Asia/Tokyo' WHERE id = ?").run(id);
    testDb.prepare("INSERT INTO job_logs(job_id, ran_at, status) VALUES (?, ?, 'failed')")
      .run(id, "2024-06-15T22:00:00Z");
    rescheduleAfterOutcome(id);
    expect(DateTime.fromISO(plan(id).nextRun).setZone("Asia/Tokyo").toISODate()).toBe("2024-06-17");
  });

  it("keeps a corrected one-time success disabled without a timer and rearms a reversal", () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET run_once = 1 WHERE id = ?").run(id);
    setNextRun(id, { nextRun: "2024-06-15T08:00:10Z", pinned: true });
    const initial = plan(id);
    testDb.prepare("UPDATE jobs SET enabled = 0, last_success_at = ? WHERE id = ?")
      .run("2024-06-15T07:00:00Z", id);
    const logId = testDb.prepare("INSERT INTO job_logs(job_id, ran_at, status) VALUES (?, ?, 'success')")
      .run(id, "2024-06-15T07:00:00Z").lastInsertRowid;
    rescheduleAfterOutcome(id);
    expect(plan(id).revision).toBe(initial.revision + 1);
    expect(status(id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    testDb.prepare("UPDATE jobs SET enabled = 1, last_success_at = NULL WHERE id = ?").run(id);
    testDb.prepare("UPDATE job_logs SET status = 'failed' WHERE id = ?").run(logId);
    rescheduleAfterOutcome(id);
    expect(plan(id).revision).toBe(initial.revision + 2);
    expect(plan(id).nextRun).toMatch(/^2024-06-16/);
    expect(status(id).nextRun).toBe(plan(id).nextRun);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not arm a corrected job with a disabled account", () => {
    const id = insertManagedJob(testDb);
    const accountId = testDb.prepare("INSERT INTO tg_accounts(disabled) VALUES (1)").run().lastInsertRowid;
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id = ?").run(accountId, id);
    testDb.prepare("INSERT INTO job_logs(job_id, ran_at, status) VALUES (?, ?, 'failed')")
      .run(id, "2024-06-15T07:00:00Z");
    rescheduleAfterOutcome(id);
    expect(plan(id).state).toBe("pending");
    expect(status(id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
