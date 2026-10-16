import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { managedDb, insertManagedJob, setSetting } from "./helpers/managedDb";

const { runJob, notifyJobEvent, defaults, originalWatchdog } = vi.hoisted(() => {
  const originalWatchdog = process.env.JOB_WATCHDOG_MS;
  process.env.JOB_WATCHDOG_MS = "1000";
  return { runJob: vi.fn(), notifyJobEvent: vi.fn(), defaults: vi.fn(() => null), originalWatchdog };
});
let testDb: Database.Database;
let releases: Array<() => void> = [];
vi.mock("../db/database", () => ({
  get db() { return testDb; },
  getDefaultTgApiCredentials: defaults,
}));
vi.mock("../jobs/runner", () => ({ runJob }));
vi.mock("../jobs/notify", () => ({
  notifyJobEvent,
  buildSuccessMessage: vi.fn(() => "Success"),
  buildFailureMessage: vi.fn(() => "Failed"),
}));

import {
  executeManagedJob, getExecutionStatus, refreshExecutionSlots, cancelManagedJob,
} from "../jobs/execution";
import { isJobRunning, getLiveDetail } from "../jobs/cancellation";
import { encryptSecret, resetSecretKeyCache } from "../db/secretColumns";

async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function log(jobId: number) {
  return testDb.prepare("SELECT * FROM job_logs WHERE job_id = ? ORDER BY id DESC").get(jobId) as any;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2024-06-15T08:00:00.000Z");
  testDb = managedDb();
  releases = [];
  vi.clearAllMocks();
  defaults.mockReturnValue(null);
  runJob.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));
});

afterEach(async () => {
  for (let i = 0; i < 5; i++) {
    releases.forEach((release) => release());
    await drain();
  }
  expect(getExecutionStatus().running).toHaveLength(0);
  expect(getExecutionStatus().queued).toHaveLength(0);
  testDb.close();
  delete process.env.BEMBY_DATA_KEY;
  resetSecretKeyCache();
  vi.clearAllTimers();
  vi.useRealTimers();
});

afterAll(() => {
  if (originalWatchdog === undefined) delete process.env.JOB_WATCHDOG_MS;
  else process.env.JOB_WATCHDOG_MS = originalWatchdog;
});

describe("managed execution with real SQLite", () => {
  it("serializes different jobs linked to the same account when both opt into exclusivity", async () => {
    setSetting(testDb, "max_concurrent_jobs", "2");
    const accountId = Number(testDb.prepare(
      "INSERT INTO tg_accounts (name, session_string) VALUES ('Shared', 'session')",
    ).run().lastInsertRowid);
    const [firstId, secondId] = [
      insertManagedJob(testDb, "Shared first"),
      insertManagedJob(testDb, "Shared second"),
    ];
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id IN (?, ?)").run(accountId, firstId, secondId);
    testDb.prepare("UPDATE jobs SET exclusive_account = 1 WHERE id IN (?, ?)").run(firstId, secondId);

    const first = executeManagedJob(firstId, { source: "manual" });
    const second = executeManagedJob(secondId, { source: "scheduler" });
    await drain();

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(getExecutionStatus()).toMatchObject({
      running: [expect.objectContaining({ jobId: firstId, accountId })],
      queued: [expect.objectContaining({ jobId: secondId, accountId })],
    });
    releases[0]();
    expect((await first).status).toBe("success");
    await drain();
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(runJob.mock.calls[1][0]).toMatchObject({ id: secondId, accountId });
    releases[1]();
    expect((await second).status).toBe("success");
  });

  it("allows ordinary jobs linked to the same account to run together", async () => {
    setSetting(testDb, "max_concurrent_jobs", "2");
    const accountId = Number(testDb.prepare(
      "INSERT INTO tg_accounts (name, session_string) VALUES ('Shared', 'session')",
    ).run().lastInsertRowid);
    const [firstId, secondId] = [insertManagedJob(testDb, "Ordinary first"), insertManagedJob(testDb, "Ordinary second")];
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id IN (?, ?)").run(accountId, firstId, secondId);
    const first = executeManagedJob(firstId, { source: "manual" });
    const second = executeManagedJob(secondId, { source: "scheduler" });
    await drain();
    expect(runJob).toHaveBeenCalledTimes(2);
    releases.forEach((release) => release());
    await Promise.all([first, second]);
  });

  it("allows different accounts to use available global slots while a same-account waiter is queued", async () => {
    setSetting(testDb, "max_concurrent_jobs", "2");
    const accountA = Number(testDb.prepare(
      "INSERT INTO tg_accounts (name, session_string) VALUES ('Account A', 'a')",
    ).run().lastInsertRowid);
    const accountB = Number(testDb.prepare(
      "INSERT INTO tg_accounts (name, session_string) VALUES ('Account B', 'b')",
    ).run().lastInsertRowid);
    const [firstId, blockedId, independentId] = [
      insertManagedJob(testDb, "A first"),
      insertManagedJob(testDb, "A second"),
      insertManagedJob(testDb, "B first"),
    ];
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id IN (?, ?)").run(accountA, firstId, blockedId);
    testDb.prepare("UPDATE jobs SET exclusive_account = 1 WHERE id = ?").run(firstId);
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id = ?").run(accountB, independentId);

    const first = executeManagedJob(firstId, { source: "manual" });
    testDb.prepare("UPDATE jobs SET exclusive_account = 1 WHERE id = ?").run(blockedId);
    const blocked = executeManagedJob(blockedId, { source: "scheduler" });
    const independent = executeManagedJob(independentId, { source: "scheduler" });
    await drain();

    expect(runJob).toHaveBeenCalledTimes(2);
    expect(runJob.mock.calls.map(([job]) => job.id)).toEqual([firstId, independentId]);
    expect(getExecutionStatus().queued).toEqual([
      expect.objectContaining({ jobId: blockedId, accountId: accountA }),
    ]);
    releases[1]();
    expect((await independent).status).toBe("success");
    releases[0]();
    expect((await first).status).toBe("success");
    await drain();
    expect(runJob).toHaveBeenCalledTimes(3);
    releases[2]();
    expect((await blocked).status).toBe("success");
  });

  it("shares one cap across scheduler, manual, and batch and deduplicates both states", async () => {
    setSetting(testDb, "max_concurrent_jobs", "1");
    const [a, b] = [insertManagedJob(testDb, "A"), insertManagedJob(testDb, "B")];
    const first = executeManagedJob(a, { source: "manual" });
    const second = executeManagedJob(b, { source: "batch" });
    await drain();

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(getExecutionStatus().running[0]).toMatchObject({ jobId: a, source: "manual" });
    expect(getExecutionStatus().queued[0]).toMatchObject({ jobId: b, jobName: "B", source: "batch" });
    expect(await executeManagedJob(a, { source: "scheduler" })).toMatchObject({ status: "skipped", logId: log(a).id });
    expect(await executeManagedJob(b, { source: "manual" })).toMatchObject({ status: "skipped", logId: null });
    releases[0]();
    await first;
    await drain();
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(log(b).source).toBe("batch");
    releases[1]();
    expect((await second).status).toBe("success");
    expect(getExecutionStatus().running).toHaveLength(0);
  });

  it("does not exceed a lowered cap and wakes waiters immediately after raising it", async () => {
    setSetting(testDb, "max_concurrent_jobs", "2");
    const ids = [0, 1, 2, 3].map(() => insertManagedJob(testDb));
    const runs = ids.map((id) => executeManagedJob(id, { source: "scheduler" }));
    await drain();
    expect(runJob).toHaveBeenCalledTimes(2);
    setSetting(testDb, "max_concurrent_jobs", "1");
    releases[0]();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(2);
    setSetting(testDb, "max_concurrent_jobs", "3");
    refreshExecutionSlots();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(4);
    releases.forEach((release) => release());
    await Promise.all(runs);
  });

  it("calls onLogId synchronously after insertion and before executing side effects", async () => {
    const id = insertManagedJob(testDb);
    const onLogId = vi.fn((logId: number) => {
      expect(log(id).id).toBe(logId);
      expect(isJobRunning(logId)).toBe(true);
      expect(runJob).not.toHaveBeenCalled();
    });
    const running = executeManagedJob(id, { source: "manual", onLogId });
    expect(onLogId).toHaveBeenCalledOnce();
    expect(runJob).toHaveBeenCalledOnce();
    releases[0]();
    await running;
    expect(log(id).source).toBe("manual");
    expect(testDb.prepare("SELECT last_success_at FROM jobs WHERE id = ?").get(id))
      .toEqual({ last_success_at: "2024-06-15T08:00:00.000Z" });
    expect(notifyJobEvent).toHaveBeenCalledWith("success", "Success", null);
  });

  it("cancels queued work through its signal without creating a log or executing it", async () => {
    setSetting(testDb, "max_concurrent_jobs", "1");
    const [a, b] = [insertManagedJob(testDb), insertManagedJob(testDb)];
    const first = executeManagedJob(a, { source: "manual" });
    const controller = new AbortController();
    const second = executeManagedJob(b, { source: "batch", signal: controller.signal });
    controller.abort();
    expect(await second).toMatchObject({ status: "cancelled", logId: null });
    expect(log(b)).toBeUndefined();
    expect(getExecutionStatus().queued).toHaveLength(0);
    releases[0]();
    await first;
    expect(runJob).toHaveBeenCalledTimes(1);
  });

  it("does not let a failed log observer prevent the runner", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = insertManagedJob(testDb);
    const running = executeManagedJob(id, {
      source: "manual", onLogId: () => { throw new Error("observer unavailable"); },
    });
    expect(runJob).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("[execution] log observer failed:", expect.any(Error));
    releases[0]();
    expect((await running).status).toBe("success");
    warning.mockRestore();
  });

  it("retains the promise, slot, and registry until a cancelled original run settles", async () => {
    setSetting(testDb, "max_concurrent_jobs", "1");
    const [a, b] = [insertManagedJob(testDb), insertManagedJob(testDb)];
    let settled = false;
    const first = executeManagedJob(a, { source: "manual" }).then((result) => {
      settled = true;
      return result;
    });
    const second = executeManagedJob(b, { source: "batch" });
    const logId = log(a).id;
    expect(cancelManagedJob(a)).toBe(true);
    await drain();
    expect(settled).toBe(false);
    expect(log(a).message).toBe("Cancelled");
    expect(isJobRunning(logId)).toBe(true);
    expect(getLiveDetail(logId)).toBeDefined();
    expect(runJob).toHaveBeenCalledTimes(1);
    releases[0]();
    expect((await first).status).toBe("cancelled");
    await drain();
    expect(isJobRunning(logId)).toBe(false);
    expect(runJob).toHaveBeenCalledTimes(2);
    releases[1]();
    await second;
    expect(notifyJobEvent).not.toHaveBeenCalledWith("failed", expect.anything(), expect.anything());
  });

  it("reports timeout immediately but never frees concurrency before actual settlement", async () => {
    setSetting(testDb, "max_concurrent_jobs", "1");
    const [a, b] = [insertManagedJob(testDb), insertManagedJob(testDb)];
    let settled = false;
    const first = executeManagedJob(a, { source: "scheduler" }).then((result) => {
      settled = true;
      return result;
    });
    const second = executeManagedJob(b, { source: "batch" });
    await vi.advanceTimersByTimeAsync(1001);
    expect(log(a).message).toContain("Watchdog");
    expect(getExecutionStatus().running[0].timedOut).toBe(true);
    expect(isJobRunning(log(a).id)).toBe(true);
    expect(settled).toBe(false);
    expect(runJob).toHaveBeenCalledTimes(1);
    releases[0]();
    expect((await first).status).toBe("failed");
    await drain();
    releases[1]();
    await second;
    expect(log(a).status).toBe("failed");
    expect(log(a).message).toContain("Watchdog");
  });

  it("re-reads the latest job, reassigned account, decrypted credentials and proxy on start", async () => {
    setSetting(testDb, "max_concurrent_jobs", "1");
    process.env.BEMBY_DATA_KEY = "phase2-test-key";
    resetSecretKeyCache();
    const blocker = insertManagedJob(testDb);
    const account = Number(testDb.prepare(`
      INSERT INTO tg_accounts (name, api_id, api_hash, session_string, proxy_id)
      VALUES ('Fresh account', 123, ?, ?, 'new-proxy')
    `).run(encryptSecret("fresh-hash"), encryptSecret("fresh-session")).lastInsertRowid);
    const id = insertManagedJob(testDb, "Old job");
    const first = executeManagedJob(blocker, { source: "manual" });
    const queued = executeManagedJob(id, { source: "batch" });
    testDb.prepare("UPDATE jobs SET name = 'Fresh job', job_type = 'checkin', account_id = ?, config = ? WHERE id = ?")
      .run(account, JSON.stringify({ fresh: true }), id);
    releases[0]();
    await first;
    await drain();
    const args = runJob.mock.calls[1];
    expect(args[0]).toMatchObject({ name: "Fresh job", accountId: account, config: '{"fresh":true}' });
    expect(args[1]).toMatchObject({
      name: "Fresh account", apiId: 123, apiHash: "fresh-hash",
      sessionString: "fresh-session", proxyId: "new-proxy",
    });
    releases[1]();
    await queued;
  });

  it("resolves incomplete own credentials as a complete global pair", async () => {
    defaults.mockReturnValue({ apiId: 456, apiHash: "default-hash" } as never);
    const account = Number(testDb.prepare(`
      INSERT INTO tg_accounts (api_id, api_hash, session_string) VALUES (123, NULL, 'session')
    `).run().lastInsertRowid);
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET job_type = 'checkin', account_id = ? WHERE id = ?").run(account, id);
    const running = executeManagedJob(id, { source: "manual" });
    expect(runJob.mock.calls[0][1]).toMatchObject({ apiId: 456, apiHash: "default-hash" });
    releases[0]();
    await running;
  });

  it("allows explicitly requested disabled jobs but skips scheduled or retired jobs", async () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET enabled = 0 WHERE id = ?").run(id);
    expect((await executeManagedJob(id, { source: "scheduler" })).status).toBe("skipped");
    const manual = executeManagedJob(id, { source: "manual" });
    releases[0]();
    expect((await manual).status).toBe("success");
    testDb.prepare("UPDATE jobs SET retired = '2024-06-15' WHERE id = ?").run(id);
    expect((await executeManagedJob(id, { source: "batch" })).status).toBe("skipped");
    expect(runJob).toHaveBeenCalledTimes(1);
  });

  it("refuses disabled accounts before invoking the runner", async () => {
    const account = Number(testDb.prepare("INSERT INTO tg_accounts (disabled) VALUES (1)").run().lastInsertRowid);
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id = ?").run(account, id);
    expect(await executeManagedJob(id, { source: "manual" })).toMatchObject({
      status: "failed", message: "Account is disabled",
    });
    expect(runJob).not.toHaveBeenCalled();
  });

  it("rejects a stale non-null account id even for jobs that can run accountless", async () => {
    const account = Number(testDb.prepare("INSERT INTO tg_accounts DEFAULT VALUES").run().lastInsertRowid);
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET account_id = ? WHERE id = ?").run(account, id);
    testDb.pragma("foreign_keys = OFF");
    testDb.prepare("DELETE FROM tg_accounts WHERE id = ?").run(account);
    testDb.pragma("foreign_keys = ON");
    expect(await executeManagedJob(id, { source: "batch" })).toMatchObject({
      status: "failed", message: "Linked account no longer exists",
    });
    expect(runJob).not.toHaveBeenCalled();
  });

  it("records failures without manager-level retry or success timestamps", async () => {
    runJob.mockRejectedValueOnce(new Error("effect failed"));
    const id = insertManagedJob(testDb);
    expect(await executeManagedJob(id, { source: "batch" })).toMatchObject({
      status: "failed", message: "effect failed",
    });
    expect(runJob).toHaveBeenCalledOnce();
    expect(log(id)).toMatchObject({ status: "failed", source: "batch" });
    expect(testDb.prepare("SELECT last_success_at FROM jobs WHERE id = ?").get(id))
      .toEqual({ last_success_at: null });
  });

  it("rolls back the success log when stamping a one-time job fails", async () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET run_once = 1 WHERE id = ?").run(id);
    testDb.exec(`
      CREATE TRIGGER reject_success_stamp BEFORE UPDATE OF last_success_at ON jobs
      BEGIN SELECT RAISE(ABORT, 'success stamp unavailable'); END;
    `);
    const running = executeManagedJob(id, { source: "manual" });
    releases[0]();
    expect(await running).toMatchObject({ status: "failed", message: "success stamp unavailable" });
    expect(log(id)).toMatchObject({ status: "failed", message: "success stamp unavailable" });
    expect(testDb.prepare("SELECT enabled, last_success_at FROM jobs WHERE id = ?").get(id))
      .toEqual({ enabled: 1, last_success_at: null });
    expect(notifyJobEvent).not.toHaveBeenCalledWith("success", expect.anything(), expect.anything());
  });

  it("does not stamp or disable a one-time job when the success log write fails", async () => {
    const id = insertManagedJob(testDb);
    testDb.prepare("UPDATE jobs SET run_once = 1 WHERE id = ?").run(id);
    testDb.exec(`
      CREATE TRIGGER reject_success_log BEFORE UPDATE OF status ON job_logs
      WHEN NEW.status = 'success'
      BEGIN SELECT RAISE(ABORT, 'success log unavailable'); END;
    `);
    const running = executeManagedJob(id, { source: "batch" });
    releases[0]();
    expect(await running).toMatchObject({ status: "failed", message: "success log unavailable" });
    expect(log(id)).toMatchObject({ status: "failed", message: "success log unavailable" });
    expect(testDb.prepare("SELECT enabled, last_success_at FROM jobs WHERE id = ?").get(id))
      .toEqual({ enabled: 1, last_success_at: null });
    expect(notifyJobEvent).not.toHaveBeenCalledWith("success", expect.anything(), expect.anything());
  });
});
