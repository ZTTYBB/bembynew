import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { insertManagedJob, managedDb } from "./helpers/managedDb";

let testDb: Database.Database;
vi.mock("../db/database", () => ({
  get db() { return testDb; }, getDefaultTgApiCredentials: () => null,
}));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent: vi.fn(), buildSuccessMessage: () => "Success", buildFailureMessage: () => "Failed",
}));
import { reconcileOrphanedRuns } from "../scheduler";
import { JobRecoveryStore } from "../db/jobRecovery";

beforeEach(() => { testDb = managedDb(); });
afterEach(() => { testDb.close(); });

describe("reconcile orphaned running logs", () => {
  it("marks every leftover running log failed without opting old jobs into replay", () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("INSERT INTO job_logs(job_id, ran_at, status) VALUES (?, ?, 'running')")
      .run(id, "2026-10-14T00:00:00Z");
    reconcileOrphanedRuns();
    expect(testDb.prepare("SELECT status, message FROM job_logs").get()).toMatchObject({
      status: "failed", message: expect.stringContaining("Interrupted by server restart"),
    });
    expect(new JobRecoveryStore(testDb).pending()).toEqual([]);
  });

  it("persists opted-in recovery once and keeps the interrupted log as failed", () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET rerun_on_restart = 1 WHERE id = ?").run(id);
    testDb.prepare("INSERT INTO job_logs(job_id, ran_at, status, source) VALUES (?, ?, 'running', 'manual')")
      .run(id, "2026-10-14T00:00:00Z");
    reconcileOrphanedRuns();
    reconcileOrphanedRuns();
    expect(new JobRecoveryStore(testDb).pending()).toHaveLength(1);
    expect(testDb.prepare("SELECT status FROM job_logs").get()).toEqual({ status: "failed" });
  });
});
