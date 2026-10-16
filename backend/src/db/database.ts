import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fuzzyScore } from "./fuzzy";
import { ensureJobSchedulesSchema } from "./jobSchedules";
import {
  ENCRYPTED_ACCOUNT_COLUMNS,
  encryptSecret,
  isEncryptedSecret,
  isSecretEncryptionEnabled,
} from "./secretColumns";
import {
  restoreMissingTemplateOptions,
} from "../jobs/templateOptions";

const DB_PATH =
  process.env.DB_PATH ?? path.resolve(process.cwd(), "data/bemby.db");

const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

// Custom function used by list endpoints for fuzzy text search (see db/fuzzy.ts)
db.function("fuzzy_score", { deterministic: true }, (needle, haystack) =>
  fuzzyScore(needle, haystack),
);

db.exec(`
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    phone_number TEXT   NOT NULL,
    api_id      INTEGER NOT NULL,
    api_hash    TEXT    NOT NULL,
    session_string TEXT,
    auth_status TEXT    NOT NULL DEFAULT 'unauthenticated',
    tg_user_id   TEXT,
    tg_avatar    TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    account_id            INTEGER NOT NULL REFERENCES tg_accounts(id) ON DELETE CASCADE,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL,
    schedule_window_start INTEGER NOT NULL DEFAULT 1400,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
    timezone              TEXT    NOT NULL DEFAULT '',
    reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
    retry_max             INTEGER NOT NULL DEFAULT 5,
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS job_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    ran_at  TEXT    NOT NULL,
    status  TEXT    NOT NULL,
    message TEXT,
    source  TEXT    NOT NULL DEFAULT 'scheduler'
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('default_timezone',     'Australia/Sydney'),
    ('default_max_retry',    '5'),
    ('check_daily_run',      'true'),
    ('default_ua',           'SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0'),
    ('default_play_duration','300'),
    ('default_device_name',  'Mac'),
    ('ai_base_url',          'https://openrouter.ai/api/v1'),
    ('ai_api_key',           ''),
    ('ai_model',             'nvidia/nemotron-nano-12b-v2-vl:free'),
    ('ai_timeout_ms',        '25000'),
    ('ai_fallback_enabled',  'true'),
    ('account_display_with_tg_name','false'),
    ('account_display_with_tg_avatar','false'),
    ('log_retention_days',   '0'),
    ('log_screenshot_max_count', '0'),
    ('ua_presets',           '[{"name":"SenPlayer (Mac)","value":"SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0"},{"name":"Yamby (Android TV)","value":"Yamby/2.0.3.4(Android)"},{"name":"Hills (Windows)","value":"Hills/0.2.1"},{"name":"Lenna (iOS)","value":"Lenna/1.0.15 CFNetwork/1494.0.7 Darwin/23.4.0"},{"name":"VidHub (iOS)","value":"VidHub/2.2.4"}]');
`);

// Seed ua_presets for existing installs that pre-date this setting
try {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(
    "ua_presets",
    '[{"name":"SenPlayer (Mac)","value":"SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0"},{"name":"Yamby (Android TV)","value":"Yamby/2.0.3.4(Android)"},{"name":"Hills (Windows)","value":"Hills/0.2.1"},{"name":"Lenna (iOS)","value":"Lenna/1.0.15 CFNetwork/1494.0.7 Darwin/23.4.0"},{"name":"VidHub (iOS)","value":"VidHub/2.2.4"}]',
  );
} catch {}

/**
 * Runs a data fix-up exactly once, recording completion in the settings table
 * under a migration:<id> key. Value-matching UPDATEs must not re-run on every
 * boot or they silently revert values the user has deliberately set.
 */
function runOnce(id: string, fn: () => void): void {
  const flagKey = `migration:${id}`;
  try {
    const done = db
      .prepare("SELECT 1 FROM settings WHERE key = ?")
      .get(flagKey);
    if (done) return;
    fn();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(
      flagKey,
    );
  } catch (e) {
    console.error(`[db] migration ${id} failed:`, e);
  }
}

// Migrations for columns added after initial schema
try {
  db.exec(
    "ALTER TABLE job_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'scheduler'",
  );
} catch {}
try {
  db.exec("ALTER TABLE jobs ADD COLUMN config TEXT");
} catch {}
runOnce("device-name-tg-runner-to-yamby", () => {
  db.exec(
    "UPDATE settings SET value = 'Yamby' WHERE key = 'default_device_name' AND value = 'tg-runner'",
  );
});
runOnce("device-name-yamby-to-mac", () => {
  db.exec(
    "UPDATE settings SET value = 'Mac' WHERE key = 'default_device_name' AND value = 'Yamby'",
  );
});
runOnce("ua-chrome-to-senplayer", () => {
  db.exec(
    "UPDATE settings SET value = 'SenPlayer/6.1.0 CFNetwork/1490.0.4 Darwin/23.2.0' WHERE key = 'default_ua' AND value = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'",
  );
});
runOnce("ua-senplayer-610-to-612", () => {
  db.exec(
    "UPDATE settings SET value = 'SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0' WHERE key = 'default_ua' AND value = 'SenPlayer/6.1.0 CFNetwork/1490.0.4 Darwin/23.2.0'",
  );
});
// Overwrite placeholder preset values written before correct UAs were researched
runOnce("ua-presets-placeholder-fix", () => {
  db.prepare(
    "UPDATE settings SET value = ? WHERE key = 'ua_presets' AND (value LIKE '%ExoPlayerLib%' OR value LIKE '%VidHub/2.1.0%')",
  ).run(
    '[{"name":"SenPlayer (Mac)","value":"SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0"},{"name":"Yamby (Android TV)","value":"Yamby/2.0.3.4(Android)"},{"name":"Hills (Windows)","value":"Hills/0.2.1"},{"name":"Lenna (iOS)","value":"Lenna/1.0.15 CFNetwork/1494.0.7 Darwin/23.4.0"},{"name":"VidHub (iOS)","value":"VidHub/2.2.4"}]',
  );
});
try {
  db.exec(
    "ALTER TABLE jobs ADD COLUMN start_command TEXT NOT NULL DEFAULT '/start'",
  );
} catch {}
try {
  db.exec(
    "ALTER TABLE jobs ADD COLUMN checkin_button TEXT NOT NULL DEFAULT '签到'",
  );
} catch {}
try {
  db.exec("ALTER TABLE job_logs ADD COLUMN detail TEXT");
} catch {}
try {
  db.exec("ALTER TABLE job_logs ADD COLUMN retired INTEGER NOT NULL DEFAULT 0");
} catch {}
try {
  db.exec(
    "ALTER TABLE jobs ADD COLUMN template_id INTEGER REFERENCES job_templates(id) ON DELETE SET NULL",
  );
} catch {}
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN proxy_id TEXT");
} catch {}
try {
  db.exec(
    "ALTER TABLE tg_accounts ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0",
  );
} catch {}
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN app_client_id TEXT");
} catch {}
try {
  db.exec(
    "ALTER TABLE tg_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
  );
  // only seed sort_order on first migration; subsequent starts must not overwrite user-defined order
  db.exec("UPDATE tg_accounts SET sort_order = id WHERE sort_order = 0");
} catch {}
try {
  db.exec(
    "ALTER TABLE jobs ADD COLUMN run_every_days INTEGER NOT NULL DEFAULT 1",
  );
} catch {}
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN tg_display_name TEXT");
} catch {}
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN tg_username TEXT");
} catch {}
try {
  // String storage avoids losing precision when Telegram IDs exceed JS's safe
  // integer range. Older installs simply receive a nullable column.
  db.exec("ALTER TABLE tg_accounts ADD COLUMN tg_user_id TEXT");
} catch {}
try {
  // Cached Telegram profile thumbnails are optional and can be regenerated by
  // the account metadata refresh endpoint.
  db.exec("ALTER TABLE tg_accounts ADD COLUMN tg_avatar TEXT");
} catch {}
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN notes TEXT");
} catch {}
try {
  db.exec("ALTER TABLE jobs ADD COLUMN retired TEXT");
} catch {}

// Seed default TG app client profiles (Linux is default)
try {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(
    "tg_app_clients",
    JSON.stringify([
      {
        id: "preset-ios",
        name: "iOS",
        deviceModel: "iPhone 13 Pro Max",
        systemVersion: "iOS 15.4.1",
        appVersion: "8.4.2",
        langCode: "en",
        langPack: "ios",
        systemLangCode: "en-US",
        isDefault: false,
      },
      {
        id: "preset-android",
        name: "Android",
        deviceModel: "Samsung SM-G991B",
        systemVersion: "Android 12",
        appVersion: "9.1.1",
        langCode: "en",
        langPack: "android",
        systemLangCode: "en-US",
        isDefault: false,
      },
      {
        id: "preset-windows",
        name: "Windows",
        deviceModel: "Desktop",
        systemVersion: "Windows 10",
        appVersion: "4.16.5",
        langCode: "en",
        langPack: "tdesktop",
        systemLangCode: "en-US",
        isDefault: false,
      },
      {
        id: "preset-mac",
        name: "Mac",
        deviceModel: "MacBook Pro",
        systemVersion: "macOS 13.2",
        appVersion: "8.4.2",
        langCode: "en",
        langPack: "macos",
        systemLangCode: "en-US",
        isDefault: false,
      },
      {
        id: "preset-linux",
        name: "Linux",
        deviceModel: "PC 64bit",
        systemVersion: "Ubuntu 22.04 LTS",
        appVersion: "4.16.5",
        langCode: "en",
        langPack: "tdesktop",
        systemLangCode: "en-US",
        isDefault: true,
      },
    ]),
  );
} catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS job_templates (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    job_type         TEXT    NOT NULL DEFAULT 'checkin',
    bot_username     TEXT    NOT NULL DEFAULT '',
    timezone         TEXT    NOT NULL DEFAULT '',
    reply_timeout_ms INTEGER NOT NULL DEFAULT 40000,
    retry_max        INTEGER NOT NULL DEFAULT 5,
    enabled          INTEGER NOT NULL DEFAULT 1,
    config           TEXT,
    start_command    TEXT    NOT NULL DEFAULT '/start',
    checkin_button   TEXT    NOT NULL DEFAULT '签到',
    run_every_days   INTEGER NOT NULL DEFAULT 1,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// Upgrade path: older databases created job_templates before run_every_days
// existed. This ALTER must run after the CREATE above, not before it. (issue #19)
try {
  db.exec(
    "ALTER TABLE job_templates ADD COLUMN run_every_days INTEGER NOT NULL DEFAULT 1",
  );
} catch {}

// Jobs and templates historically froze the default timezone at creation, so
// changing the default in Settings never affected them (issue #13). An empty
// timezone now means "follow the default_timezone setting", resolved at
// scheduling time. The per-row value was never exposed in the UI, so existing
// rows all hold stale defaults rather than deliberate choices; blank them.
runOnce("timezone-follow-default", () => {
  db.exec("UPDATE jobs SET timezone = ''");
  db.exec("UPDATE job_templates SET timezone = ''");
});

// AI supplier + model tables
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_suppliers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    base_url   TEXT    NOT NULL,
    api_key    TEXT    NOT NULL DEFAULT '',
    timeout_ms INTEGER NOT NULL DEFAULT 25000
  );
  CREATE TABLE IF NOT EXISTS ai_models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES ai_suppliers(id) ON DELETE CASCADE,
    model_id    TEXT    NOT NULL,
    label       TEXT
  );
`);

// Seed default OpenRouter supplier on first run; carry over any legacy flat-settings values for upgrades
try {
  const supplierCount = (
    db.prepare("SELECT COUNT(*) AS n FROM ai_suppliers").get() as { n: number }
  ).n;
  if (supplierCount === 0) {
    const getSetting = (key: string) =>
      (
        db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
          { value: string } | undefined
      )?.value ?? "";
    const apiKey = getSetting("ai_api_key");
    const baseUrl = getSetting("ai_base_url") || "https://openrouter.ai/api/v1";
    const model =
      getSetting("ai_model") || "nvidia/nemotron-nano-12b-v2-vl:free";
    const timeout = getSetting("ai_timeout_ms");
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)",
      )
      .run("OpenRouter", baseUrl, apiKey, Number(timeout) || 25000);
    db.prepare(
      "INSERT INTO ai_models (supplier_id, model_id) VALUES (?, ?)",
    ).run(lastInsertRowid, model);
  }
} catch (e) {
  console.error("[db] AI supplier seed failed:", e);
}

// Make account_id nullable so embywatch jobs don't require a Telegram account
try {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  if (cols.find((c) => c.name === "account_id")?.notnull === 1) {
    // job_logs.job_id -> jobs(id) ON DELETE CASCADE: with foreign_keys on,
    // DROP TABLE jobs below fires that cascade and wipes all job history.
    // Turn enforcement off for the swap, per SQLite's documented table-rebuild pattern.
    // The pragma is a no-op inside a transaction, so it must sit outside; the
    // copy/drop/rename runs in one transaction so a crash mid-swap rolls back
    // instead of leaving jobs dropped and the data stranded in jobs_v2.
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`
        DROP TABLE IF EXISTS jobs_v2;
        CREATE TABLE jobs_v2 (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          name                  TEXT    NOT NULL,
          account_id            INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
          job_type              TEXT    NOT NULL DEFAULT 'checkin',
          bot_username          TEXT    NOT NULL,
          schedule_window_start INTEGER NOT NULL DEFAULT 1400,
          schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
          timezone              TEXT    NOT NULL DEFAULT '',
          reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
          retry_max             INTEGER NOT NULL DEFAULT 5,
          enabled               INTEGER NOT NULL DEFAULT 1,
          created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
          config                TEXT,
          start_command         TEXT    NOT NULL DEFAULT '/start',
          checkin_button        TEXT    NOT NULL DEFAULT '签到',
          template_id           INTEGER REFERENCES job_templates(id) ON DELETE SET NULL,
          run_every_days        INTEGER NOT NULL DEFAULT 1,
          retired               TEXT
        );
        INSERT INTO jobs_v2 SELECT * FROM jobs;
        DROP TABLE jobs;
        ALTER TABLE jobs_v2 RENAME TO jobs;
      `);
      })();
      console.log("[db] Migrated jobs.account_id to nullable");
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
} catch (e) {
  console.error("[db] account_id migration failed:", e);
}

// Range support for "run every X days": a nullable upper bound. When set (and
// greater than run_every_days), each scheduling picks a random interval in
// [run_every_days, run_every_days_max]. Added after the jobs table rebuild above
// so its positional `SELECT *` copy isn't broken by an extra column.
try {
  db.exec("ALTER TABLE jobs ADD COLUMN run_every_days_max INTEGER");
} catch {}
try {
  db.exec("ALTER TABLE job_templates ADD COLUMN run_every_days_max INTEGER");
} catch {}
try {
  db.exec("ALTER TABLE job_templates ADD COLUMN updated_at TEXT");
} catch {}
runOnce("job-templates-updated-at-backfill", () => {
  db.exec("UPDATE job_templates SET updated_at = created_at WHERE updated_at IS NULL");
});

// Durable stamp of a job's last successful run. job_logs is pruned by the
// log_retention_days setting, so the derived value cannot be trusted long-term.
// Added after the jobs table rebuild above so its positional `SELECT *` copy
// isn't broken by an extra column.
try {
  db.exec("ALTER TABLE jobs ADD COLUMN last_success_at TEXT");
} catch {}
// One-shot backfill from whatever log history survives. Guarded by runOnce and
// an IS NULL filter so a later purge never re-writes a live value.
runOnce("jobs-last-success-at-backfill", () => {
  db.exec(`
    UPDATE jobs SET last_success_at = (
      SELECT MAX(l.ran_at) FROM job_logs l
      WHERE l.job_id = jobs.id AND l.status = 'success'
    )
    WHERE last_success_at IS NULL
  `);
});

// When the job's own settings last changed, as opposed to when it was created.
// Added after the jobs table rebuild for the same reason as last_success_at.
try {
  db.exec("ALTER TABLE jobs ADD COLUMN updated_at TEXT");
} catch {}
// Keep new columns after the legacy positional jobs-table rebuild.
for (const table of ["jobs", "job_templates"]) {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  for (const column of ["run_once", "first_run_min_days", "first_run_max_days", "rerun_on_restart"]) {
    if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns.has("exclusive_account")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN exclusive_account INTEGER NOT NULL DEFAULT 0`);
  }
}
if (!(db.prepare("PRAGMA table_info(job_templates)").all() as Array<{ name: string }>)
  .some((column) => column.name === "category")) {
  db.exec("ALTER TABLE job_templates ADD COLUMN category TEXT NOT NULL DEFAULT ''");
}
if (!(db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>)
  .some((column) => column.name === "last_attempt_at")) {
  db.exec("ALTER TABLE jobs ADD COLUMN last_attempt_at TEXT");
}
runOnce("jobs-last-attempt-at-backfill", () => {
  db.exec(`UPDATE jobs SET last_attempt_at = (
    SELECT MAX(l.ran_at) FROM job_logs l WHERE l.job_id = jobs.id
  ) WHERE last_attempt_at IS NULL`);
});
// Existing rows start out equal rather than null, so the list has something to
// show before the job is next edited.
runOnce("jobs-updated-at-backfill", () => {
  db.exec("UPDATE jobs SET updated_at = created_at WHERE updated_at IS NULL");
});

// v1.4.3-patch-1: an older editor could save a linked custom job with the
// selected values but without the template's option definitions. Restore only
// rows that genuinely lack the property; an existing copy may be intentional.
runOnce("custom-template-options-restore", () => {
  const rows = db.prepare(`
    SELECT j.id, j.config AS jobConfig, t.config AS templateConfig
    FROM jobs j
    JOIN job_templates t ON t.id = j.template_id
    WHERE j.job_type = 'custom' AND t.job_type = 'custom'
  `).all() as Array<{
    id: number;
    jobConfig: string | null;
    templateConfig: string | null;
  }>;
  const update = db.prepare("UPDATE jobs SET config = ? WHERE id = ?");
  let restored = 0;
  db.transaction(() => {
    restored = restoreMissingTemplateOptions(rows, (jobId, config) => {
      update.run(JSON.stringify(config), jobId);
    });
  })();
  if (restored > 0) {
    console.log(`[db] restored template options on ${restored} job(s)`);
  }
});

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_message_cache (
      account_id INTEGER NOT NULL,
      chat_id    TEXT    NOT NULL,
      msg_id     INTEGER NOT NULL,
      msg_date   INTEGER NOT NULL,
      payload    TEXT    NOT NULL,
      PRIMARY KEY (account_id, chat_id, msg_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tgmc ON tg_message_cache(account_id, chat_id, msg_id DESC)`,
  );
} catch {}

// Indexes for the job list and log queries, which sort by name / ran_at on every page view
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_retired_enabled_name
      ON jobs(retired, enabled, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_jobs_template_id
      ON jobs(template_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_account_id
      ON jobs(account_id);
    CREATE INDEX IF NOT EXISTS idx_job_logs_ran_at
      ON job_logs(ran_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_logs_job_ran_at
      ON job_logs(job_id, ran_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_logs_retired_ran_at
      ON job_logs(retired, ran_at DESC);
  `);
} catch {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_dialog_cache (
      account_id INTEGER NOT NULL,
      chat_id    TEXT    NOT NULL,
      sort_order INTEGER NOT NULL,
      payload    TEXT    NOT NULL,
      PRIMARY KEY (account_id, chat_id)
    )
  `);
} catch {}

// Make api_id and api_hash nullable so accounts can fall back to global defaults
try {
  const cols = db.prepare("PRAGMA table_info(tg_accounts)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  if (cols.find((c) => c.name === "api_id")?.notnull === 1) {
    // jobs.account_id -> tg_accounts(id) ON DELETE SET NULL: with foreign_keys
    // on, DROP TABLE tg_accounts below fires that cascade on every linked job,
    // wiping account_id to NULL even though the account itself is preserved
    // under the same id in tg_accounts_v2. Turn enforcement off for the swap,
    // per SQLite's documented table-rebuild pattern. The pragma is a no-op
    // inside a transaction, so it must sit outside; the copy/drop/rename runs
    // in one transaction so a crash mid-swap rolls back cleanly.
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`
        CREATE TABLE tg_accounts_v2 (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT    NOT NULL,
          phone_number    TEXT    NOT NULL,
          api_id          INTEGER,
          api_hash        TEXT,
          session_string  TEXT,
          auth_status     TEXT    NOT NULL DEFAULT 'unauthenticated',
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          proxy_id        TEXT,
          disabled        INTEGER NOT NULL DEFAULT 0,
          app_client_id   TEXT,
          sort_order      INTEGER NOT NULL DEFAULT 0,
          tg_display_name TEXT,
          tg_username     TEXT,
          notes           TEXT,
          tg_user_id      TEXT,
          tg_avatar       TEXT
        );
        INSERT INTO tg_accounts_v2 SELECT
          id, name, phone_number,
          NULLIF(api_id, 0), NULLIF(api_hash, ''),
          session_string, auth_status, created_at,
          proxy_id, disabled, app_client_id, sort_order,
          tg_display_name, tg_username, notes, tg_user_id, tg_avatar
        FROM tg_accounts;
        DROP TABLE tg_accounts;
        ALTER TABLE tg_accounts_v2 RENAME TO tg_accounts;
      `);
      })();
      console.log("[db] Migrated tg_accounts api_id/api_hash to nullable");
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
} catch (e) {
  console.error("[db] tg_accounts nullable migration failed:", e);
}

// Bemby-owned per-account columns, added after the nullable rebuild above so that
// rebuild's explicit column list stays untouched:
//   passkey               -- the single passkey secret (JSON); kept in its own column,
//                            never serialised to the UI (holds a private key)
//   additional_attributes -- generic UI-safe flags bag (JSON), e.g. email/restriction status
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN passkey TEXT");
} catch {}
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN additional_attributes TEXT");
} catch {}
// `tg_user_id` was introduced before the nullable-credentials table rebuild
// below existed.  That rebuild has an explicit column list, so databases
// upgraded from the original schema would otherwise lose the column (fresh
// installs and already-new databases do not hit this path).
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN tg_user_id TEXT");
} catch {}
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN tg_avatar TEXT");
} catch {}

// One-time move of passkeys from the old settings key-value store (tg_passkey_secrets)
// onto their account's passkey column. When an account held more than one, keep the
// entry with a known DC (the one usable for login). The old setting is then dropped.
runOnce("passkey-settings-to-column", () => {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'tg_passkey_secrets'")
    .get() as { value: string } | undefined;
  if (!row?.value) return;
  let store: Record<string, any>;
  try {
    store = JSON.parse(row.value);
  } catch {
    return;
  }
  const chosen = new Map<number, any>();
  for (const secret of Object.values(store)) {
    const accountId = (secret as any)?.accountId;
    if (typeof accountId !== "number") continue;
    const current = chosen.get(accountId);
    if (!current || ((secret as any).dcId != null && current.dcId == null)) {
      chosen.set(accountId, secret);
    }
  }
  const upd = db.prepare("UPDATE tg_accounts SET passkey = ? WHERE id = ?");
  for (const [accountId, secret] of chosen) {
    const { accountId: _omit, ...passkey } = secret;
    upd.run(JSON.stringify(passkey), accountId);
  }
  db.prepare("DELETE FROM settings WHERE key = 'tg_passkey_secrets'").run();
});

// Corrective one-off: an earlier build briefly stored the passkey inside the
// additional_attributes bag. Move any stray passkey into the dedicated column (which
// keeps the secret out of the UI-facing bag) and strip it from the bag.
runOnce("passkey-move-out-of-attributes", () => {
  const rows = db
    .prepare(
      "SELECT id, passkey, additional_attributes FROM tg_accounts WHERE additional_attributes IS NOT NULL",
    )
    .all() as Array<{ id: number; passkey: string | null; additional_attributes: string }>;
  const updBoth = db.prepare(
    "UPDATE tg_accounts SET passkey = ?, additional_attributes = ? WHERE id = ?",
  );
  const updAttrs = db.prepare(
    "UPDATE tg_accounts SET additional_attributes = ? WHERE id = ?",
  );
  for (const r of rows) {
    let bag: any;
    try {
      bag = JSON.parse(r.additional_attributes);
    } catch {
      continue;
    }
    if (!bag || typeof bag !== "object" || !("passkey" in bag)) continue;
    const { passkey, ...rest } = bag;
    const restJson = Object.keys(rest).length ? JSON.stringify(rest) : null;
    if (!r.passkey && passkey && typeof passkey === "object") {
      const { accountId: _omit, ...stored } = passkey;
      updBoth.run(JSON.stringify(stored), restJson, r.id);
    } else {
      updAttrs.run(restJson, r.id);
    }
  }
});

// With BEMBY_DATA_KEY configured, bring any credential still sitting in plain text up to
// date. Not a runOnce migration: the key can be turned on at any point, and rows written
// while it was off have to be caught the next time the app starts with it on. Rows already
// encrypted are skipped, so this costs a single scan on a boot with nothing to do.
try {
  if (isSecretEncryptionEnabled()) {
    const rows = db
      .prepare("SELECT id, api_hash, session_string, passkey FROM tg_accounts")
      .all() as Array<{
      id: number;
      api_hash: string | null;
      session_string: string | null;
      passkey: string | null;
    }>;
    const upd = db.prepare(
      "UPDATE tg_accounts SET api_hash = ?, session_string = ?, passkey = ? WHERE id = ?",
    );
    let converted = 0;
    db.transaction(() => {
      for (const r of rows) {
        const pending = ENCRYPTED_ACCOUNT_COLUMNS.some(
          (c) => r[c] && !isEncryptedSecret(r[c]),
        );
        if (!pending) continue;
        upd.run(
          encryptSecret(r.api_hash),
          encryptSecret(r.session_string),
          encryptSecret(r.passkey),
          r.id,
        );
        converted++;
      }
    })();
    if (converted) {
      console.log(`[secrets] encrypted stored credentials for ${converted} account(s)`);
    }
  } else {
    const anyStored = db
      .prepare(
        "SELECT 1 FROM tg_accounts WHERE session_string IS NOT NULL OR passkey IS NOT NULL LIMIT 1",
      )
      .get();
    if (anyStored) {
      console.warn(
        "[secrets] Telegram session strings and passkeys are stored unencrypted. Set " +
          "BEMBY_DATA_KEY to encrypt them at rest (see env.example).",
      );
    }
  }
} catch (e) {
  console.error("[secrets] encryption sweep failed:", e);
}

export const FALLBACK_TIMEZONE = "Australia/Sydney";

/** Returns the default_timezone setting, or the built-in fallback when unset. */
export function getDefaultTimezone(): string {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'default_timezone'")
      .get() as { value: string } | undefined;
    return row?.value || FALLBACK_TIMEZONE;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

/** Returns the global fallback TG API credentials, or null if not configured. */
export function getDefaultTgApiCredentials(): {
  apiId: number;
  apiHash: string;
} | null {
  try {
    const idRow = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("default_tg_api_id") as { value: string } | undefined;
    const hashRow = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("default_tg_api_hash") as { value: string } | undefined;
    const apiId = Number(idRow?.value);
    const apiHash = hashRow?.value ?? "";
    if (!apiId || !apiHash) return null;
    return { apiId, apiHash };
  } catch {
    return null;
  }
}

// This must follow the legacy jobs-table rebuild, which cascades child rows.
ensureJobSchedulesSchema(db);
