import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { insertManagedJob, managedDb, setSetting } from "./helpers/managedDb";

let testDb: Database.Database;
const { runJob } = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../db/database", () => ({
  get db() { return testDb; }, getDefaultTgApiCredentials: () => null,
  FALLBACK_TIMEZONE: "UTC", getDefaultTimezone: () => "UTC",
}));
vi.mock("../jobs/runner", () => ({ runJob }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: vi.fn(), buildSuccessMessage: () => "Success", buildFailureMessage: () => "Failed",
}));
import {
  startScheduler, stopScheduler, getSchedulerStatus, refreshScheduler, setNextRun, purgeOldLogs,
} from "../scheduler";
import { getExecutionStatus, cancelManagedJob, executeManagedJob } from "../jobs/execution";
import { JobScheduleStore } from "../db/jobSchedules";
import { JobRecoveryStore } from "../db/jobRecovery";
import { TaskQueue } from "../jobs/taskQueue";

let queue: TaskQueue | undefined;
let release: (() => void) | undefined;
function job(selected = true, exclusive = false) {
  const id = insertManagedJob(testDb);
  testDb.prepare(
    "UPDATE jobs SET rerun_on_restart = ?, exclusive_account = ? WHERE id = ?",
  ).run(selected ? 1 : 0, exclusive ? 1 : 0, id);
  return id;
}
function interrupted(id: number, source = "scheduler", ranAt = "2026-10-14T00:00:00Z") {
  return Number(testDb.prepare(`
    INSERT INTO job_logs(job_id, ran_at, status, source) VALUES (?, ?, 'running', ?)
  `).run(id, ranAt, source).lastInsertRowid);
}
function dispatching(id: number) {
  return new JobScheduleStore(testDb).save({
    jobId: id, nextRun: "2026-10-14T00:00:00Z", timezone: "UTC", pinned: true,
    state: "dispatching", origin: "manual", scheduleKey: "old", skippedAt: null,
  })!;
}
function log(logId: number) {
  return testDb.prepare("SELECT * FROM job_logs WHERE id = ?").get(logId) as any;
}
async function drain() { for (let n = 0; n < 40; n++) await Promise.resolve(); }
async function tick(ms = 0) { await vi.advanceTimersByTimeAsync(ms); await drain(); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-15T00:00:00Z");
  testDb = managedDb();
  setSetting(testDb, "schedule_min_gap_minutes", "0");
  runJob.mockReset();
  runJob.mockResolvedValue(undefined);
  queue = undefined;
  release = undefined;
});
afterEach(async () => {
  queue?.stop();
  for (const entry of [...getExecutionStatus().running, ...getExecutionStatus().queued]) cancelManagedJob(entry.jobId);
  release?.();
  await drain();
  stopScheduler();
  expect(getExecutionStatus()).toMatchObject({ running: [], queued: [] });
  testDb.close();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("restart recovery through scheduler, managed executor and batch ownership", () => {
  it("keeps restart recovery account-exclusive across different jobs", async () => {
    setSetting(testDb, "max_concurrent_jobs", "2");
    const accountId = Number(testDb.prepare(
      "INSERT INTO tg_accounts(name, session_string) VALUES ('Recovered account', 'session')",
    ).run().lastInsertRowid);
    const first = job(true, true);
    const second = job(true, true);
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id IN (?, ?)").run(accountId, first, second);
    interrupted(first, "scheduler");
    interrupted(second, "scheduler");
    const releases: Array<() => void> = [];
    runJob.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));

    startScheduler();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(getExecutionStatus()).toMatchObject({
      running: [expect.objectContaining({ accountId, jobId: first })],
      queued: [expect.objectContaining({ accountId, jobId: second })],
    });
    releases[0]();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(2);
    releases[1]();
    await drain();
    expect(getExecutionStatus()).toMatchObject({ running: [], queued: [] });
  });

  it("replays one selected scheduler run immediately and continues a revisioned normal schedule", async () => {
    const id = job();
    const previous = dispatching(id);
    const oldLog = interrupted(id);
    startScheduler();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(1);
    const recovery = new JobRecoveryStore(testDb).get(oldLog)!;
    expect(recovery).toMatchObject({ owner: "scheduler", state: "finished", rerunLogId: expect.any(Number) });
    expect(log(oldLog)).toMatchObject({ status: "failed", message: expect.stringContaining("success") });
    expect(log(recovery.rerunLogId!)).toMatchObject({ status: "success", source: "scheduler" });
    const next = new JobScheduleStore(testDb).get(id)!;
    expect(next).toMatchObject({ state: "pending", revision: previous.revision + 2, pinned: false });
    expect(next.nextRun).toMatch(/^2026-10-16/);
    refreshScheduler();
    stopScheduler();
    startScheduler();
    await tick();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(new JobScheduleStore(testDb).get(id)).toEqual(next);
  });

  it("never replays an old unselected scheduled job", async () => {
    const id = job(false);
    dispatching(id);
    const oldLog = interrupted(id);
    startScheduler();
    await tick(60_000);
    expect(runJob).not.toHaveBeenCalled();
    expect(new JobScheduleStore(testDb).get(id)?.state).toBe("interrupted");
    expect(new JobRecoveryStore(testDb).get(oldLog)?.state).toBe("skipped");
    expect(log(oldLog).status).toBe("failed");
  });

  it.each(["manual", "scheduler"])("replays a selected disabled %s job as a manual run without enabling it", async (source) => {
    const id = job();
    if (source === "scheduler") dispatching(id);
    testDb.prepare("UPDATE jobs SET enabled = 0 WHERE id = ?").run(id);
    const oldLog = interrupted(id, source);
    startScheduler();
    await drain();
    const recovery = new JobRecoveryStore(testDb).get(oldLog)!;
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(log(recovery.rerunLogId!)).toMatchObject({ status: "success", source: "manual" });
    expect(testDb.prepare("SELECT enabled FROM jobs WHERE id = ?").get(id)).toEqual({ enabled: 0 });
    expect(getSchedulerStatus()).toEqual([]);
  });

  it("keeps an independent pinned future plan intact after a manual recovery", async () => {
    const id = job();
    const future = setNextRun(id, { nextRun: "2026-10-20T10:00:00Z", pinned: true });
    interrupted(id, "manual");
    stopScheduler();
    startScheduler();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(new JobScheduleStore(testDb).get(id)).toEqual(future);
    expect(getSchedulerStatus()[0]).toMatchObject({ nextRun: future.nextRun, pinned: true });
  });

  it("leaves batch-owned replay entirely to the durable batch worker", async () => {
    const id = job();
    queue = new TaskQueue(testDb, executeManagedJob, { applySuccessTags: vi.fn() });
    const batch = queue.enqueue({ jobIds: [id] });
    const oldLog = interrupted(id, "batch");
    testDb.prepare("UPDATE task_queue_items SET status = 'running', log_id = ?, attempts = 2").run(oldLog);
    startScheduler();
    await drain();
    expect(runJob).not.toHaveBeenCalled();
    expect(new JobRecoveryStore(testDb).get(oldLog)?.owner).toBe("batch");
    queue.start();
    await tick(10);
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(queue.get(batch.batchId)?.items?.[0]).toMatchObject({ status: "success", attempts: 3 });
    const recovery = new JobRecoveryStore(testDb).get(oldLog)!;
    expect(log(recovery.rerunLogId!).source).toBe("batch");
    expect(log(oldLog).status).toBe("failed");
  });

  it("honors an opt-out changed while restart recovery waits for global capacity", async () => {
    setSetting(testDb, "max_concurrent_jobs", "1");
    const first = job();
    const second = job();
    interrupted(first, "manual");
    const oldLog = interrupted(second, "manual");
    runJob.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    startScheduler();
    expect(getExecutionStatus().queued).toHaveLength(1);
    testDb.prepare("UPDATE jobs SET rerun_on_restart = 0 WHERE id = ?").run(second);
    release!();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(new JobRecoveryStore(testDb).get(oldLog)).toMatchObject({
      state: "skipped", rerunLogId: null, message: expect.stringContaining("disabled"),
    });
  });

  it("does not stamp a new attempt or execute side effects when the recovery claim transaction rolls back", async () => {
    const id = job();
    const oldLog = interrupted(id, "manual");
    testDb.exec(`
      CREATE TRIGGER reject_attempt BEFORE UPDATE OF last_attempt_at ON jobs
      BEGIN SELECT RAISE(ABORT, 'attempt stamp unavailable'); END;
    `);
    startScheduler();
    await drain();
    expect(runJob).not.toHaveBeenCalled();
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM job_logs").get()).toEqual({ n: 1 });
    expect(new JobRecoveryStore(testDb).get(oldLog)).toMatchObject({ state: "skipped", rerunLogId: null });
    expect(log(oldLog).message).toContain("attempt stamp unavailable");
  });

  it("disables a successfully recovered one-time task and leaves the old interrupted log failed", async () => {
    const id = job();
    testDb.prepare("UPDATE jobs SET run_once = 1 WHERE id = ?").run(id);
    dispatching(id);
    const oldLog = interrupted(id);
    startScheduler();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(testDb.prepare("SELECT enabled, last_success_at FROM jobs WHERE id = ?").get(id)).toEqual({
      enabled: 0, last_success_at: "2026-10-15T00:00:00.000Z",
    });
    expect(getSchedulerStatus()).toEqual([]);
    expect(new JobScheduleStore(testDb).get(id)).toBeUndefined();
    expect(log(oldLog).status).toBe("failed");
  });

  it("keeps a newer operator plan authoritative when a recovered run completes", async () => {
    const id = job();
    dispatching(id);
    interrupted(id);
    runJob.mockImplementationOnce(async () => {
      setNextRun(id, { nextRun: "2026-10-22T10:00:00Z", pinned: true });
    });
    startScheduler();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(new JobScheduleStore(testDb).get(id)).toMatchObject({
      nextRun: "2026-10-22T10:00:00.000Z", origin: "manual", pinned: true,
    });
    expect(getSchedulerStatus()[0].nextRun).toBe("2026-10-22T10:00:00.000Z");
  });

  it("preserves an old pending recovery across log retention until it is resolved", () => {
    const id = job();
    const oldLog = interrupted(id, "manual", "2026-01-01T00:00:00Z");
    const recoveries = new JobRecoveryStore(testDb);
    recoveries.captureInterruptedRuns();
    setSetting(testDb, "log_retention_days", "1");
    purgeOldLogs();
    expect(log(oldLog).status).toBe("failed");
    expect(recoveries.pending()).toHaveLength(1);
    recoveries.skip(oldLog, "Explicitly declined");
    purgeOldLogs();
    expect(log(oldLog)).toBeUndefined();
  });

  it("continues the normal schedule after a scheduler recovery itself was interrupted again", async () => {
    const id = job();
    const before = dispatching(id);
    const oldLog = interrupted(id);
    const recoveries = new JobRecoveryStore(testDb);
    const plans = new JobScheduleStore(testDb);
    recoveries.captureInterruptedRuns();
    plans.interruptDispatching();
    const secondLog = testDb.transaction(() => {
      const logId = interrupted(id);
      expect(recoveries.claim(oldLog, "scheduler", logId)).toBe(true);
      return logId;
    })();
    startScheduler();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(recoveries.get(oldLog)?.state).toBe("finished");
    expect(recoveries.get(secondLog)?.state).toBe("finished");
    expect(plans.get(id)).toMatchObject({ state: "pending", revision: before.revision + 2 });
    expect(plans.get(id)?.nextRun).toMatch(/^2026-10-16/);
  });

  it("repairs a schedule after committed recovery success without replaying it", async () => {
    const id = job();
    const before = dispatching(id);
    const oldLog = interrupted(id);
    const recoveries = new JobRecoveryStore(testDb);
    const plans = new JobScheduleStore(testDb);
    recoveries.captureInterruptedRuns();
    plans.interruptDispatching();
    const committedLog = testDb.transaction(() => {
      const logId = interrupted(id, "scheduler", new Date().toISOString());
      expect(recoveries.claim(oldLog, "scheduler", logId)).toBe(true);
      testDb.prepare("UPDATE job_logs SET status = 'success' WHERE id = ?").run(logId);
      testDb.prepare("UPDATE jobs SET last_success_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      return logId;
    })();
    startScheduler();
    await drain();
    expect(runJob).not.toHaveBeenCalled();
    expect(recoveries.get(oldLog)).toMatchObject({ state: "finished", rerunLogId: committedLog });
    expect(plans.get(id)).toMatchObject({ state: "pending", revision: before.revision + 2 });
    expect(plans.get(id)?.nextRun).toMatch(/^2026-10-16/);
    stopScheduler();
    startScheduler();
    await drain();
    expect(runJob).not.toHaveBeenCalled();
  });

  it("unblocks ordinary scheduling after a recovered batch is explicitly cancelled", async () => {
    const id = job();
    queue = new TaskQueue(testDb, executeManagedJob, { applySuccessTags: vi.fn() });
    const { batchId } = queue.enqueue({ jobIds: [id] });
    queue.control(batchId, "pause");
    const oldLog = interrupted(id, "batch");
    testDb.prepare("UPDATE task_queue_items SET status = 'running', log_id = ?").run(oldLog);
    startScheduler();
    queue.start();
    await tick(5);
    expect(runJob).not.toHaveBeenCalled();
    queue.control(batchId, "cancel");
    queue.stop();
    expect(new JobRecoveryStore(testDb).get(oldLog)?.state).toBe("skipped");
    refreshScheduler();
    const next = new JobScheduleStore(testDb).get(id)!;
    await tick(Date.parse(next.nextRun) - Date.now() + 1);
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(testDb.prepare("SELECT source FROM job_logs ORDER BY id DESC LIMIT 1").get())
      .toEqual({ source: "scheduler" });
  });
});
