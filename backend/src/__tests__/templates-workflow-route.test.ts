import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fuzzyScore } from "../db/fuzzy";
import { encryptSecret, resetSecretKeyCache } from "../db/secretColumns";

let testDb!: InstanceType<typeof Database>;
vi.mock("../db/database", () => ({ get db() { return testDb; } }));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));
import templatesRouter from "../routes/templates";
import { refreshScheduler } from "../scheduler";
import { inferTemplateCategory } from "../routes/templateCategory";

const SCHEMA = `
  CREATE TABLE tg_accounts (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone_number TEXT DEFAULT '',
    auth_status TEXT DEFAULT 'authenticated', session_string TEXT DEFAULT 'session',
    disabled INTEGER DEFAULT 0, tg_display_name TEXT, additional_attributes TEXT
  );
  CREATE TABLE job_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    job_type TEXT DEFAULT 'custom', bot_username TEXT DEFAULT '', timezone TEXT DEFAULT '',
    reply_timeout_ms INTEGER DEFAULT 40000, retry_max INTEGER DEFAULT 5,
    enabled INTEGER DEFAULT 1, config TEXT, start_command TEXT DEFAULT '/start',
    checkin_button TEXT DEFAULT 'checkin', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    run_every_days INTEGER DEFAULT 1, run_every_days_max INTEGER,
    category TEXT NOT NULL DEFAULT '', run_once INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    rerun_on_restart INTEGER NOT NULL DEFAULT 0,
    first_run_min_days INTEGER NOT NULL DEFAULT 0, first_run_max_days INTEGER NOT NULL DEFAULT 0,
    exclusive_account INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    account_id INTEGER, job_type TEXT DEFAULT 'custom', bot_username TEXT DEFAULT '',
    schedule_window_start INTEGER DEFAULT 1000, schedule_window_end INTEGER DEFAULT 1200,
    timezone TEXT DEFAULT '', reply_timeout_ms INTEGER DEFAULT 40000,
    retry_max INTEGER DEFAULT 5, enabled INTEGER DEFAULT 1, config TEXT,
    start_command TEXT DEFAULT '/start', checkin_button TEXT DEFAULT 'checkin',
    template_id INTEGER REFERENCES job_templates(id) ON DELETE SET NULL,
    run_every_days INTEGER DEFAULT 1, run_every_days_max INTEGER,
    run_once INTEGER NOT NULL DEFAULT 0, rerun_on_restart INTEGER NOT NULL DEFAULT 0,
    first_run_min_days INTEGER NOT NULL DEFAULT 0,
    first_run_max_days INTEGER NOT NULL DEFAULT 0, retired TEXT, last_success_at TEXT,
    exclusive_account INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE job_logs (id INTEGER PRIMARY KEY, job_id INTEGER, status TEXT, retired INTEGER DEFAULT 0);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO settings VALUES ('default_play_duration', '300');
`;

function call(method: "get" | "post" | "put", path: string, {
  id = 0, body = {}, query = {},
}: { id?: number; body?: Record<string, unknown>; query?: Record<string, unknown> } = {}) {
  const layer = (templatesRouter as any).stack.find((item: any) =>
    item.route?.path === path && item.route.methods[method]);
  if (!layer) throw new Error(`Missing ${method} ${path}`);
  const response = {
    statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
  layer.route.stack[0].handle({ params: { id: String(id) }, body, query }, response);
  return response;
}

function template(body: Record<string, unknown> = {}) {
  const response = call("post", "/", { body: { name: "Daily template", jobType: "custom", ...body } });
  expect(response.statusCode).toBe(201);
  return response.body;
}

function account(id: number, extra: Record<string, unknown> = {}) {
  testDb.prepare("INSERT INTO tg_accounts (id, name, tg_display_name, additional_attributes, disabled) VALUES (?, ?, ?, ?, ?)")
    .run(id, extra.name ?? `Account ${id}`, extra.tgName ?? null,
      extra.attributes ? JSON.stringify(extra.attributes) : null, extra.disabled ? 1 : 0);
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.function("fuzzy_score", { deterministic: true }, (needle, haystack) => fuzzyScore(String(needle), String(haystack)));
  testDb.exec(SCHEMA);
});
beforeEach(() => {
  vi.clearAllMocks();
  testDb.exec("DELETE FROM job_logs; DELETE FROM jobs; DELETE FROM job_templates; DELETE FROM tg_accounts;");
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetSecretKeyCache();
});
afterAll(() => testDb.close());

describe("template execution options through real route handlers", () => {
  it("defaults restart recovery off when omitted on create and duplicate", () => {
    const source = template();
    expect(source.rerunOnRestart).toBe(false);
    expect(testDb.prepare("SELECT rerun_on_restart FROM job_templates").get())
      .toEqual({ rerun_on_restart: 0 });
    expect(call("post", "/:id/duplicate", { id: source.id }).body.rerunOnRestart).toBe(false);
    account(1);
    const created = call("post", "/:id/create-jobs", { id: source.id, body: {
      jobs: [{ accountId: 1, name: "Default off" }],
      scheduleWindowStart: 1300, scheduleWindowEnd: 2200,
    } });
    expect(created.statusCode).toBe(201);
    expect(testDb.prepare("SELECT rerun_on_restart FROM jobs").get())
      .toEqual({ rerun_on_restart: 0 });
  });

  it("round-trips options, copies them, preserves omitted fields, and syncs linked jobs without changing enabled", () => {
    const source = template({ category: "join", runOnce: true, rerunOnRestart: true, firstRunMinDays: 0, firstRunMaxDays: 10 });
    expect(source).toMatchObject({ category: "join", runOnce: true, rerunOnRestart: true, firstRunMinDays: 0, firstRunMaxDays: 10 });
    const duplicate = call("post", "/:id/duplicate", { id: source.id }).body;
    expect(duplicate).toMatchObject({ category: "join", runOnce: true, rerunOnRestart: true, firstRunMinDays: 0, firstRunMaxDays: 10 });
    account(1);
    const creation = call("post", "/:id/create-jobs", { id: source.id, body: {
      jobs: [{ accountId: 1, name: "Created" }], scheduleWindowStart: 1300,
      scheduleWindowEnd: 2200, enabled: false, maxAccounts: 1,
    } });
    expect(creation.body.created).toBe(1);
    expect(testDb.prepare("SELECT rerun_on_restart FROM jobs").get())
      .toEqual({ rerun_on_restart: 1 });
    const updated = call("put", "/:id", { id: source.id, body: { name: "Renamed" } });
    expect(updated.body).toMatchObject({ category: "join", runOnce: true, rerunOnRestart: true, firstRunMinDays: 0, firstRunMaxDays: 10 });
    expect(testDb.prepare("SELECT run_once, rerun_on_restart, first_run_min_days, first_run_max_days, enabled FROM jobs").get())
      .toEqual({ run_once: 1, rerun_on_restart: 1, first_run_min_days: 0, first_run_max_days: 10, enabled: 0 });
    const disabled = call("put", "/:id", { id: source.id, body: { runOnce: false, rerunOnRestart: false } });
    expect(disabled.body).toMatchObject({ runOnce: false, rerunOnRestart: false, firstRunMaxDays: 10 });
    expect(testDb.prepare("SELECT run_once, rerun_on_restart, first_run_max_days, enabled FROM jobs").get())
      .toEqual({ run_once: 0, rerun_on_restart: 0, first_run_max_days: 10, enabled: 0 });
  });

  it.each([
    { runOnce: 1 }, { runOnce: "true" }, { firstRunMinDays: -1 },
    { rerunOnRestart: 1 }, { rerunOnRestart: "true" }, { rerunOnRestart: null },
    { firstRunMaxDays: 3651 }, { firstRunMinDays: 0.5 },
    { firstRunMaxDays: "5" }, { firstRunMinDays: 5, firstRunMaxDays: 4 },
    { category: null }, { category: "a".repeat(65) },
  ])("rejects invalid create and partial-update fields atomically: %j", (invalid) => {
    const source = template({ runOnce: true, rerunOnRestart: true, firstRunMaxDays: 10 });
    account(1);
    const creation = call("post", "/:id/create-jobs", { id: source.id, body: {
      jobs: [{ accountId: 1, name: "Unchanged" }],
      scheduleWindowStart: 1300, scheduleWindowEnd: 2200, enabled: false,
    } });
    expect(creation.statusCode).toBe(201);
    const linkedBefore = testDb.prepare("SELECT * FROM jobs").get();
    vi.clearAllMocks();
    const created = call("post", "/", { body: { name: "Bad", ...invalid } });
    expect(created.statusCode).toBe(400);
    const updated = call("put", "/:id", { id: source.id, body: invalid });
    expect(updated.statusCode).toBe(400);
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM job_templates").get()).toEqual({ n: 1 });
    expect(testDb.prepare("SELECT run_once, rerun_on_restart, first_run_max_days FROM job_templates").get())
      .toEqual({ run_once: 1, rerun_on_restart: 1, first_run_max_days: 10 });
    expect(testDb.prepare("SELECT * FROM jobs").get()).toEqual(linkedBefore);
    expect(refreshScheduler).not.toHaveBeenCalled();
  });

  it("syncs execution options on Emby templates while preserving per-job credentials", () => {
    const source = template({ jobType: "embywatch", config: { playDuration: 300 } });
    const result = call("post", "/:id/create-jobs", { id: source.id, body: {
      jobs: [{ accountId: null, name: "Emby", config: { username: "alice", password: "secret" } }],
      scheduleWindowStart: 1300, scheduleWindowEnd: 2200, enabled: false,
    } });
    expect(result.statusCode).toBe(201);
    const updated = call("put", "/:id", { id: source.id, body: { runOnce: true, rerunOnRestart: true, firstRunMinDays: 2, firstRunMaxDays: 5 } });
    expect(updated.statusCode).toBe(200);
    const row = testDb.prepare("SELECT * FROM jobs").get() as any;
    expect(row).toMatchObject({ run_once: 1, rerun_on_restart: 1, first_run_min_days: 2, first_run_max_days: 5, enabled: 0 });
    expect(JSON.parse(row.config)).toMatchObject({ username: "alice", password: "secret" });
  });
});

describe("template categories", () => {
  it.each([
    ["checkin", "Anything", {}, "checkin"], ["embywatch", "Anything", {}, "watch"],
    ["autoreg", "Anything", {}, "signup"], ["custom", "Lottery", {}, "draw"],
    ["custom", "Register bot", {}, "signup"],
    ["custom", "Flow", { actions: [{ type: "repeat", actions: [{ type: "join_group" }] }] }, "join"],
    ["custom", "Flow", { actions: [{ type: "open_mini_app_url" }] }, "miniapp"],
    ["custom", "Flow", { actions: [{ type: "open_url" }] }, "web"],
    ["custom", "Flow", { actions: [] }, "other"],
  ])("infers %s / %s as %s", (jobType, name, config, expected) => {
    expect(inferTemplateCategory({ jobType: String(jobType), name: String(name), config })).toBe(expected);
  });

  it("filters inferred categories before pagination and respects manual overrides", () => {
    template({ name: "A unrelated" });
    template({ name: "B unrelated" });
    const inferred = template({ name: "C draw", config: { actions: [] } });
    const manual = template({ name: "D unrelated", category: "draw" });
    template({ name: "E draw", category: "join" });
    const first = call("get", "/", { query: { page: "1", pageSize: "1", category: "draw" } }).body;
    expect(first.total).toBe(2);
    expect(first.items[0].id).toBe(inferred.id);
    expect(first.items[0]).toMatchObject({ category: "", inferredCategory: "draw" });
    const second = call("get", "/", { query: { page: "2", pageSize: "1", category: "draw" } }).body;
    expect(second.items[0].id).toBe(manual.id);
    const all = call("get", "/", { query: { page: "2", pageSize: "0", category: "draw" } }).body;
    expect(all.items.map((item: any) => item.id)).toEqual([inferred.id, manual.id]);
    expect(all).toMatchObject({ page: 1, pageSize: 0, total: 2 });
  });
});

describe("full enabled-account candidate metadata", () => {
  it("keeps the default unlinked contract while includeLinked returns all enabled accounts", () => {
    const target = template();
    const previous = template({ name: "Registration" });
    call("put", "/:id", { id: previous.id, body: { enabled: false } });
    account(1, { attributes: { restriction: "mild", passkey: { secret: "must-not-leak" } } });
    account(2, { attributes: { restriction: "limited" } });
    account(3, { disabled: true });
    account(4);
    testDb.prepare("INSERT INTO jobs (name, account_id, template_id) VALUES ('Linked', 1, ?)").run(target.id);
    testDb.prepare("INSERT INTO jobs (name, account_id, template_id, retired) VALUES ('Retired target', 4, ?, '2026-10-01')").run(target.id);
    const durable = testDb.prepare("INSERT INTO jobs (name, account_id, template_id, enabled, retired, last_success_at) VALUES ('Durable', 1, ?, 0, '2026-10-01', '2026-09-01')").run(previous.id);
    const logged = testDb.prepare("INSERT INTO jobs (name, account_id, template_id, enabled, retired) VALUES ('Logged', 2, ?, 0, '2026-10-01')").run(previous.id);
    testDb.prepare("INSERT INTO jobs (name, account_id, template_id, last_success_at) VALUES ('Empty stamp', 4, ?, '')").run(previous.id);
    testDb.prepare("INSERT INTO job_logs (id, job_id, status, retired) VALUES (1, ?, 'success', 1)").run(logged.lastInsertRowid);
    testDb.prepare("INSERT INTO job_logs (id, job_id, status) VALUES (2, ?, 'failed')").run(durable.lastInsertRowid);
    const oldContract = call("get", "/:id/available-accounts", { id: target.id }).body;
    expect(oldContract.map((candidate: any) => candidate.id)).toEqual([2, 4]);
    const all = call("get", "/:id/available-accounts", { id: target.id, query: { includeLinked: "1" } }).body;
    expect(all.map((candidate: any) => candidate.id)).toEqual([1, 2, 4]);
    expect(all[0]).toMatchObject({ linked: true, restriction: "mild", successfulTemplateIds: [previous.id] });
    expect(all[1]).toMatchObject({ linked: false, restriction: "limited", successfulTemplateIds: [previous.id] });
    expect(all[2]).toMatchObject({ linked: false, restriction: null, successfulTemplateIds: [] });
    expect(JSON.stringify(all)).not.toContain("must-not-leak");
    expect(JSON.stringify(all)).not.toContain("session");
  });

  it("marks missing Telegram sessions as uncreatable without rejecting Emby candidates", () => {
    const telegram = template();
    const emby = template({ jobType: "embywatch" });
    account(1);
    testDb.exec("UPDATE tg_accounts SET session_string = NULL WHERE id = 1");
    const telegramAccounts = call("get", "/:id/available-accounts", { id: telegram.id }).body;
    const embyAccounts = call("get", "/:id/available-accounts", { id: emby.id }).body;
    expect(telegramAccounts[0]).toMatchObject({ id: 1, authStatus: "authenticated", canCreate: false });
    expect(embyAccounts[0]).toMatchObject({ id: 1, canCreate: true });
    expect(JSON.stringify(telegramAccounts)).not.toContain("session");
  });

  it("treats encrypted Telegram sessions as unavailable when the key is missing or wrong", () => {
    const telegram = template();
    account(1);
    vi.stubEnv("BEMBY_DATA_KEY", "template-session-key");
    resetSecretKeyCache();
    const encrypted = encryptSecret("session");
    expect(encrypted).toMatch(/^enc:v1:/);
    testDb.prepare("UPDATE tg_accounts SET session_string = ? WHERE id = 1").run(encrypted);

    vi.stubEnv("BEMBY_DATA_KEY", "");
    resetSecretKeyCache();
    const unavailable = call("get", "/:id/available-accounts", { id: telegram.id }).body;
    expect(unavailable[0]).toMatchObject({ authStatus: "authenticated", canCreate: false });
    const eligibility = call("post", "/creation-eligibility", {
      body: { accountIds: [1] },
    }).body;
    expect(eligibility.telegramAccountIds).toEqual([]);
    expect(eligibility.templates[0]).toMatchObject({ candidateCount: 0, eligibleCount: 0 });
    const skipped = call("post", "/:id/create-jobs", { id: telegram.id, body: {
      jobs: [{ accountId: 1, name: "Encrypted without key" }],
      scheduleWindowStart: 1300, scheduleWindowEnd: 2200,
    } });
    expect(skipped.body).toMatchObject({ created: 0, skipped: 1 });

    vi.stubEnv("BEMBY_DATA_KEY", "wrong-template-session-key");
    resetSecretKeyCache();
    const wrongKey = call("get", "/:id/available-accounts", { id: telegram.id }).body;
    expect(wrongKey[0]).toMatchObject({ authStatus: "authenticated", canCreate: false });

    vi.stubEnv("BEMBY_DATA_KEY", "template-session-key");
    resetSecretKeyCache();
    const restored = call("get", "/:id/available-accounts", { id: telegram.id }).body;
    expect(restored[0]).toMatchObject({ authStatus: "authenticated", canCreate: true });
  });
});

describe("account-side template creation eligibility", () => {
  it("counts distinct selected accounts with the same rules as create-jobs, and exposes no credentials", () => {
    const telegram = template();
    const emby = template({ jobType: "embywatch" });
    const checkin = template({ jobType: "checkin" });
    const autoreg = template({ jobType: "autoreg" });
    const disabled = template();
    call("put", "/:id", { id: disabled.id, body: { enabled: false } });
    for (let id = 1; id <= 6; id++) account(id, { disabled: id === 2 });
    testDb.exec(`
      UPDATE tg_accounts SET auth_status = 'unauthenticated' WHERE id = 3;
      UPDATE tg_accounts SET auth_status = 'session_expired', session_string = NULL WHERE id = 4;
      UPDATE tg_accounts SET session_string = '' WHERE id = 5;
    `);
    const insert = testDb.prepare("INSERT INTO jobs (name, account_id, template_id, enabled, retired) VALUES ('Linked', ?, ?, ?, ?)");
    insert.run(1, telegram.id, 0, null);
    insert.run(1, telegram.id, 1, null);
    insert.run(3, telegram.id, 1, null);
    insert.run(6, telegram.id, 1, "2026-10-01");
    insert.run(1, emby.id, 0, null);
    insert.run(3, emby.id, 1, "2026-10-01");
    const response = call("post", "/creation-eligibility", {
      body: { accountIds: [1, 1, 2, 3, 4, 5, 6, 99] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      accountCount: 5, accountIds: [1, 3, 4, 5, 6], telegramAccountIds: [1, 6],
    });
    expect(response.body.templates).toEqual([
      { templateId: telegram.id, candidateCount: 2, eligibleCount: 1, linkedAccountIds: [1, 3] },
      { templateId: emby.id, candidateCount: 5, eligibleCount: 4, linkedAccountIds: [1] },
      { templateId: checkin.id, candidateCount: 2, eligibleCount: 2, linkedAccountIds: [] },
      { templateId: autoreg.id, candidateCount: 2, eligibleCount: 2, linkedAccountIds: [] },
    ]);
    expect(response.body.templates.some((item: any) => item.templateId === disabled.id)).toBe(false);
    expect(JSON.stringify(response.body)).not.toMatch(/session|phone|password|secret/);
    const createTelegram = call("post", "/:id/create-jobs", { id: telegram.id, body: {
      jobs: [1, 2, 3, 4, 5, 6, 99].map((id) => ({ accountId: id, name: `TG ${id}` })),
      scheduleWindowStart: 1300, scheduleWindowEnd: 2200,
    } });
    const createEmby = call("post", "/:id/create-jobs", { id: emby.id, body: {
      jobs: [1, 2, 3, 4, 5, 6, 99].map((id) => ({ accountId: id, name: `Emby ${id}`, config: { username: `user${id}` } })),
      scheduleWindowStart: 1300, scheduleWindowEnd: 2200,
    } });
    expect(createTelegram.body.created).toBe(response.body.templates[0].eligibleCount);
    expect(createEmby.body.created).toBe(response.body.templates[1].eligibleCount);
  });

  it("returns zero counts for fully linked templates and empty selections without a fake Emby account", () => {
    const source = template({ jobType: "embywatch" });
    account(1);
    testDb.prepare("INSERT INTO jobs (name, account_id, template_id) VALUES ('Existing', 1, ?)").run(source.id);
    const linked = call("post", "/creation-eligibility", { body: { accountIds: [1] } }).body;
    expect(linked.templates[0]).toMatchObject({ eligibleCount: 0 });
    const empty = call("post", "/creation-eligibility", { body: { accountIds: [] } }).body;
    expect(empty).toEqual({
      accountCount: 0, accountIds: [], telegramAccountIds: [],
      templates: [{ templateId: source.id, candidateCount: 0, eligibleCount: 0, linkedAccountIds: [] }],
    });
  });

  it("accepts the 2000-account boundary and legacy NULL disabled values", () => {
    const source = template();
    account(1);
    testDb.exec("UPDATE tg_accounts SET disabled = NULL WHERE id = 1");
    const result = call("post", "/creation-eligibility", {
      body: { accountIds: Array.from({ length: 2000 }, (_, index) => index + 1) },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.templates[0]).toEqual({
      templateId: source.id, candidateCount: 1, eligibleCount: 1, linkedAccountIds: [],
    });
  });

  it.each([
    undefined, null, {}, "1,2", [null], [true], ["1"], [0], [-1], [1.5],
    [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: 2001 }, (_, index) => index + 1),
  ].map((accountIds) => ({ accountIds })))("rejects malformed or unbounded account IDs", ({ accountIds }) => {
    expect(call("post", "/creation-eligibility", { body: { accountIds } }).statusCode).toBe(400);
  });
});
