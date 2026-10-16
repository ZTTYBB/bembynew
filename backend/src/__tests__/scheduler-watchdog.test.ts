let testDb!: InstanceType<typeof Database>;
let releaseRun: Array<() => void> = [];

// Read at module load by scheduler.ts, so it has to be set before the imports run.
const WATCHDOG_MS = 60_000;
vi.hoisted(() => {
  process.env.JOB_WATCHDOG_MS = "60000";
});

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));
// Each runJob call blocks until its release function is invoked -- a stand-in for
// a Telegram call that never comes back.
vi.mock("../jobs/runner", () => ({
  runJob: vi.fn(
    () => new Promise<void>((resolve) => releaseRun.push(resolve)),
  ),
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
import { getLiveDetail, isJobRunning } from "../jobs/cancellation";
import type { Job } from "../types";

function insertJob(): Job {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO jobs (job_type, account_id) VALUES ('embywatch', NULL)")
    .run();
  return { id: Number(lastInsertRowid) } as Job;
}

function insertCustomWatchJob(actionType: "watch_buttons" | "watch_codes"): Job {
  const config = JSON.stringify({
    actions: [{
      type: actionType,
      maxWaitMs: 120_000,
    }],
  });
  const { lastInsertRowid: accountId } = testDb.prepare(
    `INSERT INTO tg_accounts
      (name, phone_number, api_id, api_hash, session_string, auth_status)
     VALUES ('watch-account', '+10000000000', 1, 'hash', 'session', 'authenticated')`,
  ).run();
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO jobs (job_type, account_id, config) VALUES ('custom', ?, ?)")
    .run(accountId, config);
  return { id: Number(lastInsertRowid) } as Job;
}

function runLog(jobId: number) {
  return testDb
    .prepare("SELECT id, status, message FROM job_logs WHERE job_id = ? ORDER BY id DESC")
    .get(jobId) as { id: number; status: string; message: string };
}

async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
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

describe("job watchdog", () => {
  it("reports timeout and aborts without unregistering an unsettled run", async () => {
    const job = insertJob();
    const running = executeJob(job, null);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await drain();

    const logId = runLog(job.id).id;
    const signal = vi.mocked(runJob).mock.calls[0][3]!;
    expect(signal.aborted).toBe(false);
    expect(isJobRunning(logId)).toBe(true);
    expect(getLiveDetail(logId)).toBeDefined();

    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1);
    await drain();

    expect(signal.aborted).toBe(true);
    expect(runLog(job.id).status).toBe("failed");
    expect(runLog(job.id).message).toContain("Watchdog");
    expect(settled).toBe(false);
    expect(isJobRunning(logId)).toBe(true);
    expect(getLiveDetail(logId)).toBeDefined();

    releaseRun[0]();
    await running;
    expect(settled).toBe(true);
    expect(isJobRunning(logId)).toBe(false);
    expect(getLiveDetail(logId)).toBeUndefined();
    expect(runLog(job.id).status).toBe("failed");
    expect(runLog(job.id).message).toContain("Watchdog");
  });

  it("keeps timed-out runs in the concurrency cap until they settle", async () => {
    const [j1, j2, j3] = [insertJob(), insertJob(), insertJob()];
    const p1 = executeJob(j1, null);
    const p2 = executeJob(j2, null);
    const p3 = executeJob(j3, null);
    await drain();
    expect(runJob).toHaveBeenCalledTimes(2);
    const log1 = runLog(j1.id).id;
    const log2 = runLog(j2.id).id;

    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1);
    await drain();

    expect(runJob).toHaveBeenCalledTimes(2);
    expect(isJobRunning(log1)).toBe(true);
    expect(isJobRunning(log2)).toBe(true);
    expect(vi.mocked(runJob).mock.calls[0][3]!.aborted).toBe(true);
    expect(vi.mocked(runJob).mock.calls[1][3]!.aborted).toBe(true);

    releaseRun[0]();
    await drain();
    expect(runJob).toHaveBeenCalledTimes(3);
    expect(isJobRunning(log1)).toBe(false);
    expect(isJobRunning(log2)).toBe(true);
    expect(isJobRunning(runLog(j3.id).id)).toBe(true);

    releaseRun[1]();
    releaseRun[2]();
    await Promise.all([p1, p2, p3]);
    expect(runLog(j1.id).status).toBe("failed");
    expect(runLog(j2.id).status).toBe("failed");
    expect(runLog(j3.id).status).toBe("success");
  });

  it("leaves a run that finishes before the deadline alone", async () => {
    const job = insertJob();
    const running = executeJob(job, null);
    await drain();
    const logId = runLog(job.id).id;
    const signal = vi.mocked(runJob).mock.calls[0][3]!;

    releaseRun[0]();
    await running;
    expect(runLog(job.id).status).toBe("success");
    expect(isJobRunning(logId)).toBe(false);

    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1);
    expect(signal.aborted).toBe(false);
    expect(runLog(job.id).status).toBe("success");
  });

  it("releases a timed-out run after its cooperative cancellation cleanup", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    vi.mocked(runJob).mockImplementationOnce(async (_job, _account, _logs, signal) => {
      try {
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new Error("Job cancelled")), {
            once: true,
          });
        });
      } finally {
        await cleanup;
      }
    });
    const job = insertJob();
    const running = executeJob(job, null);
    await drain();
    const logId = runLog(job.id).id;

    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1);
    await drain();
    expect(runLog(job.id).status).toBe("failed");
    expect(runLog(job.id).message).toContain("Watchdog");
    expect(isJobRunning(logId)).toBe(true);

    finishCleanup();
    await running;
    expect(isJobRunning(logId)).toBe(false);
    expect(runLog(job.id).message).toContain("Watchdog");
  });

  it("extends the watchdog for long-running watch_codes actions", async () => {
    const job = insertCustomWatchJob("watch_codes");
    const running = executeJob(job, null);
    await drain();
    const logId = runLog(job.id).id;

    // The global watchdog is one minute; a watch_codes action asks for two minutes,
    // plus the one-minute cleanup allowance.
    await vi.advanceTimersByTimeAsync(60_001);
    await drain();
    expect(runLog(job.id).status).toBe("running");
    expect(isJobRunning(logId)).toBe(true);

    await vi.advanceTimersByTimeAsync(120_001);
    await drain();
    expect(runLog(job.id).status).toBe("failed");
    expect(runLog(job.id).message).toContain("Watchdog");

    releaseRun[0]();
    await running;
    expect(isJobRunning(logId)).toBe(false);
  });
});
