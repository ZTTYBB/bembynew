import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { managedDb, insertManagedJob } from "./helpers/managedDb";

let testDb: Database.Database;
vi.mock("../db/database", () => ({
  get db() { return testDb; },
  getDefaultTgApiCredentials: () => null,
}));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: vi.fn(),
  buildSuccessMessage: vi.fn(() => "Success"),
  buildFailureMessage: vi.fn(() => "Failed"),
}));

import { executeJob, stopScheduler } from "../scheduler";
import { runJob } from "../jobs/runner";
import type { Job } from "../types";

let job: Job;

function log() {
  return testDb.prepare("SELECT * FROM job_logs WHERE job_id = ?").get(job.id) as any;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2024-06-15T08:00:00.000Z");
  testDb = managedDb();
  job = { id: insertManagedJob(testDb) } as Job;
  vi.clearAllMocks();
  vi.mocked(runJob).mockResolvedValue(undefined);
});

afterEach(() => {
  stopScheduler();
  testDb.close();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("executeJob DB status logging", () => {
  it("inserts a scheduler log before executing side effects", async () => {
    vi.mocked(runJob).mockImplementation(async () => {
      expect(log()).toMatchObject({
        job_id: job.id, ran_at: "2024-06-15T08:00:00.000Z", status: "running", source: "scheduler",
      });
    });
    await executeJob(job, null);
    expect(runJob).toHaveBeenCalledOnce();
  });

  it("updates status to success after runJob resolves", async () => {
    await executeJob(job, null);
    expect(log().status).toBe("success");
  });

  it("stores serialized detail logs in the success update", async () => {
    vi.mocked(runJob).mockImplementation(async (_job, _account, details) => {
      details?.push({ attempt: 1, commandSent: "/start" } as any);
    });
    await executeJob(job, null);
    expect(JSON.parse(log().detail)[0]).toMatchObject({ attempt: 1, commandSent: "/start" });
  });

  it("updates status to failed when runJob throws", async () => {
    vi.mocked(runJob).mockRejectedValue(new Error("bot is down"));
    await executeJob(job, null);
    expect(log().status).toBe("failed");
  });

  it("stores the error message in the failed update", async () => {
    vi.mocked(runJob).mockRejectedValue(new Error("connection refused"));
    await executeJob(job, null);
    expect(log()).toMatchObject({ status: "failed", message: "connection refused", detail: null });
  });

  it("marks a cancelled run as Cancelled", async () => {
    vi.mocked(runJob).mockRejectedValue(new Error("Job cancelled"));
    await executeJob(job, null);
    expect(log()).toMatchObject({ status: "failed", message: "Cancelled", detail: null });
  });
});
