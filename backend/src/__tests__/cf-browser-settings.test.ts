import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  install: vi.fn(), fonts: vi.fn(), remove: vi.fn(), clear: vi.fn(),
}));
vi.mock("../db/database", () => ({
  FALLBACK_TIMEZONE: "Australia/Sydney",
  getDefaultTimezone: () => state.settings.get("default_timezone") || "UTC",
  db: {
    transaction: (callback: () => void) => callback,
    prepare: (sql: string) => ({
      all: () => sql.includes("SELECT key, value FROM settings")
        ? [...state.settings].map(([key, value]) => ({ key, value })) : [],
      get: (key: string) => sql.includes("COUNT(*)") ? { n: 0 }
        : state.settings.has(key) ? { value: state.settings.get(key) } : undefined,
      run: (key: string, value: string) => {
        if (sql.includes("('cf_solver_enabled', 'false')")) state.settings.set("cf_solver_enabled", "false");
        else if (sql.includes("('cf_solver_enabled', 'true')")) state.settings.set("cf_solver_enabled", "true");
        else state.settings.set(key, value);
      },
    }),
  },
}));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn(), refreshRunSlots: vi.fn(), purgeOldLogs: vi.fn() }));
vi.mock("../jobs/runner", () => ({ parseTgProxy: vi.fn() }));
vi.mock("../jobs/bulkAdd", () => ({ isBulkAccountManagementEnabled: () => false }));
vi.mock("../jobs/cloudflare", () => ({
  areCfFontsInstalled: () => false, cfFontsStatus: () => ({ missing: [] }),
  chromiumVersion: () => undefined, installCfChromium: state.install, installCfFonts: state.fonts,
  isChromiumInstalled: () => false, testBrowser: vi.fn(),
}));
vi.mock("../jobs/cfBrowser", () => ({
  cfBrowsersRunning: () => 0, cfProfileCount: () => 0, checkCfLicenseKey: vi.fn(),
  clearCfProfiles: state.clear, chromiumExecutable: () => undefined, chromiumPath: () => undefined,
  CF_BROWSER_LANG_KEY: "cf_browser_lang", installedBuildTier: () => undefined,
  installedCfBuilds: () => [], keyedBuildPending: () => false, cloakCacheDir: () => "unused",
  removeAllCfBuilds: state.remove, stopAllCfBrowsers: vi.fn(),
}));
vi.mock("../jobs/cfLicense", () => ({
  CF_KEYS_SETTING: "cf_keys", cfLicenseKeys: () => [], cfLicenseKeysForClient: () => [],
  cfLicenseUsage: () => ({ inUse: 0 }), maskKey: (value: string) => value,
  saveCfLicenseKeys: vi.fn(), anyCfLicenseKey: () => undefined,
}));
vi.mock("../tg/proxyProviders", () => ({
  providersForClient: () => [], saveProviders: vi.fn(), syncProviders: vi.fn(),
}));
vi.mock("../jobs/notify", () => ({
  getBotInfo: vi.fn(), getNotifyConfig: () => ({ botToken: "" }), maskBotToken: (value: string) => value,
  NOTIFY_BOT_TARGET_KEY: "notify_bot_target", NOTIFY_BOT_TOKEN_KEY: "notify_bot_token",
  recentBotChats: vi.fn(), sendBotNotify: vi.fn(),
}));

import settingsRouter, { ALLOWED_KEYS } from "../routes/settings";
import { acquireCfBrowserUse, cfBrowserMaintenanceStatus, tryAcquireCfBrowserMaintenance } from "../jobs/cfBrowserMaintenance";
import { CF_AUTO_UPDATE_ENABLED, CF_AUTO_UPDATE_TIME, CF_AUTO_UPDATE_STATE } from "../jobs/cfBrowserAutoUpdate";

function handler(method: string, path = "/") {
  return (settingsRouter as any).stack.find((item: any) =>
    item.route?.path === path && item.route.methods[method]).route.stack[0].handle;
}
function response() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}
const cleanups: Array<() => void> = [];
beforeEach(() => {
  state.settings.clear();
  state.install.mockReset().mockResolvedValue({ ok: true, output: "" });
  state.fonts.mockReset().mockResolvedValue({ ok: true, output: "" });
  state.remove.mockReset().mockReturnValue({ removed: ["old-build"] });
  state.clear.mockReset().mockReturnValue({ removed: 2 });
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  expect(cfBrowserMaintenanceStatus()).toEqual({ users: 0, maintaining: false });
});

describe("daily browser update settings routes", () => {
  it("exposes enabled 05:00 defaults, panel timezone and last check", () => {
    const last = { day: "2026-10-15", timezone: "Asia/Shanghai", checkedAt: "2026-10-14T21:00:00Z", status: "success", message: "done" };
    state.settings.set("default_timezone", "Asia/Shanghai");
    state.settings.set(CF_AUTO_UPDATE_STATE, JSON.stringify(last));
    const res = response();
    handler("get")({}, res);
    expect(res.body).toMatchObject({
      [CF_AUTO_UPDATE_ENABLED]: "true", [CF_AUTO_UPDATE_TIME]: "05:00",
      cf_browser_auto_update_timezone: "Asia/Shanghai",
    });
    expect(JSON.parse(res.body[CF_AUTO_UPDATE_STATE])).toEqual(last);
  });

  it("saves only enabled and time, leaving last-check state server-owned", () => {
    expect(ALLOWED_KEYS).toContain(CF_AUTO_UPDATE_ENABLED);
    expect(ALLOWED_KEYS).toContain(CF_AUTO_UPDATE_TIME);
    expect(ALLOWED_KEYS).not.toContain(CF_AUTO_UPDATE_STATE);
    const res = response();
    handler("put")({ body: {
      [CF_AUTO_UPDATE_ENABLED]: "false", [CF_AUTO_UPDATE_TIME]: "06:35",
      [CF_AUTO_UPDATE_STATE]: "forged",
    } }, res);
    expect(res.statusCode).toBe(200);
    expect(state.settings.get(CF_AUTO_UPDATE_ENABLED)).toBe("false");
    expect(state.settings.get(CF_AUTO_UPDATE_TIME)).toBe("06:35");
    expect(state.settings.has(CF_AUTO_UPDATE_STATE)).toBe(false);
  });

  it.each([
    { [CF_AUTO_UPDATE_ENABLED]: true }, { [CF_AUTO_UPDATE_ENABLED]: "yes" },
    { [CF_AUTO_UPDATE_TIME]: "5:00" }, { [CF_AUTO_UPDATE_TIME]: "24:00" },
    { [CF_AUTO_UPDATE_TIME]: 500 },
  ])("rejects invalid values atomically: %j", (invalid) => {
    const res = response();
    handler("put")({ body: { default_ua: "must not save", ...invalid } }, res);
    expect(res.statusCode).toBe(400);
    expect(state.settings.size).toBe(0);
  });
});

describe("browser route maintenance exclusion", () => {
  it.each(["/cf-solver/install", "/cf-solver/uninstall", "/cf-solver/clear-profiles"])(
    "refuses %s during a browser startup reservation", async (route) => {
      cleanups.push(await acquireCfBrowserUse());
      const res = response();
      await handler("post", route)({ body: {}, query: {} }, res);
      expect(res.statusCode).toBe(409);
      expect(state.install).not.toHaveBeenCalled();
      expect(state.remove).not.toHaveBeenCalled();
      expect(state.clear).not.toHaveBeenCalled();
    },
  );

  it.each(["/cf-solver/install", "/cf-solver/uninstall", "/cf-solver/clear-profiles"])(
    "refuses %s during automatic-update maintenance", async (route) => {
      cleanups.push(tryAcquireCfBrowserMaintenance()!);
      const res = response();
      await handler("post", route)({ body: {}, query: {} }, res);
      expect(res.statusCode).toBe(409);
      expect(state.install).not.toHaveBeenCalled();
      expect(state.remove).not.toHaveBeenCalled();
      expect(state.clear).not.toHaveBeenCalled();
    },
  );

  it("makes new launches wait for an in-progress manual install", async () => {
    let finish!: (value: { ok: boolean; output: string }) => void;
    state.install.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pendingInstall = handler("post", "/cf-solver/install")({ body: {}, query: {} }, response());
    expect(tryAcquireCfBrowserMaintenance()).toBeUndefined();
    let launched = false;
    const pendingLaunch = acquireCfBrowserUse().then((release) => { launched = true; return release; });
    await Promise.resolve();
    expect(launched).toBe(false);
    finish({ ok: true, output: "" });
    await pendingInstall;
    cleanups.push(await pendingLaunch);
    expect(launched).toBe(true);
  });

  it.each([undefined, "free"])("releases maintenance after a failed %s install", async (tier) => {
    state.install.mockRejectedValueOnce(new Error("download failed"));
    const res = response();
    await handler("post", "/cf-solver/install")({ body: { tier }, query: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(cfBrowserMaintenanceStatus().maintaining).toBe(false);
  });

  it("holds maintenance for uninstall and releases after a removal error", () => {
    state.remove.mockImplementationOnce(() => {
      expect(cfBrowserMaintenanceStatus().maintaining).toBe(true);
      return { removed: [], error: "locked file" };
    });
    const res = response();
    handler("post", "/cf-solver/uninstall")({}, res);
    expect(res.statusCode).toBe(409);
    expect(state.settings.has("cf_solver_enabled")).toBe(false);
    expect(cfBrowserMaintenanceStatus().maintaining).toBe(false);
  });
});
