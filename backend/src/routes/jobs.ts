import { Router } from "express";
import { db, getDefaultTgApiCredentials } from "../db/database";
import { decryptAccountRow } from "../db/secretColumns";
import { executeManagedJob, getExecutionStatus, getExclusiveConflict } from "../jobs/execution";
import { hasActiveBatchJob } from "../jobs/taskQueue";
import { refreshScheduler, rescheduleAfterOutcome } from "../scheduler";
import type { Job, TgAccount } from "../types";
import { testEmbyConnection } from "../jobs/embywatch";
import { mergeEmbyTemplateConfig, parseEmbyConfig, validateEffectiveEmbyDurations } from "../jobs/embyTemplate";
import { normalizeJobOptions } from "../jobs/jobOptions";
import {
  mergeCustomTemplateConfig,
  parseTemplateConfig,
  readTemplateOptions,
  resolveTemplateOptionValues,
  TEMPLATE_OPTION_VALUES_KEY,
} from "../jobs/templateOptions";
import { getJobOutcome, markJobOutcome, JobOutcomeError } from "../jobs/outcome";
import { parsePaging, parseSort, textParam, escapeLike } from "./list-query";

const router = Router();

// Route tests and old embedded databases may load the router before the main
// startup migration. Keep the new flag additive in those environments too.
try {
  for (const table of ["jobs", "job_templates"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.length && !columns.some((column) => column.name === "exclusive_account")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN exclusive_account INTEGER NOT NULL DEFAULT 0`);
    }
  }
} catch {}

function assertEmbywatchCredentials(config: unknown): string | null {
  if (config == null || typeof config !== 'object') {
    return 'Emby username is required';
  }
  const cfg = config as { username?: unknown; password?: unknown };
  const username = typeof cfg.username === 'string' ? cfg.username.trim() : '';
  if (!username) return 'Emby username is required';
  // password may be empty
  return null;
}

type JobRow = {
  id: number;
  name: string;
  account_id: number | null;
  job_type: string;
  bot_username: string;
  schedule_window_start: number;
  schedule_window_end: number;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  created_at: string;
  updated_at: string | null;
  config: string | null;
  start_command: string;
  checkin_button: string;
  template_id: number | null;
  run_every_days: number;
  run_every_days_max: number | null;
  run_once: number;
  first_run_min_days: number;
  first_run_max_days: number;
  rerun_on_restart: number;
  exclusive_account: number;
  retired: string | null;
  last_success_at: string | null;
  last_attempt_at: string | null;
  account_name?: string;
};

type AccountRow = {
  id: number;
  name: string;
  phone_number: string;
  api_id: number | null;
  api_hash: string | null;
  session_string: string | null;
  auth_status: string;
  proxy_id: string | null;
  disabled: number;
  app_client_id: string | null;
  created_at: string;
};

/** Credentials are resolved as a pair: the account's own if complete, else the global defaults. */
function rowToAccount(row: AccountRow): TgAccount {
  const ownCredentials =
    row.api_id && row.api_hash
      ? { apiId: row.api_id, apiHash: row.api_hash }
      : null;
  const credentials = ownCredentials ?? getDefaultTgApiCredentials();
  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone_number,
    apiId: credentials?.apiId ?? null,
    apiHash: credentials?.apiHash ?? null,
    sessionString: row.session_string,
    authStatus: row.auth_status as TgAccount["authStatus"],
    proxyId: row.proxy_id ?? null,
    disabled: Boolean(row.disabled),
    appClientId: row.app_client_id ?? null,
    createdAt: row.created_at,
  };
}

// Normalise a run-every-days range: min is clamped to >= 1; max is kept only
// when it is a valid integer strictly greater than min, otherwise null (fixed).
export function normalizeRunEvery(min: unknown, max: unknown): { min: number; max: number | null } {
  const lo = Math.max(1, Math.floor(Number(min ?? 1)) || 1);
  const hiNum = max == null || max === "" ? NaN : Math.floor(Number(max));
  const hi = Number.isFinite(hiNum) && hiNum > lo ? hiNum : null;
  return { min: lo, max: hi };
}

const JOB_TYPES = new Set(["checkin", "embywatch", "custom", "autoreg"]);

function validInteger(value: unknown, min: number, max: number): boolean {
  if (typeof value !== "number" && typeof value !== "string") return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max;
}

function validScheduleMinute(value: unknown): boolean {
  return validInteger(value, 0, 2359) && Number(value) % 100 < 60;
}

function validJobIdInput(value: unknown, allowEmpty = true): boolean {
  if (value === undefined || (allowEmpty && (value === null || value === ""))) return true;
  return validInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function validateJobInput(
  body: Record<string, unknown>,
  partial: boolean,
): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Invalid job payload";
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 256) {
      return "name must be a non-empty string of at most 256 characters";
    }
  }
  if (body.jobType !== undefined &&
      (typeof body.jobType !== "string" || !JOB_TYPES.has(body.jobType))) {
    return "Invalid job type";
  }
  if (!validJobIdInput(body.accountId)) return "accountId must be a positive integer or empty";
  if (!validJobIdInput(body.templateId)) return "templateId must be a positive integer or empty";
  if (body.botUsername !== undefined && typeof body.botUsername !== "string") {
    return "botUsername must be a string";
  }
  if (body.timezone !== undefined && typeof body.timezone !== "string") return "timezone must be a string";
  if (body.scheduleWindowStart !== undefined && !validScheduleMinute(body.scheduleWindowStart)) {
    return "scheduleWindowStart must be a valid HHMM time";
  }
  if (body.scheduleWindowEnd !== undefined && !validScheduleMinute(body.scheduleWindowEnd)) {
    return "scheduleWindowEnd must be a valid HHMM time";
  }
  if (
    body.scheduleWindowStart !== undefined &&
    body.scheduleWindowEnd !== undefined &&
    Number(body.scheduleWindowEnd) < Number(body.scheduleWindowStart)
  ) return "scheduleWindowEnd must not be before scheduleWindowStart";
  if (body.replyTimeoutMs !== undefined && !validInteger(body.replyTimeoutMs, 100, 3_600_000)) {
    return "replyTimeoutMs must be an integer from 100 to 3600000";
  }
  if (body.retryMax !== undefined && !validInteger(body.retryMax, 1, 20)) {
    return "retryMax must be an integer from 1 to 20";
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return "enabled must be boolean";
  if (body.exclusiveAccount !== undefined && typeof body.exclusiveAccount !== "boolean") {
    return "exclusiveAccount must be boolean";
  }
  if (body.config !== undefined &&
      body.config !== null &&
      (typeof body.config !== "object" || Array.isArray(body.config))) {
    return "config must be an object or null";
  }
  for (const field of ["startCommand", "checkinButton"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      return `${field} must be a string`;
    }
  }
  for (const field of ["runEveryDays", "runEveryDaysMax"] as const) {
    const value = body[field];
    if (value !== undefined && value !== null && value !== "" &&
        !validInteger(value, 1, 3650)) {
      return `${field} must be an integer from 1 to 3650`;
    }
  }
  if (body.runEveryDays !== undefined && body.runEveryDaysMax !== undefined &&
      body.runEveryDaysMax !== null && body.runEveryDaysMax !== "" &&
      Number(body.runEveryDaysMax) < Number(body.runEveryDays)) {
    return "runEveryDaysMax must not be less than runEveryDays";
  }
  return null;
}

function rowToJob(row: JobRow): Job & { accountName?: string } {
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id ?? null,
    accountName: row.account_name,
    jobType: row.job_type as Job["jobType"],
    botUsername: row.bot_username,
    scheduleWindowStart: row.schedule_window_start,
    scheduleWindowEnd: row.schedule_window_end,
    timezone: row.timezone,
    replyTimeoutMs: row.reply_timeout_ms,
    retryMax: row.retry_max,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
    config: row.config ?? null,
    startCommand: row.start_command || "/start",
    checkinButton: row.checkin_button || "签到",
    templateId: row.template_id ?? null,
    runEveryDays: row.run_every_days ?? 1,
    runEveryDaysMax: row.run_every_days_max ?? null,
    runOnce: Boolean(row.run_once),
    firstRunMinDays: row.first_run_min_days ?? 0,
    firstRunMaxDays: row.first_run_max_days ?? 0,
    rerunOnRestart: Boolean(row.rerun_on_restart),
    exclusiveAccount: Boolean(row.exclusive_account),
    retired: row.retired ?? null,
    lastSuccessAt: row.last_success_at ?? null,
    lastAttemptAt: row.last_attempt_at ?? null,
  };
}

function embyDurationError(config: unknown, templateId: number | null): string | null {
  const parsed = parseEmbyConfig(config == null ? null : typeof config === "string" ? config : JSON.stringify(config));
  const template = templateId == null ? undefined : db.prepare(
    "SELECT config FROM job_templates WHERE id = ?",
  ).get(templateId) as { config: string | null } | undefined;
  const defaults = db.prepare("SELECT value FROM settings WHERE key = 'default_play_duration'").get() as
    { value: string } | undefined;
  return validateEffectiveEmbyDurations(
    template ? mergeEmbyTemplateConfig(template.config, parsed) : parsed,
    defaults?.value,
  );
}

function selectedTemplateOptions(templateId: number | null) {
  if (templateId == null) return undefined;
  if (!Number.isSafeInteger(templateId) || templateId <= 0) throw new Error("Invalid templateId");
  const template = db.prepare(
    "SELECT * FROM job_templates WHERE id = ?",
  ).get(templateId) as {
    run_once: number; first_run_min_days: number; first_run_max_days: number; rerun_on_restart: number;
    exclusive_account: number;
  } | undefined;
  if (!template) throw new Error("Template not found");
  return {
    runOnce: Boolean(template.run_once), firstRunMinDays: template.first_run_min_days ?? 0,
    firstRunMaxDays: template.first_run_max_days ?? 0,
    rerunOnRestart: Boolean(template.rerun_on_restart),
    exclusiveAccount: Boolean(template.exclusive_account),
  };
}

function customTemplateConfigForJob(
  templateId: number | null,
  rawConfig: unknown,
): { config: string | null; error: string | null } {
  if (templateId == null) {
    return { config: rawConfig == null ? null : JSON.stringify(rawConfig), error: null };
  }
  const template = db.prepare(
    "SELECT job_type, config FROM job_templates WHERE id = ?",
  ).get(templateId) as { job_type: string; config: string | null } | undefined;
  if (!template) return { config: null, error: "Template not found" };
  if (template.job_type !== "custom") {
    return { config: rawConfig == null ? null : JSON.stringify(rawConfig), error: null };
  }
  const definitions = readTemplateOptions(template.config);
  if (definitions.error) return { config: null, error: definitions.error };
  // PUT accepts an omitted config for partial edits, so an existing row arrives
  // here as its persisted JSON string. Parse both forms before extracting the
  // selected values; otherwise a name-only edit silently resets every option to
  // the template defaults.
  const parsedConfig = parseTemplateConfig(rawConfig);
  const rawValues = parsedConfig &&
    Object.prototype.hasOwnProperty.call(parsedConfig, TEMPLATE_OPTION_VALUES_KEY)
    ? parsedConfig[TEMPLATE_OPTION_VALUES_KEY]
    : undefined;
  const values = resolveTemplateOptionValues(definitions.options, rawValues, true);
  if (values.error) return { config: null, error: values.error };
  const merged = mergeCustomTemplateConfig(
    template.config,
    rawValues === undefined ? null : { [TEMPLATE_OPTION_VALUES_KEY]: rawValues },
  );
  return { config: merged == null ? null : JSON.stringify(merged), error: null };
}

const JOB_SORTS: Record<string, string> = {
  name: "j.name COLLATE NOCASE",
  account: "account_name COLLATE NOCASE",
  type: "j.job_type",
  botUrl: "j.bot_username COLLATE NOCASE",
  window: "j.schedule_window_start",
  // asc shows enabled jobs first, matching the previous client-side sort
  enabled: "CASE WHEN j.enabled = 1 THEN 0 ELSE 1 END",
  // asc puts never-succeeded jobs first, then oldest success
  lastSuccess: "j.last_success_at",
  updated: "j.updated_at",
};

router.get("/", (req, res) => {
  const query = req.query as Record<string, unknown>;
  const paging = parsePaging(query);
  const search = textParam(query.search);
  const jobType = textParam(query.jobType);
  const accountId = textParam(query.accountId);
  const botUsername = textParam(query.botUsername);
  const templateId = textParam(query.templateId);
  const enabled = textParam(query.enabled);

  const conditions: string[] = ["j.retired IS NULL"];
  const params: (string | number)[] = [];

  if (search) {
    conditions.push("j.name LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(search)}%`);
  }
  if (jobType) {
    conditions.push("j.job_type = ?");
    params.push(jobType);
  }
  if (accountId) {
    const parsed = Number(accountId);
    if (!Number.isInteger(parsed)) {
      res.status(400).json({ error: "Invalid accountId" });
      return;
    }
    conditions.push("j.account_id = ?");
    params.push(parsed);
  }
  if (botUsername) {
    conditions.push("j.bot_username = ?");
    params.push(botUsername);
  }
  if (templateId) {
    const parsed = Number(templateId);
    if (!Number.isInteger(parsed)) {
      res.status(400).json({ error: "Invalid templateId" });
      return;
    }
    conditions.push("j.template_id = ?");
    params.push(parsed);
  }
  if (enabled === "1" || enabled === "0") {
    conditions.push("j.enabled = ?");
    params.push(Number(enabled));
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const orderClause = parseSort(query, JOB_SORTS, JOB_SORTS.name);
  const baseSql = `
    FROM jobs j
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    ${where}
  `;

  if (!paging) {
    const rows = db
      .prepare(`SELECT j.*, a.name AS account_name ${baseSql} ORDER BY ${orderClause}`)
      .all(...params) as JobRow[];
    res.json(rows.map(rowToJob));
    return;
  }

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total ${baseSql}`)
    .get(...params) as { total: number };

  const rows = db
    .prepare(`
      SELECT j.*, a.name AS account_name
      ${baseSql}
      ORDER BY ${orderClause}
      LIMIT ? OFFSET ?
    `)
    .all(...params, paging.limit, paging.offset) as JobRow[];

  // Facets let the client build filter dropdowns without loading every row
  const botUsernames = db
    .prepare(`
      SELECT DISTINCT bot_username FROM jobs
      WHERE retired IS NULL AND template_id IS NULL AND bot_username != ''
      ORDER BY bot_username COLLATE NOCASE
    `)
    .all() as Array<{ bot_username: string }>;
  const templatesInUse = db
    .prepare(`
      SELECT DISTINCT t.id, t.name FROM jobs j
      JOIN job_templates t ON j.template_id = t.id
      WHERE j.retired IS NULL
      ORDER BY t.name COLLATE NOCASE
    `)
    .all() as Array<{ id: number; name: string }>;

  res.json({
    items: rows.map(rowToJob),
    total: totalRow.total,
    page: paging.page,
    pageSize: paging.pageSize,
    facets: {
      botUsernames: botUsernames.map((r) => r.bot_username),
      templates: templatesInUse,
    },
  });
});

// Verify Emby server reachability and credentials without creating a job
router.post("/test-emby", async (req, res) => {
  const { serverUrl, username, password, userAgent, proxyId, backupUrls } = (req.body ?? {}) as Record<
    string,
    string | string[] | undefined
  >;
  if (
    typeof serverUrl !== "string" ||
    typeof username !== "string" ||
    (password !== undefined && typeof password !== "string") ||
    (userAgent !== undefined && typeof userAgent !== "string") ||
    (proxyId !== undefined && typeof proxyId !== "string") ||
    (backupUrls !== undefined &&
      (!Array.isArray(backupUrls) || backupUrls.some((u) => typeof u !== "string"))) ||
    !serverUrl ||
    !username
  ) {
    res
      .status(400)
      .json({ error: "serverUrl and username are required" });
    return;
  }
  // The test walks the same list a run would, so check every address the job
  // would try, not just the first
  const allUrls = [serverUrl, ...((backupUrls as string[] | undefined) ?? [])];
  const bad = allUrls.find((u) => u && !/^https?:\/\//i.test(u));
  if (bad) {
    res
      .status(400)
      .json({ error: `serverUrl must start with http:// or https:// (got "${bad}")` });
    return;
  }
  const result = await testEmbyConnection(serverUrl, {
    username,
    password: password ?? '',
    userAgent,
    proxyId,
    backupUrls: backupUrls as string[] | undefined,
  });
  res.json(result);
});

router.post("/", (req, res) => {
  const inputError = validateJobInput(req.body as Record<string, unknown>, false);
  if (inputError) {
    res.status(400).json({ error: inputError });
    return;
  }
  const {
    name,
    accountId,
    jobType,
    botUsername,
    scheduleWindowStart,
    scheduleWindowEnd,
    timezone,
    replyTimeoutMs,
    retryMax,
    enabled,
    config,
    startCommand,
    checkinButton,
    templateId,
    runEveryDays,
    runEveryDaysMax,
  } = (req.body ?? {}) as Record<string, any>;

  const resolvedType = jobType ?? "checkin";
  const needsAccount =
    resolvedType === "checkin" ||
    resolvedType === "custom" ||
    resolvedType === "autoreg";
  // A custom job need not target a bot at all: its actions can each name their own
  // contact, or drive a page that never touches Telegram.
  if (resolvedType === "embywatch") {
    const configError = assertEmbywatchCredentials(config) ?? embyDurationError(config, templateId ? Number(templateId) : null);
    if (configError) {
      res.status(400).json({ error: configError });
      return;
    }
  }

  if (!name || (needsAccount && !accountId) || (resolvedType !== "custom" && !botUsername)) {
    res.status(400).json({
      error:
        "name is required; botUsername is required for every type except custom; " +
        "accountId is required for checkin, custom and autoreg jobs",
    });
    return;
  }
  // Validate foreign-key references before SQLite sees the insert. Without this
  // check a stale account/template id bubbles out as a generic 500, even though
  // it is a client-side input error.
  if (accountId != null && accountId !== "" &&
      !db.prepare("SELECT 1 FROM tg_accounts WHERE id = ?").get(Number(accountId))) {
    res.status(400).json({ error: "Account not found" });
    return;
  }
  if (templateId != null && templateId !== "" &&
      !db.prepare("SELECT 1 FROM job_templates WHERE id = ?").get(Number(templateId))) {
    res.status(400).json({ error: "Template not found" });
    return;
  }

  let storedConfig = config != null ? JSON.stringify(config) : null;
  if (resolvedType === "custom" && templateId != null) {
    const prepared = customTemplateConfigForJob(Number(templateId), config);
    if (prepared.error) {
      res.status(400).json({ error: prepared.error });
      return;
    }
    storedConfig = prepared.config;
  }

  let options: ReturnType<typeof normalizeJobOptions>;
  let exclusiveAccount = false;
  try {
    const inherited = selectedTemplateOptions(templateId ? Number(templateId) : null);
    options = normalizeJobOptions(inherited ? {} : req.body, inherited);
    exclusiveAccount = inherited
      ? inherited.exclusiveAccount
      : Boolean((req.body as Record<string, unknown>).exclusiveAccount);
  }
  catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  const runEvery = normalizeRunEvery(runEveryDays, runEveryDaysMax);
  const result = db
    .prepare(
      `
    INSERT INTO jobs
      (name, account_id, job_type, bot_username, schedule_window_start, schedule_window_end,
       timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button, template_id, run_every_days, run_every_days_max, updated_at,
       run_once, first_run_min_days, first_run_max_days, rerun_on_restart, exclusive_account)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      name,
      accountId ? Number(accountId) : null,
      resolvedType,
      ((botUsername as string | undefined) ?? "").replace(/^@+/, ""),
      Number(scheduleWindowStart ?? 1400),
      Number(scheduleWindowEnd ?? 1600),
      timezone ?? "",
      Number(replyTimeoutMs ?? 40000),
      Number(retryMax ?? 5),
      enabled !== false ? 1 : 0,
      storedConfig,
      (startCommand as string | undefined)?.trim() || "/start",
      (checkinButton as string | undefined)?.trim() || "签到",
      templateId ? Number(templateId) : null,
      runEvery.min,
      runEvery.max,
      new Date().toISOString(),
      options.runOnce ? 1 : 0,
      options.firstRunMinDays,
      options.firstRunMaxDays,
      options.rerunOnRestart ? 1 : 0,
      exclusiveAccount ? 1 : 0,
    );

  const row = db
    .prepare(
      "SELECT j.*, a.name AS account_name FROM jobs j LEFT JOIN tg_accounts a ON j.account_id = a.id WHERE j.id = ?",
    )
    .get(result.lastInsertRowid) as JobRow;
  refreshScheduler();
  res.status(201).json(rowToJob(row));
});

router.put("/:id", (req, res) => {
  const existing = db
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .get(req.params.id) as JobRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const {
    name,
    accountId,
    jobType,
    botUsername,
    scheduleWindowStart,
    scheduleWindowEnd,
    timezone,
    replyTimeoutMs,
    retryMax,
    enabled,
    config,
    startCommand,
    checkinButton,
    templateId,
    runEveryDays,
    runEveryDaysMax,
  } = (req.body ?? {}) as Record<string, any>;
  const inputError = validateJobInput(req.body as Record<string, unknown>, true);
  if (inputError) {
    res.status(400).json({ error: inputError });
    return;
  }

  // When linked to a template, template-controlled fields are read-only
  const isLinked = existing.template_id != null &&
    (templateId === undefined || Number(templateId) === existing.template_id);
  const resolvedTemplateId = templateId !== undefined
    ? (templateId ? Number(templateId) : null)
    : existing.template_id;

  const updatedType = isLinked ? existing.job_type : (jobType ?? existing.job_type);

  // Partial edits still need to validate the final schedule/range. Validating
  // only fields present in the request would let an upper bound below the
  // existing lower bound through (or a start/end inversion across two edits).
  const finalRangeError = validateJobInput({
    name: existing.name,
    scheduleWindowStart: scheduleWindowStart ?? existing.schedule_window_start,
    scheduleWindowEnd: scheduleWindowEnd ?? existing.schedule_window_end,
    runEveryDays: !isLinked && runEveryDays !== undefined
      ? runEveryDays
      : existing.run_every_days,
    runEveryDaysMax: !isLinked && runEveryDaysMax !== undefined
      ? runEveryDaysMax
      : existing.run_every_days_max,
  }, false);
  if (finalRangeError) {
    res.status(400).json({ error: finalRangeError });
    return;
  }

  // Validate the effective binding after applying this partial update. A
  // checkin/custom/autoreg job without an account can never run, and a
  // positive id that does not exist would otherwise surface as an opaque
  // SQLite foreign-key error.
  const nextAccountId = accountId !== undefined
    ? (accountId ? Number(accountId) : null)
    : (existing.account_id ?? null);
  const requiresAccount = ["checkin", "custom", "autoreg"].includes(updatedType);
  if (requiresAccount && nextAccountId == null) {
    res.status(400).json({ error: "accountId is required for checkin, custom and autoreg jobs" });
    return;
  }
  if (nextAccountId != null &&
      !db.prepare("SELECT 1 FROM tg_accounts WHERE id = ?").get(nextAccountId)) {
    res.status(400).json({ error: "Account not found" });
    return;
  }
  if (resolvedTemplateId != null &&
      !db.prepare("SELECT 1 FROM job_templates WHERE id = ?").get(resolvedTemplateId)) {
    res.status(400).json({ error: "Template not found" });
    return;
  }
  const nextBotUsername = botUsername !== undefined
    ? String(botUsername).replace(/^@+/, "").trim()
    : String(existing.bot_username ?? "").trim();
  if (updatedType !== "custom" && !nextBotUsername) {
    res.status(400).json({ error: "botUsername is required for every type except custom" });
    return;
  }

  if (updatedType === "embywatch") {
    const nextConfig =
      (isLinked && existing.job_type !== "embywatch")
        ? existing.config
        : (config !== undefined
            ? (config != null ? JSON.stringify(config) : null)
            : existing.config);
    let parsed: unknown = null;
    if (nextConfig) {
      parsed = parseEmbyConfig(nextConfig);
    } else if (config !== undefined) {
      parsed = config;
    }
    const credError = assertEmbywatchCredentials(parsed);
    if (credError) {
      res.status(400).json({ error: credError });
      return;
    }
    const durationError = embyDurationError(parsed, resolvedTemplateId);
    if (durationError) {
      res.status(400).json({ error: durationError });
      return;
    }
  }

  let storedConfig = (isLinked && existing.job_type !== "embywatch")
    ? existing.config
    : (config !== undefined
      ? (config != null ? JSON.stringify(config) : null)
      : existing.config);
  if (updatedType === "custom" && resolvedTemplateId != null) {
    const prepared = customTemplateConfigForJob(
      Number(resolvedTemplateId),
      config !== undefined ? config : existing.config,
    );
    if (prepared.error) {
      res.status(400).json({ error: prepared.error });
      return;
    }
    storedConfig = prepared.config;
  }

  let options: ReturnType<typeof normalizeJobOptions>;
  let exclusiveAccount = Boolean(existing.exclusive_account);
  try {
    const inherited = selectedTemplateOptions(resolvedTemplateId);
    options = normalizeJobOptions(inherited ? {} : req.body, inherited ?? {
      runOnce: Boolean(existing.run_once),
      firstRunMinDays: existing.first_run_min_days ?? 0,
      firstRunMaxDays: existing.first_run_max_days ?? 0,
      rerunOnRestart: Boolean(existing.rerun_on_restart),
      exclusiveAccount: Boolean(existing.exclusive_account),
    });
    exclusiveAccount = inherited
      ? inherited.exclusiveAccount
      : req.body.exclusiveAccount !== undefined
        ? Boolean(req.body.exclusiveAccount)
        : Boolean(existing.exclusive_account);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  const runEvery = normalizeRunEvery(
    !isLinked && runEveryDays !== undefined ? runEveryDays : existing.run_every_days,
    !isLinked && runEveryDaysMax !== undefined ? runEveryDaysMax : existing.run_every_days_max,
  );
  db.prepare(
    `
    UPDATE jobs SET
      name = ?, account_id = ?, job_type = ?, bot_username = ?,
      schedule_window_start = ?, schedule_window_end = ?, timezone = ?,
      reply_timeout_ms = ?, retry_max = ?, enabled = ?, config = ?,
      start_command = ?, checkin_button = ?, template_id = ?, run_every_days = ?, run_every_days_max = ?,
      updated_at = ?, run_once = ?, first_run_min_days = ?, first_run_max_days = ?, rerun_on_restart = ?, exclusive_account = ?
    WHERE id = ?
  `,
  ).run(
    name ?? existing.name,
    accountId !== undefined ? (accountId ? Number(accountId) : null) : (existing.account_id ?? null),
    updatedType,
    isLinked ? existing.bot_username : ((botUsername as string | undefined)?.replace(/^@+/, "") ?? existing.bot_username),
    Number(scheduleWindowStart ?? existing.schedule_window_start),
    Number(scheduleWindowEnd ?? existing.schedule_window_end),
    isLinked ? existing.timezone : (timezone ?? existing.timezone),
    isLinked ? existing.reply_timeout_ms : Number(replyTimeoutMs ?? existing.reply_timeout_ms),
    isLinked ? existing.retry_max : Number(retryMax ?? existing.retry_max),
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    storedConfig,
    isLinked ? existing.start_command : (startCommand !== undefined ? ((startCommand as string).trim() || "/start") : existing.start_command),
    isLinked ? existing.checkin_button : (checkinButton !== undefined ? ((checkinButton as string).trim() || "签到") : existing.checkin_button),
    resolvedTemplateId,
    runEvery.min,
    runEvery.max,
    new Date().toISOString(),
    options.runOnce ? 1 : 0,
    options.firstRunMinDays,
    options.firstRunMaxDays,
    options.rerunOnRestart ? 1 : 0,
    exclusiveAccount ? 1 : 0,
    req.params.id,
  );

  const row = db
    .prepare(
      "SELECT j.*, a.name AS account_name FROM jobs j LEFT JOIN tg_accounts a ON j.account_id = a.id WHERE j.id = ?",
    )
    .get(req.params.id) as JobRow;
  refreshScheduler();
  res.json(rowToJob(row));
});

router.delete("/:id", (req, res) => {
  db.prepare("UPDATE jobs SET retired = datetime('now') WHERE id = ?").run(req.params.id);
  refreshScheduler();
  res.status(204).send();
});

router.get("/:id/outcome", (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }
  try {
    res.json(getJobOutcome(db, jobId));
  } catch (error) {
    res.status(error instanceof JobOutcomeError ? error.status : 500)
      .json({ error: error instanceof JobOutcomeError ? error.message : "Could not read job result" });
  }
});

router.post("/:id/outcome", (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }
  const active = getExecutionStatus();
  if ([...active.running, ...active.queued].some((entry) => entry.jobId === jobId) ||
    hasActiveBatchJob(db, jobId)) {
    res.status(409).json({ error: "Job is running or queued; finish or cancel it before correcting its result" });
    return;
  }
  try {
    const result = markJobOutcome(db, jobId, req.body ?? {});
    let scheduleRefreshPending = false;
    try {
      rescheduleAfterOutcome(jobId);
    } catch (error) {
      scheduleRefreshPending = true;
      console.error("[jobs] Result saved, but the schedule could not be refreshed:", error);
    }
    const row = db.prepare(
      "SELECT j.*, a.name AS account_name FROM jobs j LEFT JOIN tg_accounts a ON j.account_id = a.id WHERE j.id = ?",
    ).get(jobId) as JobRow;
    res.json({ ...result, job: rowToJob(row), ...(scheduleRefreshPending ? { scheduleRefreshPending: true } : {}) });
  } catch (error) {
    if (!(error instanceof JobOutcomeError)) console.error("[jobs] Could not correct result:", error);
    res.status(error instanceof JobOutcomeError ? error.status : 500)
      .json({ error: error instanceof JobOutcomeError ? error.message : "Could not correct job result" });
  }
});

// Manual trigger
router.post("/:id/run", async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isSafeInteger(jobId) || jobId < 1) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }
  const jobRow = db
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .get(jobId) as JobRow | undefined;
  if (!jobRow || jobRow.retired != null) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const job = rowToJob(jobRow);
  const status = getExecutionStatus();
  const duplicate = [...status.running, ...status.queued].find((entry) => entry.jobId === job.id);
  if (duplicate || hasActiveBatchJob(db, job.id)) {
    res.status(409).json({ error: "Job is already running or queued", logId: duplicate?.logId ?? null });
    return;
  }
  const exclusiveConflict = getExclusiveConflict(job.id);
  if (exclusiveConflict) {
    res.status(409).json({
      error: "Another exclusive job is already running for this account",
      jobId: exclusiveConflict.jobId,
    });
    return;
  }
  let account: TgAccount | null = null;

  if (job.jobType === "checkin" || job.jobType === "custom" || job.jobType === "autoreg") {
    const accountRow = db
      .prepare("SELECT * FROM tg_accounts WHERE id = ?")
      .get(jobRow.account_id) as AccountRow | undefined;
    if (accountRow) decryptAccountRow(accountRow);
    if (accountRow?.disabled) {
      res.status(400).json({ error: "Account is disabled" });
      return;
    }
    if (!accountRow?.session_string || accountRow.auth_status !== "authenticated") {
      res.status(400).json({ error: "Account is not authenticated" });
      return;
    }
    account = rowToAccount(accountRow);
    if (!account.apiId || !account.apiHash) {
      res.status(400).json({
        error:
          "No API credentials available for this account. Add credentials to the account or configure global defaults in Settings.",
      });
      return;
    }
  } else if (job.accountId) {
    // Emby can run without a Telegram session, but not with a disabled or missing linked account.
    const accountRow = db
      .prepare("SELECT * FROM tg_accounts WHERE id = ?")
      .get(job.accountId) as AccountRow | undefined;
    if (accountRow) decryptAccountRow(accountRow);
    if (!accountRow || accountRow.disabled) {
      res.status(400).json({ error: accountRow ? "Account is disabled" : "Linked account no longer exists" });
      return;
    }
    if (accountRow?.session_string) {
      account = rowToAccount(accountRow);
    }
  }

  try {
    void executeManagedJob(job.id, { source: "manual" }).catch((error) =>
      console.error("[jobs] Managed manual execution failed:", error),
    );
    const current = getExecutionStatus();
    const running = current.running.find((entry) => entry.jobId === job.id);
    res.json({
      message: running ? "Job triggered" : "Job queued",
      logId: running?.logId ?? null,
      state: running ? "running" : "queued",
    });
  } catch (error) {
    console.error("[jobs] Could not enqueue manual execution:", error);
    res.status(500).json({ error: "Could not enqueue job" });
  }
});

export default router;
