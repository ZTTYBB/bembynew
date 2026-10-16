let testDb!: InstanceType<typeof Database>;
let releaseRun: Array<() => void> = [];

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));
// Each runJob call blocks until its release function is invoked
vi.mock("../jobs/runner", () => ({
  runJob: vi.fn(
    () => new Promise<void>((resolve) => releaseRun.push(resolve)),
  ),
}));
vi.mock("../jobs/cancellation", () => ({
  cancelJob: vi.fn(),
  registerJob: vi.fn().mockReturnValue(new AbortController().signal),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock("../jobs/notify", () => ({
  getNotifyConfig: vi.fn().mockReturnValue({ events: [], username: null }),
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildSuccessMessage: vi.fn(),
  buildFailureMessage: vi.fn(),
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { executeJob, stopScheduler } from "../scheduler";
import { managedDb } from "./helpers/managedDb";
import { runJob } from "../jobs/runner";
import type { Job } from "../types";

function insertJob(): Job {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO jobs (job_type, account_id) VALUES ('embywatch', NULL)")
    .run();
  return { id: Number(lastInsertRowid) } as Job;
}

// Drain the microtask queue so pending awaits settle without advancing timers
async function drain() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeAll(() => {
  testDb = managedDb();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-06-15T08:00:00Z"));
  releaseRun = [];
  vi.mocked(runJob).mockClear();
  testDb.exec("DELETE FROM job_logs; DELETE FROM jobs;");
});

afterEach(() => {
  stopScheduler();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("job execution concurrency cap", () => {
  it("runs at most 2 jobs at once and queues the rest", async () => {
    const [j1, j2, j3] = [insertJob(), insertJob(), insertJob()];

    const p1 = executeJob(j1, null);
    const p2 = executeJob(j2, null);
    const p3 = executeJob(j3, null);
    await drain();

    // Third job waits for a free slot
    expect(runJob).toHaveBeenCalledTimes(2);

    releaseRun[0]();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(3);

    releaseRun[1]();
    releaseRun[2]();
    await drain();
    await Promise.all([p1, p2, p3]);

    const statuses = testDb
      .prepare("SELECT status FROM job_logs ORDER BY id")
      .all() as Array<{ status: string }>;
    expect(statuses).toHaveLength(3);
    expect(statuses.every((s) => s.status === "success")).toBe(true);
  });

  it("does not create the run log until a slot is acquired", async () => {
    const [j1, j2, j3] = [insertJob(), insertJob(), insertJob()];

    const runs = [executeJob(j1, null), executeJob(j2, null), executeJob(j3, null)];
    await drain();

    // Only the two running jobs have log rows; the queued one has none yet
    const count = testDb
      .prepare("SELECT COUNT(*) AS n FROM job_logs")
      .get() as { n: number };
    expect(count.n).toBe(2);

    releaseRun.forEach((release) => release());
    await drain();
    releaseRun.forEach((release) => release()); // release the late starter too
    await drain();
    await Promise.all(runs);
  });

  it("frees the slot when a job fails", async () => {
    const [j1, j2, j3] = [insertJob(), insertJob(), insertJob()];
    vi.mocked(runJob).mockRejectedValueOnce(new Error("boom"));

    const p1 = executeJob(j1, null);
    await drain();
    const p2 = executeJob(j2, null);
    const p3 = executeJob(j3, null);
    await drain();

    // j1 failed immediately, so its slot was released and all three have run
    expect(runJob).toHaveBeenCalledTimes(3);

    releaseRun.forEach((release) => release());
    await drain();
    await Promise.all([p1, p2, p3]);
  });
});
