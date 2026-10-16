// UA preset edits must carry existing jobs and templates forward without touching
// arbitrary custom User-Agent values.

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  jobs: [] as Array<{ id: number; config: string | null }>,
  templates: [] as Array<{ id: number; config: string | null }>,
  runs: [] as unknown[][],
}));

const mockPrepare = vi.hoisted(() =>
  vi.fn((sql: string) => {
    if (sql.includes("SELECT key, value FROM settings")) {
      return { all: () => Object.entries(state.settings).map(([key, value]) => ({ key, value })) };
    }
    if (sql.includes("SELECT value FROM settings WHERE key = 'ua_presets'")) {
      return { get: () => ({ value: state.settings.ua_presets }) };
    }
    if (sql.includes("SELECT value FROM settings WHERE key = 'default_ua'")) {
      return { get: () => ({ value: state.settings.default_ua }) };
    }
    if (sql.startsWith("INSERT OR REPLACE INTO settings")) {
      return {
        run: (key: string, value: string) => {
          state.settings[key] = value;
          state.runs.push([key, value]);
        },
      };
    }
    if (sql.startsWith("UPDATE settings SET value = ? WHERE key = 'default_ua'")) {
      return {
        run: (value: string) => {
          state.settings.default_ua = value;
          state.runs.push(["default_ua", value]);
        },
      };
    }
    if (sql.includes("SELECT id, config FROM jobs")) {
      return { all: () => state.jobs };
    }
    if (sql.includes("SELECT id, config FROM job_templates")) {
      return { all: () => state.templates };
    }
    if (sql.startsWith("UPDATE jobs SET config")) {
      return {
        run: (config: string, id: number) => {
          const row = state.jobs.find((job) => job.id === id);
          if (row) row.config = config;
          state.runs.push([config, id]);
        },
      };
    }
    if (sql.startsWith("UPDATE job_templates SET config")) {
      return {
        run: (config: string, id: number) => {
          const row = state.templates.find((template) => template.id === id);
          if (row) row.config = config;
          state.runs.push([config, id]);
        },
      };
    }
    return {
      get: () => (sql.includes("COUNT(*) AS n") ? { n: 0 } : undefined),
      all: () => [],
      run: (...args: unknown[]) => state.runs.push(args),
    };
  }),
);

vi.mock("../db/database", () => ({
  getDefaultTimezone: () => "UTC",
  FALLBACK_TIMEZONE: "Australia/Sydney",
  db: {
    prepare: mockPrepare,
    transaction: (fn: () => void) => fn,
  },
}));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn(), purgeOldLogs: vi.fn() }));
vi.mock("../jobs/runner", () => ({ parseTgProxy: vi.fn() }));
vi.mock("socks", () => ({ SocksClient: { createConnection: vi.fn() } }));
vi.mock("../jobs/bulkAdd", () => ({ isBulkAccountManagementEnabled: () => false }));
vi.mock("../jobs/cloudflare", () => ({
  areCfFontsInstalled: () => false,
  cfFontsStatus: () => ({ missing: [] }),
  chromiumVersion: () => undefined,
  installCfChromium: vi.fn(),
  installCfFonts: vi.fn(),
  isChromiumInstalled: () => false,
  testBrowser: vi.fn(),
}));
vi.mock("../jobs/cfTuning", () => ({
  CF_TUNING_DEFAULTS: {},
  CF_TUNING_KEY: "cf_tuning",
  CF_TUNING_LIMITS: {},
  cfTuning: () => ({}),
  invalidateCfTuning: vi.fn(),
  resolveCfTuning: (value: unknown) => value,
}));
vi.mock("../jobs/cfLicense", () => ({
  CF_KEYS_SETTING: "cf_keys",
  cfLicenseKeys: () => [],
  cfLicenseKeysForClient: () => [],
  cfLicenseUsage: () => ({ inUse: 0 }),
  maskKey: (value: string) => value,
  saveCfLicenseKeys: vi.fn(),
}));
vi.mock("../jobs/cfBrowser", () => ({
  cfBrowsersRunning: () => 0,
  cfProfileCount: () => 0,
  checkCfLicenseKey: vi.fn(),
  clearCfProfiles: vi.fn(() => ({ removed: 0 })),
  chromiumExecutable: () => undefined,
  chromiumPath: () => undefined,
  CF_BROWSER_LANG_KEY: "cf_browser_lang",
  installedBuildTier: () => undefined,
  installedCfBuilds: () => [],
  keyedBuildPending: () => false,
  removeAllCfBuilds: vi.fn(() => ({ removed: [] })),
  stopAllCfBrowsers: vi.fn(() => ({ stopped: 0 })),
}));
vi.mock("../tg/proxyProviders", () => ({
  providersForClient: () => [],
  saveProviders: vi.fn(),
  syncProviders: vi.fn(),
}));
vi.mock("../jobs/notify", () => ({
  getBotInfo: vi.fn(),
  getNotifyConfig: () => ({ botToken: "", botTarget: "" }),
  maskBotToken: (value: string) => value,
  NOTIFY_BOT_TARGET_KEY: "notify_bot_target",
  NOTIFY_BOT_TOKEN_KEY: "notify_bot_token",
  recentBotChats: vi.fn(),
  sendBotNotify: vi.fn(),
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import settingsRouter from "../routes/settings";

function routeHandler(method: string, path: string) {
  const layer = (settingsRouter as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route.methods[method],
  );
  return layer.route.stack[0].handle as (req: any, res: any) => void;
}

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res;
}

const putSettings = routeHandler("put", "/");

beforeEach(() => {
  state.settings = {
    ua_presets: JSON.stringify([
      { name: "Mac", value: "Player/1" },
      { name: "TV", value: "Player/2" },
    ]),
    default_ua: "Player/1",
  };
  state.jobs = [
    { id: 1, config: JSON.stringify({ userAgent: "Player/1", keep: true }) },
    { id: 2, config: JSON.stringify({ userAgent: "Custom/9" }) },
    { id: 3, config: "{not-json" },
  ];
  state.templates = [
    { id: 4, config: JSON.stringify({ userAgent: "Player/1", retries: 2 }) },
  ];
  state.runs = [];
  vi.clearAllMocks();
});

describe("editable UA presets", () => {
  it("migrates exact default, job and template references by preset name", () => {
    const next = JSON.stringify([
      { name: "Mac", value: "Player/9" },
      { name: "TV", value: "Player/2" },
    ]);

    putSettings({ body: { ua_presets: next } }, makeRes());

    expect(state.settings.default_ua).toBe("Player/9");
    expect(JSON.parse(state.jobs[0].config!)).toEqual({
      userAgent: "Player/9",
      keep: true,
    });
    expect(state.jobs[1].config).toBe(JSON.stringify({ userAgent: "Custom/9" }));
    expect(state.jobs[2].config).toBe("{not-json");
    expect(JSON.parse(state.templates[0].config!)).toEqual({
      userAgent: "Player/9",
      retries: 2,
    });
  });

  it("does not overwrite an explicitly selected custom default UA", () => {
    const next = JSON.stringify([{ name: "Mac", value: "Player/9" }]);

    putSettings(
      { body: { default_ua: "Custom/9", ua_presets: next } },
      makeRes(),
    );

    expect(state.settings.default_ua).toBe("Custom/9");
  });

  it("does not guess when presets sharing one UA have different destinations", () => {
    state.settings.ua_presets = JSON.stringify([
      { name: "Mac", value: "Player/1" },
      { name: "Alias", value: "Player/1" },
    ]);

    putSettings(
      {
        body: {
          ua_presets: JSON.stringify([
            { name: "Mac", value: "Player/9" },
            { name: "Alias", value: "Player/1" },
          ]),
        },
      },
      makeRes(),
    );

    expect(state.settings.default_ua).toBe("Player/1");
    expect(JSON.parse(state.jobs[0].config!).userAgent).toBe("Player/1");
    expect(JSON.parse(state.templates[0].config!).userAgent).toBe("Player/1");
  });

  it.each([
    ["bad JSON", "{not-json"],
    ["empty preset name", JSON.stringify([{ name: " ", value: "Player/9" }])],
    ["empty preset value", JSON.stringify([{ name: "Mac", value: " " }])],
    [
      "duplicate preset name",
      JSON.stringify([
        { name: "Mac", value: "Player/9" },
        { name: "Mac", value: "Player/10" },
      ]),
    ],
  ])("rejects %s without changing stored state", (_label, uaPresets) => {
    const before = {
      settings: { ...state.settings },
      jobs: state.jobs.map((row) => ({ ...row })),
      templates: state.templates.map((row) => ({ ...row })),
    };
    const res = makeRes();

    putSettings({ body: { ua_presets: uaPresets } }, res);

    expect(res.statusCode).toBe(400);
    expect(state.settings).toEqual(before.settings);
    expect(state.jobs).toEqual(before.jobs);
    expect(state.templates).toEqual(before.templates);
    expect(state.runs).toEqual([]);
  });

  it("does not migrate references when a preset is removed", () => {
    const res = makeRes();
    putSettings(
      {
        body: {
          ua_presets: JSON.stringify([{ name: "TV", value: "Player/2" }]),
        },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(state.settings.default_ua).toBe("Player/1");
    expect(JSON.parse(state.jobs[0].config!).userAgent).toBe("Player/1");
    expect(JSON.parse(state.templates[0].config!).userAgent).toBe("Player/1");
  });

  it("keeps an explicitly submitted default UA over an automatic migration", () => {
    const res = makeRes();
    putSettings(
      {
        body: {
          default_ua: "Custom/9",
          ua_presets: JSON.stringify([
            { name: "Mac", value: "Player/9" },
            { name: "TV", value: "Player/2" },
          ]),
        },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(state.settings.default_ua).toBe("Custom/9");
    expect(JSON.parse(state.jobs[0].config!).userAgent).toBe("Player/9");
    expect(JSON.parse(state.templates[0].config!).userAgent).toBe("Player/9");
  });
});
