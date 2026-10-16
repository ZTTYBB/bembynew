import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let testDb!: InstanceType<typeof Database>;
const { refreshScheduler } = vi.hoisted(() => ({
  refreshScheduler: vi.fn(),
}));

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("../scheduler", () => ({ refreshScheduler }));

import templatesRouter from "../routes/templates";
import {
  EMBY_TEMPLATE_META_KEY,
  mergeEmbyTemplateConfig,
  parseEmbyConfig,
} from "../jobs/embyTemplate";

const SCHEMA = `
  CREATE TABLE tg_accounts (
    id INTEGER PRIMARY KEY,
    disabled INTEGER NOT NULL DEFAULT 0,
    auth_status TEXT NOT NULL DEFAULT 'authenticated',
    session_string TEXT DEFAULT 'test-session'
  );
  CREATE TABLE job_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    job_type TEXT NOT NULL DEFAULT 'embywatch',
    bot_username TEXT NOT NULL DEFAULT 'https://emby.example.com',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    reply_timeout_ms INTEGER NOT NULL DEFAULT 40000,
    retry_max INTEGER NOT NULL DEFAULT 5,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT,
    start_command TEXT NOT NULL DEFAULT '/start',
    checkin_button TEXT NOT NULL DEFAULT 'checkin',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    run_every_days INTEGER NOT NULL DEFAULT 1,
    run_every_days_max INTEGER,
    category TEXT NOT NULL DEFAULT '',
    run_once INTEGER NOT NULL DEFAULT 0,
    rerun_on_restart INTEGER NOT NULL DEFAULT 0,
    first_run_min_days INTEGER NOT NULL DEFAULT 0,
    first_run_max_days INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    exclusive_account INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    account_id INTEGER,
    job_type TEXT NOT NULL DEFAULT 'embywatch',
    bot_username TEXT NOT NULL DEFAULT '',
    schedule_window_start INTEGER NOT NULL DEFAULT 1000,
    schedule_window_end INTEGER NOT NULL DEFAULT 1200,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    reply_timeout_ms INTEGER NOT NULL DEFAULT 40000,
    retry_max INTEGER NOT NULL DEFAULT 5,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT,
    start_command TEXT NOT NULL DEFAULT '/start',
    checkin_button TEXT NOT NULL DEFAULT 'checkin',
    template_id INTEGER REFERENCES job_templates(id) ON DELETE SET NULL,
    run_every_days INTEGER NOT NULL DEFAULT 1,
    run_every_days_max INTEGER,
    run_once INTEGER NOT NULL DEFAULT 0,
    rerun_on_restart INTEGER NOT NULL DEFAULT 0,
    first_run_min_days INTEGER NOT NULL DEFAULT 0,
    first_run_max_days INTEGER NOT NULL DEFAULT 0,
    retired TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    exclusive_account INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO settings (key, value) VALUES ('default_play_duration', '300');
`;

type StoredRow = { id: number; config: string | null };

function handler(method: "post" | "put", path: string) {
  const layer = (templatesRouter as any).stack.find(
    (item: any) => item.route?.path === path && item.route.methods[method],
  );
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle as (req: any, res: any) => void;
}

function callRoute(method: "post" | "put", path: string, id: number, body: unknown) {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
  };
  handler(method, path)({ params: { id: String(id) }, body }, res);
  return res;
}

function insertTemplate(config: Record<string, unknown>, doubleEncoded = false) {
  const raw = doubleEncoded
    ? JSON.stringify(JSON.stringify(config))
    : JSON.stringify(config);
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO job_templates (name, config) VALUES (?, ?)")
    .run("Emby template", raw);
  return Number(lastInsertRowid);
}

function insertJob(templateId: number, config: Record<string, unknown>) {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO jobs (name, template_id, config) VALUES (?, ?, ?)")
    .run("Linked Emby job", templateId, JSON.stringify(config));
  return Number(lastInsertRowid);
}

function storedJob(id: number) {
  const row = testDb.prepare("SELECT id, config FROM jobs WHERE id = ?").get(id) as StoredRow;
  return parseEmbyConfig(row.config);
}

function effectiveJob(templateId: number, jobId: number) {
  const row = testDb
    .prepare("SELECT id, config FROM job_templates WHERE id = ?")
    .get(templateId) as StoredRow;
  return mergeEmbyTemplateConfig(row.config, storedJob(jobId));
}

function createJob(templateId: number, config: Record<string, unknown>) {
  const res = callRoute("post", "/:id/create-jobs", templateId, {
    jobs: [{ accountId: null, name: "Created Emby job", config }],
    scheduleWindowStart: 1000,
    scheduleWindowEnd: 1200,
  });
  expect(res.statusCode).toBe(201);
  expect(res.body.created).toBe(1);
  return res.body.ids[0] as number;
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  vi.clearAllMocks();
  testDb.exec("DELETE FROM jobs; DELETE FROM job_templates; DELETE FROM tg_accounts;");
  testDb.prepare("UPDATE settings SET value = '300' WHERE key = 'default_play_duration'").run();
});

afterAll(() => {
  testDb.close();
});

describe("real Emby template bulk-create route", () => {
  it("rejects an upper-only job override below its inherited template minimum", () => {
    const templateId = insertTemplate({ playDuration: 500 });
    const res = callRoute("post", "/:id/create-jobs", templateId, {
      jobs: [{ accountId: null, name: "Bad inherited range", config: { username: "alice", playDurationMax: 400 } }],
      scheduleWindowStart: 1000,
      scheduleWindowEnd: 1200,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("less than");
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  it("marks credentials-only jobs as inheriting the full template range", () => {
    const templateId = insertTemplate({
      playDuration: 300,
      playDurationMax: 600,
      userAgent: "TemplateUA",
    });
    const jobId = createJob(templateId, { username: "alice", password: "" });

    expect(storedJob(jobId)[EMBY_TEMPLATE_META_KEY]).toEqual({ overrides: {} });
    expect(effectiveJob(templateId, jobId)).toMatchObject({
      username: "alice",
      password: "",
      playDuration: 300,
      playDurationMax: 600,
      userAgent: "TemplateUA",
    });
    expect(refreshScheduler).toHaveBeenCalledOnce();
  });

  it("preserves a supplied fixed duration rather than writing an empty marker", () => {
    const templateId = insertTemplate({ playDuration: 300, playDurationMax: 600 });
    const jobId = createJob(templateId, {
      username: "alice",
      password: "",
      playDuration: 900,
    });

    expect(storedJob(jobId)[EMBY_TEMPLATE_META_KEY]).toEqual({
      overrides: { playDuration: 900 },
    });
    expect(effectiveJob(templateId, jobId).playDuration).toBe(900);
    expect(effectiveJob(templateId, jobId).playDurationMax).toBeUndefined();
  });

  it("preserves a supplied independent range", () => {
    const templateId = insertTemplate({ playDuration: 300, playDurationMax: 600 });
    const jobId = createJob(templateId, {
      username: "alice",
      password: "",
      playDuration: 900,
      playDurationMax: 1200,
    });

    expect(storedJob(jobId)[EMBY_TEMPLATE_META_KEY]).toEqual({
      overrides: { playDuration: 900, playDurationMax: 1200 },
    });
    expect(effectiveJob(templateId, jobId)).toMatchObject({
      playDuration: 900,
      playDurationMax: 1200,
    });
  });

  it("preserves namespaced duration overrides already supplied by a client", () => {
    const templateId = insertTemplate({ playDuration: 300, playDurationMax: 600 });
    const jobId = createJob(templateId, {
      username: "alice",
      password: "",
      [EMBY_TEMPLATE_META_KEY]: { overrides: { playDuration: 900 } },
    });

    expect(storedJob(jobId)[EMBY_TEMPLATE_META_KEY]).toEqual({
      overrides: { playDuration: 900 },
    });
    expect(effectiveJob(templateId, jobId).playDuration).toBe(900);
    expect(effectiveJob(templateId, jobId).playDurationMax).toBeUndefined();
  });

  it("parses double-encoded legacy templates before merging credentials", () => {
    const templateId = insertTemplate(
      { playDuration: 300, playDurationMax: 600, userAgent: "LegacyUA" },
      true,
    );
    const jobId = createJob(templateId, { username: "alice", password: "pw" });
    const config = storedJob(jobId);

    expect(config).toMatchObject({
      playDuration: 300,
      playDurationMax: 600,
      userAgent: "LegacyUA",
      username: "alice",
      password: "pw",
    });
    expect(Object.keys(config).some((key) => /^\d+$/.test(key))).toBe(false);
  });

  it("treats an explicit empty marker as inheritance despite stale top-level durations", () => {
    const templateId = insertTemplate({ playDuration: 300, playDurationMax: 600 });
    const jobId = createJob(templateId, {
      username: "alice",
      password: "",
      playDuration: 900,
      [EMBY_TEMPLATE_META_KEY]: { overrides: {} },
    });

    expect(storedJob(jobId)[EMBY_TEMPLATE_META_KEY]).toEqual({ overrides: {} });
    expect(effectiveJob(templateId, jobId).playDuration).toBe(300);
  });

  it("rejects an invalid per-job duration before inserting any jobs", () => {
    const templateId = insertTemplate({ playDuration: 300 });
    const res = callRoute("post", "/:id/create-jobs", templateId, {
      jobs: [
        { accountId: null, name: "Good", config: { username: "good", playDuration: 300 } },
        { accountId: null, name: "Bad", config: { username: "bad", playDuration: 29 } },
      ],
      scheduleWindowStart: 1000,
      scheduleWindowEnd: 1200,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("at least 30 seconds");
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    expect(refreshScheduler).not.toHaveBeenCalled();
  });
});

describe("real Emby template update route", () => {
  it("rejects an upper-only template range below the system default on create", () => {
    testDb.prepare("UPDATE settings SET value = '500' WHERE key = 'default_play_duration'").run();
    const res = callRoute("post", "/", 0, {
      name: "Invalid upper-only", jobType: "embywatch", config: { playDurationMax: 400 },
    });
    expect(res.statusCode).toBe(400);
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM job_templates").get()).toEqual({ n: 0 });
  });

  it("rejects an update that would invalidate a linked upper-only override", () => {
    const templateId = insertTemplate({ playDuration: 300 });
    const jobId = insertJob(templateId, {
      username: "alice", password: "pw",
      [EMBY_TEMPLATE_META_KEY]: { overrides: { playDurationMax: 500 } },
    });
    const previous = storedJob(jobId);
    const res = callRoute("put", "/:id", templateId, {
      config: { playDuration: 600 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain(`Linked job ${jobId}`);
    expect(storedJob(jobId)).toEqual(previous);
    const row = testDb.prepare("SELECT config FROM job_templates WHERE id = ?").get(templateId) as StoredRow;
    expect(parseEmbyConfig(row.config)).toEqual({ playDuration: 300 });
    expect(refreshScheduler).not.toHaveBeenCalled();
  });

  it("rolls back the template and earlier linked writes if syncing one job fails", () => {
    const templateId = insertTemplate({ playDuration: 300 });
    const first = insertJob(templateId, { username: "alice", password: "a" });
    const second = insertJob(templateId, { username: "bob", password: "b" });
    testDb.exec(`CREATE TEMP TRIGGER fail_linked_sync BEFORE UPDATE OF config ON jobs
      WHEN NEW.id = ${second} BEGIN SELECT RAISE(ABORT, 'test sync failure'); END;`);
    try {
      expect(() => callRoute("put", "/:id", templateId, { name: "Changed", config: { playDuration: 500 } }))
        .toThrow("test sync failure");
      expect(storedJob(first)).toEqual({ username: "alice", password: "a" });
      const row = testDb.prepare("SELECT name, config FROM job_templates WHERE id = ?").get(templateId) as StoredRow & { name: string };
      expect(row.name).toBe("Emby template");
      expect(parseEmbyConfig(row.config)).toEqual({ playDuration: 300 });
      expect(refreshScheduler).not.toHaveBeenCalled();
    } finally {
      testDb.exec("DROP TRIGGER fail_linked_sync");
    }
  });

  it("does not revive a stale duration after its marker was explicitly cleared", () => {
    const templateId = insertTemplate({ playDuration: 300, playDurationMax: 600 });
    const jobId = insertJob(templateId, {
      username: "alice",
      password: "pw",
      playDuration: 900,
      playDurationMax: 1200,
      [EMBY_TEMPLATE_META_KEY]: { overrides: {} },
    });
    const res = callRoute("put", "/:id", templateId, {
      config: { playDuration: 400, playDurationMax: 800 },
    });

    expect(res.statusCode).toBe(200);
    expect(storedJob(jobId)[EMBY_TEMPLATE_META_KEY]).toEqual({ overrides: {} });
    expect(effectiveJob(templateId, jobId)).toMatchObject({
      username: "alice",
      password: "pw",
      playDuration: 400,
      playDurationMax: 800,
    });
  });

  it("preserves an explicitly marked fixed override when the template range changes", () => {
    const templateId = insertTemplate({ playDuration: 300, playDurationMax: 600 });
    const jobId = insertJob(templateId, {
      username: "alice",
      password: "pw",
      [EMBY_TEMPLATE_META_KEY]: { overrides: { playDuration: 900 } },
    });
    const res = callRoute("put", "/:id", templateId, {
      config: { playDuration: 400, playDurationMax: 800 },
    });

    expect(res.statusCode).toBe(200);
    expect(storedJob(jobId)[EMBY_TEMPLATE_META_KEY]).toEqual({
      overrides: { playDuration: 900 },
    });
    expect(effectiveJob(templateId, jobId).playDuration).toBe(900);
    expect(effectiveJob(templateId, jobId).playDurationMax).toBeUndefined();
    expect(refreshScheduler).toHaveBeenCalledOnce();
  });

  it("migrates only a genuine unmarked legacy override", () => {
    const templateId = insertTemplate({ playDuration: 300, playDurationMax: 600 });
    const inheritedId = insertJob(templateId, {
      username: "inherited",
      password: "",
      playDuration: 300,
      playDurationMax: 600,
    });
    const overrideId = insertJob(templateId, {
      username: "override",
      password: "",
      playDuration: 900,
      playDurationMax: 1200,
    });
    const res = callRoute("put", "/:id", templateId, {
      config: { playDuration: 400, playDurationMax: 800 },
    });

    expect(res.statusCode).toBe(200);
    expect(storedJob(inheritedId)[EMBY_TEMPLATE_META_KEY]).toEqual({ overrides: {} });
    expect(effectiveJob(templateId, inheritedId)).toMatchObject({
      playDuration: 400,
      playDurationMax: 800,
    });
    expect(storedJob(overrideId)[EMBY_TEMPLATE_META_KEY]).toEqual({
      overrides: { playDuration: 900, playDurationMax: 1200 },
    });
    expect(effectiveJob(templateId, overrideId)).toMatchObject({
      playDuration: 900,
      playDurationMax: 1200,
    });
  });

  it("validates a template update before changing the template or linked jobs", () => {
    const templateId = insertTemplate({ playDuration: 300 });
    const jobId = insertJob(templateId, { username: "alice", password: "pw" });
    const res = callRoute("put", "/:id", templateId, {
      config: { playDuration: 400, playDurationMax: 100 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("less than");
    const template = testDb.prepare("SELECT config FROM job_templates WHERE id = ?").get(templateId) as StoredRow;
    expect(parseEmbyConfig(template.config)).toEqual({ playDuration: 300 });
    expect(storedJob(jobId)).toEqual({ username: "alice", password: "pw" });
    expect(refreshScheduler).not.toHaveBeenCalled();
  });
});

describe("template account batch validation", () => {
  function readyTemplate() {
    const id = insertTemplate({});
    testDb.prepare(`
      UPDATE job_templates SET job_type = 'custom', run_every_days = 3,
        run_every_days_max = 5 WHERE id = ?
    `).run(id);
    testDb.exec(`
      INSERT INTO tg_accounts (id) VALUES (1), (2), (3), (4);
      UPDATE tg_accounts SET disabled = 1 WHERE id = 3;
      UPDATE tg_accounts SET auth_status = 'session_expired', session_string = NULL WHERE id = 4;
    `);
    return id;
  }

  it("skips duplicate, invalid, disabled, and expired accounts in one transaction", () => {
    const templateId = readyTemplate();
    const result = callRoute("post", "/:id/create-jobs", templateId, {
      jobs: [1, 1, 2, 3, 4, 999, null].map((accountId) => ({ accountId, name: `Job ${accountId}` })),
      scheduleWindowStart: 1000,
      scheduleWindowEnd: 1200,
      enabled: false,
    });
    expect(result.statusCode).toBe(201);
    expect(result.body).toMatchObject({ created: 2, skipped: 5 });
    const rows = testDb.prepare(
      "SELECT account_id, enabled, run_every_days, run_every_days_max FROM jobs ORDER BY account_id",
    ).all();
    expect(rows).toEqual([
      { account_id: 1, enabled: 0, run_every_days: 3, run_every_days_max: 5 },
      { account_id: 2, enabled: 0, run_every_days: 3, run_every_days_max: 5 },
    ]);
    const repeated = callRoute("post", "/:id/create-jobs", templateId, {
      jobs: [{ accountId: 1, name: "Again" }],
      scheduleWindowStart: 1000,
      scheduleWindowEnd: 1200,
    });
    expect(repeated.body).toMatchObject({ created: 0, skipped: 1 });
  });

  it("applies the account limit to eligible creations instead of invalid candidates", () => {
    const templateId = readyTemplate();
    const result = callRoute("post", "/:id/create-jobs", templateId, {
      jobs: [3, 4, 1, 2].map((accountId) => ({ accountId, name: `Job ${accountId}` })),
      scheduleWindowStart: 0,
      scheduleWindowEnd: 2359,
      maxAccounts: 1,
    });
    expect(result.body).toMatchObject({ created: 1, skipped: 3 });
    expect(testDb.prepare("SELECT account_id FROM jobs").get()).toEqual({ account_id: 1 });
  });

  it.each([
    { scheduleWindowStart: 1260 }, { scheduleWindowEnd: 2400 },
    { scheduleWindowStart: 1201, scheduleWindowEnd: 1200 },
    { scheduleWindowStart: "1000" }, { enabled: 1 }, { maxAccounts: 0 },
    { maxAccounts: 1.5 }, { jobs: [{ accountId: "1", name: "Invalid" }] },
    { jobs: [null] }, { jobs: [{ accountId: 1, name: " " }] },
  ])("rejects invalid parameters before inserting %j", (overrides) => {
    const templateId = readyTemplate();
    const result = callRoute("post", "/:id/create-jobs", templateId, {
      jobs: [{ accountId: 1, name: "Valid" }],
      scheduleWindowStart: 1000,
      scheduleWindowEnd: 1200,
      ...overrides,
    });
    expect(result.statusCode).toBe(400);
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    expect(refreshScheduler).not.toHaveBeenCalled();
  });
});
