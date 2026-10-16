import Database from "better-sqlite3";
import express from "express";
import type { Server } from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskQueue, validateSuccessTags, type TaskExecutor, type TaskResult } from "../jobs/taskQueue";
import { createTaskQueueRouter } from "../routes/taskQueue";
import { encryptSecret, resetSecretKeyCache } from "../db/secretColumns";
import { JobRecoveryStore } from "../db/jobRecovery";

let db: Database.Database;
let queues: TaskQueue[];
let servers: Server[];

const SCHEMA = `
  CREATE TABLE tg_accounts (id INTEGER PRIMARY KEY, name TEXT, disabled INTEGER,
    auth_status TEXT, session_string TEXT);
  CREATE TABLE jobs (id INTEGER PRIMARY KEY, name TEXT, account_id INTEGER,
    template_id INTEGER, job_type TEXT, retired TEXT, enabled INTEGER);
  INSERT INTO tg_accounts VALUES
    (1,'Ready',0,'authenticated','test-session'),
    (2,'Disabled',1,'authenticated','test-session'),
    (3,'Expired',0,'session_expired',NULL);
  INSERT INTO jobs VALUES
    (1,'First',1,10,'checkin',NULL,1),
    (2,'Manual only',1,11,'custom',NULL,0),
    (3,'Disabled account',2,10,'custom',NULL,1),
    (4,'Expired account',3,10,'custom',NULL,1),
    (5,'Emby',NULL,10,'embywatch',NULL,1),
    (6,'Retired',1,10,'checkin','done',1),
    (7,'Missing account',99,10,'embywatch',NULL,1),
    (8,'Second Emby',NULL,11,'embywatch',NULL,1);
`;
const success: TaskResult = { status: "success", logId: 42 };

function createQueue(execute: TaskExecutor = async () => success, options: {
  applySuccessTags?: (accountId: number, tags: any) => void;
  isJobActive?: (jobId: number) => boolean;
  hasCapacity?: () => boolean;
} = {}) {
  const queue = new TaskQueue(db, execute, {
    applySuccessTags: options.applySuccessTags ?? vi.fn(),
    ...options,
  });
  queues.push(queue);
  return queue;
}

function controlled() {
  const runs: Array<{
    jobId: number;
    options: Parameters<TaskExecutor>[1];
    resolve: (result: TaskResult) => void;
  }> = [];
  const execute = vi.fn<TaskExecutor>((jobId, options) => new Promise((resolve) => {
    runs.push({ jobId, options, resolve });
  }));
  return { execute, runs };
}

function restartSchema() {
  db.exec(`
    ALTER TABLE jobs ADD COLUMN rerun_on_restart INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL REFERENCES jobs(id),
      ran_at TEXT NOT NULL, status TEXT NOT NULL, message TEXT,
      source TEXT NOT NULL DEFAULT 'batch'
    );
  `);
}

function interrupt(batchId: string, jobId: number, status = "running"): number {
  const logId = Number(db.prepare(`
    INSERT INTO job_logs(job_id, ran_at, status, message) VALUES (?, ?, ?, 'Previous execution')
  `).run(jobId, new Date().toISOString(), status).lastInsertRowid);
  db.prepare(`
    UPDATE task_queue_items SET status = 'running', log_id = ?, attempts = 3
    WHERE batch_id = ? AND job_id = ?
  `).run(logId, batchId, jobId);
  return logId;
}

function durableSuccess(): TaskExecutor {
  return vi.fn<TaskExecutor>(async (jobId, options) => {
    const store = new JobRecoveryStore(db);
    const logId = db.transaction(() => {
      const id = Number(db.prepare(`
        INSERT INTO job_logs(job_id, ran_at, status, source) VALUES (?, ?, 'running', 'batch')
      `).run(jobId, new Date().toISOString()).lastInsertRowid);
      if (options.recovery) expect(store.claim(
        options.recovery.interruptedLogId, options.recovery.owner, id,
      )).toBe(true);
      return id;
    })();
    options.onLogId(logId);
    db.prepare("UPDATE job_logs SET status = 'success' WHERE id = ?").run(logId);
    return { status: "success", logId };
  });
}

async function tick(ms = 1) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let n = 0; n < 10; n++) await Promise.resolve();
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  queues = [];
  servers = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
});

afterEach(async () => {
  for (const queue of queues) queue.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  db.close();
  vi.unstubAllEnvs();
  resetSecretKeyCache();
});

describe("persistent task batches", () => {
  it("filters retired/invalid accounts but allows explicitly running disabled jobs", async () => {
    const run = vi.fn<TaskExecutor>(async () => success);
    const queue = createQueue(run);
    const batch = queue.enqueue({ jobIds: [1, 2, 3, 4, 5, 6, 7, 999] });
    expect(batch).toMatchObject({ queued: 3, skipped: 5 });
    queue.start();
    await tick(50);
    expect(run.mock.calls.map(([id]) => id)).toEqual([1, 2, 5]);
    expect(queue.get(batch.batchId)).toMatchObject({ total: 3, done: 3, state: "completed" });
  });

  it("selects linked jobs by account and template and deduplicates across batches", () => {
    const queue = createQueue();
    const first = queue.enqueue({ accountIds: [1, 1, 2, 3], templateIds: [10, 11] });
    expect(first).toMatchObject({ queued: 2, skipped: 3 });
    const second = queue.enqueue({ jobIds: [1, 2, 5] });
    expect(second).toMatchObject({ queued: 1, skipped: 2 });
    expect(queue.list()).toHaveLength(2);
    expect(queue.list()[0]).not.toHaveProperty("items");
  });

  it("does not enqueue a job already active outside the batch queue", () => {
    const queue = createQueue(undefined, { isJobActive: (id) => id === 1 });
    const batch = queue.enqueue({ jobIds: [1, 2] });
    expect(batch).toMatchObject({ queued: 1, skipped: 1 });
  });

  it("honors parallelism and does not start after pausing", async () => {
    const { execute, runs } = controlled();
    const queue = createQueue(execute);
    const { batchId } = queue.enqueue({ jobIds: [1, 2, 5], concurrency: 2 });
    queue.start();
    await tick(10);
    expect(execute).toHaveBeenCalledTimes(2);
    queue.control(batchId, "pause");
    runs[0].resolve(success);
    await tick(2000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(queue.get(batchId)).toMatchObject({ state: "paused", running: 1, pending: 1 });
    queue.control(batchId, "resume");
    await tick(10);
    expect(execute).toHaveBeenCalledTimes(3);
    runs[1].resolve(success);
    runs[2].resolve(success);
    await tick();
    expect(queue.get(batchId)?.state).toBe("completed");
  });

  it("counts the interval from actual execution rather than queue admission", async () => {
    const { execute, runs } = controlled();
    const queue = createQueue(execute);
    const { batchId } = queue.enqueue({ jobIds: [1, 2, 5], concurrency: 3, startIntervalSeconds: 10 });
    queue.start();
    await tick(20_000);
    expect(execute).toHaveBeenCalledTimes(1);
    runs[0].options.onLogId(100);
    expect(queue.get(batchId)?.nextStartAt).toBe("2026-10-15T00:00:30.000Z");
    await tick(9999);
    expect(execute).toHaveBeenCalledTimes(1);
    await tick(2);
    expect(execute).toHaveBeenCalledTimes(2);
    // Completion of an older run must not clear a newer run's start gate.
    runs[0].resolve(success);
    await tick(20_000);
    expect(execute).toHaveBeenCalledTimes(2);
    runs[1].options.onLogId(101);
    await tick(10_001);
    expect(execute).toHaveBeenCalledTimes(3);
    runs[1].resolve(success);
    runs[2].resolve(success);
    await tick();
  });

  it("waits for global capacity and abort cleanup before freeing a cancelled item", async () => {
    let capacity = false;
    const { execute, runs } = controlled();
    const queue = createQueue(execute, { hasCapacity: () => capacity });
    const { batchId } = queue.enqueue({ jobIds: [1, 2] });
    queue.start();
    await tick(1000);
    expect(execute).not.toHaveBeenCalled();
    capacity = true;
    await tick(1001);
    expect(execute).toHaveBeenCalledTimes(1);
    queue.control(batchId, "cancel");
    expect(runs[0].options.signal.aborted).toBe(true);
    expect(queue.get(batchId)).toMatchObject({ state: "cancelled", running: 1, pending: 0, done: 1 });
    expect(queue.enqueue({ jobIds: [1] })).toMatchObject({ queued: 0, skipped: 1 });
    runs[0].resolve({ status: "cancelled", logId: 100 });
    await tick();
    expect(queue.get(batchId)).toMatchObject({ state: "cancelled", running: 0, done: 2 });
    expect(() => queue.control(batchId, "resume")).toThrow("Cancelled");
  });

  it("recovers pending items but never automatically replays interrupted running work", async () => {
    const first = createQueue();
    const { batchId } = first.enqueue({ jobIds: [1, 2] });
    db.prepare("UPDATE task_queue_items SET status = 'running', attempts = 1 WHERE job_id = 1").run();
    const execute = vi.fn<TaskExecutor>(async () => success);
    const replacement = createQueue(execute);
    replacement.start();
    await tick(10);
    expect(execute.mock.calls.map(([id]) => id)).toEqual([2]);
    expect(replacement.get(batchId)?.items?.[0]).toMatchObject({
      status: "failed", attempts: 1, error: expect.stringContaining("restart"),
    });
    expect(replacement.get(batchId)?.state).toBe("completed");
  });

  it("can restart a stopped worker without misclassifying its unsettled work", async () => {
    const { execute, runs } = controlled();
    const queue = createQueue(execute);
    const { batchId } = queue.enqueue({ jobIds: [1] });
    queue.start();
    await tick();
    queue.stop();
    queue.start();
    await tick();
    expect(queue.get(batchId)?.items?.[0].status).toBe("running");
    expect(execute).toHaveBeenCalledTimes(1);
    runs[0].resolve({ status: "cancelled", logId: null });
    await tick();
  });

  it("recovers only selected batch items while preserving pause, attempts and remaining cooldown", async () => {
    restartSchema();
    db.prepare("UPDATE jobs SET rerun_on_restart = 1 WHERE id = 1").run();
    const first = createQueue();
    const { batchId } = first.enqueue({ jobIds: [1], startIntervalSeconds: 10 });
    first.control(batchId, "pause");
    const oldLog = interrupt(batchId, 1);
    db.prepare("UPDATE task_batches SET next_start_at = ? WHERE id = ?").run(Date.now() + 30_000, batchId);
    const execute = durableSuccess();
    const replacement = createQueue(execute);
    replacement.start();
    expect(replacement.get(batchId)).toMatchObject({
      state: "paused", pending: 1, running: 0, nextStartAt: "2026-10-15T00:00:30.000Z",
    });
    expect(replacement.get(batchId)?.items?.[0].attempts).toBe(3);
    await tick(10_000);
    expect(execute).not.toHaveBeenCalled();
    replacement.control(batchId, "resume");
    await tick(19_999);
    expect(execute).not.toHaveBeenCalled();
    await tick(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(replacement.get(batchId)?.items?.[0]).toMatchObject({ status: "success", attempts: 4 });
    expect(new JobRecoveryStore(db).get(oldLog)).toMatchObject({
      owner: "batch", state: "finished", rerunLogId: expect.any(Number),
    });
    expect(db.prepare("SELECT status, message FROM job_logs WHERE id = ?").get(oldLog)).toMatchObject({
      status: "failed", message: expect.stringContaining("success"),
    });
    replacement.stop();
    const another = createQueue(execute);
    another.start();
    await tick(5000);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not replay an unselected running batch item or revive a cancelled batch", async () => {
    restartSchema();
    const first = createQueue();
    const unselected = first.enqueue({ jobIds: [1] }).batchId;
    const cancelled = first.enqueue({ jobIds: [2] }).batchId;
    interrupt(unselected, 1);
    interrupt(cancelled, 2);
    db.prepare("UPDATE jobs SET rerun_on_restart = 1 WHERE id = 2").run();
    db.prepare("UPDATE task_batches SET state = 'cancelled' WHERE id = ?").run(cancelled);
    const execute = durableSuccess();
    const replacement = createQueue(execute);
    replacement.start();
    await tick(10);
    expect(execute).not.toHaveBeenCalled();
    expect(replacement.get(unselected)?.items?.[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(replacement.get(cancelled)).toMatchObject({ state: "cancelled", pending: 0 });
  });

  it("checks the latest opt-out before resuming an interrupted paused item", async () => {
    restartSchema();
    db.prepare("UPDATE jobs SET rerun_on_restart = 1 WHERE id = 1").run();
    const first = createQueue();
    const { batchId } = first.enqueue({ jobIds: [1] });
    first.control(batchId, "pause");
    const oldLog = interrupt(batchId, 1);
    const execute = durableSuccess();
    const replacement = createQueue(execute);
    replacement.start();
    db.prepare("UPDATE jobs SET rerun_on_restart = 0 WHERE id = 1").run();
    replacement.control(batchId, "resume");
    await tick(10);
    expect(execute).not.toHaveBeenCalled();
    expect(replacement.get(batchId)?.items?.[0]).toMatchObject({
      status: "failed", error: expect.stringContaining("disabled"),
    });
    expect(new JobRecoveryStore(db).get(oldLog)?.state).toBe("skipped");
  });

  it("recovers an opted-in batch item interrupted before its execution log was created", async () => {
    restartSchema();
    db.prepare("UPDATE jobs SET rerun_on_restart = 1 WHERE id = 1").run();
    const first = createQueue();
    const { batchId } = first.enqueue({ jobIds: [1] });
    db.prepare("UPDATE task_queue_items SET status = 'running', attempts = 2 WHERE batch_id = ?").run(batchId);
    const execute = durableSuccess();
    const replacement = createQueue(execute);
    replacement.start();
    await tick(10);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(replacement.get(batchId)?.items?.[0]).toMatchObject({ status: "success", attempts: 3 });
  });

  it("keeps a committed execution success and recovers only its success tags after a crash", async () => {
    restartSchema();
    const applySuccessTags = vi.fn();
    const first = createQueue();
    const { batchId } = first.enqueue({ jobIds: [1], successTags: { completed: true } });
    interrupt(batchId, 1, "success");
    const execute = durableSuccess();
    const replacement = createQueue(execute, { applySuccessTags });
    replacement.start();
    await tick(10);
    expect(execute).not.toHaveBeenCalled();
    expect(applySuccessTags).toHaveBeenCalledTimes(1);
    expect(applySuccessTags).toHaveBeenCalledWith(1, { completed: true });
    expect(replacement.get(batchId)?.items?.[0]).toMatchObject({ status: "success", attempts: 3 });
    expect(replacement.get(batchId)?.state).toBe("completed");
    replacement.stop();
    createQueue(execute, { applySuccessTags }).start();
    await tick(10);
    expect(applySuccessTags).toHaveBeenCalledTimes(1);
  });

  it("never retries committed external success when recovered tag post-processing fails", async () => {
    restartSchema();
    const first = createQueue();
    const { batchId } = first.enqueue({ jobIds: [1], successTags: { completed: true } });
    interrupt(batchId, 1, "success");
    const execute = durableSuccess();
    const applySuccessTags = vi.fn(() => { throw new Error("tag storage unavailable"); });
    const replacement = createQueue(execute, { applySuccessTags });
    replacement.start();
    await tick(10);
    expect(execute).not.toHaveBeenCalled();
    expect(replacement.get(batchId)?.items?.[0]).toMatchObject({
      status: "success", error: expect.stringContaining("Post-processing failed"),
    });
    replacement.control(batchId, "retry-failed");
    await tick(10);
    expect(execute).not.toHaveBeenCalled();
    expect(applySuccessTags).toHaveBeenCalledTimes(1);
  });

  it("clears a pending recovery when an operator cancels its batch", async () => {
    restartSchema();
    db.prepare("UPDATE jobs SET rerun_on_restart = 1 WHERE id = 1").run();
    const first = createQueue();
    const { batchId } = first.enqueue({ jobIds: [1] });
    const oldLog = interrupt(batchId, 1);
    const replacement = createQueue(async () => success);
    replacement.start();
    expect(replacement.get(batchId)?.items?.[0]).toMatchObject({ status: "pending" });
    expect(new JobRecoveryStore(db).get(oldLog)).toMatchObject({ state: "pending" });
    replacement.control(batchId, "cancel");
    expect(replacement.get(batchId)?.items?.[0]).toMatchObject({ status: "cancelled" });
    expect(new JobRecoveryStore(db).get(oldLog)).toMatchObject({
      state: "skipped", message: expect.stringContaining("cancelled"),
    });
    replacement.stop();
  });

  it("clears stale pending recovery after a cancelled batch survives restart", async () => {
    restartSchema();
    db.prepare("UPDATE jobs SET rerun_on_restart = 1 WHERE id = 1").run();
    const first = createQueue();
    const { batchId } = first.enqueue({ jobIds: [1] });
    const oldLog = interrupt(batchId, 1);
    new JobRecoveryStore(db).captureInterruptedRuns();
    db.prepare("UPDATE task_queue_items SET status = 'cancelled' WHERE batch_id = ?").run(batchId);
    db.prepare("UPDATE task_batches SET state = 'cancelled' WHERE id = ?").run(batchId);
    const replacement = createQueue(async () => success);
    replacement.start();
    await tick(5);
    expect(new JobRecoveryStore(db).get(oldLog)).toMatchObject({
      state: "skipped", message: expect.stringContaining("cancelled"),
    });
    expect(replacement.get(batchId)?.items?.[0].status).toBe("cancelled");
    replacement.stop();
  });

  it("retries only explicitly failed items, preserving successful external actions", async () => {
    const execute = vi.fn<TaskExecutor>()
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce({ status: "failed", logId: 43, message: "temporary failure" })
      .mockResolvedValue(success);
    const queue = createQueue(execute);
    const { batchId } = queue.enqueue({ jobIds: [1, 2] });
    queue.start();
    await tick(10);
    expect(queue.get(batchId)).toMatchObject({ state: "completed", failed: 1 });
    queue.control(batchId, "retry-failed");
    await tick(10);
    expect(execute.mock.calls.map(([id]) => id)).toEqual([1, 2, 2]);
    expect(queue.get(batchId)?.items?.map((item) => item.attempts)).toEqual([1, 2]);
    expect(queue.get(batchId)).toMatchObject({ state: "completed", failed: 0 });
  });

  it("applies success tags only on success and never makes post-processing errors retryable", async () => {
    const applySuccessTags = vi.fn(() => { throw new Error("account tags unavailable"); });
    const queue = createQueue(async () => success, { applySuccessTags });
    const { batchId } = queue.enqueue({ jobIds: [1], successTags: { done: true, points: 8 } });
    queue.start();
    await tick(10);
    expect(applySuccessTags).toHaveBeenCalledWith(1, { done: true, points: 8 });
    expect(queue.get(batchId)?.items?.[0]).toMatchObject({
      status: "success", error: expect.stringContaining("Post-processing"),
    });
    queue.control(batchId, "retry-failed");
    await tick(10);
    expect(applySuccessTags).toHaveBeenCalledTimes(1);
  });

  it("uses the current account binding when a pending task is rebound before launch", async () => {
    const applySuccessTags = vi.fn();
    const { execute, runs } = controlled();
    const queue = createQueue(execute, {
      applySuccessTags,
      hasCapacity: () => true,
    });
    const { batchId } = queue.enqueue({
      jobIds: [1, 2],
      concurrency: 1,
      successTags: { completed: true },
    });
    queue.start();
    await tick(10);
    expect(execute).toHaveBeenCalledTimes(1);

    // The second item was enqueued for account 1, then reassigned while waiting.
    db.prepare("UPDATE jobs SET account_id = 2 WHERE id = 2").run();
    runs[0].resolve(success);
    await tick(10);
    expect(execute).toHaveBeenCalledTimes(2);

    runs[1].resolve(success);
    await tick(10);
    expect(queue.get(batchId)).toMatchObject({ state: "completed", done: 2 });
    expect(applySuccessTags.mock.calls).toEqual([
      [1, { completed: true }],
      [2, { completed: true }],
    ]);
  });

  it("encrypts stored success tag values and excludes them from API payloads", () => {
    vi.stubEnv("BEMBY_DATA_KEY", "test-only-key");
    resetSecretKeyCache();
    const queue = createQueue();
    const { batchId } = queue.enqueue({ jobIds: [1], successTags: { token: "private-test-value" } });
    const stored = db.prepare("SELECT success_tags AS tags FROM task_batches").get() as { tags: string };
    expect(stored.tags).toMatch(/^enc:v1:/);
    expect(stored.tags).not.toContain("private-test-value");
    expect(JSON.stringify(queue.get(batchId))).not.toContain("private-test-value");
    expect(JSON.stringify(queue.list())).not.toContain("test-session");
  });

  it("skips encrypted Telegram jobs when the key is missing or mismatched", () => {
    vi.stubEnv("BEMBY_DATA_KEY", "queue-session-key");
    resetSecretKeyCache();
    const encrypted = encryptSecret("test-session");
    expect(encrypted).toMatch(/^enc:v1:/);
    db.prepare("UPDATE tg_accounts SET session_string = ? WHERE id = 1").run(encrypted);

    vi.stubEnv("BEMBY_DATA_KEY", "");
    resetSecretKeyCache();
    expect(createQueue().enqueue({ jobIds: [1] })).toMatchObject({ queued: 0, skipped: 1 });

    vi.stubEnv("BEMBY_DATA_KEY", "wrong-queue-session-key");
    resetSecretKeyCache();
    expect(createQueue().enqueue({ jobIds: [1] })).toMatchObject({ queued: 0, skipped: 1 });

    vi.stubEnv("BEMBY_DATA_KEY", "queue-session-key");
    resetSecretKeyCache();
    expect(createQueue().enqueue({ jobIds: [1] })).toMatchObject({ queued: 1, skipped: 0 });
  });

  it.each([
    {}, { jobIds: [] }, { jobIds: ["1"] }, { jobIds: [0] },
    { jobIds: [1], accountIds: [1] }, { jobIds: [1], concurrency: 21 },
    { jobIds: [1], concurrency: 1.5 }, { jobIds: [1], startIntervalSeconds: -1 },
    { jobIds: [1], startIntervalSeconds: "2" }, { jobIds: [1], successTags: [] },
    { jobIds: [1], successTags: { invalid: {} } },
  ])("rejects malformed batches %j", (input) => {
    expect(() => createQueue().enqueue(input)).toThrow();
  });

  it("rejects unsafe tag names and non-finite values", () => {
    expect(() => validateSuccessTags(JSON.parse('{"__proto__":true}'))).toThrow();
    expect(() => validateSuccessTags({ empty: Number.NaN })).toThrow();
    expect(() => validateSuccessTags({ " padded ": true })).toThrow();
  });
});

describe("task batch HTTP routes", () => {
  it("returns actual HTTP validation, status, and control responses", async () => {
    vi.useRealTimers();
    const queue = createQueue();
    const app = express();
    app.use(express.json());
    app.use("/api/task-queue", createTaskQueueRouter(queue));
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test listener");
    const base = `http://127.0.0.1:${address.port}/api/task-queue`;
    const post = (url: string, body: unknown = {}) => fetch(`${base}${url}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await post("", { jobIds: [] })).status).toBe(400);
    const created = await post("", { jobIds: [1, 2] });
    expect(created.status).toBe(202);
    const { batchId } = await created.json() as { batchId: string };
    const listed = await (await fetch(base)).json() as { batches: unknown[] };
    expect(listed.batches).toHaveLength(1);
    expect((await post(`/${batchId}/pause`)).status).toBe(200);
    expect(await (await fetch(`${base}/${batchId}`)).json()).toMatchObject({ state: "paused", pending: 2 });
    expect((await post(`/${batchId}/cancel`)).status).toBe(200);
    expect((await post(`/${batchId}/retry-failed`)).status).toBe(409);
    expect((await fetch(`${base}/unknown`)).status).toBe(404);
    expect((await post("/unknown/pause")).status).toBe(404);
  });
});
