import Database from "better-sqlite3";
import express from "express";
import { request as httpRequest, type Server } from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptPayload, encryptPayload } from "../db/exportCrypto";
import { encryptSecret, resetSecretKeyCache } from "../db/secretColumns";
import type { ExportPayload } from "../routes/data";

let testDb: Database.Database;
const state = vi.hoisted(() => ({
  running: [] as unknown[], queued: [] as unknown[], refresh: vi.fn(),
}));
vi.mock("../db/database", () => ({ get db() { return testDb; } }));
vi.mock("../scheduler", () => ({
  refreshScheduler: state.refresh,
  buildScheduleKey: (job: any, timezone: string) => JSON.stringify([
    job.accountId, job.runEveryDays, job.runEveryDaysMax, timezone,
  ]),
}));
vi.mock("../jobs/execution", () => ({
  getExecutionStatus: () => ({ running: state.running, queued: state.queued, maxConcurrent: 2 }),
  readExecutionJob: (id: number) => {
    const row = testDb.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
    return row && { id: row.id, accountId: row.account_id, runEveryDays: row.run_every_days, runEveryDaysMax: row.run_every_days_max };
  },
}));
vi.mock("../auth/credentials", () => ({
  getStoredCredentials: () => ({ passwordHash: "hash" }),
  verifyPassword: async (password: string) => password === "confirm",
  legacyHashPassword: (value: string) => value,
  timingSafeCompare: (a: string, b: string) => a === b,
}));
import router from "../routes/data";
import { warehouse } from "../db/warehouse";
import { JobScheduleStore } from "../db/jobSchedules";
import { ensureTaskQueueSchema } from "../jobs/taskQueue";

const schema = `
  CREATE TABLE tg_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone_number TEXT NOT NULL,
    api_id INTEGER, api_hash TEXT, session_string TEXT, auth_status TEXT NOT NULL,
    proxy_id TEXT, passkey TEXT, additional_attributes TEXT,
    disabled INTEGER NOT NULL DEFAULT 0, app_client_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE job_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, job_type TEXT, bot_username TEXT,
    timezone TEXT, reply_timeout_ms INTEGER, retry_max INTEGER, config TEXT,
    start_command TEXT, checkin_button TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    run_every_days INTEGER NOT NULL DEFAULT 1, run_every_days_max INTEGER,
    run_once INTEGER NOT NULL DEFAULT 0, first_run_min_days INTEGER NOT NULL DEFAULT 0,
    first_run_max_days INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT '',
    rerun_on_restart INTEGER NOT NULL DEFAULT 0,
    exclusive_account INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER REFERENCES tg_accounts(id),
    template_id INTEGER REFERENCES job_templates(id), name TEXT NOT NULL, job_type TEXT,
    bot_username TEXT, schedule_window_start INTEGER, schedule_window_end INTEGER,
    timezone TEXT, reply_timeout_ms INTEGER, retry_max INTEGER, enabled INTEGER,
    config TEXT, start_command TEXT, checkin_button TEXT,
    run_every_days INTEGER NOT NULL DEFAULT 1, run_every_days_max INTEGER,
    last_success_at TEXT, last_attempt_at TEXT, retired TEXT,
    run_once INTEGER NOT NULL DEFAULT 0, first_run_min_days INTEGER NOT NULL DEFAULT 0,
    first_run_max_days INTEGER NOT NULL DEFAULT 0, rerun_on_restart INTEGER NOT NULL DEFAULT 0,
    exclusive_account INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE ai_suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, base_url TEXT, api_key TEXT, timeout_ms INTEGER);
  CREATE TABLE ai_models (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER REFERENCES ai_suppliers(id), model_id TEXT, label TEXT);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
let server: Server;
let base: string;
const originalKey = process.env.BEMBY_DATA_KEY;
function freshDb() {
  testDb?.close();
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(schema);
}
async function post(path: string, body: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Connection: "close" };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const request = httpRequest(`${base}${path}`, {
      method: "POST", headers, agent: false,
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        try { resolve({ status: response.statusCode!, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}
async function callImportRoute(body: unknown) {
  const response: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
  const route = (router as any).stack.find((layer: any) => layer.route?.path === "/import").route;
  await route.stack[0].handle({ body }, response);
  return { status: response.statusCode, body: response.body };
}
function payload(): ExportPayload {
  return {
    version: "1", exportedAt: "2026-10-15T00:00:00.000Z", settings: {},
    accounts: [{ name: "Alice", phoneNumber: "+123", apiId: 1, apiHash: "", sessionString: null,
      authStatus: "authenticated", disabled: true, appClientId: "fixed-profile", sortOrder: 42 }],
    templates: [{ name: "Workflow", jobType: "custom", botUsername: "@bot", timezone: "",
      replyTimeoutMs: 40000, retryMax: 1, config: null, startCommand: "/start",
      checkinButton: "Check", enabled: false, runEveryDays: 3, runEveryDaysMax: 5 }],
    jobs: [{ accountIndex: 0, templateIndex: 0, name: "Task", jobType: "custom",
      botUsername: "@bot", scheduleWindowStart: 1400, scheduleWindowEnd: 1600,
      timezone: "", replyTimeoutMs: 40000, retryMax: 1, enabled: true, config: null,
      startCommand: "/start", checkinButton: "Check", runEveryDays: 3, runEveryDaysMax: 5,
      lastSuccessAt: "2026-10-10T01:00:00.000Z",
      schedule: { nextRun: "2026-10-18T01:30:00.000Z", timezone: "Asia/Shanghai",
        pinned: true, state: "pending", origin: "manual", skippedAt: null } }],
  };
}
beforeEach(async () => {
  freshDb();
  state.running = [];
  state.queued = [];
  state.refresh.mockClear();
  delete process.env.BEMBY_DATA_KEY;
  resetSecretKeyCache();
  const app = express();
  app.use(express.json({ limit: "90mb" }));
  app.use(router);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  testDb.close();
  if (originalKey === undefined) delete process.env.BEMBY_DATA_KEY;
  else process.env.BEMBY_DATA_KEY = originalKey;
  resetSecretKeyCache();
});

describe("full backup workflow contracts", () => {
  it("rejects an import request without a usable JSON body", async () => {
    expect(await callImportRoute(undefined)).toMatchObject({
      status: 400,
      body: { error: "Invalid import request body" },
    });
    expect(await post("/import", [])).toMatchObject({
      status: 400,
      body: { error: "Invalid import request body" },
    });
  });

  it("returns 400 when a parsed backup cannot be serialized", async () => {
    const source = payload() as ExportPayload & { nested?: unknown };
    source.nested = source;
    expect(await callImportRoute({ data: source, mode: "merge" })).toMatchObject({
      status: 400,
      body: { error: "Invalid or unsupported export file" },
    });
    expect(state.refresh).not.toHaveBeenCalled();
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM tg_accounts").get()).toEqual({ n: 0 });
  });

  it("rolls back a merge whose imported default breaks an existing Emby upper bound", async () => {
    testDb.prepare(`INSERT INTO jobs(name,job_type,config,enabled) VALUES ('Existing','embywatch',?,0)`)
      .run(JSON.stringify({ username: "u", playDurationMax: 500 }));
    const source = payload();
    source.settings.default_play_duration = "600";
    expect((await post("/import", { data: source, mode: "merge" })).status).toBe(400);
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM tg_accounts").get()).toEqual({ n: 0 });
    expect(testDb.prepare("SELECT name FROM jobs").all()).toEqual([{ name: "Existing" }]);
    expect(testDb.prepare("SELECT value FROM settings WHERE key = 'default_play_duration'").get()).toBeUndefined();
  });
  it("round-trips one-time job/template options and category without losing pinned plans", async () => {
    const source = payload();
    Object.assign(source.templates![0], { runOnce: true, firstRunMinDays: 0, firstRunMaxDays: 10, category: "join", rerunOnRestart: true });
    Object.assign(source.jobs[0], { runOnce: true, firstRunMinDays: 2, firstRunMaxDays: 5, enabled: false,
      lastAttemptAt: "2026-10-14T01:00:00.000Z", rerunOnRestart: true });
    expect((await post("/import", { data: source, mode: "merge" })).status).toBe(200);
    const exported = await post("/export", {});
    expect(exported.status).toBe(200);
    expect(exported.body.templates[0]).toMatchObject({
      runOnce: true, firstRunMinDays: 0, firstRunMaxDays: 10, category: "join", rerunOnRestart: true,
    });
    expect(exported.body.jobs[0]).toMatchObject({
      runOnce: true, firstRunMinDays: 2, firstRunMaxDays: 5, enabled: false, schedule: source.jobs[0].schedule,
      lastAttemptAt: "2026-10-14T01:00:00.000Z",
      rerunOnRestart: true,
    });
  });
  it("defaults an older backup to no restart reruns and rejects a non-boolean opt-in", async () => {
    const source = payload();
    expect((await post("/import", { data: source, mode: "merge" })).status).toBe(200);
    expect(testDb.prepare("SELECT rerun_on_restart FROM jobs").get()).toEqual({ rerun_on_restart: 0 });
    expect(testDb.prepare("SELECT rerun_on_restart FROM job_templates").get()).toEqual({ rerun_on_restart: 0 });
    (source.jobs[0] as any).rerunOnRestart = "true";
    expect((await post("/import", { data: source, mode: "merge" })).status).toBe(400);
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
  });
  it("rejects invalid first-run ranges before replace-mode changes existing rows", async () => {
    testDb.prepare("INSERT INTO job_templates(name) VALUES ('Keep')").run();
    const source = payload();
    source.jobs[0].firstRunMinDays = 5;
    source.jobs[0].firstRunMaxDays = 2;
    expect((await post("/import", { data: source, mode: "replace", confirmPassword: "confirm" })).status).toBe(400);
    expect(testDb.prepare("SELECT name FROM job_templates").all()).toEqual([{ name: "Keep" }]);
  });
  it("does not treat placeholder-shaped objects in variables as workflow actions", async () => {
    const source = payload();
    const value = { type: "for_each", source: "warehouse", folderId: 99, actions: [{ any: "data" }] };
    source.jobs[0].config = JSON.stringify({
      variables: { example: value },
      actions: [{ type: "set_variables", variables: [{ name: "example", value }] }],
    });
    expect((await post("/import", { data: source, mode: "merge" })).status).toBe(200);
    const row = testDb.prepare("SELECT config FROM jobs").get() as { config: string };
    expect(JSON.parse(row.config).variables.example).toEqual(value);
    expect(JSON.parse(row.config).actions[0].variables[0].value).toEqual(value);
  });

  it.each(["constructor", "__proto__", 0, -1, 1.5, "1"])("rejects invalid warehouse workflow folderId %s", async (folderId) => {
    const source = payload();
    source.jobs[0].config = JSON.stringify({ actions: [{ type: "for_each", source: "warehouse", folderId, actions: [] }] });
    expect((await post("/import", { data: source, mode: "merge" })).status).toBe(400);
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM tg_accounts").get()).toEqual({ n: 0 });
  });

  it.each(["api_hash", "session_string", "passkey"] as const)("refuses an incomplete export when encrypted %s cannot be read", async (column) => {
    process.env.BEMBY_DATA_KEY = "original local data key";
    resetSecretKeyCache();
    const stored = encryptSecret(column === "passkey" ? '{"privateKeyPem":"private"}' : "private");
    testDb.prepare(`INSERT INTO tg_accounts(name,phone_number,auth_status,${column}) VALUES ('A','+1','unauthenticated',?)`).run(stored);
    delete process.env.BEMBY_DATA_KEY;
    resetSecretKeyCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await post("/export", { secret: "backup" })).toMatchObject({ status: 409 });
    } finally {
      warn.mockRestore();
    }
  });

  it("distinguishes an absent passkey from invalid stored passkey JSON", async () => {
    testDb.prepare("INSERT INTO tg_accounts(name,phone_number,auth_status) VALUES ('A','+1','unauthenticated')").run();
    expect((await post("/export", {})).status).toBe(200);
    testDb.prepare("UPDATE tg_accounts SET passkey = 'broken-json'").run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await post("/export", {})).status).toBe(409);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["jobs", "job_templates"] as const)(
    "requires encrypted exports for legacy double-encoded Emby credentials in %s",
    async (table) => {
      const config = JSON.stringify(JSON.stringify({ username: "viewer", password: "legacy-private" }));
      testDb.prepare(`INSERT INTO ${table}(name, job_type, config) VALUES ('Legacy', 'embywatch', ?)`).run(config);
      expect(await post("/export", {})).toMatchObject({ status: 400, body: { code: "SECRET_REQUIRED" } });
      const exported = await post("/export", { secret: "backup-password" });
      expect(exported.status).toBe(200);
      expect(JSON.stringify(exported.body)).not.toContain("legacy-private");
      const restored = JSON.parse(decryptPayload(exported.body, "backup-password"));
      expect(restored[table === "jobs" ? "jobs" : "templates"][0].config).toBe(config);
    },
  );

  it("preserves account flags, template cadence, success stamps and durable plans through the real routes", async () => {
    const source = payload();
    expect((await post("/import", { data: source, mode: "merge", forceReauth: false })).status).toBe(200);
    const exported = await post("/export", {});
    expect(exported.status).toBe(200);
    expect(exported.body.accounts[0]).toMatchObject({ disabled: true, appClientId: "fixed-profile", sortOrder: 42 });
    expect(exported.body.templates[0]).toMatchObject({ enabled: false, runEveryDays: 3, runEveryDaysMax: 5 });
    expect(exported.body.jobs[0]).toMatchObject({ runEveryDays: 3, runEveryDaysMax: 5,
      lastSuccessAt: source.jobs[0].lastSuccessAt, schedule: source.jobs[0].schedule });
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it("remaps nested workflow folders, account IDs and plan fingerprints on merge", async () => {
    warehouse.createFolder({ name: "Existing" });
    testDb.prepare("INSERT INTO tg_accounts(name,phone_number,auth_status) VALUES ('Old','+9','unauthenticated')").run();
    const source = payload();
    source.warehouse = { version: 1, omittedSensitive: 0, folders: [
      { key: "1", parentKey: null, name: "Parent", records: [] },
      { key: "2", parentKey: "1", name: "Codes", records: [{ name: "First", data: { code: "ABC" }, sensitive: false, processed: true }] },
    ] };
    source.jobs[0].config = JSON.stringify({ actions: [{ type: "if_check", thenActions: [
      { type: "repeat", count: 1, actions: [{ type: "for_each", source: "warehouse", folderId: 2, actions: [] }] },
    ] }] });
    source.templates![0].config = source.jobs[0].config;
    const result = await post("/import", { data: source, mode: "merge", forceReauth: false });
    expect(result).toMatchObject({ status: 200, body: { schedulesImported: 1, warehouseFoldersImported: 2, warehouseRecordsImported: 1 } });
    const folder = warehouse.folders().find((entry) => entry.name === "Codes")!;
    expect(folder.id).not.toBe(2);
    const job = testDb.prepare("SELECT * FROM jobs").get() as any;
    expect(job.account_id).toBe(2);
    expect(JSON.parse(job.config).actions[0].thenActions[0].actions[0].folderId).toBe(folder.id);
    const template = testDb.prepare("SELECT config FROM job_templates").get() as any;
    expect(JSON.parse(template.config).actions[0].thenActions[0].actions[0].folderId).toBe(folder.id);
    expect(new JobScheduleStore(testDb).get(job.id)?.scheduleKey).toBe(JSON.stringify([2, 3, 5, "Asia/Shanghai"]));
    expect(warehouse.records(folder.id)[0].processed).toBe(true);
  });

  it("restores an in-flight plan as interrupted instead of replaying its action", async () => {
    const source = payload();
    source.jobs[0].schedule!.state = "dispatching";
    expect((await post("/import", { data: source, mode: "merge" })).status).toBe(200);
    expect(new JobScheduleStore(testDb).list()[0]).toMatchObject({ state: "interrupted", pinned: true });
  });

  it("requires encrypted full exports when warehouse records are sensitive", async () => {
    process.env.BEMBY_DATA_KEY = "local-test-data-key";
    resetSecretKeyCache();
    const folder = warehouse.createFolder({ name: "Private" });
    warehouse.createRecord(folder.id, { name: "Login", sensitive: true, data: { password: "secret" } });
    expect(await post("/export", {})).toMatchObject({ status: 400, body: { code: "SECRET_REQUIRED" } });
    const exported = await post("/export", { secret: "backup-password" });
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).not.toContain("secret");
    const restored = JSON.parse(decryptPayload(exported.body, "backup-password"));
    expect(restored.warehouse.folders[0].records[0].data).toEqual({ password: "secret" });
    freshDb();
    const imported = await post("/import", { data: exported.body, mode: "merge", secret: "backup-password" });
    expect(imported.status).toBe(200);
    expect(warehouse.records(warehouse.folders()[0].id)[0].sensitive).toBe(true);
  });

  it("rolls back records and business rows when a nested workflow folder is absent", async () => {
    const source = payload();
    source.jobs[0].config = JSON.stringify({ actions: [{ type: "for_each", source: "warehouse", folderId: 99, actions: [] }] });
    const imported = await post("/import", { data: source, mode: "merge" });
    expect(imported).toMatchObject({ status: 400 });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM tg_accounts").get()).toEqual({ n: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  it.each(["running", "queued"] as const)("refuses replace while an execution is %s", async (kind) => {
    state[kind] = [{ jobId: 1 }];
    const imported = await post("/import", { data: payload(), mode: "replace", confirmPassword: "confirm" });
    expect(imported).toMatchObject({ status: 409, body: { code: "EXECUTIONS_ACTIVE" } });
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("clears pending batches and old nested warehouse data before a confirmed replace", async () => {
    ensureTaskQueueSchema(testDb);
    testDb.prepare(`INSERT INTO task_batches(id,state,concurrency,start_interval_ms,success_tags,created_at,updated_at)
      VALUES ('old','paused',1,0,'{}','now','now')`).run();
    testDb.prepare("INSERT INTO task_queue_items(batch_id,job_id,job_name,status) VALUES ('old',1,'old','pending')").run();
    const parent = warehouse.createFolder({ name: "Old" });
    warehouse.createFolder({ name: "Child", parentId: parent.id });
    const imported = await post("/import", { data: payload(), mode: "replace", confirmPassword: "confirm" });
    expect(imported.status).toBe(200);
    expect(warehouse.folders()).toEqual([]);
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM task_queue_items").get()).toEqual({ n: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM task_batches").get()).toEqual({ n: 0 });
  });

  it("accepts legacy backups and rejects invalid options or broken encrypted envelopes", async () => {
    const legacy = { version: "1", accounts: [], jobs: [], settings: {} };
    expect((await post("/import", { data: legacy, mode: "merge" })).status).toBe(200);
    expect((await post("/import", { data: legacy, mode: "unknown" })).status).toBe(400);
    expect((await post("/import", { data: legacy, mode: "merge", forceReauth: "false" })).status).toBe(400);
    const envelope = encryptPayload(JSON.stringify(legacy), "right");
    expect(await post("/import", { data: envelope, mode: "merge", secret: "wrong" }))
      .toMatchObject({ status: 400, body: { code: "WRONG_SECRET" } });
  });
});
