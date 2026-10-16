import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { managedDb, insertManagedJob } from "./helpers/managedDb";
import { getJobOutcome, markJobOutcome } from "../jobs/outcome";

let testDb: Database.Database;
const execution = vi.hoisted(() => ({ running: [] as any[], queued: [] as any[] }));
const reschedule = vi.hoisted(() => vi.fn());
vi.mock("../db/database", () => ({
  get db() { return testDb; }, getDefaultTgApiCredentials: () => null,
}));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn(), rescheduleAfterOutcome: reschedule }));
vi.mock("../jobs/execution", () => ({ executeManagedJob: vi.fn(), getExecutionStatus: () => execution }));
vi.mock("../jobs/embywatch", () => ({ testEmbyConnection: vi.fn() }));
import router from "../routes/jobs";

function addLog(jobId: number, status: string, ranAt = "2026-10-15T10:00:00.000Z") {
  return Number(testDb.prepare(
    "INSERT INTO job_logs(job_id, ran_at, status, message, detail) VALUES (?, ?, ?, 'Original result', '[{\"status\":\"success\"}]')",
  ).run(jobId, ranAt, status).lastInsertRowid);
}
function mark(jobId: number, status: "success" | "failed") {
  return markJobOutcome(testDb, jobId, { status, expectedRevision: getJobOutcome(testDb, jobId).revision });
}
function call(method: "get" | "post", id: string | number, body?: unknown) {
  const handler = (router as any).stack.find((entry: any) =>
    entry.route?.path === "/:id/outcome" && entry.route.methods[method]).route.stack[0].handle;
  const response: any = { statusCode: 200 };
  response.status = (value: number) => { response.statusCode = value; return response; };
  response.json = (value: unknown) => { response.body = value; return response; };
  handler({ params: { id: String(id) }, body }, response);
  return response;
}
beforeEach(() => {
  testDb = managedDb();
  execution.running = [];
  execution.queued = [];
  reschedule.mockReset();
});
afterEach(() => { testDb?.close(); vi.useRealTimers(); });

describe("manual job outcomes", () => {
  it("records a manual completion today without executing any task", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    const id = insertManagedJob(testDb);
    expect(getJobOutcome(testDb, id).latestLog).toBeNull();
    const result = mark(id, "success");
    expect(result).toMatchObject({ created: true, status: "success" });
    expect(testDb.prepare("SELECT status, source, ran_at FROM job_logs").get()).toEqual({
      status: "success", source: "manual", ran_at: "2026-10-15T12:00:00.000Z",
    });
    expect(testDb.prepare("SELECT last_success_at, last_attempt_at FROM jobs").get()).toEqual({
      last_success_at: "2026-10-15T12:00:00.000Z", last_attempt_at: "2026-10-15T12:00:00.000Z",
    });
  });
  it("corrects the latest log, retaining its time, details, source and original verdict in an audit row", () => {
    const id = insertManagedJob(testDb);
    addLog(id, "failed", "2026-10-14T10:00:00.000Z");
    const logId = addLog(id, "failed");
    expect(mark(id, "success")).toEqual({ logId, created: false, status: "success" });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM job_logs").get()).toEqual({ n: 2 });
    expect(testDb.prepare("SELECT ran_at, detail, source FROM job_logs WHERE id = ?").get(logId)).toEqual({
      ran_at: "2026-10-15T10:00:00.000Z", detail: '[{"status":"success"}]', source: "scheduler",
    });
    expect(testDb.prepare("SELECT prior_status, next_status, prior_message FROM job_outcome_changes").get())
      .toEqual({ prior_status: "failed", next_status: "success", prior_message: "Original result" });
  });
  it("disables one-time tasks and enables them again when their only success is reversed", () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET run_once = 1 WHERE id = ?").run(id);
    mark(id, "success");
    expect(testDb.prepare("SELECT enabled FROM jobs").get()).toEqual({ enabled: 0 });
    mark(id, "failed");
    expect(testDb.prepare("SELECT enabled, last_success_at FROM jobs").get()).toEqual({ enabled: 1, last_success_at: null });
  });
  it("keeps a one-time task disabled if an earlier success remains", () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET run_once = 1, enabled = 0, last_success_at = ? WHERE id = ?")
      .run("2026-10-15T10:00:00.000Z", id);
    addLog(id, "success", "2026-10-14T10:00:00.000Z");
    addLog(id, "success");
    mark(id, "failed");
    expect(testDb.prepare("SELECT enabled, last_success_at FROM jobs").get())
      .toEqual({ enabled: 0, last_success_at: "2026-10-14T10:00:00.000Z" });
  });
  it("does not enable a task that was manually disabled and has no success to reverse", () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET run_once = 1, enabled = 0 WHERE id = ?").run(id);
    addLog(id, "failed");
    mark(id, "failed");
    expect(testDb.prepare("SELECT enabled FROM jobs").get()).toEqual({ enabled: 0 });
  });
  it("keeps a durable success even if its log was purged", () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET last_success_at = ? WHERE id = ?").run("2026-10-13T10:00:00.000Z", id);
    addLog(id, "failed");
    mark(id, "failed");
    expect(testDb.prepare("SELECT last_success_at FROM jobs").get())
      .toEqual({ last_success_at: "2026-10-13T10:00:00.000Z" });
  });
  it.each([
    ["2026-10-15T12:00:00.000Z", "2026-10-15T15:00:00+08:00", "2026-10-15T12:00:00.000Z"],
    ["2026-10-15T04:00:00.000Z", "2026-10-15T15:00:00+08:00", "2026-10-15T15:00:00+08:00"],
    ["2026-10-15 12:00:00", "2026-10-15T07:00:00Z", "2026-10-15 12:00:00"],
  ])("does not move the last attempt backwards across timestamp formats: %s / %s", (attempt, ranAt, expected) => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET last_attempt_at = ? WHERE id = ?").run(attempt, id);
    addLog(id, "failed", ranAt);
    mark(id, "failed");
    expect(testDb.prepare("SELECT last_attempt_at FROM jobs").get()).toEqual({ last_attempt_at: expected });
  });
  it("rejects stale previews after a new run or another result correction", () => {
    const id = insertManagedJob(testDb);
    const beforeRun = getJobOutcome(testDb, id).revision;
    addLog(id, "failed");
    expect(() => markJobOutcome(testDb, id, { status: "success", expectedRevision: beforeRun })).toThrow(/changed/);
    const beforeEdit = getJobOutcome(testDb, id).revision;
    mark(id, "success");
    expect(() => markJobOutcome(testDb, id, { status: "failed", expectedRevision: beforeEdit })).toThrow(/changed/);
  });
  it("refuses any running row, even when a newer terminal log exists", () => {
    const id = insertManagedJob(testDb);
    addLog(id, "running", "2026-10-14T10:00:00.000Z");
    addLog(id, "failed");
    expect(() => mark(id, "success")).toThrow(/still running/);
  });
  it("rolls back verdict, audit row and scheduling stamps if completion cannot be saved", () => {
    const id = insertManagedJob(testDb);
    addLog(id, "failed");
    testDb.exec("CREATE TRIGGER refuse_stamp BEFORE UPDATE ON jobs BEGIN SELECT RAISE(FAIL, 'stamp unavailable'); END;");
    expect(() => mark(id, "success")).toThrow("stamp unavailable");
    expect(testDb.prepare("SELECT status, message FROM job_logs").get())
      .toEqual({ status: "failed", message: "Original result" });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM job_outcome_changes").get()).toEqual({ n: 0 });
  });
  it.each([null, 1, "", "not-a-revision"])("requires a valid preview revision %j", (revision) => {
    const id = insertManagedJob(testDb);
    expect(() => markJobOutcome(testDb, id, { status: "success", expectedRevision: revision })).toThrow(/expectedRevision/);
  });
  it("leaves other jobs and preserved plan revision counters alone", () => {
    const id = insertManagedJob(testDb);
    const other = insertManagedJob(testDb, "Other");
    const insert = testDb.prepare(`INSERT INTO job_schedules
      (job_id,next_run,timezone,pinned,state,origin,schedule_key,revision,updated_at)
      VALUES (?,'2030-10-15T12:00:00.000Z','UTC',1,'pending','manual','old',8,'now')`);
    insert.run(id); insert.run(other);
    mark(id, "success");
    expect(testDb.prepare("SELECT pinned, revision, schedule_key FROM job_schedules WHERE job_id = ?").get(id))
      .toEqual({ pinned: 0, revision: 9, schedule_key: "" });
    expect(testDb.prepare("SELECT pinned, revision, schedule_key FROM job_schedules WHERE job_id = ?").get(other))
      .toEqual({ pinned: 1, revision: 8, schedule_key: "old" });
  });
});

describe("job outcome routes", () => {
  it("returns a preview and replans after saving a valid result", () => {
    const id = insertManagedJob(testDb);
    const preview = call("get", id);
    expect(preview.statusCode).toBe(200);
    const response = call("post", id, { status: "success", expectedRevision: preview.body.revision });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ created: true, job: { id, lastSuccessAt: expect.any(String) } });
    expect(reschedule).toHaveBeenCalledTimes(1);
    expect(reschedule).toHaveBeenCalledWith(id);
  });
  it("reports a committed result separately if replanning fails afterwards", () => {
    const id = insertManagedJob(testDb);
    const revision = getJobOutcome(testDb, id).revision;
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      reschedule.mockImplementationOnce(() => { throw new Error("Schedule revision changed"); });
      const response = call("post", id, { status: "success", expectedRevision: revision });
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        created: true, status: "success", scheduleRefreshPending: true,
        job: { id, lastSuccessAt: expect.any(String) },
      });
      expect(testDb.prepare("SELECT status FROM job_logs WHERE job_id = ?").get(id)).toEqual({ status: "success" });
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally { stderr.mockRestore(); }
  });
  it.each(["bad", 0, -1, 1.5])("rejects an invalid job id %j", (id) => {
    expect(call("get", id).statusCode).toBe(400);
    expect(call("post", id, {}).statusCode).toBe(400);
  });
  it("returns 404 for missing and retired jobs", () => {
    expect(call("get", 99).statusCode).toBe(404);
    const id = insertManagedJob(testDb);
    const revision = getJobOutcome(testDb, id).revision;
    testDb.prepare("UPDATE jobs SET retired = 'now' WHERE id = ?").run(id);
    expect(call("post", id, { status: "success", expectedRevision: revision }).statusCode).toBe(404);
  });
  it("blocks running and queued managed jobs before touching their result", () => {
    const id = insertManagedJob(testDb);
    const revision = getJobOutcome(testDb, id).revision;
    execution.queued.push({ jobId: id });
    expect(call("post", id, { status: "success", expectedRevision: revision }).statusCode).toBe(409);
    expect(reschedule).not.toHaveBeenCalled();
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM job_logs").get()).toEqual({ n: 0 });
  });
  it("blocks pending persistent batch jobs", () => {
    const id = insertManagedJob(testDb);
    const preview = call("get", id);
    call("post", id, { status: "wrong", expectedRevision: preview.body.revision });
    testDb.prepare(`INSERT INTO task_batches(id,state,concurrency,start_interval_ms,success_tags,created_at,updated_at)
      VALUES ('batch','running',1,0,'{}','now','now')`).run();
    testDb.prepare("INSERT INTO task_queue_items(batch_id,job_id,job_name) VALUES ('batch',?,'Job')").run(id);
    expect(call("post", id, { status: "success", expectedRevision: preview.body.revision }).statusCode).toBe(409);
  });
});
