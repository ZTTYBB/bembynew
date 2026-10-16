// vi.hoisted defines values before mock factories run, so the same class
// reference is used by both the mock module and runner.ts's instanceof checks.
const { MockCheckinError, MockCustomJobError, MockEmbywatchError } = vi.hoisted(() => {
  class MockCheckinError extends Error {
    log: any;
    constructor(message: string, log: any) {
      super(message);
      this.name = "CheckinError";
      this.log = log;
    }
  }
  class MockCustomJobError extends Error {
    log: any;
    constructor(message: string, log: any) {
      super(message);
      this.name = "CustomJobError";
      this.log = log;
    }
  }
  class MockEmbywatchError extends Error {
    log: any;
    constructor(message: string, proxy: string, sequencePlay: boolean) {
      super(message);
      this.name = "EmbywatchError";
      this.log = { error: message, proxy, ...(sequencePlay ? { sequencePlay: true } : {}) };
    }
  }
  return { MockCheckinError, MockCustomJobError, MockEmbywatchError };
});

vi.mock("../jobs/checkin", () => ({
  runCheckin: vi.fn(),
  CheckinError: MockCheckinError,
}));
vi.mock("../jobs/embywatch", () => ({
  runEmbywatch: vi.fn(),
  EmbywatchError: MockEmbywatchError,
  resolveProxyLabel: vi.fn(() => "direct"),
}));
vi.mock("../jobs/custom", () => ({
  runCustom: vi.fn(),
  CustomJobError: MockCustomJobError,
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runJob, type JobDetailLog } from "../jobs/runner";
import { runCheckin } from "../jobs/checkin";
import { runCustom } from "../jobs/custom";
import { runEmbywatch } from "../jobs/embywatch";
import type { Job, TgAccount } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(jobType: Job["jobType"], retryMax = 1): Job {
  return {
    id: 1,
    name: "Test Job",
    accountId: 1,
    jobType,
    botUsername: "@bot",
    scheduleWindowStart: 1000,
    scheduleWindowEnd: 1200,
    timezone: "UTC",
    replyTimeoutMs: 5000,
    retryMax,
    enabled: true,
    createdAt: "2024-01-01T00:00:00Z",
    config:
      jobType === "embywatch"
        ? JSON.stringify({ username: "u", password: "p" })
        : null,
    startCommand: "/start",
    checkinButton: "签到",
    runEveryDays: 1,
  };
}

function makeAccount(): TgAccount {
  return {
    id: 1,
    name: "Acct",
    phoneNumber: "+1",
    apiId: 1,
    apiHash: "hash",
    sessionString: "session",
    authStatus: "authenticated",
    proxyId: null,
    disabled: false,
    appClientId: null,
    createdAt: "2024-01-01T00:00:00Z",
  };
}

// Minimal checkin attempt log
const stubCheckinLog = {
  attempt: 1,
  commandSent: "/start",
  hasMedia: false,
  commandResponseHtml: "",
  availableButtons: [],
};

// ---------------------------------------------------------------------------
// checkin job
// ---------------------------------------------------------------------------

describe("runJob — checkin", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("records the returned log on success", async () => {
    vi.mocked(runCheckin).mockResolvedValue(stubCheckinLog as any);
    const logs: JobDetailLog[] = [];
    await runJob(makeJob("checkin"), makeAccount(), logs);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe(stubCheckinLog);
  });

  it("extracts and records the log carried on a CheckinError", async () => {
    const errorLog = { ...stubCheckinLog, error: "timeout" };
    vi.mocked(runCheckin).mockRejectedValue(
      new MockCheckinError("timeout", errorLog),
    );
    const logs: JobDetailLog[] = [];
    await expect(runJob(makeJob("checkin"), makeAccount(), logs)).rejects.toThrow(
      "timeout",
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe(errorLog);
  });

  it("collects one log per attempt when retries are exhausted", async () => {
    vi.useFakeTimers();
    vi.mocked(runCheckin).mockRejectedValue(
      new MockCheckinError("fail", { ...stubCheckinLog }),
    );
    const logs: JobDetailLog[] = [];
    const promise = runJob(makeJob("checkin", 3), makeAccount(), logs);
    // Attach rejection handler before timers fire to avoid unhandled rejection warnings
    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    expect(logs).toHaveLength(3);
    expect(vi.mocked(runCheckin)).toHaveBeenCalledTimes(3);
  });

  it("stops retrying and re-throws after the last attempt", async () => {
    vi.useFakeTimers();
    const err = new MockCheckinError("permanent", { ...stubCheckinLog });
    vi.mocked(runCheckin).mockRejectedValue(err);
    const promise = runJob(makeJob("checkin", 2), makeAccount(), []);
    // Attach rejection handler before timers fire to avoid unhandled rejection warnings
    const assertion = expect(promise).rejects.toBe(err);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("throws immediately when no account is linked", async () => {
    const logs: JobDetailLog[] = [];
    await expect(runJob(makeJob("checkin"), null, logs)).rejects.toThrow(
      "No account linked",
    );
    expect(logs).toHaveLength(0);
  });

  it("throws when account has no session string", async () => {
    const acct = { ...makeAccount(), sessionString: "" };
    await expect(runJob(makeJob("checkin"), acct, [])).rejects.toThrow(
      "Account has no session",
    );
  });
});

// ---------------------------------------------------------------------------
// custom job
// ---------------------------------------------------------------------------

describe("runJob — custom", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the returned log on success", async () => {
    const customLog = { steps: [] };
    vi.mocked(runCustom).mockResolvedValue(customLog);
    const logs: JobDetailLog[] = [];
    const job = { ...makeJob("custom"), config: '{"actions":[]}' };
    await runJob(job, makeAccount(), logs);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe(customLog);
    const args = vi.mocked(runCustom).mock.calls[0];
    expect(args[9]).toEqual(expect.objectContaining({ deadlines: expect.any(Map) }));
    expect(args[10]).toBe(1);
  });

  it("extracts and records the log from a CustomJobError", async () => {
    const errorLog = { steps: [{ step: 1, actionType: "send_command", label: "Send: /start", error: "fail" }] };
    vi.mocked(runCustom).mockRejectedValue(
      new MockCustomJobError("fail", errorLog as any),
    );
    const logs: JobDetailLog[] = [];
    const job = { ...makeJob("custom"), config: '{"actions":[]}' };
    await expect(runJob(job, makeAccount(), logs)).rejects.toThrow("fail");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe(errorLog);
  });

  it("throws immediately when no account is linked", async () => {
    const job = { ...makeJob("custom"), config: '{"actions":[]}' };
    await expect(runJob(job, null, [])).rejects.toThrow("No account linked");
  });
});

// ---------------------------------------------------------------------------
// embywatch job
// ---------------------------------------------------------------------------

describe("runJob — embywatch", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("records the returned log on success", async () => {
    const embywatchLog = { played: 1, total: 1, durationMs: 100 };
    vi.mocked(runEmbywatch).mockResolvedValue(embywatchLog as any);
    const logs: JobDetailLog[] = [];
    await runJob(makeJob("embywatch"), makeAccount(), logs);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe(embywatchLog);
  });

  it("throws when the Emby username is missing", async () => {
    const job = { ...makeJob("embywatch"), config: JSON.stringify({ username: "" }) };
    await expect(runJob(job, null, [])).rejects.toThrow(
      "Emby username is required",
    );
    expect(vi.mocked(runEmbywatch)).not.toHaveBeenCalled();
  });

  it("allows an empty Emby password", async () => {
    const embywatchLog = { played: 1, total: 1, durationMs: 100 };
    vi.mocked(runEmbywatch).mockResolvedValue(embywatchLog as any);
    const logs: JobDetailLog[] = [];
    const job = { ...makeJob("embywatch"), config: JSON.stringify({ username: "u", password: "" }) };

    await runJob(job, null, logs);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe(embywatchLog);
    expect(vi.mocked(runEmbywatch)).toHaveBeenCalledWith(
      "@bot",
      { username: "u", password: "" },
      undefined,
    );
  });

  it("records the safe proxy details carried on an Emby failure", async () => {
    const failure = new MockEmbywatchError("Cannot reach Emby server", "Office", false);
    vi.mocked(runEmbywatch).mockRejectedValue(failure);
    const logs: JobDetailLog[] = [];

    await expect(runJob(makeJob("embywatch"), null, logs)).rejects.toBe(failure);

    expect(logs).toEqual([failure.log]);
    expect(logs[0]).toMatchObject({ proxy: "Office", error: "Cannot reach Emby server" });
  });

  it("keeps each failed Emby attempt before the successful retry", async () => {
    vi.useFakeTimers();
    const failure = new MockEmbywatchError("Cannot reach Emby server", "Office", false);
    const success = { itemType: "Movie", title: "Movie", proxy: "Office" } as any;
    vi.mocked(runEmbywatch).mockRejectedValueOnce(failure).mockResolvedValueOnce(success);
    const logs: JobDetailLog[] = [];
    const promise = runJob(makeJob("embywatch", 2), null, logs);
    await vi.runAllTimersAsync();
    await promise;

    expect(logs).toEqual([failure.log, success]);
    expect(vi.mocked(runEmbywatch)).toHaveBeenCalledTimes(2);
  });

  it("records direct proxy details even when legacy credentials are missing", async () => {
    const logs: JobDetailLog[] = [];
    const job = { ...makeJob("embywatch"), config: JSON.stringify({ username: "" }) };

    await expect(runJob(job, null, logs)).rejects.toThrow("Emby username is required");

    expect(logs).toEqual([{ error: "Emby username is required", proxy: "direct" }]);
    expect(vi.mocked(runEmbywatch)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

describe("runJob — general", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws for an unknown job type and does not push any logs", async () => {
    const job = { ...makeJob("checkin"), jobType: "unknown" as any };
    const logs: JobDetailLog[] = [];
    await expect(runJob(job, makeAccount(), logs)).rejects.toThrow(
      "Unknown job type",
    );
    expect(logs).toHaveLength(0);
  });

  it("throws immediately when the abort signal is already set", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runJob(makeJob("checkin"), makeAccount(), [], controller.signal),
    ).rejects.toThrow("Job cancelled");
    expect(vi.mocked(runCheckin)).not.toHaveBeenCalled();
  });
});
