import Database from "better-sqlite3";
import { ensureJobSchedulesSchema } from "../../db/jobSchedules";

export function managedDb(filename = ":memory:"): Database.Database {
  const database = new Database(filename);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS tg_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'Account',
      phone_number TEXT NOT NULL DEFAULT '',
      api_id INTEGER, api_hash TEXT, session_string TEXT,
      auth_status TEXT NOT NULL DEFAULT 'authenticated',
      disabled INTEGER NOT NULL DEFAULT 0,
      proxy_id TEXT, app_client_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'Job',
      account_id INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
      job_type TEXT NOT NULL DEFAULT 'embywatch',
      bot_username TEXT NOT NULL DEFAULT 'https://emby.example.com',
      schedule_window_start INTEGER NOT NULL DEFAULT 1000,
      schedule_window_end INTEGER NOT NULL DEFAULT 1200,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      reply_timeout_ms INTEGER NOT NULL DEFAULT 40000,
      retry_max INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      config TEXT, start_command TEXT DEFAULT '/start', checkin_button TEXT DEFAULT 'checkin',
      template_id INTEGER, run_every_days INTEGER DEFAULT 1, run_every_days_max INTEGER,
      retired TEXT, last_success_at TEXT, last_attempt_at TEXT, updated_at TEXT,
      run_once INTEGER NOT NULL DEFAULT 0,
      rerun_on_restart INTEGER NOT NULL DEFAULT 0,
      first_run_min_days INTEGER NOT NULL DEFAULT 0,
      first_run_max_days INTEGER NOT NULL DEFAULT 0
      , exclusive_account INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      ran_at TEXT NOT NULL, status TEXT NOT NULL, message TEXT, detail TEXT,
      source TEXT NOT NULL DEFAULT 'scheduler'
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  ensureJobSchedulesSchema(database);
  return database;
}

export function insertManagedJob(database: Database.Database, name = "Job"): number {
  return Number(database.prepare("INSERT INTO jobs (name) VALUES (?)").run(name).lastInsertRowid);
}

export function setSetting(database: Database.Database, key: string, value: string): void {
  database.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}
