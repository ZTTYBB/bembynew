import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { managedDb } from "./helpers/managedDb";

let testDb: Database.Database;
const refreshScheduler = vi.hoisted(() => vi.fn());
vi.mock("../db/database", () => ({
  FALLBACK_TIMEZONE: "Australia/Sydney",
  get db() { return testDb; }, getDefaultTgApiCredentials: () => null, getDefaultTimezone: () => "UTC",
}));
vi.mock("../scheduler", () => ({
  refreshScheduler, refreshRunSlots: vi.fn(), purgeOldLogs: vi.fn(),
}));
vi.mock("../jobs/execution", () => ({
  executeManagedJob: vi.fn(), getExecutionStatus: () => ({ running: [], queued: [] }),
}));
vi.mock("../jobs/embywatch", () => ({ testEmbyConnection: vi.fn() }));
vi.mock("../jobs/runner", () => ({ parseTgProxy: vi.fn() }));
vi.mock("../jobs/bulkAdd", () => ({ isBulkAccountManagementEnabled: () => false }));
vi.mock("../jobs/cloudflare", () => ({
  areCfFontsInstalled: () => false, cfFontsStatus: () => ({ missing: [] }),
  chromiumVersion: () => undefined, installCfChromium: vi.fn(), installCfFonts: vi.fn(),
  isChromiumInstalled: () => false, testBrowser: vi.fn(),
}));
vi.mock("../jobs/cfBrowser", () => ({
  cfBrowsersRunning: () => 0, cfProfileCount: () => 0,
  checkCfLicenseKey: vi.fn(), clearCfProfiles: vi.fn(),
  chromiumExecutable: () => undefined, chromiumPath: () => undefined,
  CF_BROWSER_LANG_KEY: "cf_browser_lang", installedBuildTier: () => undefined,
  installedCfBuilds: () => [], keyedBuildPending: () => false,
  removeAllCfBuilds: vi.fn(), stopAllCfBrowsers: vi.fn(),
}));
vi.mock("../jobs/cfLicense", () => ({
  CF_KEYS_SETTING: "cf_keys", cfLicenseKeys: () => [], cfLicenseKeysForClient: () => [],
  cfLicenseUsage: () => ({ inUse: 0 }), maskKey: (value: string) => value, saveCfLicenseKeys: vi.fn(),
}));
vi.mock("../tg/proxyProviders", () => ({
  providersForClient: () => [], saveProviders: vi.fn(), syncProviders: vi.fn(),
}));
vi.mock("../jobs/notify", () => ({
  getBotInfo: vi.fn(), getNotifyConfig: () => ({ botToken: "", botTarget: "" }),
  maskBotToken: (value: string) => value, NOTIFY_BOT_TARGET_KEY: "notify_bot_target",
  NOTIFY_BOT_TOKEN_KEY: "notify_bot_token", recentBotChats: vi.fn(), sendBotNotify: vi.fn(),
}));
import jobsRouter from "../routes/jobs";
import settingsRouter from "../routes/settings";

function call(router: any, method: string, path: string, body: unknown, id = 1) {
  const handler = router.stack.find((item: any) => item.route?.path === path && item.route.methods[method]).route.stack[0].handle;
  const response: any = { statusCode: 200, body: undefined };
  response.status = (value: number) => { response.statusCode = value; return response; };
  response.json = (value: unknown) => { response.body = value; return response; };
  handler({ body, params: { id: String(id) } }, response);
  return response;
}
function create(overrides: Record<string, unknown> = {}) {
  return call(jobsRouter, "post", "/", {
    name: "Emby", jobType: "embywatch", botUsername: "https://emby.example.com",
    config: { username: "user", password: "", playDuration: 300 }, ...overrides,
  });
}
function template(config: Record<string, unknown>) {
  return Number(testDb.prepare(
    "INSERT INTO job_templates(name, config) VALUES ('Template', ?)",
  ).run(JSON.stringify(config)).lastInsertRowid);
}
beforeEach(() => {
  testDb = managedDb();
  testDb.exec(`CREATE TABLE job_templates (
    id INTEGER PRIMARY KEY, name TEXT, job_type TEXT DEFAULT 'embywatch', config TEXT,
    run_once INTEGER NOT NULL DEFAULT 0, first_run_min_days INTEGER NOT NULL DEFAULT 0,
    first_run_max_days INTEGER NOT NULL DEFAULT 0,
    rerun_on_restart INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE ai_suppliers (id INTEGER PRIMARY KEY, api_key TEXT);
  CREATE TABLE ai_models (id INTEGER PRIMARY KEY, supplier_id INTEGER, model_id TEXT, label TEXT);`);
  refreshScheduler.mockClear();
});
afterEach(() => { testDb.close(); });

describe("task options on actual jobs routes", () => {
  it.each([
    { name: 42 },
    { scheduleWindowStart: 2360 },
    { scheduleWindowEnd: "12:00" },
    { replyTimeoutMs: 99 },
    { retryMax: 21 },
    { enabled: "false" },
    { config: [] },
    { runEveryDays: 0 },
    { runEveryDays: 3, runEveryDaysMax: 2 },
  ])("rejects malformed job fields before inserting: %j", (invalid) => {
    expect(create(invalid).statusCode).toBe(400);
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    expect(refreshScheduler).not.toHaveBeenCalled();
  });

  it("accepts a valid run-every-days range and validates cross-field edits", () => {
    const created = create({
      scheduleWindowStart: 1000,
      scheduleWindowEnd: 1200,
      runEveryDays: 3,
      runEveryDaysMax: 5,
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({ runEveryDays: 3, runEveryDaysMax: 5 });

    const lowerMax = call(jobsRouter, "put", "/:id", { runEveryDaysMax: 2 }, created.body.id);
    expect(lowerMax.statusCode).toBe(400);
    expect(lowerMax.body.error).toContain("runEveryDaysMax");

    const invertedWindow = call(
      jobsRouter,
      "put",
      "/:id",
      { scheduleWindowStart: 1300 },
      created.body.id,
    );
    expect(invertedWindow.statusCode).toBe(400);
    expect(invertedWindow.body.error).toContain("scheduleWindowEnd");

    const row = testDb.prepare(
      "SELECT schedule_window_start, schedule_window_end, run_every_days, run_every_days_max FROM jobs WHERE id = ?",
    ).get(created.body.id);
    expect(row).toEqual({
      schedule_window_start: 1000,
      schedule_window_end: 1200,
      run_every_days: 3,
      run_every_days_max: 5,
    });
  });

  it("creates and preserves one-time options on partial edits", () => {
    const result = create({ runOnce: true, firstRunMinDays: 0, firstRunMaxDays: 10 });
    expect(result.statusCode).toBe(201);
    expect(result.body).toMatchObject({ runOnce: true, firstRunMinDays: 0, firstRunMaxDays: 10 });
    const edited = call(jobsRouter, "put", "/:id", { name: "Renamed" }, result.body.id);
    expect(edited.body).toMatchObject({ runOnce: true, firstRunMinDays: 0, firstRunMaxDays: 10 });
  });
  it("requires explicit restart reruns and preserves the choice on partial edits", () => {
    const { body } = create();
    expect(body.rerunOnRestart).toBe(false);
    const updated = call(jobsRouter, "put", "/:id", { rerunOnRestart: true }, body.id);
    expect(updated.body.rerunOnRestart).toBe(true);
    expect(call(jobsRouter, "put", "/:id", { name: "Renamed" }, body.id).body.rerunOnRestart).toBe(true);
  });
  it.each([
    { runOnce: "false" }, { rerunOnRestart: "false" }, { firstRunMaxDays: -1 }, { firstRunMaxDays: 3651 },
    { firstRunMinDays: 3, firstRunMaxDays: 2 },
  ])("rejects invalid create options %j before inserting", (options) => {
    expect(create(options).statusCode).toBe(400);
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    expect(refreshScheduler).not.toHaveBeenCalled();
  });
  it("rejects invalid partial ranges without changing the stored task", () => {
    const { body } = create({ runOnce: true, firstRunMaxDays: 10 });
    expect(call(jobsRouter, "put", "/:id", { firstRunMinDays: 11 }, body.id).statusCode).toBe(400);
    expect((testDb.prepare("SELECT first_run_min_days FROM jobs").get() as any).first_run_min_days).toBe(0);
  });
  it("keeps template-controlled options even when the form echoes templateId", () => {
    const id = template({ playDuration: 300 });
    testDb.prepare("UPDATE job_templates SET run_once = 1, first_run_max_days = 10 WHERE id = ?").run(id);
    const { body } = create({ templateId: id });
    const edited = call(jobsRouter, "put", "/:id", {
      templateId: id, runOnce: false, firstRunMaxDays: 0,
    }, body.id);
    expect(edited.body).toMatchObject({ runOnce: true, firstRunMaxDays: 10 });
  });
  it("inherits one-time options when switching an independent task to a template", () => {
    const id = template({ playDuration: 300 });
    testDb.prepare("UPDATE job_templates SET run_once = 1, first_run_max_days = 10 WHERE id = ?").run(id);
    const { body } = create();
    const edited = call(jobsRouter, "put", "/:id", { templateId: id }, body.id);
    expect(edited.body).toMatchObject({ runOnce: true, firstRunMinDays: 0, firstRunMaxDays: 10 });
  });

  it("preserves selected custom-template options on a partial edit", () => {
    const id = template({
      actions: [],
      jobOptions: [{ name: "mode", label: "Mode", options: ["fast", "safe"], default: "fast" }],
    });
    testDb.prepare("UPDATE job_templates SET job_type = 'custom' WHERE id = ?").run(id);
    testDb.prepare("INSERT INTO tg_accounts (id, name, phone_number) VALUES (1, 'A', '')").run();
    const created = create({
      name: "Custom",
      jobType: "custom",
      accountId: 1,
      templateId: id,
      config: { jobOptionValues: { mode: "safe" } },
    });
    expect(created.statusCode).toBe(201);

    const edited = call(jobsRouter, "put", "/:id", { name: "Renamed" }, created.body.id);
    expect(edited.statusCode).toBe(200);
    expect(JSON.parse(edited.body.config).jobOptionValues).toEqual({ mode: "safe" });
  });
});

describe("effective Emby intervals across save paths", () => {
  it("rejects an upper-only standalone interval below the system minimum", () => {
    expect(create({ config: { username: "u", playDurationMax: 299 } }).statusCode).toBe(400);
    expect(create({ config: { username: "u", playDurationMax: 300 } }).statusCode).toBe(201);
  });
  it("checks linked job overrides against the template rather than the copied lower bound", () => {
    const id = template({ playDuration: 600 });
    expect(create({ templateId: id, config: {
      username: "u", playDuration: 300, __bembyTemplate: { overrides: { playDurationMax: 500 } },
    } }).statusCode).toBe(400);
  });
  it("validates the effective interval when an upper-only override is edited", () => {
    const id = template({ playDuration: 600 });
    const { body } = create({ templateId: id, config: {
      username: "u", __bembyTemplate: { overrides: {} },
    } });
    expect(call(jobsRouter, "put", "/:id", { config: {
      username: "u", __bembyTemplate: { overrides: { playDurationMax: 500 } },
    } }, body.id).statusCode).toBe(400);
  });
  it("rejects a default that would break an inherited job, with no partial settings writes", () => {
    create({ config: { username: "u", playDurationMax: 500 } });
    const response = call(settingsRouter, "put", "/", { default_play_duration: "600", default_ua: "new" });
    expect(response.statusCode).toBe(400);
    expect(response.body.conflicts).toHaveLength(1);
    expect(testDb.prepare("SELECT * FROM settings").all()).toEqual([]);
  });
  it("checks inherited template and linked override bounds when changing the default", () => {
    const id = template({});
    create({ templateId: id, config: {
      username: "u", __bembyTemplate: { overrides: { playDurationMax: 500 } },
    } });
    expect(call(settingsRouter, "put", "/", { default_play_duration: "600" }).statusCode).toBe(400);
  });
  it("ignores retired tasks but still protects disabled tasks", () => {
    const { body } = create({ config: { username: "u", playDurationMax: 500 }, enabled: false });
    expect(call(settingsRouter, "put", "/", { default_play_duration: "600" }).statusCode).toBe(400);
    testDb.prepare("UPDATE jobs SET retired = 'old' WHERE id = ?").run(body.id);
    expect(call(settingsRouter, "put", "/", { default_play_duration: "600" }).statusCode).toBe(200);
  });
  it("allows a valid new default and ignores tasks with an explicit lower bound", () => {
    create({ config: { username: "u", playDuration: 300, playDurationMax: 500 } });
    expect(call(settingsRouter, "put", "/", { default_play_duration: "600" }).statusCode).toBe(200);
    expect(testDb.prepare("SELECT value FROM settings WHERE key = 'default_play_duration'").get()).toEqual({ value: "600" });
  });
  it.each(["", "29", "30.5", "invalid"])("rejects invalid new default %s", (value) => {
    expect(call(settingsRouter, "put", "/", { default_play_duration: value }).statusCode).toBe(400);
  });
});
