import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let testDb!: InstanceType<typeof Database>;
vi.mock("../db/database", () => ({ get db() { return testDb; } }));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));

import templatesRouter from "../routes/templates";

const SCHEMA = `
  CREATE TABLE job_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    job_type TEXT NOT NULL DEFAULT 'checkin', bot_username TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT '', reply_timeout_ms INTEGER NOT NULL DEFAULT 40000,
    retry_max INTEGER NOT NULL DEFAULT 5, enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT, start_command TEXT NOT NULL DEFAULT '/start',
    checkin_button TEXT NOT NULL DEFAULT '签到', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    run_every_days INTEGER NOT NULL DEFAULT 1, run_every_days_max INTEGER,
    category TEXT NOT NULL DEFAULT '', updated_at TEXT,
    run_once INTEGER NOT NULL DEFAULT 0, rerun_on_restart INTEGER NOT NULL DEFAULT 0,
    first_run_min_days INTEGER NOT NULL DEFAULT 0, first_run_max_days INTEGER NOT NULL DEFAULT 0,
    exclusive_account INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, account_id INTEGER,
    job_type TEXT NOT NULL DEFAULT 'checkin', bot_username TEXT NOT NULL DEFAULT '',
    schedule_window_start INTEGER NOT NULL DEFAULT 1000, schedule_window_end INTEGER NOT NULL DEFAULT 1200,
    timezone TEXT NOT NULL DEFAULT '', reply_timeout_ms INTEGER NOT NULL DEFAULT 40000,
    retry_max INTEGER NOT NULL DEFAULT 5, enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT, start_command TEXT NOT NULL DEFAULT '/start', checkin_button TEXT NOT NULL DEFAULT '签到',
    template_id INTEGER, run_every_days INTEGER NOT NULL DEFAULT 1, run_every_days_max INTEGER,
    run_once INTEGER NOT NULL DEFAULT 0, rerun_on_restart INTEGER NOT NULL DEFAULT 0,
    first_run_min_days INTEGER NOT NULL DEFAULT 0, first_run_max_days INTEGER NOT NULL DEFAULT 0,
    retired TEXT, last_success_at TEXT, exclusive_account INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE tg_accounts (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Account',
    phone_number TEXT NOT NULL DEFAULT '', auth_status TEXT NOT NULL DEFAULT 'authenticated',
    session_string TEXT DEFAULT 'session', disabled INTEGER DEFAULT 0,
    tg_display_name TEXT, additional_attributes TEXT
  );
  CREATE TABLE job_logs (id INTEGER PRIMARY KEY, job_id INTEGER, status TEXT);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function handler(method: "post" | "put", path: string) {
  const layer = (templatesRouter as any).stack.find(
    (item: any) => item.route?.path === path && item.route.methods[method],
  );
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle as (req: any, res: any) => void;
}

function call(method: "post" | "put", path: string, id: number, body: unknown) {
  const response: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
  handler(method, path)({ params: { id: String(id) }, body, query: {} }, response);
  return response;
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(SCHEMA);
});
beforeEach(() => {
  testDb.exec("DELETE FROM jobs; DELETE FROM job_templates; DELETE FROM tg_accounts; DELETE FROM settings;");
});
afterAll(() => testDb.close());

describe("template option route contract", () => {
  it("rejects malformed template fields instead of coercing them", () => {
    for (const invalid of [
      { name: " " },
      { name: "ok", jobType: "not-a-type" },
      { name: "ok", jobType: "checkin", botUsername: 7 },
      { name: "ok", enabled: "false" },
      { name: "ok", runEveryDays: 3, runEveryDaysMax: 2 },
    ]) {
      const result = call("post", "/", 0, invalid);
      expect(result.statusCode).toBe(400);
      expect(testDb.prepare("SELECT COUNT(*) AS n FROM job_templates").get()).toEqual({ n: 0 });
    }
  });

  it("stores selected values with jobs and retains them when the template changes", () => {
    const initial = {
      actions: [{ type: "send_command", content: "{mode}" }],
      jobOptions: [{ name: "mode", label: "Mode", options: ["fast", "slow"], default: "fast" }],
    };
    const created = call("post", "/", 0, { name: "Flow", jobType: "custom", config: initial });
    expect(created.statusCode).toBe(201);
    const templateId = created.body.id as number;
    testDb.prepare("INSERT INTO tg_accounts (id) VALUES (1)").run();
    const jobs = call("post", "/:id/create-jobs", templateId, {
      jobs: [{ accountId: 1, name: "Selected", config: { jobOptionValues: { mode: "slow" } } }],
      scheduleWindowStart: 1000, scheduleWindowEnd: 1200,
    });
    expect(jobs.statusCode).toBe(201);
    const jobId = jobs.body.ids[0] as number;
    expect(JSON.parse((testDb.prepare("SELECT config FROM jobs WHERE id = ?").get(jobId) as any).config))
      .toMatchObject({ jobOptions: initial.jobOptions, jobOptionValues: { mode: "slow" } });

    const updated = call("put", "/:id", templateId, {
      config: {
        actions: [{ type: "send_command", content: "{mode}" }],
        jobOptions: [{ name: "mode", label: "Mode", options: ["fast", "slow", "turbo"], default: "turbo" }],
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(JSON.parse((testDb.prepare("SELECT config FROM jobs WHERE id = ?").get(jobId) as any).config))
      .toMatchObject({ jobOptionValues: { mode: "slow" }, jobOptions: [{ options: ["fast", "slow", "turbo"] }] });
  });
});

