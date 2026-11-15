vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));

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
vi.mock("../tg/client", () => ({
  withAccountClient: vi.fn((_acct: unknown, fn: (c: unknown) => Promise<unknown>) => fn({})),
  destroyClient: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runJob, type JobDetailLog } from "../jobs/runner";
import { runEmbywatch } from "../jobs/embywatch";
import { runCheckin } from "../jobs/checkin";
import type { Job, TgAccount } from "../types";

function makeJob(jobType: Job["jobType"], retryMax: number): Job {
  return {
    id: 35,
    name: "Retry Zero Test",
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
        ? JSON.stringify({ embyUrl: "https://emby.example.com:443", username: "u", password: "" })
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

describe("runJob enforces at least 1 attempt when retryMax < 1", () => {
  beforeEach(() => vi.clearAllMocks());

  it("executes an embywatch job once when retryMax is 0", async () => {
    const ok = { itemType: "Movie", title: "Movie", proxy: "direct" } as any;
    vi.mocked(runEmbywatch).mockResolvedValue(ok);
    const logs: JobDetailLog[] = [];

    await runJob(makeJob("embywatch", 0), null, logs);

    expect(vi.mocked(runEmbywatch)).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([ok]);
  });

  it("throws a real error instead of undefined when retryMax is 0 and attempt fails", async () => {
    const failure = new MockEmbywatchError("Network timeout", "direct", false);
    vi.mocked(runEmbywatch).mockRejectedValue(failure);
    const logs: JobDetailLog[] = [];

    await expect(runJob(makeJob("embywatch", 0), null, logs)).rejects.toThrow("Network timeout");
    expect(vi.mocked(runEmbywatch)).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([failure.log]);
  });

  it("executes a checkin job once when retryMax is -2", async () => {
    vi.mocked(runCheckin).mockResolvedValue({
      attempt: 1,
      commandSent: "/start",
      hasMedia: false,
      commandResponseHtml: "",
      availableButtons: [],
    } as any);
    const logs: JobDetailLog[] = [];

    await runJob(makeJob("checkin", -2), makeAccount(), logs);

    expect(vi.mocked(runCheckin)).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
  });
});
