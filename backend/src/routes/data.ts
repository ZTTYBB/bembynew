import { Router } from 'express';
import { db } from '../db/database';
import { decryptPayload, encryptPayload, type EncryptedEnvelope } from '../db/exportCrypto';
import { decryptAccountRow, encryptSecret, isEncryptedSecret } from '../db/secretColumns';
import { buildScheduleKey, refreshScheduler } from '../scheduler';
import { JobScheduleStore, type JobSchedule } from '../db/jobSchedules';
import { ensureWarehouseSchema, warehouse } from '../db/warehouse';
import { getExecutionStatus, readExecutionJob } from '../jobs/execution';
import { ensureTaskQueueSchema } from '../jobs/taskQueue';
import { normalizeJobOptions } from '../jobs/jobOptions';
import { mergeEmbyTemplateConfig, parseEmbyConfig, validateEffectiveEmbyDurations } from '../jobs/embyTemplate';
import {
  verifyPassword,
  legacyHashPassword,
  timingSafeCompare,
  getStoredCredentials,
} from '../auth/credentials';
import {
  savePasskeySecret,
  parseStoredPasskey,
  importedPasskeyFor,
  type StoredPasskey,
} from '../tg/passkeyStore';
import {
  parseAttributes,
  writeAttributes,
  foldImportedAttributes,
  LEGACY_PASSKEY_STORE_KEY,
} from '../db/accountAttributes';

// Admin/JWT secrets are instance-local and must never travel in a backup.
export const EXPORT_EXCLUDED_SETTINGS = new Set([
  'admin_password_hash',
  'admin_username',
  'jwt_secret',
  // Session revocation state and one-shot migrations belong to this
  // installation. Importing them from another database could roll back the
  // token epoch (reviving old JWTs) or suppress a pending startup migration.
  'token_epoch',
  // References an instance-local ai_models row id; meaningless after import
  'ai_default_model_id',
]);

// Settings whose presence forces the export to be encrypted. Proxy entries carry their
// credentials in the URL, and a provider entry carries the seller's API token.
export const SENSITIVE_SETTING_KEYS = [
  'default_tg_api_hash',
  'proxies',
  'proxy_providers',
  'webshare_api_key',
  // Whoever holds the notification bot's token can act as that bot
  'notify_bot_token',
  'ai_api_key',
  'cf_cloak_keys',
];

// Config keys that carry a credential (e.g. Emby login) inside a job/template config blob.
const SENSITIVE_CONFIG_KEYS = ['password', 'username'];
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/** True if a job/template config JSON string carries a credential field. */
function configHasSecret(config: string | null | undefined): boolean {
  if (!config) return false;
  try {
    let parsed = JSON.parse(config) as unknown;
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return SENSITIVE_CONFIG_KEYS.some((k) => Boolean((parsed as Record<string, unknown>)[k]));
  } catch {
    return false;
  }
}

// Encryption is mandatory when the payload carries any credential-bearing field:
// session strings, API keys, per-account API hashes, sensitive settings, or an
// Emby username/password embedded in a job/template config.
export function exportRequiresEncryption(
  payload: Pick<ExportPayload, 'accounts' | 'aiSuppliers' | 'settings'> &
    Partial<Pick<ExportPayload, 'jobs' | 'templates' | 'warehouse'>>,
): boolean {
  return (
    payload.accounts.some(
      (a) => a.sessionString || a.apiHash || a.passkey?.privateKeyPem,
    ) ||
    (payload.aiSuppliers ?? []).some((s) => s.apiKey) ||
    SENSITIVE_SETTING_KEYS.some((k) => Boolean(payload.settings?.[k])) ||
    (payload.jobs ?? []).some((j) => configHasSecret(j.config)) ||
    (payload.templates ?? []).some((t) => configHasSecret(t.config)) ||
    (payload.warehouse?.folders ?? []).some((folder) => folder.records.some((record) => record.sensitive))
  );
}

const router = Router();

try {
  for (const table of ["jobs", "job_templates"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.length && !columns.some((column) => column.name === "exclusive_account")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN exclusive_account INTEGER NOT NULL DEFAULT 0`);
    }
  }
} catch {}

type AccountRow = {
  id: number;
  name: string;
  phone_number: string;
  api_id: number;
  api_hash: string;
  session_string: string | null;
  auth_status: string;
  proxy_id: string | null;
  passkey: string | null;
  additional_attributes: string | null;
  disabled: number;
  app_client_id: string | null;
  sort_order: number;
};

type JobRow = {
  id: number;
  account_id: number | null;
  template_id: number | null;
  name: string;
  job_type: string;
  bot_username: string;
  schedule_window_start: number;
  schedule_window_end: number;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
  run_every_days: number;
  run_every_days_max: number | null;
  run_once: number;
  first_run_min_days: number;
  first_run_max_days: number;
  rerun_on_restart: number;
  exclusive_account: number;
  last_success_at: string | null;
  last_attempt_at: string | null;
  retired: string | null;
};

type TemplateRow = {
  id: number;
  name: string;
  job_type: string;
  bot_username: string;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
  enabled: number;
  run_every_days: number;
  run_every_days_max: number | null;
  run_once: number;
  first_run_min_days: number;
  first_run_max_days: number;
  rerun_on_restart: number;
  exclusive_account: number;
  category: string;
};

type SettingRow = { key: string; value: string };

type AiSupplierRow = {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  timeout_ms: number;
};

type AiModelRow = {
  id: number;
  supplier_id: number;
  model_id: string;
  label: string | null;
};

export type ExportPayload = {
  version: '1';
  exportedAt: string;
  accounts: Array<{
    name: string;
    phoneNumber: string;
    apiId: number;
    apiHash: string;
    sessionString: string | null;
    authStatus: string;
    proxyId?: string | null;
    // Passkey secret and generic flags travel inline with the account so nothing needs
    // remapping on import (a raw settings blob would keep stale, detached account ids).
    passkey?: StoredPasskey | null;
    additionalAttributes?: Record<string, unknown> | null;
    disabled?: boolean;
    appClientId?: string | null;
    sortOrder?: number;
  }>;
  templates?: Array<{
    name: string;
    jobType: string;
    botUsername: string;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    config: string | null;
    startCommand: string;
    checkinButton: string;
    enabled?: boolean;
    runEveryDays?: number;
    runEveryDaysMax?: number | null;
    runOnce?: boolean;
    firstRunMinDays?: number;
    firstRunMaxDays?: number;
    rerunOnRestart?: boolean;
    exclusiveAccount?: boolean;
    category?: string;
  }>;
  jobs: Array<{
    /** Index into the accounts array; null for jobs that don't require an account */
    accountIndex: number | null;
    /** Index into the templates array; null if not linked to a template */
    templateIndex?: number | null;
    name: string;
    jobType: string;
    botUsername: string;
    scheduleWindowStart: number;
    scheduleWindowEnd: number;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    enabled: boolean;
    config: string | null;
    startCommand: string;
    checkinButton: string;
    runEveryDays?: number;
    runEveryDaysMax?: number | null;
    runOnce?: boolean;
    firstRunMinDays?: number;
    firstRunMaxDays?: number;
    rerunOnRestart?: boolean;
    exclusiveAccount?: boolean;
    lastSuccessAt?: string | null;
    lastAttemptAt?: string | null;
    retired?: string | null;
    schedule?: Pick<JobSchedule, 'nextRun' | 'timezone' | 'pinned' | 'state' | 'origin' | 'skippedAt'>;
  }>;
  aiSuppliers?: Array<{
    name: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  }>;
  aiModels?: Array<{
    /** Index into the aiSuppliers array */
    supplierIndex: number;
    modelId: string;
    label: string | null;
  }>;
  settings: Record<string, string>;
  warehouse?: ReturnType<typeof warehouse.export>;
};

function remapWarehouseConfig(config: string | null, folderIds: Record<string, number>): string | null {
  if (!config) return config;
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  } catch {
    return config;
  }
  const visitAction = (value: unknown, depth = 0): void => {
    if (depth > 40) throw new Error('Config nesting is too deep');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    if (node.type === 'for_each' && node.source === 'warehouse') {
      if (!Number.isSafeInteger(node.folderId) || Number(node.folderId) < 1) {
        throw new Error('Warehouse workflow folderId is invalid');
      }
      const key = String(node.folderId);
      if (!Object.prototype.hasOwnProperty.call(folderIds, key)) {
        throw new Error('Warehouse folder referenced by a workflow is missing from the backup');
      }
      node.folderId = folderIds[key];
    }
    for (const childKey of ['actions', 'thenActions', 'elseActions'] as const) {
      const children = node[childKey];
      if (children === undefined) continue;
      if (!Array.isArray(children)) throw new Error(`Workflow ${childKey} must be an array`);
      children.forEach((child) => visitAction(child, depth + 1));
    }
  };
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const actions = (parsed as Record<string, unknown>).actions;
    if (actions !== undefined) {
      if (!Array.isArray(actions)) throw new Error('Workflow actions must be an array');
      actions.forEach((action) => visitAction(action));
    }
  }
  return JSON.stringify(parsed);
}

function decryptAccountsForExport(rows: AccountRow[]): AccountRow[] {
  return rows.map((row) => {
    const encrypted = {
      apiHash: isEncryptedSecret(row.api_hash),
      sessionString: isEncryptedSecret(row.session_string),
      passkey: isEncryptedSecret(row.passkey),
    };
    const account = decryptAccountRow(row);
    if (
      (encrypted.apiHash && account.api_hash == null) ||
      (encrypted.sessionString && account.session_string == null) ||
      (encrypted.passkey && account.passkey == null)
    ) {
      throw new Error(`Account ${account.id} has a secret that cannot be decrypted`);
    }
    if (account.passkey != null && parseStoredPasskey(account.passkey) == null) {
      throw new Error(`Account ${account.id} has an invalid stored passkey`);
    }
    return account;
  });
}

function runInterval(value: unknown, fallback = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error('Invalid runEveryDays');
  }
  return Number(value);
}

function runIntervalMax(value: unknown, min: number): number | null {
  if (value == null) return null;
  const max = runInterval(value);
  if (max < min) throw new Error('runEveryDaysMax must not be below runEveryDays');
  return max;
}

/** Ids of the proxies currently configured, for validating references against. */
function configuredProxyIds(): Set<string> {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'proxies'").get() as
    | { value: string }
    | undefined;
  try {
    const list = JSON.parse(row?.value ?? '[]') as Array<{ id?: string }>;
    return new Set(list.map((p) => p.id).filter((id): id is string => !!id));
  } catch {
    return new Set();
  }
}

/**
 * Drops proxy references that point at proxies this instance does not have: the account
 * column, and the `proxyId` inside job and template configs. Returns how many were
 * cleared. A dangling reference is worse than none, because it silently resolves to no
 * proxy at all instead of the one the job was set up with.
 */
export function clearDanglingProxyRefs(): number {
  const known = configuredProxyIds();
  let cleared = 0;

  const accounts = db
    .prepare("SELECT id, proxy_id FROM tg_accounts WHERE proxy_id IS NOT NULL AND proxy_id != ''")
    .all() as Array<{ id: number; proxy_id: string }>;
  for (const a of accounts) {
    if (known.has(a.proxy_id)) continue;
    db.prepare('UPDATE tg_accounts SET proxy_id = NULL WHERE id = ?').run(a.id);
    cleared++;
  }

  for (const table of ['jobs', 'job_templates'] as const) {
    const rows = db
      .prepare(`SELECT id, config FROM ${table} WHERE config IS NOT NULL AND config LIKE '%proxyId%'`)
      .all() as Array<{ id: number; config: string }>;
    for (const row of rows) {
      let cfg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.config);
        cfg = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
      } catch {
        continue;
      }
      const proxyId = cfg?.proxyId;
      if (typeof proxyId !== 'string' || !proxyId || known.has(proxyId)) continue;
      delete cfg.proxyId;
      db.prepare(`UPDATE ${table} SET config = ? WHERE id = ?`).run(JSON.stringify(cfg), row.id);
      cleared++;
    }
  }

  return cleared;
}

router.post('/export', (req, res) => {
  const { secret } = req.body as { secret?: string };
  if (secret !== undefined && (typeof secret !== 'string' || !secret || secret.length > 1024)) {
    res.status(400).json({ error: 'Invalid encryption secret' });
    return;
  }

  try {
  const accounts = decryptAccountsForExport(
    db.prepare('SELECT * FROM tg_accounts ORDER BY id').all() as AccountRow[],
  );
  const templates = db.prepare('SELECT * FROM job_templates ORDER BY id').all() as TemplateRow[];
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY id').all() as JobRow[];
  const aiSuppliers = db.prepare('SELECT * FROM ai_suppliers ORDER BY id').all() as AiSupplierRow[];
  const aiModels = db.prepare('SELECT * FROM ai_models ORDER BY id').all() as AiModelRow[];
  const settings = db.prepare('SELECT key, value FROM settings').all() as SettingRow[];

  const accountIdToIndex = new Map(accounts.map((a, i) => [a.id, i]));
  const templateIdToIndex = new Map(templates.map((t, i) => [t.id, i]));
  const supplierIdToIndex = new Map(aiSuppliers.map((s, i) => [s.id, i]));
  const plans = new Map(new JobScheduleStore(db).list().map((plan) => [plan.jobId, plan]));

  const payload: ExportPayload = {
    version: '1',
    exportedAt: new Date().toISOString(),
    accounts: accounts.map(a => ({
      name: a.name,
      phoneNumber: a.phone_number,
      apiId: a.api_id,
      apiHash: a.api_hash,
      sessionString: a.session_string,
      authStatus: a.auth_status,
      proxyId: a.proxy_id ?? null,
      passkey: parseStoredPasskey(a.passkey),
      additionalAttributes: parseAttributes(a.additional_attributes),
      disabled: Boolean(a.disabled),
      appClientId: a.app_client_id ?? null,
      sortOrder: a.sort_order ?? 0,
    })),
    templates: templates.map(t => ({
      name: t.name,
      jobType: t.job_type,
      botUsername: t.bot_username,
      timezone: t.timezone,
      replyTimeoutMs: t.reply_timeout_ms,
      retryMax: t.retry_max,
      config: t.config,
      startCommand: t.start_command,
      checkinButton: t.checkin_button,
      enabled: t.enabled === 1,
      runEveryDays: t.run_every_days ?? 1,
      runEveryDaysMax: t.run_every_days_max ?? null,
      runOnce: Boolean(t.run_once),
      firstRunMinDays: t.first_run_min_days ?? 0,
      firstRunMaxDays: t.first_run_max_days ?? 0,
      rerunOnRestart: Boolean(t.rerun_on_restart),
      exclusiveAccount: Boolean(t.exclusive_account),
      category: t.category ?? '',
    })),
    jobs: jobs.map(j => ({
      accountIndex: j.account_id != null ? (accountIdToIndex.get(j.account_id) ?? null) : null,
      templateIndex: j.template_id != null ? (templateIdToIndex.get(j.template_id) ?? null) : null,
      name: j.name,
      jobType: j.job_type,
      botUsername: j.bot_username,
      scheduleWindowStart: j.schedule_window_start,
      scheduleWindowEnd: j.schedule_window_end,
      timezone: j.timezone,
      replyTimeoutMs: j.reply_timeout_ms,
      retryMax: j.retry_max,
      enabled: j.enabled === 1,
      config: j.config,
      startCommand: j.start_command,
      checkinButton: j.checkin_button,
      runEveryDays: j.run_every_days ?? 1,
      runEveryDaysMax: j.run_every_days_max ?? null,
      runOnce: Boolean(j.run_once),
      firstRunMinDays: j.first_run_min_days ?? 0,
      firstRunMaxDays: j.first_run_max_days ?? 0,
      rerunOnRestart: Boolean(j.rerun_on_restart),
      exclusiveAccount: Boolean(j.exclusive_account),
      lastSuccessAt: j.last_success_at ?? null,
      lastAttemptAt: j.last_attempt_at ?? null,
      retired: j.retired ?? null,
      schedule: (() => {
        const plan = plans.get(j.id);
        if (!plan) return undefined;
        const { nextRun, timezone, pinned, state, origin, skippedAt } = plan;
        return { nextRun, timezone, pinned, state, origin, skippedAt };
      })(),
    })),
    aiSuppliers: aiSuppliers.map(s => ({
      name: s.name,
      baseUrl: s.base_url,
      apiKey: s.api_key,
      timeoutMs: s.timeout_ms,
    })),
    aiModels: aiModels
      .filter(m => supplierIdToIndex.has(m.supplier_id))
      .map(m => ({
        supplierIndex: supplierIdToIndex.get(m.supplier_id)!,
        modelId: m.model_id,
        label: m.label,
      })),
    settings: Object.fromEntries(
      settings
        // Passkeys now live on the account row (exported per-account above), never as a
        // setting. Exclude the legacy blob in case an un-migrated DB still holds it.
        .filter(s =>
          !EXPORT_EXCLUDED_SETTINGS.has(s.key) &&
          !s.key.startsWith('migration:') &&
          s.key !== LEGACY_PASSKEY_STORE_KEY,
        )
        .map(s => [s.key, s.value]),
    ),
    warehouse: warehouse.export(true),
  };

  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BACKUP_BYTES) {
    res.status(413).json({ error: 'Backup exceeds the 64 MiB full-backup limit' });
    return;
  }
  const hasSecrets = exportRequiresEncryption(payload);

  if (hasSecrets && !secret) {
    res.status(400).json({
      error: 'This export contains sensitive credentials (session strings or API keys). Provide an encryption secret.',
      code: 'SECRET_REQUIRED',
    });
    return;
  }

  if (secret) {
    res.json(encryptPayload(serialized, secret));
  } else {
    res.json(payload);
  }
  } catch (error) {
    console.warn('[backup] export failed:', error);
    res.status(409).json({ error: 'Backup could not be read completely. Check the data encryption key and server logs.' });
  }
});

router.post('/import', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    res.status(400).json({ error: 'Invalid import request body' });
    return;
  }
  let { data, mode, secret, forceReauth = true, confirmPassword } = req.body as { data: ExportPayload | EncryptedEnvelope; mode: 'merge' | 'replace'; secret?: string; forceReauth?: boolean; confirmPassword?: string };
  if (
    (mode !== 'merge' && mode !== 'replace') ||
    typeof forceReauth !== 'boolean' ||
    (secret !== undefined && (typeof secret !== 'string' || secret.length > 1024))
  ) {
    res.status(400).json({ error: 'Invalid import options' });
    return;
  }

  if (data && (data as EncryptedEnvelope).encrypted === true) {
    if (!secret) {
      res.status(400).json({ error: 'This backup is encrypted. Please provide the secret to decrypt it.' });
      return;
    }
    try {
      const plaintext = decryptPayload(data as EncryptedEnvelope, secret);
      if (Buffer.byteLength(plaintext, 'utf8') > MAX_BACKUP_BYTES) {
        res.status(413).json({ error: 'Backup exceeds the 64 MiB full-backup limit' });
        return;
      }
      data = JSON.parse(plaintext) as ExportPayload;
    } catch {
      res.status(400).json({ error: 'Incorrect secret or corrupted backup file', code: 'WRONG_SECRET' });
      return;
    }
  }

  const payload = data as ExportPayload;
  let serializedPayload: string;
  try {
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== 'string') throw new Error('Export payload is not JSON');
    serializedPayload = serialized;
  } catch {
    res.status(400).json({ error: 'Invalid or unsupported export file' });
    return;
  }
  if (Buffer.byteLength(serializedPayload, 'utf8') > MAX_BACKUP_BYTES) {
    res.status(413).json({ error: 'Backup exceeds the 64 MiB full-backup limit' });
    return;
  }

  if (!payload || payload.version !== '1') {
    res.status(400).json({ error: 'Invalid or unsupported export file' });
    return;
  }

  if (!Array.isArray(payload.accounts) || !Array.isArray(payload.jobs)) {
    res.status(400).json({ error: 'Malformed export file: missing accounts or jobs' });
    return;
  }
  try {
    for (const record of [...(payload.templates ?? []), ...payload.jobs]) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid task or template');
      normalizeJobOptions(record as unknown as Record<string, unknown>);
    }
    for (const template of payload.templates ?? []) {
      if (template.category !== undefined && (typeof template.category !== 'string' || template.category.length > 64)) {
        throw new Error('Invalid template category');
      }
    }
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }

  if (mode === 'replace') {
    if (typeof confirmPassword !== 'string' || !confirmPassword) {
      res.status(400).json({ error: 'Current password confirmation is required for replace-mode import.', code: 'CONFIRM_REQUIRED' });
      return;
    }
    const stored = getStoredCredentials();
    // With no stored hash and no ADMIN_PASSWORD, the old fallback compared the input against
    // the hash of the empty string, so an empty confirmPassword passed. Refuse outright
    // instead: there is nothing to check against, and a wipe is not the place to fail open.
    const envPassword = process.env.ADMIN_PASSWORD;
    const valid = stored.passwordHash
      ? await verifyPassword(confirmPassword, stored.passwordHash)
      : envPassword
        ? timingSafeCompare(legacyHashPassword(confirmPassword), legacyHashPassword(envPassword))
        : false;
    if (!valid) {
      res.status(401).json({ error: 'Incorrect password', code: 'WRONG_PASSWORD' });
      return;
    }
    const execution = getExecutionStatus();
    ensureTaskQueueSchema(db);
    if (execution.running.length || execution.queued.length ||
      db.prepare("SELECT 1 FROM task_queue_items WHERE status = 'running' LIMIT 1").get()) {
      res.status(409).json({ error: 'Stop active and queued executions before replacing data.', code: 'EXECUTIONS_ACTIVE' });
      return;
    }
  }

  const results = { accountsImported: 0, accountsSkipped: 0, templatesImported: 0, jobsImported: 0, aiSuppliersImported: 0, aiModelsImported: 0, settingsUpdated: 0, proxyRefsCleared: 0, schedulesImported: 0, warehouseFoldersImported: 0, warehouseRecordsImported: 0 };

  try {
    db.transaction(() => {
    ensureWarehouseSchema(db);
    const plans = new JobScheduleStore(db);
    if (mode === 'replace') {
      // Do not leave pending batch IDs pointing at newly imported business rows.
      db.prepare('DELETE FROM task_batches').run();
      // FK order: models -> suppliers, jobs -> templates/accounts
      db.prepare('DELETE FROM ai_models').run();
      db.prepare('DELETE FROM ai_suppliers').run();
      db.prepare('DELETE FROM jobs').run();
      db.prepare('DELETE FROM job_templates').run();
      db.prepare('DELETE FROM tg_accounts').run();
      // The pinned default references a wiped ai_models row id
      db.prepare("DELETE FROM settings WHERE key = 'ai_default_model_id'").run();
      db.prepare('DELETE FROM warehouse_records').run();
      while (db.prepare(`DELETE FROM warehouse_folders WHERE id NOT IN
        (SELECT parent_id FROM warehouse_folders WHERE parent_id IS NOT NULL)`).run().changes) {}
    }

    const folderIds = payload.warehouse ? warehouse.import(payload.warehouse).folderIdMap : null;
    if (payload.warehouse) {
      results.warehouseFoldersImported = payload.warehouse.folders.length;
      results.warehouseRecordsImported = payload.warehouse.folders.reduce((sum, folder) => sum + folder.records.length, 0);
    }
    const configFor = (config: string | null) => remapWarehouseConfig(config, folderIds ?? {});

    // Import accounts and build accountIndex -> new db id mapping
    const accountIndexToId = new Map<number, number>();

    for (let i = 0; i < payload.accounts.length; i++) {
      const a = payload.accounts[i];

      if (mode === 'merge') {
        const existing = db.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get(a.phoneNumber) as { id: number } | undefined;
        if (existing) {
          accountIndexToId.set(i, existing.id);
          results.accountsSkipped++;
          continue;
        }
      }

      const result = db.prepare(
        `INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status, proxy_id, disabled, app_client_id, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        a.name, a.phoneNumber, a.apiId, encryptSecret(a.apiHash),
        encryptSecret(forceReauth ? null : (a.sessionString ?? null)),
        forceReauth ? 'unauthenticated' : (a.authStatus ?? 'unauthenticated'),
        a.proxyId ?? null,
        a.disabled ? 1 : 0,
        a.appClientId ?? null,
        Number.isSafeInteger(a.sortOrder) ? a.sortOrder! : 0,
      );

      const newAccountId = result.lastInsertRowid as number;
      accountIndexToId.set(i, newAccountId);
      // Restore the passkey secret under the new account id so passkey login still works
      // after import (even when force-reauth clears the session string).
      const pk = importedPasskeyFor(a);
      if (pk) savePasskeySecret({ ...pk, accountId: newAccountId });
      // Restore the generic attributes bag.
      const attrs = foldImportedAttributes(a);
      if (attrs) writeAttributes(newAccountId, attrs);
      results.accountsImported++;
    }

    // Import templates and build templateIndex -> new db id mapping
    const templateIndexToId = new Map<number, number>();

    if (Array.isArray(payload.templates)) {
      for (let i = 0; i < payload.templates.length; i++) {
        const t = payload.templates[i];

        if (mode === 'merge') {
          const existing = db.prepare('SELECT id FROM job_templates WHERE name = ?').get(t.name) as { id: number } | undefined;
          if (existing) {
            templateIndexToId.set(i, existing.id);
            continue;
          }
        }

        const result = db.prepare(
          `INSERT INTO job_templates
             (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, config, start_command, checkin_button, enabled, run_every_days, run_every_days_max,
              run_once, first_run_min_days, first_run_max_days, category, rerun_on_restart, exclusive_account)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          t.name,
          t.jobType ?? 'checkin',
          t.botUsername ?? '',
          t.timezone ?? '',
          t.replyTimeoutMs ?? 40000,
          t.retryMax ?? 5,
          configFor(t.config ?? null),
          t.startCommand ?? '/start',
          t.checkinButton ?? '签到',
          t.enabled === false ? 0 : 1,
          runInterval(t.runEveryDays),
          runIntervalMax(t.runEveryDaysMax, runInterval(t.runEveryDays)),
          t.runOnce ? 1 : 0,
          t.firstRunMinDays ?? 0,
          t.firstRunMaxDays ?? 0,
          t.category ?? '',
          t.rerunOnRestart ? 1 : 0,
          t.exclusiveAccount ? 1 : 0,
        );

        templateIndexToId.set(i, result.lastInsertRowid as number);
        results.templatesImported++;
      }
    }

    // Import jobs
    const importedSchedules: Array<{ jobId: number; plan: NonNullable<ExportPayload['jobs'][number]['schedule']> }> = [];
    for (const j of payload.jobs) {
      const resolvedAccountId = j.accountIndex != null ? (accountIndexToId.get(j.accountIndex) ?? null) : null;
      const resolvedTemplateId = j.templateIndex != null ? (templateIndexToId.get(j.templateIndex) ?? null) : null;

      if (j.accountIndex != null && !accountIndexToId.has(j.accountIndex)) throw new Error('Invalid job accountIndex');
      if (j.templateIndex != null && !templateIndexToId.has(j.templateIndex)) throw new Error('Invalid job templateIndex');
      const imported = db.prepare(
        `INSERT INTO jobs
           (account_id, template_id, name, job_type, bot_username, schedule_window_start, schedule_window_end,
            timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button,
            run_every_days, run_every_days_max, last_success_at, retired,
            run_once, first_run_min_days, first_run_max_days, last_attempt_at, rerun_on_restart, exclusive_account)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        resolvedAccountId,
        resolvedTemplateId,
        j.name,
        j.jobType ?? 'checkin',
        j.botUsername,
        j.scheduleWindowStart ?? 1400,
        j.scheduleWindowEnd ?? 1600,
        j.timezone ?? '',
        j.replyTimeoutMs ?? 40000,
        j.retryMax ?? 5,
        j.enabled ? 1 : 0,
        configFor(j.config ?? null),
        j.startCommand ?? '/start',
        j.checkinButton ?? '签到',
        runInterval(j.runEveryDays),
        runIntervalMax(j.runEveryDaysMax, runInterval(j.runEveryDays)),
        j.lastSuccessAt ?? null,
        j.retired ?? null,
        j.runOnce ? 1 : 0,
        j.firstRunMinDays ?? 0,
        j.firstRunMaxDays ?? 0,
        j.lastAttemptAt ?? j.lastSuccessAt ?? null,
        j.rerunOnRestart ? 1 : 0,
        j.exclusiveAccount ? 1 : 0,
      );
      if (j.schedule) importedSchedules.push({ jobId: Number(imported.lastInsertRowid), plan: j.schedule });
      results.jobsImported++;
    }

    // Import AI suppliers and build supplierIndex -> new db id mapping
    const supplierIndexToId = new Map<number, number>();

    if (Array.isArray(payload.aiSuppliers)) {
      for (let i = 0; i < payload.aiSuppliers.length; i++) {
        const s = payload.aiSuppliers[i];

        if (mode === 'merge') {
          const existing = db.prepare('SELECT id FROM ai_suppliers WHERE name = ?').get(s.name) as { id: number } | undefined;
          if (existing) {
            supplierIndexToId.set(i, existing.id);
            continue;
          }
        }

        const result = db.prepare(
          'INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)',
        ).run(s.name, s.baseUrl, s.apiKey, s.timeoutMs ?? 25000);

        supplierIndexToId.set(i, result.lastInsertRowid as number);
        results.aiSuppliersImported++;
      }
    }

    // Import AI models
    if (Array.isArray(payload.aiModels)) {
      for (const m of payload.aiModels) {
        const resolvedSupplierId = supplierIndexToId.get(m.supplierIndex);
        if (resolvedSupplierId == null) continue;

        db.prepare(
          'INSERT INTO ai_models (supplier_id, model_id, label) VALUES (?, ?, ?)',
        ).run(resolvedSupplierId, m.modelId, m.label ?? null);
        results.aiModelsImported++;
      }
    }

    // Merge settings -- never let a backup overwrite instance-local admin/JWT secrets
    if (payload.settings && typeof payload.settings === 'object') {
      const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries(payload.settings)) {
        if (EXPORT_EXCLUDED_SETTINGS.has(key) || key.startsWith('migration:')) continue;
        // Never merge a legacy raw passkey blob: passkeys live on the account row now,
        // and an older backup's blob carries stale account ids.
        if (key === LEGACY_PASSKEY_STORE_KEY) continue;
        if (typeof value === 'string') { stmt.run(key, value); results.settingsUpdated++; }
      }
    }

    // Validate the final merged state, including existing tasks affected by an
    // imported default. An invalid backup must roll back the entire transaction.
    const defaultDuration = (db.prepare(
      "SELECT value FROM settings WHERE key = 'default_play_duration'",
    ).get() as { value: string } | undefined)?.value;
    const embyTemplates = db.prepare(
      "SELECT id, name, config FROM job_templates WHERE job_type = 'embywatch'",
    ).all() as Array<{ id: number; name: string; config: string | null }>;
    const templateConfigs = new Map(embyTemplates.map((template) => [template.id, template.config]));
    for (const template of embyTemplates) {
      const error = validateEffectiveEmbyDurations(parseEmbyConfig(template.config), defaultDuration);
      if (error) throw new Error(`Emby template ${template.id}: ${error}`);
    }
    const embyJobs = db.prepare(
      "SELECT id, template_id, config FROM jobs WHERE job_type = 'embywatch' AND retired IS NULL",
    ).all() as Array<{ id: number; template_id: number | null; config: string | null }>;
    for (const job of embyJobs) {
      const parsed = parseEmbyConfig(job.config);
      const effective = job.template_id != null && templateConfigs.has(job.template_id)
        ? mergeEmbyTemplateConfig(templateConfigs.get(job.template_id), parsed) : parsed;
      const error = validateEffectiveEmbyDurations(effective, defaultDuration);
      if (error) throw new Error(`Emby job ${job.id}: ${error}`);
    }

    // A proxy reference is an id that only means something next to the proxy list it came
    // from: a backup taken without proxies, or one imported into an instance with its own,
    // leaves accounts and jobs pointing at nothing. That reads as "no proxy" at run time
    // rather than as an error, so the dangling references are cleared here and counted.
    results.proxyRefsCleared = clearDanglingProxyRefs();
    // Settings are restored first because timezone and daily-run policy are part
    // of the fingerprint. A backup's in-flight claim must never be replayed.
    for (const { jobId, plan } of importedSchedules) {
      const job = readExecutionJob(jobId)!;
      plans.save({
        jobId, nextRun: plan.nextRun, timezone: plan.timezone, pinned: plan.pinned === true,
        state: plan.state === 'dispatching' ? 'interrupted' : plan.state,
        origin: plan.origin, skippedAt: plan.skippedAt ?? null,
        scheduleKey: buildScheduleKey(job, plan.timezone),
      });
      results.schedulesImported++;
    }
    })();
  } catch (err) {
    // A malformed backup can throw inside the transaction (bad bind value,
    // constraint violation). Roll back and respond, rather than letting the
    // rejection escape the async handler and hang the request.
    res.status(400).json({
      error: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  refreshScheduler();
  res.json({ message: 'Import complete', ...results });
});

export default router;
