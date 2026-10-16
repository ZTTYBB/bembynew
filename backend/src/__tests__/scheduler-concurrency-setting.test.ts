let testDb!: InstanceType<typeof Database>;
let releaseRun: Array<() => void> = [];

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));
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
import { executeJob, getMaxConcurrentJobs, refreshRunSlots, stopScheduler } from "../scheduler";
import { managedDb } from "./helpers/managedDb";
import { runJob } from "../jobs/runner";
import type { Job } from "../types";

function insertJob(): Job {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO jobs (job_type, account_id) VALUES ('embywatch', NULL)")
    .run();
  return { id: Number(lastInsertRowid) } as Job;
}

function setLimit(value: string | null) {
  testDb.prepare("DELETE FROM settings WHERE key = 'max_concurrent_jobs'").run();
  if (value !== null) {
    testDb
      .prepare("INSERT INTO settings (key, value) VALUES ('max_concurrent_jobs', ?)")
      .run(value);
  }
}

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
  testDb.exec("DELETE FROM job_logs; DELETE FROM jobs; DELETE FROM settings;");
});

afterEach(() => {
  stopScheduler();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("getMaxConcurrentJobs", () => {
  it("defaults to 2 when the setting is absent", () => {
    setLimit(null);
    expect(getMaxConcurrentJobs()).toBe(2);
  });

  it("defaults to 2 for an empty or non-numeric value", () => {
    setLimit("");
    expect(getMaxConcurrentJobs()).toBe(2);
    setLimit("abc");
    expect(getMaxConcurrentJobs()).toBe(2);
  });

  it("reads the configured value", () => {
    setLimit("5");
    expect(getMaxConcurrentJobs()).toBe(5);
  });

  it("clamps to at least 1", () => {
    setLimit("0");
    expect(getMaxConcurrentJobs()).toBe(1);
    setLimit("-3");
    expect(getMaxConcurrentJobs()).toBe(1);
  });

  it("clamps to the ceiling so a typo cannot open the floodgates", () => {
    setLimit("9999");
    expect(getMaxConcurrentJobs()).toBe(20);
  });
});

describe("the configured cap actually gates execution", () => {
  it("runs only one job at a time when the limit is 1", async () => {
    setLimit("1");
    const [j1, j2] = [insertJob(), insertJob()];

    const p1 = executeJob(j1, null);
    const p2 = executeJob(j2, null);
    await drain();

    expect(runJob).toHaveBeenCalledTimes(1);

    releaseRun[0]();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(2);

    releaseRun[1]();
    await drain();
    await Promise.all([p1, p2]);
  });

  it("runs three at a time when the limit is raised to 3", async () => {
    setLimit("3");
    const jobs = [insertJob(), insertJob(), insertJob(), insertJob()];

    const runs = jobs.map((j) => executeJob(j, null));
    await drain();

    expect(runJob).toHaveBeenCalledTimes(3);

    releaseRun.forEach((release) => release());
    await drain();
    releaseRun.forEach((release) => release()); // release the late starter
    await drain();
    await Promise.all(runs);
  });

  it("does not exceed a lowered limit while draining the existing queue", async () => {
    setLimit("2");
    const jobs = [insertJob(), insertJob(), insertJob(), insertJob()];
    const runs = jobs.map((j) => executeJob(j, null));
    await drain();

    expect(runJob).toHaveBeenCalledTimes(2);

    // Lowering the cap while two jobs are in flight must not let their queued
    // successors overlap after the first slot becomes available.
    setLimit("1");
    releaseRun[0]();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(2);

    releaseRun[1]();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(3);

    releaseRun[2]();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(4);

    releaseRun[3]();
    await drain();
    await Promise.all(runs);
  });

  it("starts existing waiters immediately when the limit is raised", async () => {
    setLimit("1");
    const jobs = [insertJob(), insertJob(), insertJob()];
    const runs = jobs.map((j) => executeJob(j, null));
    await drain();
    expect(runJob).toHaveBeenCalledTimes(1);

    setLimit("3");
    refreshRunSlots();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(3);

    releaseRun.forEach((release) => release());
    await drain();
    await Promise.all(runs);
  });
});
