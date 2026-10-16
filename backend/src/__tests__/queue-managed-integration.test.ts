import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { managedDb, insertManagedJob, setSetting } from "./helpers/managedDb";

const mocks = vi.hoisted(() => ({ runJob: vi.fn() }));
let testDb: Database.Database;
vi.mock("../db/database", () => ({
  get db() { return testDb; }, getDefaultTgApiCredentials: () => null,
}));
vi.mock("../jobs/runner", () => ({ runJob: mocks.runJob }));
vi.mock("../jobs/embywatch", () => ({ testEmbyConnection: vi.fn() }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: vi.fn(), buildSuccessMessage: () => "Success", buildFailureMessage: () => "Failed",
}));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));
import router from "../routes/jobs";
import { executeManagedJob, getExecutionStatus, cancelManagedJob } from "../jobs/execution";
import { TaskQueue } from "../jobs/taskQueue";
import { applyBatchSuccessTags } from "../jobs/taskQueueRuntime";

let queue: TaskQueue;
let releases: Array<() => void>;
async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function manual(id: string | number) {
  const handle = (router as any).stack.find((layer: any) => layer.route?.path === "/:id/run").route.stack[0].handle;
  const response: any = { statusCode: 200 };
  response.status = (status: number) => { response.statusCode = status; return response; };
  response.json = (body: unknown) => { response.body = body; return response; };
  await handle({ params: { id: String(id) } }, response);
  return response;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-15T00:00:00Z");
  testDb = managedDb();
  testDb.exec("ALTER TABLE tg_accounts ADD COLUMN additional_attributes TEXT");
  setSetting(testDb, "max_concurrent_jobs", "1");
  releases = [];
  mocks.runJob.mockReset();
  mocks.runJob.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));
  queue = new TaskQueue(testDb, executeManagedJob, {
    applySuccessTags: applyBatchSuccessTags,
    isJobActive: (jobId) => {
      const status = getExecutionStatus();
      return [...status.running, ...status.queued].some((entry) => entry.jobId === jobId);
    },
    hasCapacity: (accountId, exclusiveAccount) => {
      const status = getExecutionStatus();
      return status.running.length < status.maxConcurrent &&
        (accountId == null || !status.running.some((entry) =>
          entry.accountId === accountId && (exclusiveAccount || entry.exclusiveAccount)));
    },
  });
});
afterEach(async () => {
  queue.stop();
  for (const entry of [...getExecutionStatus().running, ...getExecutionStatus().queued]) cancelManagedJob(entry.jobId);
  for (let i = 0; i < 5; i++) {
    releases.forEach((release) => release());
    await tick();
  }
  expect(getExecutionStatus()).toMatchObject({ running: [], queued: [] });
  testDb.close();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("manual, durable queue and managed executor integration", () => {
  it("rejects a same-account manual trigger while an exclusive job runs", async () => {
    setSetting(testDb, "max_concurrent_jobs", "2");
    const accountId = Number(testDb.prepare(
      "INSERT INTO tg_accounts(name, session_string) VALUES ('Shared', 'session')",
    ).run().lastInsertRowid);
    const first = insertManagedJob(testDb, "First shared");
    const second = insertManagedJob(testDb, "Second shared");
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id IN (?, ?)").run(accountId, first, second);
    testDb.prepare("UPDATE jobs SET exclusive_account = 1 WHERE id IN (?, ?)").run(first, second);

    expect(await manual(first)).toMatchObject({
      statusCode: 200, body: { state: "running", logId: expect.any(Number) },
    });
    expect(await manual(second)).toMatchObject({ statusCode: 409 });
    expect(mocks.runJob).toHaveBeenCalledOnce();
    releases[0]();
    await tick();
    expect(mocks.runJob).toHaveBeenCalledOnce();
  });

  it("keeps the account mutex across a manual run and durable batch items", async () => {
    setSetting(testDb, "max_concurrent_jobs", "2");
    const accountA = Number(testDb.prepare(
      "INSERT INTO tg_accounts(name, session_string) VALUES ('Account A', 'a')",
    ).run().lastInsertRowid);
    const accountB = Number(testDb.prepare(
      "INSERT INTO tg_accounts(name, session_string) VALUES ('Account B', 'b')",
    ).run().lastInsertRowid);
    const first = insertManagedJob(testDb, "Manual A");
    const second = insertManagedJob(testDb, "Batch A");
    const independent = insertManagedJob(testDb, "Batch B");
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id IN (?, ?)").run(accountA, first, second);
    testDb.prepare("UPDATE jobs SET exclusive_account = 1 WHERE id IN (?, ?)").run(first, second);
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id = ?").run(accountB, independent);

    const manualRun = executeManagedJob(first, { source: "manual" });
    const batch = queue.enqueue({ jobIds: [second, independent], concurrency: 2 });
    queue.start();
    await tick(1200);

    expect(mocks.runJob.mock.calls.map(([job]) => job.id)).toEqual([first, independent]);
    expect(queue.get(batch.batchId)).toMatchObject({ running: 1, pending: 1 });
    expect(getExecutionStatus().queued).toHaveLength(0);

    releases[1]();
    await tick();
    expect(queue.get(batch.batchId)).toMatchObject({ running: 0, pending: 1, done: 1 });
    releases[0]();
    expect((await manualRun).status).toBe("success");
    await tick(1000);
    expect(mocks.runJob.mock.calls.map(([job]) => job.id)).toEqual([first, independent, second]);
    releases[2]();
    await tick();
    expect(queue.get(batch.batchId)).toMatchObject({ done: 2, state: "completed" });
  });

  it("returns nullable log IDs for queued manual work and prevents both kinds of duplicate", async () => {
    const a = insertManagedJob(testDb, "A");
    const b = insertManagedJob(testDb, "B");
    expect(await manual(a)).toMatchObject({ statusCode: 200, body: { state: "running", logId: expect.any(Number) } });
    expect(await manual(b)).toMatchObject({ statusCode: 200, body: { state: "queued", logId: null } });
    expect(await manual(a)).toMatchObject({ statusCode: 409 });
    expect(await manual(b)).toMatchObject({ statusCode: 409 });
    expect(queue.enqueue({ jobIds: [a, b] })).toMatchObject({ queued: 0, skipped: 2 });
    expect(mocks.runJob).toHaveBeenCalledOnce();
    releases[0]();
    await tick();
    expect(mocks.runJob).toHaveBeenCalledTimes(2);
    expect(testDb.prepare("SELECT source FROM job_logs WHERE job_id = ?").get(b)).toEqual({ source: "manual" });
  });

  it("does not run a persistent pending batch again through a manual or scheduler entry", async () => {
    const id = insertManagedJob(testDb);
    const batch = queue.enqueue({ jobIds: [id] });
    expect(await manual(id)).toMatchObject({ statusCode: 409, body: { logId: null } });
    expect(await executeManagedJob(id, { source: "scheduler" })).toMatchObject({ status: "skipped", logId: null });
    expect(mocks.runJob).not.toHaveBeenCalled();
    queue.start();
    await tick(1);
    expect(mocks.runJob).toHaveBeenCalledOnce();
    releases[0]();
    await tick(1);
    expect(queue.get(batch.batchId)).toMatchObject({ done: 1, state: "completed" });
  });

  it("shares capacity with manual runs and holds the cancelled batch slot until cleanup finishes", async () => {
    const a = insertManagedJob(testDb, "Manual");
    const b = insertManagedJob(testDb, "Batch one");
    const c = insertManagedJob(testDb, "Batch two");
    await manual(a);
    const batch = queue.enqueue({ jobIds: [b, c], concurrency: 20 });
    queue.start();
    await tick(100);
    expect(mocks.runJob).toHaveBeenCalledOnce();
    releases[0]();
    await tick(1100);
    expect(mocks.runJob).toHaveBeenCalledTimes(2);
    expect(testDb.prepare("SELECT source FROM job_logs WHERE job_id = ?").get(b)).toEqual({ source: "batch" });
    queue.control(batch.batchId, "cancel");
    await tick(1000);
    expect(getExecutionStatus().running).toHaveLength(1);
    expect(queue.get(batch.batchId)).toMatchObject({ running: 1, state: "cancelled" });
    expect(mocks.runJob).toHaveBeenCalledTimes(2);
    releases[1]();
    await tick(1);
    expect(getExecutionStatus().running).toHaveLength(0);
    expect(queue.get(batch.batchId)).toMatchObject({ running: 0, done: 2, state: "cancelled" });
  });

  it("merges success tags without deleting empty/null/false values or other account attributes", async () => {
    const accountId = Number(testDb.prepare("INSERT INTO tg_accounts(additional_attributes) VALUES (?)")
      .run(JSON.stringify({ note: "keep", tags: { old: "keep" } })).lastInsertRowid);
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id = ?").run(accountId, id);
    const batch = queue.enqueue({ jobIds: [id], successTags: { empty: "", marker: null, flag: false, count: 0 } });
    queue.start();
    await tick(1);
    releases[0]();
    await tick(1);
    expect(queue.get(batch.batchId)).toMatchObject({ state: "completed", done: 1 });
    const attributes = testDb.prepare("SELECT additional_attributes FROM tg_accounts WHERE id = ?").get(accountId) as any;
    expect(JSON.parse(attributes.additional_attributes)).toEqual({
      note: "keep", tags: { old: "keep", empty: "", marker: null, flag: false, count: 0 },
    });
  });

  it("applies success tags to the account currently linked when a queued job is reassigned", async () => {
    const oldAccountId = Number(testDb.prepare("INSERT INTO tg_accounts(additional_attributes) VALUES (?)")
      .run(JSON.stringify({ tags: { old: true } })).lastInsertRowid);
    const newAccountId = Number(testDb.prepare("INSERT INTO tg_accounts(additional_attributes) VALUES (?)")
      .run(JSON.stringify({ tags: { new: true } })).lastInsertRowid);
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id = ?").run(oldAccountId, id);
    const batch = queue.enqueue({ jobIds: [id], successTags: { completed: true } });
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id = ?").run(newAccountId, id);
    queue.start();
    await tick(1);
    expect(testDb.prepare("SELECT account_id FROM task_queue_items WHERE batch_id = ?")
      .get(batch.batchId)).toEqual({ account_id: newAccountId });
    releases[0]();
    await tick(1);

    expect(queue.get(batch.batchId)).toMatchObject({ state: "completed", done: 1 });
    expect(JSON.parse((testDb.prepare("SELECT additional_attributes FROM tg_accounts WHERE id = ?")
      .get(oldAccountId) as any).additional_attributes)).toEqual({ tags: { old: true } });
    expect(JSON.parse((testDb.prepare("SELECT additional_attributes FROM tg_accounts WHERE id = ?")
      .get(newAccountId) as any).additional_attributes)).toEqual({ tags: { new: true, completed: true } });
  });

  it("rolls back a tag-limit error and does not turn a completed action into a retry", async () => {
    const tags = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`tag${i}`, true]));
    const previous = JSON.stringify({ tags });
    const accountId = Number(testDb.prepare("INSERT INTO tg_accounts(additional_attributes) VALUES (?)").run(previous).lastInsertRowid);
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id = ?").run(accountId, id);
    const batch = queue.enqueue({ jobIds: [id], successTags: { extra: true } });
    queue.start();
    await tick(1);
    releases[0]();
    await tick(1);
    const completed = queue.get(batch.batchId)!;
    expect(completed.items![0]).toMatchObject({ status: "success", error: expect.stringContaining("Post-processing failed") });
    expect(testDb.prepare("SELECT additional_attributes FROM tg_accounts WHERE id = ?").get(accountId))
      .toEqual({ additional_attributes: previous });
    queue.control(batch.batchId, "retry-failed");
    await tick(1000);
    expect(mocks.runJob).toHaveBeenCalledOnce();
  });

  it("refuses invalid, retired, disabled and unauthenticated manual targets before running", async () => {
    expect(await manual("invalid")).toMatchObject({ statusCode: 400 });
    expect(await manual(999)).toMatchObject({ statusCode: 404 });
    const retired = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET retired = '2026-10-15' WHERE id = ?").run(retired);
    expect(await manual(retired)).toMatchObject({ statusCode: 404 });
    const account = Number(testDb.prepare("INSERT INTO tg_accounts(disabled) VALUES (1)").run().lastInsertRowid);
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET job_type = 'checkin', account_id = ? WHERE id = ?").run(account, id);
    expect(await manual(id)).toMatchObject({ statusCode: 400, body: { error: "Account is disabled" } });
    testDb.prepare("UPDATE tg_accounts SET disabled = 0, auth_status = 'session_expired' WHERE id = ?").run(account);
    expect(await manual(id)).toMatchObject({ statusCode: 400, body: { error: "Account is not authenticated" } });
    expect(mocks.runJob).not.toHaveBeenCalled();
  });
});
