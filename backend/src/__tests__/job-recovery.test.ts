import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobRecoveryStore } from "../db/jobRecovery";
import { JobScheduleStore } from "../db/jobSchedules";
import { ensureTaskQueueSchema } from "../jobs/taskQueue";
import { insertManagedJob, managedDb } from "./helpers/managedDb";

let database: Database.Database;
let store: JobRecoveryStore;
let directory: string | undefined;

function job(selected = true): number {
  const id = insertManagedJob(database);
  database.prepare("UPDATE jobs SET rerun_on_restart = ? WHERE id = ?").run(selected ? 1 : 0, id);
  return id;
}
function running(jobId: number, source = "manual"): number {
  return Number(database.prepare(`
    INSERT INTO job_logs(job_id, ran_at, status, source) VALUES (?, ?, 'running', ?)
  `).run(jobId, new Date().toISOString(), source).lastInsertRowid);
}
function log(logId: number) {
  return database.prepare("SELECT * FROM job_logs WHERE id = ?").get(logId) as any;
}
function claim(oldLog: number, owner: "manual" | "scheduler" | "batch") {
  return database.transaction(() => {
    const newLog = running(store.get(oldLog)!.jobId, owner);
    expect(store.claim(oldLog, owner, newLog)).toBe(true);
    return newLog;
  })();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-15T00:00:00Z");
  database = managedDb();
  store = new JobRecoveryStore(database);
});
afterEach(() => {
  database.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  vi.useRealTimers();
});

describe("durable interrupted execution recovery", () => {
  it("captures opted-in sources once and keeps every original run failed", () => {
    const ids = ["manual", "scheduler"].map((source) => running(job(), source));
    expect(store.captureInterruptedRuns()).toBe(2);
    expect(store.captureInterruptedRuns()).toBe(0);
    expect(store.pending().map((item) => item.owner)).toEqual(["manual", "scheduler"]);
    for (const id of ids) expect(log(id)).toMatchObject({
      status: "failed", message: expect.stringContaining("rerun pending"),
    });
  });

  it("never opts old or explicitly unselected jobs into replay", () => {
    const id = running(job(false));
    store.captureInterruptedRuns();
    expect(store.pending()).toEqual([]);
    expect(store.get(id)).toMatchObject({ state: "skipped", message: expect.stringContaining("disabled") });
    expect(log(id).status).toBe("failed");
  });

  it("treats a legacy schema without the option as opted out", () => {
    database.close();
    database = managedDb();
    database.exec("ALTER TABLE jobs DROP COLUMN rerun_on_restart");
    store = new JobRecoveryStore(database);
    const id = running(insertManagedJob(database));
    store.captureInterruptedRuns();
    expect(store.get(id)?.state).toBe("skipped");
    expect(store.pending()).toEqual([]);
  });

  it("excludes live logs if the scheduler is stopped and started in the same process", () => {
    const id = running(job());
    expect(store.captureInterruptedRuns(new Set([id]))).toBe(0);
    expect(store.get(id)).toBeUndefined();
    expect(log(id).status).toBe("running");
  });

  it.each(["retired", "one-time succeeded"])("does not replay a %s job", (reason) => {
    const jobId = job();
    if (reason === "retired") database.prepare("UPDATE jobs SET retired = 'done' WHERE id = ?").run(jobId);
    else database.prepare("UPDATE jobs SET run_once = 1, last_success_at = ? WHERE id = ?")
      .run("2026-10-14T00:00:00Z", jobId);
    const id = running(jobId);
    store.captureInterruptedRuns();
    expect(store.get(id)?.state).toBe("skipped");
    expect(store.pending()).toEqual([]);
  });

  it("deduplicates multiple stale running logs by keeping only the newest", () => {
    const jobId = job();
    const first = running(jobId);
    vi.advanceTimersByTime(1000);
    const second = running(jobId);
    store.captureInterruptedRuns();
    expect(store.pending().map((item) => item.interruptedLogId)).toEqual([second]);
    expect(store.get(first)?.message).toContain("newer interrupted run");
    expect(log(first).status).toBe("failed");
  });

  it("records the interrupted scheduler revision without modifying its plan", () => {
    const jobId = job();
    const plans = new JobScheduleStore(database);
    const plan = plans.save({
      jobId, nextRun: "2026-10-15T00:00:00Z", timezone: "UTC", pinned: true,
      state: "dispatching", origin: "manual", scheduleKey: "key", skippedAt: null,
    })!;
    const id = running(jobId, "scheduler");
    store.captureInterruptedRuns();
    expect(store.get(id)).toMatchObject({ owner: "scheduler", planRevision: plan.revision + 1 });
    expect(plans.get(jobId)).toEqual(plan);
  });

  it("assigns active batch runs exclusively to their paused batch item", () => {
    ensureTaskQueueSchema(database);
    const jobId = job();
    const id = running(jobId, "batch");
    database.prepare(`
      INSERT INTO task_batches(id, state, concurrency, start_interval_ms, next_start_at,
        success_tags, created_at, updated_at)
      VALUES ('paused', 'paused', 1, 1000, ?, '{}', ?, ?)
    `).run(Date.now() + 50_000, new Date().toISOString(), new Date().toISOString());
    const itemId = Number(database.prepare(`
      INSERT INTO task_queue_items(batch_id, job_id, job_name, status, log_id, attempts)
      VALUES ('paused', ?, 'Job', 'running', ?, 3)
    `).run(jobId, id).lastInsertRowid);
    store.captureInterruptedRuns();
    expect(store.pending("manual")).toEqual([]);
    expect(store.pending("scheduler")).toEqual([]);
    expect(store.pending("batch")[0]).toMatchObject({ interruptedLogId: id, batchItemId: itemId });
    expect(database.prepare("SELECT state, next_start_at FROM task_batches").get())
      .toEqual({ state: "paused", next_start_at: Date.now() + 50_000 });
    expect(database.prepare("SELECT status, attempts FROM task_queue_items").get())
      .toEqual({ status: "running", attempts: 3 });
  });

  it("does not let standalone recovery take over a missing or cancelled batch", () => {
    const id = running(job(), "batch");
    store.captureInterruptedRuns();
    expect(store.get(id)).toMatchObject({
      owner: "batch", state: "skipped", message: expect.stringContaining("no recoverable batch item"),
    });
  });

  it("requires the claim and new execution log to share one transaction", () => {
    const jobId = job();
    const id = running(jobId);
    store.captureInterruptedRuns();
    const newLog = running(jobId);
    expect(() => store.claim(id, "manual", newLog)).toThrow("share the new execution log transaction");
    expect(store.get(id)?.state).toBe("pending");
    database.prepare("DELETE FROM job_logs WHERE id = ?").run(newLog);
    expect(() => database.transaction(() => {
      const rolledBack = running(jobId);
      expect(store.claim(id, "manual", rolledBack)).toBe(true);
      throw new Error("stamp write failed");
    })()).toThrow("stamp write failed");
    expect(store.get(id)).toMatchObject({ state: "pending", rerunLogId: null });
    expect(database.prepare("SELECT COUNT(*) AS n FROM job_logs").get()).toEqual({ n: 1 });
  });

  it("claims exactly once for its owner and records the new log without changing the old status", () => {
    const jobId = job();
    const id = running(jobId, "scheduler");
    store.captureInterruptedRuns();
    database.transaction(() => {
      expect(store.claim(id, "manual", running(jobId))).toBe(false);
    })();
    const newLog = claim(id, "scheduler");
    database.transaction(() => {
      expect(store.claim(id, "scheduler", newLog)).toBe(false);
    })();
    expect(store.get(id)).toMatchObject({ state: "started", rerunLogId: newLog });
    expect(log(id)).toMatchObject({ status: "failed", message: expect.stringContaining(`#${newLog}`) });
  });

  it("re-checks explicit opt-out before claiming a queued recovery", () => {
    const jobId = job();
    const id = running(jobId);
    store.captureInterruptedRuns();
    database.prepare("UPDATE jobs SET rerun_on_restart = 0 WHERE id = ?").run(jobId);
    expect(store.blockedReason(id)).toContain("disabled");
    database.transaction(() => {
      expect(store.claim(id, "manual", running(jobId))).toBe(false);
    })();
    store.skip(id, store.blockedReason(id)!);
    expect(store.get(id)?.state).toBe("skipped");
  });

  it("preserves a completed rerun after crashing before its completion bookkeeping", () => {
    const id = running(job());
    store.captureInterruptedRuns();
    const newLog = claim(id, "manual");
    database.prepare("UPDATE job_logs SET status = 'success' WHERE id = ?").run(newLog);
    store.captureInterruptedRuns();
    expect(store.get(id)?.state).toBe("finished");
    expect(store.pending()).toEqual([]);
    expect(log(id)).toMatchObject({ status: "failed", message: expect.stringContaining("success") });
  });

  it("recovers a rerun interrupted again without reviving the earlier recovery", () => {
    const id = running(job());
    store.captureInterruptedRuns();
    const newLog = claim(id, "manual");
    expect(store.captureInterruptedRuns()).toBe(1);
    expect(store.get(id)?.state).toBe("finished");
    expect(store.pending().map((item) => item.interruptedLogId)).toEqual([newLog]);
    expect(log(id).status).toBe("failed");
    expect(log(newLog).status).toBe("failed");
  });

  it("persists a pending recovery through a real SQLite close and reopen", () => {
    database.close();
    directory = mkdtempSync(join(tmpdir(), "bemby-recovery-"));
    const filename = join(directory, "test.sqlite");
    database = managedDb(filename);
    store = new JobRecoveryStore(database);
    const id = running(job());
    store.captureInterruptedRuns();
    database.close();
    database = managedDb(filename);
    store = new JobRecoveryStore(database);
    expect(store.captureInterruptedRuns()).toBe(0);
    expect(store.pending()).toHaveLength(1);
    const newLog = claim(id, "manual");
    database.prepare("UPDATE job_logs SET status = 'failed' WHERE id = ?").run(newLog);
    store.finish(id, "failed", "network unavailable");
    expect(store.pending()).toEqual([]);
    expect(log(id).message).toContain("network unavailable");
    expect(log(id).status).toBe("failed");
  });
});
