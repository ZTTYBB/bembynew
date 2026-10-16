import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import express from "express";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { managedDb, insertManagedJob, setSetting } from "./helpers/managedDb";

let testDb: Database.Database;
let server: Server;
let releases: Array<() => void>;
const { runJob } = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../db/database", () => ({
  get db() { return testDb; },
  getDefaultTgApiCredentials: () => null,
  getDefaultTimezone: () => "UTC",
  FALLBACK_TIMEZONE: "UTC",
}));
vi.mock("../jobs/runner", () => ({ runJob }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: vi.fn(),
  buildSuccessMessage: vi.fn(() => "Success"),
  buildFailureMessage: vi.fn(() => "Failed"),
}));
vi.mock("../monitor/memory", () => ({ memoryReport: () => ({ rss: 123 }) }));

import router from "../routes/status";
import { refreshScheduler, stopScheduler } from "../scheduler";
import { JobScheduleStore } from "../db/jobSchedules";
import { executeManagedJob, getExecutionStatus } from "../jobs/execution";

async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1", port: (server.address() as AddressInfo).port,
      path: `/api/status${path}`, method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(text) });
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

beforeEach(async () => {
  testDb = managedDb();
  releases = [];
  vi.clearAllMocks();
  runJob.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));
  const app = express();
  app.use(express.json());
  app.use("/api/status", router);
  server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
});

afterEach(async () => {
  for (let i = 0; i < 5; i++) {
    releases.forEach((release) => release());
    await drain();
  }
  stopScheduler();
  expect(getExecutionStatus().running).toHaveLength(0);
  expect(getExecutionStatus().queued).toHaveLength(0);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  testDb.close();
});

describe("actual managed status HTTP routes", () => {
  it("preserves the bare schedule array and memory route", async () => {
    const id = insertManagedJob(testDb, "Visible job");
    refreshScheduler();
    const response = await request("GET", "/");
    expect(response.status).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({
      jobId: id, jobName: "Visible job", timezone: "UTC", pinned: false,
      state: "pending", revision: 1,
    })]);
    expect((await request("GET", "/memory")).body).toEqual({ rss: 123 });
  });

  it("saves and pins an exact plan, then skips it durably", async () => {
    const id = insertManagedJob(testDb);
    const saved = await request("PUT", `/schedule/${id}`, {
      nextRun: "2099-06-16T01:23:45+09:00", timezone: "Asia/Tokyo",
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      jobId: id, nextRun: "2099-06-15T16:23:45.000Z", timezone: "Asia/Tokyo", origin: "manual",
    });
    const pinned = await request("PUT", `/schedule/${id}/pin`, { pinned: true });
    expect(pinned.status).toBe(200);
    expect(pinned.body.pinned).toBe(true);
    expect(pinned.body.revision).toBe(saved.body.revision + 1);
    const skipped = await request("POST", `/skip/${id}`);
    expect(skipped.status).toBe(200);
    expect(new Date(skipped.body.nextRun).getTime()).toBeGreaterThan(Date.parse(saved.body.nextRun));
    expect(new JobScheduleStore(testDb).get(id)).toMatchObject({ origin: "skip", skippedAt: expect.any(String) });
  });

  it("rejects malformed ids, ambiguous/past times, invalid zones and nonboolean flags", async () => {
    const id = insertManagedJob(testDb);
    for (const body of [
      { nextRun: "2099-06-15T10:00:00" },
      { nextRun: "2020-01-01T10:00:00Z" },
      { nextRun: "2099-06-15T10:00:00Z", timezone: "Not/AZone" },
      { nextRun: "2099-06-15T10:00:00Z", pinned: "yes" },
      ...[0, -1, 1.5, 9007199254740992, "1", null, true].map((expectedRevision) => ({
        nextRun: "2099-06-15T10:00:00Z", expectedRevision,
      })),
      {},
    ]) expect((await request("PUT", `/schedule/${id}`, body)).status).toBe(400);
    expect((await request("PUT", "/schedule/1.5", { nextRun: "2099-01-01T00:00:00Z" })).status).toBe(400);
    expect((await request("PUT", "/schedule/9007199254740992", { nextRun: "2099-01-01T00:00:00Z" })).status).toBe(400);
    expect((await request("PUT", `/schedule/${id}/pin`, { pinned: 1 })).status).toBe(400);
    expect((await request("PUT", "/schedule/9999", { nextRun: "2099-01-01T00:00:00Z" })).status).toBe(404);
  });

  it("saves the expected revision and rejects stale or vanished plans without overwriting", async () => {
    const id = insertManagedJob(testDb);
    refreshScheduler();
    const store = new JobScheduleStore(testDb);
    const original = store.get(id)!;
    const saved = await request("PUT", `/schedule/${id}`, {
      nextRun: "2099-06-15T10:00:00Z", expectedRevision: original.revision,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.revision).toBe(original.revision + 1);
    const current = store.get(id);
    const stale = await request("PUT", `/schedule/${id}`, {
      nextRun: "2099-06-16T10:00:00Z", expectedRevision: original.revision,
    });
    expect(stale).toMatchObject({
      status: 409, body: { error: "Schedule changed or no longer exists; refresh and try again" },
    });
    expect(store.get(id)).toEqual(current);
    store.remove(id);
    const vanished = await request("PUT", `/schedule/${id}`, {
      nextRun: "2099-06-17T10:00:00Z", expectedRevision: saved.body.revision,
    });
    expect(vanished.status).toBe(409);
    expect(store.get(id)).toBeUndefined();
  });

  it("returns conflicts for dispatching and nonpending plans without replacing them", async () => {
    const id = insertManagedJob(testDb);
    const store = new JobScheduleStore(testDb);
    const original = store.save({
      jobId: id, nextRun: "2020-01-01T00:00:00Z", timezone: "UTC", pinned: false,
      origin: "manual", state: "dispatching", scheduleKey: "key", skippedAt: null,
    });
    expect((await request("PUT", `/schedule/${id}`, { nextRun: "2099-01-01T00:00:00Z" })).status).toBe(409);
    expect((await request("PUT", `/schedule/${id}/pin`, { pinned: true })).status).toBe(409);
    expect((await request("POST", `/skip/${id}`)).status).toBe(404);
    expect(store.get(id)).toEqual(original);
  });

  it("lists and cancels queued/running work while preserving active slots until settlement", async () => {
    setSetting(testDb, "max_concurrent_jobs", "1");
    const [a, b] = [insertManagedJob(testDb, "Running"), insertManagedJob(testDb, "Queued")];
    const first = executeManagedJob(a, { source: "manual" });
    const second = executeManagedJob(b, { source: "batch" });
    const state = await request("GET", "/executions");
    expect(state.body.running).toEqual([expect.objectContaining({ jobId: a, jobName: "Running", source: "manual" })]);
    expect(state.body.queued).toEqual([expect.objectContaining({ jobId: b, jobName: "Queued", source: "batch", logId: null })]);
    expect((await request("POST", `/executions/${b}/cancel`)).body).toEqual({ ok: true });
    expect((await second).status).toBe("cancelled");
    expect((await request("POST", `/executions/${a}/cancel`)).status).toBe(200);
    expect(getExecutionStatus().running).toHaveLength(1);
    releases[0]();
    expect((await first).status).toBe("cancelled");
    expect((await request("POST", `/executions/${a}/cancel`)).status).toBe(404);
    expect((await request("POST", "/executions/no/cancel")).status).toBe(400);
    expect(runJob).toHaveBeenCalledOnce();
  });

  it("validates shuffle requests and leaves another local date alone", async () => {
    const id = insertManagedJob(testDb);
    await request("PUT", `/schedule/${id}`, { nextRun: "2099-06-15T10:00:00Z" });
    const before = new JobScheduleStore(testDb).get(id);
    expect((await request("POST", "/shuffle", { date: "2099-06-16" })).body).toEqual({ moved: 0, protected: 0 });
    expect(new JobScheduleStore(testDb).get(id)).toEqual(before);
    expect((await request("POST", "/shuffle", { date: "2099-02-30" })).status).toBe(400);
    expect((await request("POST", "/shuffle", { date: 123 })).status).toBe(400);
    expect((await request("POST", "/shuffle", {})).status).toBe(200);
    expect(new JobScheduleStore(testDb).get(id)?.nextRun.slice(0, 10)).toBe("2099-06-15");
  });
});
