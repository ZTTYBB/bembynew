import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryGet, runEmbywatch } = vi.hoisted(() => ({
  queryGet: vi.fn(),
  runEmbywatch: vi.fn(),
}));

vi.mock("../db/database", () => ({
  db: { prepare: vi.fn(() => ({ get: queryGet })) },
}));
vi.mock("../jobs/checkin", () => ({
  runCheckin: vi.fn(),
  CheckinError: class extends Error {},
}));
vi.mock("../jobs/embywatch", () => ({
  runEmbywatch,
  EmbywatchError: class extends Error {},
  resolveProxyLabel: vi.fn(() => "direct"),
}));
vi.mock("../jobs/custom", () => ({
  runCustom: vi.fn(),
  CustomJobError: class extends Error {},
}));
vi.mock("../jobs/autoreg", () => ({
  runAutoreg: vi.fn(),
  AutoregJobError: class extends Error {},
}));
vi.mock("../jobs/cloudflare", () => ({ newCfRunState: vi.fn(() => ({})) }));
vi.mock("../tg/appClient", () => ({ resolveAppClientParams: vi.fn() }));

import { runJob } from "../jobs/runner";
import { EMBY_TEMPLATE_META_KEY } from "../jobs/embyTemplate";
import type { Job } from "../types";

function job(config: Record<string, unknown>, linked = true): Job {
  return {
    id: 1,
    name: "Emby job",
    accountId: null,
    jobType: "embywatch",
    botUsername: "https://emby.example.com",
    scheduleWindowStart: 1000,
    scheduleWindowEnd: 1200,
    timezone: "UTC",
    replyTimeoutMs: 40000,
    retryMax: 1,
    enabled: true,
    createdAt: "2024-01-01T00:00:00Z",
    config: JSON.stringify(config),
    startCommand: "/start",
    checkinButton: "checkin",
    templateId: linked ? 1 : null,
    runEveryDays: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runEmbywatch.mockResolvedValue({ played: 1, total: 1 });
});

describe("runner with an empty Emby template config", () => {
  it.each([null, ""])("applies marked fixed duration with template config %j", async (raw) => {
    queryGet.mockReturnValue({ config: raw });
    await runJob(
      job({
        username: "alice",
        password: "",
        [EMBY_TEMPLATE_META_KEY]: { overrides: { playDuration: 900 } },
      }),
      null,
      [],
    );

    expect(runEmbywatch).toHaveBeenCalledOnce();
    expect(runEmbywatch.mock.calls[0][1]).toEqual({
      username: "alice",
      password: "",
      playDuration: 900,
    });
  });

  it("applies a marked range even when the template config is null", async () => {
    queryGet.mockReturnValue({ config: null });
    await runJob(
      job({
        username: "alice",
        password: "",
        [EMBY_TEMPLATE_META_KEY]: {
          overrides: { playDuration: 900, playDurationMax: 1200 },
        },
      }),
      null,
      [],
    );

    expect(runEmbywatch.mock.calls[0][1]).toEqual({
      username: "alice",
      password: "",
      playDuration: 900,
      playDurationMax: 1200,
    });
  });

  it("honors explicit inheritance instead of stale top-level values", async () => {
    queryGet.mockReturnValue({ config: null });
    await runJob(
      job({
        username: "alice",
        password: "",
        playDuration: 900,
        playDurationMax: 1200,
        [EMBY_TEMPLATE_META_KEY]: { overrides: {} },
      }),
      null,
      [],
    );

    expect(runEmbywatch.mock.calls[0][1]).toEqual({
      username: "alice",
      password: "",
    });
  });

  it("continues merging non-empty template settings with independent duration", async () => {
    queryGet.mockReturnValue({
      config: JSON.stringify({ playDuration: 300, playDurationMax: 600, userAgent: "TemplateUA" }),
    });
    await runJob(
      job({
        username: "alice",
        password: "",
        [EMBY_TEMPLATE_META_KEY]: { overrides: { playDuration: 900 } },
      }),
      null,
      [],
    );

    expect(runEmbywatch.mock.calls[0][1]).toEqual({
      username: "alice",
      password: "",
      playDuration: 900,
      userAgent: "TemplateUA",
    });
  });

  it("does not change the direct config of an unlinked task", async () => {
    await runJob(job({ username: "alice", password: "", playDuration: 900 }, false), null, []);

    expect(queryGet).not.toHaveBeenCalled();
    expect(runEmbywatch.mock.calls[0][1]).toEqual({
      username: "alice",
      password: "",
      playDuration: 900,
    });
  });
});
