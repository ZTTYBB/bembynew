import { Router } from 'express';
import { db } from '../db/database';
import { decryptSecret } from '../db/secretColumns';
import { refreshScheduler } from '../scheduler';
import { parsePaging, parseSort, textParam } from './list-query';
import type { JobTemplate } from '../types';
import { parseAttributes } from '../db/accountAttributes';
import { normalizeJobOptions } from '../jobs/jobOptions';
import { effectiveTemplateCategory, inferTemplateCategory } from './templateCategory';
import {
  EMBY_TEMPLATE_META_KEY,
  EMBY_TEMPLATE_OVERRIDE_KEYS,
  embyTemplateOverrides,
  parseEmbyConfig,
  mergeEmbyTemplateConfig,
  validateEmbyDurations,
  validateEffectiveEmbyDurations,
  withEmbyTemplateMeta,
  type EmbyTemplateJobConfig,
} from '../jobs/embyTemplate';
import {
  mergeCustomTemplateConfig,
  parseTemplateConfig,
  readTemplateOptions,
  resolveTemplateOptionValues,
  TEMPLATE_OPTION_VALUES_KEY,
  validateTemplateOptions,
} from '../jobs/templateOptions';

const router = Router();

// Keep isolated route tests and old embedded databases compatible with the
// additive account-exclusivity flag; the normal startup migration does this
// before the application mounts routes.
try {
  for (const table of ["jobs", "job_templates"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.length && !columns.some((column) => column.name === "exclusive_account")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN exclusive_account INTEGER NOT NULL DEFAULT 0`);
    }
  }
} catch {}

type TemplateRow = {
  id: number;
  name: string;
  job_type: string;
  bot_username: string;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
  created_at: string;
  run_every_days: number;
  run_every_days_max: number | null;
  category: string;
  updated_at: string | null;
  run_once: number;
  rerun_on_restart: number;
  exclusive_account: number;
  first_run_min_days: number;
  first_run_max_days: number;
};

// Normalise a run-every-days range: min >= 1; max kept only when a valid integer
// strictly greater than min, else null (fixed interval).
function normalizeRunEvery(min: unknown, max: unknown): { min: number; max: number | null } {
  const lo = Math.max(1, Math.floor(Number(min ?? 1)) || 1);
  const hiNum = max == null || max === '' ? NaN : Math.floor(Number(max));
  const hi = Number.isFinite(hiNum) && hiNum > lo ? hiNum : null;
  return { min: lo, max: hi };
}

const TEMPLATE_JOB_TYPES = new Set(['checkin', 'embywatch', 'custom', 'autoreg']);

function validInteger(value: unknown, min: number, max: number): boolean {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max;
}

function validateTemplateInput(
  body: unknown,
  partial: boolean,
  existing?: TemplateRow,
): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid template payload';
  const input = body as Record<string, unknown>;
  if (!partial || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 256) {
      return 'name must be a non-empty string of at most 256 characters';
    }
  }
  if (input.jobType !== undefined &&
      (typeof input.jobType !== 'string' || !TEMPLATE_JOB_TYPES.has(input.jobType))) {
    return 'Invalid template type';
  }
  if (input.botUsername !== undefined && typeof input.botUsername !== 'string') {
    return 'botUsername must be a string';
  }
  if (input.timezone !== undefined && typeof input.timezone !== 'string') {
    return 'timezone must be a string';
  }
  if (input.replyTimeoutMs !== undefined && !validInteger(input.replyTimeoutMs, 100, 3_600_000)) {
    return 'replyTimeoutMs must be an integer from 100 to 3600000';
  }
  if (input.retryMax !== undefined && !validInteger(input.retryMax, 1, 20)) {
    return 'retryMax must be an integer from 1 to 20';
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return 'enabled must be boolean';
  }
  if (input.exclusiveAccount !== undefined && typeof input.exclusiveAccount !== 'boolean') {
    return 'exclusiveAccount must be boolean';
  }
  if (input.config !== undefined && input.config !== null) {
    if (typeof input.config === 'string') {
      if (!parseTemplateConfig(input.config)) return 'config must contain valid JSON object data';
    } else if (typeof input.config !== 'object' || Array.isArray(input.config)) {
      return 'config must be an object or null';
    }
  }
  for (const field of ['startCommand', 'checkinButton'] as const) {
    if (input[field] !== undefined && typeof input[field] !== 'string') {
      return `${field} must be a string`;
    }
  }
  for (const field of ['runEveryDays', 'runEveryDaysMax'] as const) {
    const value = input[field];
    if (value !== undefined && value !== null && value !== '' &&
        !validInteger(value, 1, 3650)) {
      return `${field} must be an integer from 1 to 3650`;
    }
  }
  const min = input.runEveryDays !== undefined
    ? input.runEveryDays
    : existing?.run_every_days ?? 1;
  const max = input.runEveryDaysMax !== undefined
    ? input.runEveryDaysMax
    : existing?.run_every_days_max;
  if (
    max !== undefined && max !== null && max !== '' &&
    validInteger(min, 1, 3650) && Number(max) < Number(min)
  ) {
    return 'runEveryDaysMax must not be less than runEveryDays';
  }
  if (input.category !== undefined &&
      (typeof input.category !== 'string' || input.category.trim().length > 64)) {
    return 'category must be a string of at most 64 characters';
  }
  return null;
}

function serialiseTemplateConfig(value: unknown): string | null {
  if (value == null) return null;
  const parsed = parseTemplateConfig(value);
  return parsed ? JSON.stringify(parsed) : JSON.stringify(value);
}

function rowToTemplate(row: TemplateRow): JobTemplate {
  return {
    id: row.id,
    name: row.name,
    jobType: row.job_type as JobTemplate['jobType'],
    botUsername: row.bot_username,
    timezone: row.timezone,
    replyTimeoutMs: row.reply_timeout_ms,
    retryMax: row.retry_max,
    enabled: Boolean(row.enabled),
    config: row.config ?? null,
    startCommand: row.start_command || '/start',
    checkinButton: row.checkin_button || '签到',
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    runEveryDays: row.run_every_days ?? 1,
    runEveryDaysMax: row.run_every_days_max ?? null,
    category: row.category ?? '',
    inferredCategory: inferTemplateCategory({ name: row.name, jobType: row.job_type, config: row.config }),
    runOnce: Boolean(row.run_once),
    rerunOnRestart: Boolean(row.rerun_on_restart),
    exclusiveAccount: Boolean(row.exclusive_account),
    firstRunMinDays: row.first_run_min_days ?? 0,
    firstRunMaxDays: row.first_run_max_days ?? 0,
  };
}

function defaultPlayDuration(): unknown {
  return (db.prepare("SELECT value FROM settings WHERE key = 'default_play_duration'").get() as
    { value: string } | undefined)?.value;
}

function syncedEmbyConfig(
  templateConfig: string | null,
  jobConfig: string | null,
  previousConfig?: string | null,
): EmbyTemplateJobConfig {
  const tplCfg = parseEmbyConfig(templateConfig);
  const previousTplCfg = parseEmbyConfig(previousConfig);
  const jobCfg = parseEmbyConfig(jobConfig);
  const overrides = embyTemplateOverrides(jobCfg);
  if (!Object.prototype.hasOwnProperty.call(jobCfg, EMBY_TEMPLATE_META_KEY)) {
    for (const key of EMBY_TEMPLATE_OVERRIDE_KEYS) {
      if (
        Object.prototype.hasOwnProperty.call(jobCfg, key) &&
        Object.prototype.hasOwnProperty.call(previousTplCfg, key) &&
        jobCfg[key] !== previousTplCfg[key]
      ) {
        overrides[key] = jobCfg[key] as never;
      }
    }
  }
  return withEmbyTemplateMeta(
    { ...tplCfg, username: jobCfg.username, password: jobCfg.password },
    overrides,
  );
}

// Sync template fields to all linked jobs (enabled is job-specific, not synced)
function syncLinkedJobs(
  templateId: number,
  t: TemplateRow,
  previousConfig?: string | null,
) {
  if (t.job_type === 'embywatch') {
    // Per-job credentials (username, password) must not be overwritten by the template config.
    // Update all non-config fields in bulk, then merge config per-job.
    db.prepare(`
      UPDATE jobs SET
        job_type = ?,
        bot_username = ?,
        timezone = ?,
        reply_timeout_ms = ?,
        retry_max = ?,
        start_command = ?,
        checkin_button = ?,
        run_every_days = ?,
        run_every_days_max = ?,
        run_once = ?,
        rerun_on_restart = ?,
        first_run_min_days = ?,
        first_run_max_days = ?,
        exclusive_account = ?
      WHERE template_id = ?
    `).run(
      t.job_type,
      t.bot_username,
      t.timezone,
      t.reply_timeout_ms,
      t.retry_max,
      t.start_command,
      t.checkin_button,
      t.run_every_days ?? 7,
      t.run_every_days_max ?? null,
      t.run_once ?? 0,
      t.rerun_on_restart ?? 0,
      t.first_run_min_days ?? 0,
      t.first_run_max_days ?? 0,
      t.exclusive_account ?? 0,
      templateId,
    );

    const linkedJobs = db.prepare('SELECT id, config FROM jobs WHERE template_id = ?').all(templateId) as Array<{ id: number; config: string | null }>;
    for (const job of linkedJobs) {
      const merged = syncedEmbyConfig(t.config, job.config, previousConfig);
      db.prepare('UPDATE jobs SET config = ? WHERE id = ?').run(JSON.stringify(merged), job.id);
    }
  } else {
    const previousCustomJobs = t.job_type === 'custom'
      ? db.prepare('SELECT id, config FROM jobs WHERE template_id = ?')
        .all(templateId) as Array<{ id: number; config: string | null }>
      : [];
    db.prepare(`
      UPDATE jobs SET
        job_type = ?,
        bot_username = ?,
        timezone = ?,
        reply_timeout_ms = ?,
        retry_max = ?,
        config = ?,
        start_command = ?,
        checkin_button = ?,
        run_every_days = ?,
        run_every_days_max = ?,
        run_once = ?,
        rerun_on_restart = ?,
        first_run_min_days = ?,
        first_run_max_days = ?,
        exclusive_account = ?
      WHERE template_id = ?
    `).run(
      t.job_type,
      t.bot_username,
      t.timezone,
      t.reply_timeout_ms,
      t.retry_max,
      t.config,
      t.start_command,
      t.checkin_button,
      t.run_every_days ?? 7,
      t.run_every_days_max ?? null,
      t.run_once ?? 0,
      t.rerun_on_restart ?? 0,
      t.first_run_min_days ?? 0,
      t.first_run_max_days ?? 0,
      t.exclusive_account ?? 0,
      templateId,
    );
    if (t.job_type === 'custom') {
      for (const job of previousCustomJobs) {
        const merged = mergeCustomTemplateConfig(t.config, job.config);
        db.prepare('UPDATE jobs SET config = ? WHERE id = ?')
          .run(merged == null ? null : JSON.stringify(merged), job.id);
      }
    }
  }
}

const TEMPLATE_SORTS: Record<string, string> = {
  name: 't.name COLLATE NOCASE',
  type: 't.job_type',
  // asc shows enabled templates first, matching the previous client-side sort
  enabled: 'CASE WHEN t.enabled = 1 THEN 0 ELSE 1 END',
  botUrl: 't.bot_username COLLATE NOCASE',
  linkedJobs: 'linked_job_count',
  updated: 't.updated_at',
};

router.get('/', (req, res) => {
  const query = req.query as Record<string, unknown>;
  const paging = parsePaging(query);
  const search = textParam(query.search);
  const jobType = textParam(query.jobType);
  const enabled = textParam(query.enabled);
  const sortKey = textParam(query.sortKey);
  const category = textParam(query.category);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (search) {
    // Fuzzy match against name and bot username (see db/fuzzy.ts)
    conditions.push("fuzzy_score(?, t.name || ' ' || t.bot_username) > 0");
    params.push(search);
  }
  if (jobType) {
    conditions.push('t.job_type = ?');
    params.push(jobType);
  }
  if (enabled === '1' || enabled === '0') {
    conditions.push('t.enabled = ?');
    params.push(Number(enabled));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // With a search active and no explicit column sort, order by match relevance
  const useRelevance = search && (!sortKey || sortKey === 'relevance');
  const orderClause = useRelevance
    ? 'search_score DESC, t.name COLLATE NOCASE'
    : parseSort(query, TEMPLATE_SORTS, TEMPLATE_SORTS.name);
  const scoreSelect = search
    ? ", fuzzy_score(?, t.name || ' ' || t.bot_username) AS search_score"
    : '';
  const scoreParams = search ? [search] : [];

  const baseSql = `
    FROM job_templates t
    LEFT JOIN jobs j ON j.template_id = t.id AND j.retired IS NULL
    ${where}
    GROUP BY t.id
  `;

  if (category) {
    const allRows = db.prepare(`
      SELECT t.*, COUNT(j.id) AS linked_job_count ${scoreSelect}
      ${baseSql}
      ORDER BY ${orderClause}
    `).all(...scoreParams, ...params) as (TemplateRow & { linked_job_count: number })[];
    const filtered = allRows.filter((row) => effectiveTemplateCategory({
      name: row.name, jobType: row.job_type, config: row.config, category: row.category,
    }) === category);
    const items = (paging && paging.limit >= 0 ? filtered.slice(paging.offset, paging.offset + paging.limit) : filtered)
      .map((row) => ({ ...rowToTemplate(row), linkedJobCount: row.linked_job_count }));
    res.json(paging ? { items, total: filtered.length, page: paging.page, pageSize: paging.pageSize } : items);
    return;
  }

  if (!paging) {
    const rows = db.prepare(`
      SELECT t.*, COUNT(j.id) AS linked_job_count ${scoreSelect}
      ${baseSql}
      ORDER BY ${orderClause}
    `).all(...scoreParams, ...params) as (TemplateRow & { linked_job_count: number })[];
    res.json(rows.map(r => ({ ...rowToTemplate(r), linkedJobCount: r.linked_job_count })));
    return;
  }

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total FROM job_templates t ${where}
  `).get(...params) as { total: number };

  const rows = db.prepare(`
    SELECT t.*, COUNT(j.id) AS linked_job_count ${scoreSelect}
    ${baseSql}
    ORDER BY ${orderClause}
    LIMIT ? OFFSET ?
  `).all(...scoreParams, ...params, paging.limit, paging.offset) as (TemplateRow & { linked_job_count: number })[];

  res.json({
    items: rows.map(r => ({ ...rowToTemplate(r), linkedJobCount: r.linked_job_count })),
    total: totalRow.total,
    page: paging.page,
    pageSize: paging.pageSize,
  });
});

router.post('/creation-eligibility', (req, res) => {
  const requestedIds = req.body?.accountIds;
  if (!Array.isArray(requestedIds) || requestedIds.length > 2000
    || requestedIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) <= 0)) {
    res.status(400).json({ error: 'accountIds must contain up to 2000 positive integer IDs' });
    return;
  }
  const selectedIds = [...new Set<number>(requestedIds)];
  const accounts = selectedIds.length ? db.prepare(`
    SELECT id, auth_status, session_string
    FROM tg_accounts WHERE id IN (${selectedIds.map(() => '?').join(',')})
      AND (disabled = 0 OR disabled IS NULL)
    ORDER BY id
  `).all(...selectedIds) as Array<{ id: number; auth_status: string; session_string: string | null }> : [];
  const accountIds = accounts.map((account) => account.id);
  const telegramAccountIds = accounts
    .filter((account) => account.auth_status === 'authenticated' && Boolean(decryptSecret(account.session_string)))
    .map((account) => account.id);
  const telegramIds = new Set(telegramAccountIds);
  const linkedAccounts = new Map<number, number[]>();
  if (accountIds.length) {
    const linked = db.prepare(`
      SELECT DISTINCT j.template_id, j.account_id FROM jobs j
      JOIN job_templates t ON t.id = j.template_id AND t.enabled = 1
      WHERE j.retired IS NULL AND j.account_id IN (${accountIds.map(() => '?').join(',')})
      ORDER BY j.template_id, j.account_id
    `).all(...accountIds) as Array<{ template_id: number; account_id: number }>;
    for (const row of linked) {
      const ids = linkedAccounts.get(row.template_id) ?? [];
      ids.push(row.account_id);
      linkedAccounts.set(row.template_id, ids);
    }
  }
  const templates = db.prepare('SELECT id, job_type FROM job_templates WHERE enabled = 1 ORDER BY id')
    .all() as Array<{ id: number; job_type: string }>;
  res.json({
    accountCount: accountIds.length,
    accountIds,
    telegramAccountIds,
    templates: templates.map((template) => {
      const linkedAccountIds = linkedAccounts.get(template.id) ?? [];
      const emby = template.job_type === 'embywatch';
      const linkedCount = emby ? linkedAccountIds.length
        : linkedAccountIds.filter((id) => telegramIds.has(id)).length;
      const candidateCount = emby ? accountIds.length : telegramAccountIds.length;
      return {
        templateId: template.id,
        candidateCount,
        eligibleCount: candidateCount - linkedCount,
        linkedAccountIds,
      };
    }),
  });
});

router.post('/', (req, res) => {
  const inputError = validateTemplateInput(req.body, false);
  if (inputError) {
    res.status(400).json({ error: inputError });
    return;
  }
  const {
    name,
    jobType,
    botUsername,
    timezone,
    replyTimeoutMs,
    retryMax,
    config,
    startCommand,
    checkinButton,
    runEveryDays,
    runEveryDaysMax,
    category,
    exclusiveAccount,
  } = req.body as Record<string, any>;
  const durationError = (jobType ?? 'checkin') === 'embywatch'
    ? validateEmbyDurations(typeof config === 'string' ? parseEmbyConfig(config) : config)
    : null;
  if (durationError) {
    res.status(400).json({ error: durationError });
    return;
  }
  if (category !== undefined && (typeof category !== 'string' || category.trim().length > 64)) {
    res.status(400).json({ error: 'category must be a string of at most 64 characters' });
    return;
  }
  let options;
  try {
    options = normalizeJobOptions(req.body);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  if ((jobType ?? 'checkin') === 'embywatch') {
    const effectiveError = validateEffectiveEmbyDurations(
      typeof config === 'string' ? parseEmbyConfig(config) : config, defaultPlayDuration(),
    );
    if (effectiveError) { res.status(400).json({ error: effectiveError }); return; }
  }
  if ((jobType ?? 'checkin') === 'custom') {
    const optionError = validateTemplateOptions(config);
    if (optionError) { res.status(400).json({ error: optionError }); return; }
  }

  const runEvery = normalizeRunEvery(runEveryDays, runEveryDaysMax);
  const result = db.prepare(`
    INSERT INTO job_templates
      (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, config, start_command, checkin_button, run_every_days, run_every_days_max,
       category, updated_at, run_once, rerun_on_restart, first_run_min_days, first_run_max_days, exclusive_account)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    jobType ?? 'checkin',
    (botUsername as string | undefined)?.replace(/^@+/, '') ?? '',
    timezone ?? '',
    Number(replyTimeoutMs ?? 40000),
    Number(retryMax ?? 5),
    serialiseTemplateConfig(config),
    (startCommand as string | undefined)?.trim() || '/start',
    (checkinButton as string | undefined)?.trim() || '签到',
    runEvery.min,
    runEvery.max,
    category?.trim() ?? '',
    new Date().toISOString(),
    options.runOnce ? 1 : 0,
    options.rerunOnRestart ? 1 : 0,
    options.firstRunMinDays,
    options.firstRunMaxDays,
    exclusiveAccount ? 1 : 0,
  );

  const row = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(result.lastInsertRowid) as TemplateRow;
  res.status(201).json(rowToTemplate(row));
});

/**
 * `<name> (copy)`, or `(copy 2)` and up when that is taken. Templates are picked from a
 * list by name, so a duplicate reading exactly like its source is of little use.
 */
function copyName(name: string): string {
  const taken = new Set(
    (db.prepare('SELECT name FROM job_templates').all() as { name: string }[]).map(r => r.name),
  );
  let candidate = `${name} (copy)`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name} (copy ${n})`;
  return candidate;
}

router.post('/:id/duplicate', (req, res) => {
  const source = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id) as TemplateRow | undefined;
  if (!source) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // Everything the source configures, nothing about its identity: the copy starts with no
  // linked jobs, which stay with the original.
  const result = db.prepare(`
    INSERT INTO job_templates
      (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button, run_every_days, run_every_days_max,
       category, updated_at, run_once, rerun_on_restart, first_run_min_days, first_run_max_days, exclusive_account)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    copyName(source.name),
    source.job_type,
    source.bot_username,
    source.timezone,
    source.reply_timeout_ms,
    source.retry_max,
    source.enabled,
    source.config,
    source.start_command,
    source.checkin_button,
    source.run_every_days,
    source.run_every_days_max,
    source.category ?? '',
    new Date().toISOString(),
    source.run_once ?? 0,
    source.rerun_on_restart ?? 0,
    source.first_run_min_days ?? 0,
    source.first_run_max_days ?? 0,
    source.exclusive_account ?? 0,
  );

  const row = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(result.lastInsertRowid) as TemplateRow;
  res.status(201).json(rowToTemplate(row));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id) as TemplateRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const {
    name,
    jobType,
    botUsername,
    timezone,
    replyTimeoutMs,
    retryMax,
    enabled,
    config,
    startCommand,
    checkinButton,
    runEveryDays,
    runEveryDaysMax,
    category,
    exclusiveAccount,
  } = (req.body ?? {}) as Record<string, any>;

  const inputError = validateTemplateInput(req.body, true, existing);
  if (inputError) {
    res.status(400).json({ error: inputError });
    return;
  }
  let options;
  try {
    options = normalizeJobOptions(req.body, {
      runOnce: Boolean(existing.run_once),
      rerunOnRestart: Boolean(existing.rerun_on_restart),
      firstRunMinDays: existing.first_run_min_days ?? 0,
      firstRunMaxDays: existing.first_run_max_days ?? 0,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const runEvery = normalizeRunEvery(
    runEveryDays !== undefined ? runEveryDays : existing.run_every_days,
    runEveryDaysMax !== undefined ? runEveryDaysMax : existing.run_every_days_max,
  );
  const durationError = (jobType ?? existing.job_type) === 'embywatch' && config !== undefined
    ? validateEmbyDurations(typeof config === 'string' ? parseEmbyConfig(config) : config)
    : null;
  if (durationError) {
    res.status(400).json({ error: durationError });
    return;
  }
  const updated: TemplateRow = {
    ...existing,
    name: name ?? existing.name,
    job_type: jobType ?? existing.job_type,
    bot_username: (botUsername as string | undefined)?.replace(/^@+/, '') ?? existing.bot_username,
    timezone: timezone ?? existing.timezone,
    reply_timeout_ms: Number(replyTimeoutMs ?? existing.reply_timeout_ms),
    retry_max: Number(retryMax ?? existing.retry_max),
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    config: config !== undefined
      ? serialiseTemplateConfig(config)
      : existing.config,
    start_command: startCommand !== undefined
      ? ((startCommand as string).trim() || '/start')
      : existing.start_command,
    checkin_button: checkinButton !== undefined
      ? ((checkinButton as string).trim() || '签到')
      : existing.checkin_button,
    run_every_days: runEvery.min,
    run_every_days_max: runEvery.max,
    category: category !== undefined ? category.trim() : existing.category ?? '',
    run_once: options.runOnce ? 1 : 0,
    rerun_on_restart: options.rerunOnRestart ? 1 : 0,
    first_run_min_days: options.firstRunMinDays,
    first_run_max_days: options.firstRunMaxDays,
    exclusive_account: exclusiveAccount !== undefined ? (exclusiveAccount ? 1 : 0) : existing.exclusive_account,
  };
  if (updated.job_type === 'custom') {
    const optionError = validateTemplateOptions(updated.config);
    if (optionError) { res.status(400).json({ error: optionError }); return; }
  }
  // Enabling/disabling a template is an operational switch, not a template
  // definition edit. Keep the real modification timestamp stable for that
  // change (and for no-op saves), matching the list's "last updated" meaning.
  const definitionChanged = (
    updated.name !== existing.name ||
    updated.job_type !== existing.job_type ||
    updated.bot_username !== existing.bot_username ||
    updated.timezone !== existing.timezone ||
    updated.reply_timeout_ms !== existing.reply_timeout_ms ||
    updated.retry_max !== existing.retry_max ||
    updated.config !== existing.config ||
    updated.start_command !== existing.start_command ||
    updated.checkin_button !== existing.checkin_button ||
    updated.run_every_days !== existing.run_every_days ||
    updated.run_every_days_max !== existing.run_every_days_max ||
    updated.category !== (existing.category ?? '') ||
    updated.run_once !== existing.run_once ||
    updated.rerun_on_restart !== existing.rerun_on_restart ||
    updated.first_run_min_days !== existing.first_run_min_days ||
    updated.first_run_max_days !== existing.first_run_max_days
    || updated.exclusive_account !== existing.exclusive_account
  );
  const updatedAt = definitionChanged ? new Date().toISOString() : existing.updated_at;

  if (updated.job_type === 'embywatch') {
    const defaultDuration = defaultPlayDuration();
    const effectiveError = validateEffectiveEmbyDurations(parseEmbyConfig(updated.config), defaultDuration);
    if (effectiveError) { res.status(400).json({ error: effectiveError }); return; }
    const linkedJobs = db.prepare('SELECT id, config FROM jobs WHERE template_id = ?').all(existing.id) as Array<{ id: number; config: string | null }>;
    for (const job of linkedJobs) {
      const nextConfig = syncedEmbyConfig(updated.config, job.config, existing.config);
      const linkedError = validateEffectiveEmbyDurations(
        mergeEmbyTemplateConfig(updated.config, nextConfig), defaultDuration,
      );
      if (linkedError) { res.status(400).json({ error: `Linked job ${job.id}: ${linkedError}` }); return; }
    }
  }

  db.transaction(() => {
    db.prepare(`
    UPDATE job_templates SET
      name = ?, job_type = ?, bot_username = ?, timezone = ?,
      reply_timeout_ms = ?, retry_max = ?, enabled = ?,
      config = ?, start_command = ?, checkin_button = ?, run_every_days = ?, run_every_days_max = ?,
      category = ?, updated_at = ?, run_once = ?, rerun_on_restart = ?, first_run_min_days = ?, first_run_max_days = ?
      , exclusive_account = ?
    WHERE id = ?
  `).run(
    updated.name,
    updated.job_type,
    updated.bot_username,
    updated.timezone,
    updated.reply_timeout_ms,
    updated.retry_max,
    updated.enabled,
    updated.config,
    updated.start_command,
    updated.checkin_button,
    updated.run_every_days,
    updated.run_every_days_max,
    updated.category,
    updatedAt,
    updated.run_once,
    updated.rerun_on_restart,
    updated.first_run_min_days,
    updated.first_run_max_days,
    updated.exclusive_account,
    req.params.id,
  );

    syncLinkedJobs(Number(req.params.id), updated, existing.config);
  })();
  refreshScheduler();

  const row = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id) as TemplateRow;
  res.json(rowToTemplate(row));
});

router.delete('/:id', (req, res) => {
  // ON DELETE SET NULL handles unlinking jobs
  db.prepare('DELETE FROM job_templates WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// ── Bulk enable / disable linked jobs ────────────────────────────────────────

router.put('/:id/jobs/enabled', (req, res) => {
  const { enabled } = req.body as { enabled: boolean };
  db.prepare('UPDATE jobs SET enabled = ? WHERE template_id = ?').run(enabled ? 1 : 0, req.params.id);
  refreshScheduler();
  res.json({ ok: true });
});

// ── Candidate accounts (no existing job for this template) ───────────────────

router.get('/:id/available-accounts', (req, res) => {
  const includeLinked = req.query.includeLinked === '1';
  const rows = db.prepare(`
    SELECT a.id, a.name, a.phone_number, a.auth_status, a.tg_display_name, a.additional_attributes,
      a.session_string,
      EXISTS (SELECT 1 FROM job_templates t WHERE t.id = ? AND t.job_type = 'embywatch') AS emby,
      EXISTS (
        SELECT 1 FROM jobs j WHERE j.template_id = ? AND j.account_id = a.id AND j.retired IS NULL
      ) AS linked
    FROM tg_accounts a
    WHERE (a.disabled = 0 OR a.disabled IS NULL)
      ${includeLinked ? '' : `AND a.id NOT IN (
        SELECT account_id FROM jobs
        WHERE template_id = ? AND account_id IS NOT NULL AND retired IS NULL
      )`}
    ORDER BY a.name COLLATE NOCASE
  `).all(...(includeLinked ? [req.params.id, req.params.id] : [req.params.id, req.params.id, req.params.id])) as Array<{
    id: number; name: string; phone_number: string; auth_status: string; tg_display_name: string | null;
    additional_attributes: string | null; linked: number; session_string: string | null; emby: number;
  }>;

  const successes = db.prepare(`
    SELECT DISTINCT j.account_id, j.template_id
    FROM jobs j JOIN tg_accounts a ON a.id = j.account_id
    WHERE j.template_id IS NOT NULL AND (a.disabled = 0 OR a.disabled IS NULL)
      AND (NULLIF(TRIM(j.last_success_at), '') IS NOT NULL OR EXISTS (
        SELECT 1 FROM job_logs l WHERE l.job_id = j.id AND l.status = 'success'
      ))
  `).all() as Array<{ account_id: number; template_id: number }>;
  const successfulTemplates = new Map<number, number[]>();
  for (const success of successes) {
    const ids = successfulTemplates.get(success.account_id) ?? [];
    ids.push(success.template_id);
    successfulTemplates.set(success.account_id, ids);
  }
  res.json(rows.map(r => {
    const restriction = parseAttributes(r.additional_attributes).restriction;
    return {
      id: r.id,
      name: r.name,
      phoneNumber: r.phone_number,
      authStatus: r.auth_status,
      tgDisplayName: r.tg_display_name ?? null,
      linked: Boolean(r.linked),
      canCreate: !r.linked && Boolean(
        r.emby || (r.auth_status === 'authenticated' && decryptSecret(r.session_string)),
      ),
      restriction: typeof restriction === 'string' ? restriction : null,
      successfulTemplateIds: successfulTemplates.get(r.id) ?? [],
    };
  }));
});

// ── Bulk create jobs from template ───────────────────────────────────────────

type CreateJobEntry = {
  accountId: number | null;
  name: string;
  config?: Record<string, unknown>;
};

router.post('/:id/create-jobs', (req, res) => {
  const template = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id) as TemplateRow | undefined;
  if (!template) { res.status(404).json({ error: 'Not found' }); return; }

  const { jobs, scheduleWindowStart, scheduleWindowEnd, enabled = true, maxAccounts } = (req.body ?? {}) as {
    jobs: CreateJobEntry[];
    scheduleWindowStart: number;
    scheduleWindowEnd: number;
    enabled?: boolean;
    maxAccounts?: number;
  };

  if (!Array.isArray(jobs) || !jobs.length || jobs.length > 2000) {
    res.status(400).json({ error: 'jobs must contain 1 to 2000 entries' }); return;
  }
  const validTime = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) &&
    value >= 0 && value <= 2359 && value % 100 < 60;
  if (
    !validTime(scheduleWindowStart) || !validTime(scheduleWindowEnd) ||
    scheduleWindowEnd < scheduleWindowStart
  ) {
    res.status(400).json({ error: 'Schedule window must use valid HHMM times with end >= start' }); return;
  }
  if (typeof enabled !== 'boolean' || (
    maxAccounts !== undefined && (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 2000)
  )) {
    res.status(400).json({ error: 'enabled must be boolean and maxAccounts must be an integer from 1 to 2000' }); return;
  }
  const requiresTg = ['checkin', 'custom', 'autoreg'].includes(template.job_type);
  for (const j of jobs) {
    if (
      !j || typeof j !== 'object' || typeof j.name !== 'string' ||
      !j.name.trim() || j.name.length > 256 ||
      (j.accountId !== null && (!Number.isSafeInteger(j.accountId) || j.accountId <= 0)) ||
      (j.config !== undefined && (!j.config || typeof j.config !== 'object' || Array.isArray(j.config)))
    ) {
      res.status(400).json({ error: 'Each job requires a name, a valid accountId (or null), and an object config' }); return;
    }
  }

  const defaultDuration = template.job_type === 'embywatch' ? defaultPlayDuration() : undefined;
  const preparedConfigs = new Map<CreateJobEntry, string | null>();
  if (template.job_type === 'embywatch') {
    for (const j of jobs) {
      const username = typeof j.config?.username === 'string' ? String(j.config.username).trim() : '';
      if (!username) {
        res.status(400).json({ error: `${j.name || 'job'}: Emby username is required` });
        return;
      }
      const durationError = validateEmbyDurations(j.config);
      if (durationError) {
        res.status(400).json({ error: `${j.name || 'job'}: ${durationError}` });
        return;
      }
      const overrides = embyTemplateOverrides(j.config as EmbyTemplateJobConfig);
      if (!Object.prototype.hasOwnProperty.call(j.config, EMBY_TEMPLATE_META_KEY)) {
        for (const key of EMBY_TEMPLATE_OVERRIDE_KEYS) {
          const value = j.config?.[key];
          if (value !== undefined && value !== null && value !== '') overrides[key] = value as never;
        }
      }
      const nextConfig = withEmbyTemplateMeta({ ...parseEmbyConfig(template.config), ...j.config }, overrides);
      const effectiveError = validateEffectiveEmbyDurations(
        mergeEmbyTemplateConfig(template.config, nextConfig), defaultDuration,
      );
      if (effectiveError) { res.status(400).json({ error: `${j.name}: ${effectiveError}` }); return; }
      preparedConfigs.set(j, JSON.stringify(nextConfig));
      // password may be empty
    }
  } else if (template.job_type === 'custom') {
    const templateOptions = readTemplateOptions(template.config);
    if (templateOptions.error) {
      res.status(400).json({ error: templateOptions.error });
      return;
    }
    for (const j of jobs) {
      const rawValues = j.config && Object.prototype.hasOwnProperty.call(j.config, TEMPLATE_OPTION_VALUES_KEY)
        ? j.config[TEMPLATE_OPTION_VALUES_KEY]
        : undefined;
      const values = resolveTemplateOptionValues(templateOptions.options, rawValues, true);
      if (values.error) {
        res.status(400).json({ error: `${j.name}: ${values.error}` });
        return;
      }
      const merged = mergeCustomTemplateConfig(
        template.config,
        rawValues === undefined ? null : { [TEMPLATE_OPTION_VALUES_KEY]: rawValues },
      );
      preparedConfigs.set(j, merged == null ? null : JSON.stringify(merged));
    }
  }

  const createdIds: number[] = [];
  let skipped = 0;

  db.transaction(() => {
    for (const j of jobs) {
      if (createdIds.length >= (maxAccounts ?? jobs.length)) { skipped++; continue; }
      if (j.accountId == null) {
        if (requiresTg) { skipped++; continue; }
      } else {
        const account = db.prepare(
          'SELECT disabled, auth_status, session_string FROM tg_accounts WHERE id = ?',
        ).get(j.accountId) as {
          disabled: number; auth_status: string; session_string: string | null;
        } | undefined;
        if (!account || account.disabled || (
          requiresTg && (account.auth_status !== 'authenticated' || !decryptSecret(account.session_string))
        )) {
          skipped++;
          continue;
        }
        const linked = db.prepare(
          'SELECT 1 FROM jobs WHERE template_id = ? AND account_id = ? AND retired IS NULL',
        ).get(template.id, j.accountId);
        if (linked) { skipped++; continue; }
      }
      // Emby credentials and custom option selections are job-specific. Keep
      // the template definition alongside those values so a later edit can
      // restore the placeholders even if the client only sends selections.
      const jobConfig = preparedConfigs.has(j)
        ? preparedConfigs.get(j)
        : template.config;

      const result = db.prepare(`
        INSERT INTO jobs (
          name, account_id, job_type, bot_username,
          schedule_window_start, schedule_window_end, timezone,
          reply_timeout_ms, retry_max, enabled, config,
          start_command, checkin_button, template_id, run_every_days, run_every_days_max,
          run_once, rerun_on_restart, first_run_min_days, first_run_max_days, exclusive_account
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        j.name.trim(),
        j.accountId,
        template.job_type,
        template.bot_username,
        Number(scheduleWindowStart),
        Number(scheduleWindowEnd),
        template.timezone,
        template.reply_timeout_ms,
        template.retry_max,
        enabled ? 1 : 0,
        jobConfig,
        template.start_command,
        template.checkin_button,
        template.id,
        template.run_every_days ?? 1,
        template.run_every_days_max ?? null,
        template.run_once ?? 0,
        template.rerun_on_restart ?? 0,
        template.first_run_min_days ?? 0,
        template.first_run_max_days ?? 0,
        template.exclusive_account ?? 0,
      );
      createdIds.push(Number(result.lastInsertRowid));
    }
  })();

  refreshScheduler();
  res.status(201).json({ created: createdIds.length, ids: createdIds, skipped });
});

export default router;
