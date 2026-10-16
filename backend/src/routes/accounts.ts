import { Router } from "express";
import { db, getDefaultTgApiCredentials } from "../db/database";
import { parsePaging, parseSort, textParam, escapeLike } from "./list-query";
import {
  requestCode,
  submitCode,
  submitPassword,
  checkAccountStatus,
  resendCodeAsSms,
  updateTwoFa,
  getProfile,
  updateProfile,
  getSessions,
  terminateSession,
  terminateOtherSessions,
  getPasswordInfo,
  sendLoginEmailCode,
  verifyLoginEmail,
  getPasskeys,
  deletePasskey,
  registerPasskey,
  verifyPasskeyLogin,
  startPasskeyLogin,
  getSessionDc,
  type PasswordInfo,
} from "../auth/tgAuth";
import { checkSpamStatus } from "../jobs/checkin";
import { generateProfiles } from "../jobs/profileGen";
import {
  startBulkAdd,
  getBulkAddStatus,
  cancelBulkAdd,
  isBulkAccountManagementEnabled,
  type BulkAddOptions,
} from "../jobs/bulkAdd";
import {
  startBulkProfile,
  getBulkProfileStatus,
  cancelBulkProfile,
  type BulkProfileEntry,
  type BulkProfileOptions,
} from "../jobs/bulkProfile";
import {
  changeLoginEmailViaGmail,
  testGmailImap,
} from "../jobs/bulkLoginEmail";
import type { AuthStatus } from "../types";
import { parseTgProxy } from "../jobs/runner";
import { resolveAppClientParams, previewDeviceModel } from "../tg/appClient";
import { isAuthError, markSessionExpired } from "../tg/liveClient";
import {
  savePasskeySecret,
  getPasskeySecret,
  deletePasskeySecret,
  storedPasskeyIdsForAccount,
  accountPasskeySecrets,
  parseStoredPasskey,
  importedPasskeyFor,
  setAccountPasskeyDc,
  pruneAccountPasskeySecrets,
} from "../tg/passkeyStore";
import {
  parseAttributes,
  publicAttributes,
  publicTags,
  normalizeTags,
  writeAttributes,
  patchAttributes,
  foldImportedAttributes,
} from "../db/accountAttributes";
import { refreshScheduler } from "../scheduler";
import {
  decryptPayload,
  encryptPayload,
  type EncryptedEnvelope,
} from "../db/exportCrypto";
import {
  decryptAccountRow,
  encryptSecret,
  isEncryptedSecret,
} from "../db/secretColumns";

// Reasons set by checkAccountStatus for frozen/revoked sessions that need re-auth
const REAUTH_REASONS = new Set([
  "auth_key_duplicated",
  "session_revoked",
  "auth_key_unregistered",
  "account_frozen",
]);

function statusNeedsReauth(
  status: import("../auth/tgAuth").TgAccountStatus,
): boolean {
  return status.restrictions.some((r) =>
    REAUTH_REASONS.has(r.reason.toLowerCase()),
  );
}

function internalError(res: import('express').Response, err: unknown, context: string): void {
  console.error(`[accounts] ${context}:`, err);
  res.status(500).json({ error: 'An internal error occurred' });
}

/**
 * Decrypt account credentials before putting them in an export. A missing or changed
 * BEMBY_DATA_KEY makes decryptSecret return null by design; treating that as an ordinary
 * absent credential would produce a successful but lossy backup.
 */
function decryptAccountsForExport(rows: AccountRow[]): AccountRow[] {
  return rows.map((row) => {
    const encrypted = {
      apiHash: isEncryptedSecret(row.api_hash),
      sessionString: isEncryptedSecret(row.session_string),
      passkey: isEncryptedSecret(row.passkey),
    };
    decryptAccountRow(row);
    if (
      (encrypted.apiHash && row.api_hash == null) ||
      (encrypted.sessionString && row.session_string == null) ||
      (encrypted.passkey && row.passkey == null)
    ) {
      throw new Error(`Account ${row.id} has a secret that cannot be decrypted`);
    }
    if (row.passkey != null && parseStoredPasskey(row.passkey) == null) {
      throw new Error(`Account ${row.id} has an invalid stored passkey`);
    }
    return row;
  });
}

// Surface Telegram RPC refusals (e.g. EMAIL_NOT_ALLOWED) as a 400 with the raw
// error code so the frontend can translate them; returns false for other errors.
function rpcBadRequest(res: import('express').Response, err: any, context: string): boolean {
  if (typeof err?.errorMessage !== "string" || typeof err?.code !== "number") return false;
  console.warn(`[accounts] ${context}: RPC ${err.errorMessage}`);
  res.status(400).json({ error: err.errorMessage });
  return true;
}

const router = Router();

type AccountRow = {
  id: number;
  name: string;
  phone_number: string;
  api_id: number | null;
  api_hash: string | null;
  session_string: string | null;
  auth_status: AuthStatus;
  proxy_id: string | null;
  disabled: number;
  app_client_id: string | null;
  created_at: string;
  tg_user_id: string | null;
  tg_avatar: string | null;
  sort_order: number;
  tg_display_name: string | null;
  tg_username: string | null;
  notes: string | null;
  passkey: string | null;
  additional_attributes: string | null;
};

/**
 * Loads one account with its credential columns decrypted. Every handler below goes through
 * this rather than querying directly, so the decryption cannot be forgotten at a call site
 * (see db/secretColumns for why the columns are encrypted at all).
 */
function loadAccount(id: string | number | bigint): AccountRow | undefined {
  const row = db.prepare("SELECT * FROM tg_accounts WHERE id = ?").get(id) as
    | AccountRow
    | undefined;
  return row ? decryptAccountRow(row) : undefined;
}

/** Resolves effective API credentials, falling back to global defaults. Throws if neither is set. */
function resolveApiCredentials(account: AccountRow): {
  apiId: number;
  apiHash: string;
} {
  const ownCredentials =
    account.api_id && account.api_hash
      ? { apiId: account.api_id, apiHash: account.api_hash }
      : null;
  const credentials = ownCredentials ?? getDefaultTgApiCredentials();
  const apiId = credentials?.apiId;
  const apiHash = credentials?.apiHash;
  if (!apiId || !apiHash) {
    throw new Error(
      "No API credentials available. Add credentials to this account or configure global defaults in Settings.",
    );
  }
  return { apiId, apiHash };
}

function resolveProxyUrl(
  proxyId: string | null | undefined,
): string | undefined {
  if (!proxyId) return undefined;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("proxies") as { value: string } | undefined;
    if (!row?.value) return undefined;
    const list = JSON.parse(row.value) as Array<{ id: string; url: string }>;
    return list.find((p) => p.id === proxyId)?.url;
  } catch {
    return undefined;
  }
}

function toJson(row: AccountRow) {
  const attrs = parseAttributes(row.additional_attributes);
  const tags = publicTags(attrs.tags);
  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone_number,
    apiId: row.api_id ?? null,
    // apiHash intentionally omitted from responses
    /** True when the account has no per-account credentials and relies on global defaults. */
    usesDefaultCredentials: !row.api_id || !row.api_hash,
    authStatus: row.auth_status,
    proxyId: row.proxy_id ?? null,
    disabled: Boolean(row.disabled),
    appClientId: row.app_client_id ?? null,
    createdAt: row.created_at,
    sortOrder: row.sort_order ?? 0,
    tgDisplayName: row.tg_display_name ?? null,
    tgUsername: row.tg_username ?? null,
    tgUserId: row.tg_user_id ?? null,
    tgAvatar: shouldFetchTgAvatar() ? row.tg_avatar ?? null : null,
    notes: row.notes ?? null,
    resolvedDeviceModel: previewDeviceModel(row.id, row.app_client_id),
    // Generic UI-safe flags; the passkey secret is deliberately never included here.
    attributes: publicAttributes(attrs),
    tags,
    // Whether the Telegram account has ANY passkey (any device/origin). Sourced from the
    // stored flag, refreshed whenever Bemby lists the account's passkeys.
    hasPasskey:
      (attrs.hasPasskey as boolean | undefined) ??
      false,
    // Whether Bemby holds a stored passkey usable for login (its home DC is known).
    hasBembyPasskey: parseStoredPasskey(row.passkey)?.dcId != null,
  };
}

function accountAttributesColumnAvailable(): boolean {
  try {
    return (db.prepare("PRAGMA table_info(tg_accounts)").all() as Array<{ name: string }>)
      .some((column) => column.name === "additional_attributes");
  } catch {
    return false;
  }
}

type TagFilter = {
  name: string;
  op?: "has" | "lacks" | "eq" | "ne" | "contains" | "gt" | "gte" | "lt" | "lte";
  value?: string;
};

function parseTagFilters(query: Record<string, unknown>): TagFilter[] {
  const filters: TagFilter[] = [];
  const add = (value: unknown) => {
    if (!value) return;
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of values) {
        if (!item || typeof item !== "object") continue;
        const name = String((item as any).name ?? "").trim();
        if (!name) continue;
        const op = String((item as any).op ?? "has") as TagFilter["op"];
        const allowed = new Set<TagFilter["op"]>([
          "has", "lacks", "eq", "ne", "contains", "gt", "gte", "lt", "lte",
        ]);
        filters.push({
          name,
          op: allowed.has(op) ? op : "has",
          value: (item as any).value == null ? undefined : String((item as any).value),
        });
      }
    } catch {
      // A malformed optional filter is ignored; the rest of the account query remains usable.
    }
  };
  add(query.tagFilters);
  const tag = textParam(query.tag);
  if (tag) {
    filters.push({
      name: tag,
      op: (textParam(query.tagOp) || (textParam(query.tagValue) ? "contains" : "has")) as TagFilter["op"],
      value: textParam(query.tagValue) || undefined,
    });
  }
  return filters.slice(0, 32);
}

export function tagFilterSql(filter: TagFilter): { sql: string; params: (string | number)[] } {
  const op = filter.op ?? "has";
  const base =
    "json_extract(CASE WHEN json_valid(COALESCE(tg_accounts.additional_attributes, '')) " +
    "THEN tg_accounts.additional_attributes ELSE '{}' END, '$.tags')";
  const exists = `EXISTS (SELECT 1 FROM json_each(${base}) AS tag WHERE tag.key = ?)`;
  if (op === "has") return { sql: exists, params: [filter.name] };
  if (op === "lacks") return { sql: `NOT ${exists}`, params: [filter.name] };
  const orderedOp = op === "gt" || op === "gte" || op === "lt" || op === "lte";
  let comparison = "=";
  let value = filter.value ?? "";
  if (op === "contains") {
    comparison = "LIKE";
    value = `%${escapeLike(value)}%`;
  } else if (op === "ne") {
    comparison = "<>";
  } else if (op === "gt") comparison = ">";
  else if (op === "gte") comparison = ">=";
  else if (op === "lt") comparison = "<";
  else if (op === "lte") comparison = "<=";
  let numericValue: number | null = null;
  if (orderedOp || op === "eq" || op === "ne") {
    try {
      // Match SQLite's complete JSON-number grammar, not partial numeric casts.
      const parsed = JSON.parse(value.replace(/,/g, ""));
      if (typeof parsed === "number" && Number.isFinite(parsed)) numericValue = parsed;
    } catch {
      // eq/ne retain exact text semantics for non-numeric filter values.
    }
  }
  if (orderedOp && numericValue === null) return { sql: "0", params: [] };
  if (numericValue !== null) {
    const numberText = "REPLACE(CAST(tag.value AS TEXT), ',', '')";
    const numberExpr = `CAST(${numberText} AS REAL)`;
    // CASE protects json_type from malformed JSON; markers/nulls are not numbers.
    const numberGuard =
      `tag.type IN ('text', 'integer', 'real') AND CASE WHEN json_valid(${numberText}) ` +
      `THEN CASE WHEN json_type(${numberText}) IN ('integer', 'real') ` +
      `THEN ABS(${numberExpr}) <= 1.7976931348623157e308 ELSE 0 END ELSE 0 END`;
    return {
      sql: `EXISTS (SELECT 1 FROM json_each(${base}) AS tag WHERE tag.key = ? AND ${numberGuard} AND ${numberExpr} ${comparison} ?)`,
      params: [filter.name, numericValue],
    };
  }
  return {
    sql: `EXISTS (SELECT 1 FROM json_each(${base}) AS tag WHERE tag.key = ? AND CAST(tag.value AS TEXT) ${comparison} ?${op === "contains" ? " ESCAPE '\\'" : ""})`,
    params: [filter.name, value],
  };
}

function saveTgMeta(
  id: number,
  firstName: string,
  lastName: string | undefined,
  username: string | undefined,
  userId?: string,
  avatar?: string | null,
) {
  const displayName = [firstName, lastName].filter(Boolean).join(" ");
  if (avatar !== undefined) {
    db.prepare(
      "UPDATE tg_accounts SET tg_display_name = ?, tg_username = ?, tg_user_id = COALESCE(?, tg_user_id), tg_avatar = ? WHERE id = ?",
    ).run(displayName || null, username || null, userId || null, avatar, id);
  } else {
    db.prepare(
      "UPDATE tg_accounts SET tg_display_name = ?, tg_username = ?, tg_user_id = COALESCE(?, tg_user_id) WHERE id = ?",
    ).run(displayName || null, username || null, userId || null, id);
  }
}

function shouldFetchTgAvatar(): boolean {
  try {
    const setting = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("account_display_with_tg_avatar") as { value?: string } | undefined;
    return setting?.value === "true";
  } catch {
    return false;
  }
}

const ACCOUNT_SORTS: Record<string, string> = {
  order: "sort_order, id",
  name: "name COLLATE NOCASE",
  phone: "phone_number",
  status: "auth_status",
  created: "created_at",
};

router.get("/", (req, res) => {
  const query = req.query as Record<string, unknown>;
  const paging = parsePaging(query);
  const search = textParam(query.search);
  const authStatus = textParam(query.authStatus);
  const disabled = textParam(query.disabled);
  const tagFilters = accountAttributesColumnAvailable()
    ? parseTagFilters(query)
    : [];

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (search) {
    const searchColumns = [
      "name LIKE ? ESCAPE '\\'",
      "phone_number LIKE ? ESCAPE '\\'",
      "COALESCE(tg_display_name, '') LIKE ? ESCAPE '\\'",
      "COALESCE(tg_username, '') LIKE ? ESCAPE '\\'",
      "COALESCE(notes, '') LIKE ? ESCAPE '\\'",
    ];
    if (accountAttributesColumnAvailable()) {
      searchColumns.push("COALESCE(additional_attributes, '') LIKE ? ESCAPE '\\'");
      searchColumns.push("REPLACE(COALESCE(additional_attributes, ''), ',', '') LIKE ? ESCAPE '\\'");
    }
    conditions.push(`(${searchColumns.join(" OR ")})`);
    const like = `%${escapeLike(search)}%`;
    params.push(...searchColumns.map(() => like));
  }
  if (authStatus) {
    conditions.push("auth_status = ?");
    params.push(authStatus);
  }
  if (disabled === "1" || disabled === "0") {
    conditions.push("COALESCE(disabled, 0) = ?");
    params.push(Number(disabled));
  }
  for (const filter of tagFilters) {
    const compiled = tagFilterSql(filter);
    conditions.push(compiled.sql);
    params.push(...compiled.params);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderClause = parseSort(query, ACCOUNT_SORTS, ACCOUNT_SORTS.order);

  if (!paging) {
    const rows = db
      .prepare(`SELECT * FROM tg_accounts ${where} ORDER BY ${orderClause}`)
      .all(...params) as AccountRow[];
    rows.forEach(decryptAccountRow);
    res.json(rows.map(toJson));
    return;
  }

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM tg_accounts ${where}`)
    .get(...params) as { total: number };

  const rows = db
    .prepare(`SELECT * FROM tg_accounts ${where} ORDER BY ${orderClause} LIMIT ? OFFSET ?`)
    .all(...params, paging.limit, paging.offset) as AccountRow[];
  rows.forEach(decryptAccountRow);

  res.json({
    items: rows.map(toJson),
    total: totalRow.total,
    page: paging.page,
    pageSize: paging.pageSize,
  });
});

router.post("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { name, phoneNumber, apiId, apiHash, proxyId, appClientId, notes } = body;
  if (
    typeof name !== "string" ||
    typeof phoneNumber !== "string" ||
    !name ||
    !phoneNumber
  ) {
    res.status(400).json({ error: "name and phoneNumber are required" });
    return;
  }
  if (
    apiId !== undefined &&
    apiId !== null &&
    apiId !== "" &&
    ((typeof apiId !== "number" && typeof apiId !== "string") ||
      !Number.isSafeInteger(Number(apiId)) ||
      Number(apiId) <= 0)
  ) {
    res.status(400).json({ error: "apiId must be a positive integer" });
    return;
  }
  if (apiHash !== undefined && apiHash !== null && typeof apiHash !== "string") {
    res.status(400).json({ error: "apiHash must be a string" });
    return;
  }
  for (const [field, value] of [
    ["proxyId", proxyId],
    ["appClientId", appClientId],
    ["notes", notes],
  ] as const) {
    if (value !== undefined && value !== null && typeof value !== "string") {
      res.status(400).json({ error: `${field} must be a string` });
      return;
    }
  }
  // API credentials required unless global defaults are configured
  if ((!apiId || !apiHash) && !getDefaultTgApiCredentials()) {
    res.status(400).json({
      error:
        "apiId and apiHash are required (or configure global defaults in Settings)",
    });
    return;
  }

  const maxRow = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM tg_accounts")
    .get() as { m: number };
  const result = db
    .prepare(
      "INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, proxy_id, app_client_id, sort_order, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      name,
      phoneNumber,
      apiId ? Number(apiId) : null,
      encryptSecret((apiHash as string | null | undefined) || null),
      (proxyId as string | null | undefined) || null,
      (appClientId as string | null | undefined) || null,
      maxRow.m + 1,
      (notes as string | null | undefined) || null,
    );

  const row = loadAccount(result.lastInsertRowid) as AccountRow;
  res.status(201).json(toJson(row));
});

// POST /bulk-add -- create accounts from "phone----apiUrl" lines, then
// authenticate them one by one using codes/2FA served by each API page
// Reject bulk-management requests unless enabled via BULK_ACCOUNT_MANAGEMENT
const bulkMgmtGuard: import("express").RequestHandler = (_req, res, next) => {
  if (!isBulkAccountManagementEnabled()) {
    res.status(403).json({ error: "Bulk account management is not enabled" });
    return;
  }
  next();
};

router.post("/bulk-add", bulkMgmtGuard, (req, res) => {
  const { text, options } = req.body as {
    text?: string;
    options?: BulkAddOptions;
  };
  if (!text || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const result = startBulkAdd(text, options);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json(result.batch);
});

// GET /bulk-add/status -- current batch progress (null if none has run)
router.get("/bulk-add/status", bulkMgmtGuard, (_req, res) => {
  res.json(getBulkAddStatus());
});

// POST /bulk-add/cancel -- stop the running batch after the current step
router.post("/bulk-add/cancel", bulkMgmtGuard, (_req, res) => {
  res.json({ cancelled: cancelBulkAdd() });
});

// POST /bulk-profile -- update first/last name + bio on many accounts at once
router.post("/bulk-profile", bulkMgmtGuard, (req, res) => {
  const { items, options } = req.body as {
    items?: BulkProfileEntry[];
    options?: BulkProfileOptions;
  };
  if (!Array.isArray(items) || !items.length) {
    res.status(400).json({ error: "items array required" });
    return;
  }
  const result = startBulkProfile(items, options);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json(result.batch);
});

// POST /bulk-profile/generate -- AI-written profiles, cleaned to what Telegram accepts
router.post("/bulk-profile/generate", bulkMgmtGuard, async (req, res) => {
  const { count, hint, includeAbout } = req.body as {
    count?: number;
    hint?: string;
    includeAbout?: boolean;
  };
  const wanted = Number(count);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > 200) {
    res.status(400).json({ error: "count must be between 1 and 200" });
    return;
  }
  try {
    const { profiles } = await generateProfiles(
      wanted,
      hint?.trim() || undefined,
      includeAbout !== false,
    );
    res.json({ profiles });
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? "Profile generation failed" });
  }
});

// GET /bulk-profile/status -- current batch progress (null if none has run)
router.get("/bulk-profile/status", bulkMgmtGuard, (_req, res) => {
  res.json(getBulkProfileStatus());
});

// POST /bulk-profile/cancel -- stop the running batch after the current step
router.post("/bulk-profile/cancel", bulkMgmtGuard, (_req, res) => {
  res.json({ cancelled: cancelBulkProfile() });
});

// POST /gmail/test -- check Gmail IMAP login works (for bulk login-email change)
router.post("/gmail/test", bulkMgmtGuard, async (req, res) => {
  const { gmail, appPassword } = req.body as {
    gmail?: string;
    appPassword?: string;
  };
  if (!gmail || !gmail.includes("@") || !appPassword) {
    res.status(400).json({ error: "gmail and appPassword are required" });
    return;
  }
  const result = await testGmailImap(gmail.trim(), appPassword);
  res.json(result);
});

// PUT /reorder -- update sort_order for multiple accounts at once
router.put("/reorder", (req, res) => {
  const { items } = req.body as {
    items?: Array<{ id: number; sortOrder: number }>;
  };
  if (!Array.isArray(items)) {
    res.status(400).json({ error: "items array required" });
    return;
  }
  const update = db.prepare(
    "UPDATE tg_accounts SET sort_order = ? WHERE id = ?",
  );
  const tx = db.transaction(() => {
    for (const { id, sortOrder } of items) update.run(sortOrder, id);
  });
  tx();
  res.json({ ok: true });
});

// PUT /bulk-notes -- update notes for multiple accounts at once
router.put("/bulk-notes", (req, res) => {
  const { ids, notes } = req.body as { ids?: number[]; notes?: string | null };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: "ids array required" });
    return;
  }
  const newNotes = notes || null;
  const update = db.prepare("UPDATE tg_accounts SET notes = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const id of ids) update.run(newNotes, id);
  });
  tx();
  res.json({ ok: true });
});

// PUT /bulk-rename -- set the Bemby name for multiple accounts at once. Each
// item carries its own pre-computed name; blank names are skipped.
router.put("/bulk-rename", (req, res) => {
  const { items } = req.body as {
    items?: Array<{ id: number; name: string }>;
  };
  if (!Array.isArray(items) || !items.length) {
    res.status(400).json({ error: "items array required" });
    return;
  }
  const update = db.prepare("UPDATE tg_accounts SET name = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const { id, name } of items) {
      const trimmed = String(name ?? "").trim();
      if (trimmed) update.run(trimmed, id);
    }
  });
  tx();
  res.json({ ok: true });
});

type AccountImportItem = {
  name?: string;
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  sessionString?: string | null;
  authStatus?: string;
  proxyId?: string | null;
  appClientId?: string | null;
  disabled?: boolean;
  // Passkey secret and generic flags travel inline with the account. `passkey` is the
  // current shape; `passkeys` (array) from interim builds is still tolerated on import.
  passkey?: unknown;
  passkeys?: unknown;
  additionalAttributes?: Record<string, unknown> | null;
};

// POST /export -- export selected (or all) accounts with sensitive fields
router.post("/export", (req, res) => {
  const { ids, secret } = (req.body ?? {}) as {
    ids?: number[];
    secret?: string;
  };
  if (
    secret !== undefined &&
    (typeof secret !== "string" || !secret || secret.length > 1024)
  ) {
    res.status(400).json({ error: "Invalid encryption secret" });
    return;
  }
  if (
    ids !== undefined &&
    (
      !Array.isArray(ids) ||
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    )
  ) {
    res.status(400).json({ error: "ids must contain positive integer account ids" });
    return;
  }
  let rows: AccountRow[];
  if (Array.isArray(ids) && ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    rows = db
      .prepare(
        `SELECT * FROM tg_accounts WHERE id IN (${placeholders}) ORDER BY id`,
      )
      .all(...ids) as AccountRow[];
  } else {
    rows = db
      .prepare("SELECT * FROM tg_accounts ORDER BY id")
      .all() as AccountRow[];
  }
  // A backup carries the credentials in the clear inside its own encrypted envelope, so the
  // at-rest key is never needed to restore one somewhere else. Refuse a partial export when
  // the at-rest key is missing or no longer matches the stored ciphertext.
  try {
    decryptAccountsForExport(rows);
  } catch (error) {
    console.warn("[accounts] export failed:", error);
    res.status(409).json({
      error:
        "Account export could not be read completely. Check the data encryption key and server logs.",
    });
    return;
  }
  const payload = {
    version: "1",
    exportedAt: new Date().toISOString(),
    accounts: rows.map((a) => ({
      name: a.name,
      phoneNumber: a.phone_number,
      apiId: a.api_id,
      apiHash: a.api_hash,
      sessionString: a.session_string,
      authStatus: a.auth_status,
      proxyId: a.proxy_id ?? null,
      appClientId: a.app_client_id ?? null,
      disabled: Boolean(a.disabled),
      // Passkey secret (incl. private key + home DC) so the account can still log in
      // after import, even when force-reauth clears the session string.
      passkey: parseStoredPasskey(a.passkey),
      // Generic per-account flags bag.
      additionalAttributes: parseAttributes(a.additional_attributes),
    })),
  };
  const hasSecrets = payload.accounts.some(
    (a) =>
      a.sessionString != null || a.apiHash || a.passkey?.privateKeyPem,
  );
  if (hasSecrets && !secret) {
    res.status(400).json({
      error: 'This export contains session strings or API credentials. Provide an encryption secret.',
      code: 'SECRET_REQUIRED',
    });
    return;
  }

  if (secret) {
    res.json(encryptPayload(JSON.stringify(payload), secret));
  } else {
    res.json(payload);
  }
});

// POST /import -- import accounts; skips existing by phone number
router.post("/import", (req, res) => {
  let {
    data,
    secret,
    forceReauth = true,
  } = (req.body ?? {}) as {
    data:
      { version?: string; accounts?: AccountImportItem[] } | EncryptedEnvelope;
    secret?: string;
    forceReauth?: boolean;
  };

  if (
    typeof forceReauth !== "boolean" ||
    (secret !== undefined &&
      (typeof secret !== "string" || secret.length > 1024))
  ) {
    res.status(400).json({ error: "Invalid import options" });
    return;
  }

  if (data && (data as EncryptedEnvelope).encrypted === true) {
    if (!secret) {
      res
        .status(400)
        .json({
          error:
            "This backup is encrypted. Please provide the secret to decrypt it.",
        });
      return;
    }
    try {
      data = JSON.parse(decryptPayload(data as EncryptedEnvelope, secret));
    } catch {
      res
        .status(400)
        .json({
          error: "Incorrect secret or corrupted backup file",
          code: "WRONG_SECRET",
        });
      return;
    }
  }

  const payload = data as { version?: string; accounts?: AccountImportItem[] };
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload.version !== undefined && payload.version !== "1")
  ) {
    res.status(400).json({ error: "Invalid or unsupported account export file" });
    return;
  }
  const items = payload?.accounts;
  if (!Array.isArray(items)) {
    res.status(400).json({ error: "accounts array required" });
    return;
  }
  for (let index = 0; index < items.length; index++) {
    const item = items[index] as unknown;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      res.status(400).json({ error: `Invalid account at index ${index}` });
      return;
    }
    const account = item as Record<string, unknown>;
    const stringFields = [
      "name",
      "phoneNumber",
      "apiHash",
      "sessionString",
      "authStatus",
      "proxyId",
      "appClientId",
    ] as const;
    for (const field of stringFields) {
      const value = account[field];
      if (value !== undefined && value !== null && typeof value !== "string") {
        res.status(400).json({ error: `Invalid account ${field} at index ${index}` });
        return;
      }
    }
    if (
      account.apiId !== undefined &&
      account.apiId !== null &&
      account.apiId !== "" &&
      (
        (typeof account.apiId !== "number" && typeof account.apiId !== "string") ||
        !Number.isSafeInteger(Number(account.apiId)) ||
        Number(account.apiId) <= 0
      )
    ) {
      res.status(400).json({ error: `Invalid account apiId at index ${index}` });
      return;
    }
    if (account.disabled !== undefined && typeof account.disabled !== "boolean") {
      res.status(400).json({ error: `Invalid account disabled at index ${index}` });
      return;
    }
  }
  let imported = 0;
  let skipped = 0;
  const defaults = getDefaultTgApiCredentials();
  db.transaction(() => {
    for (const a of items) {
      if (!a.phoneNumber || ((!a.apiId || !a.apiHash) && !defaults)) {
        skipped++;
        continue;
      }
      const existing = db
        .prepare("SELECT id FROM tg_accounts WHERE phone_number = ?")
        .get(a.phoneNumber) as { id: number } | undefined;
      if (existing) {
        skipped++;
        continue;
      }
      const info = db
        .prepare(
          "INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status, proxy_id, app_client_id, disabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          a.name || a.phoneNumber,
          a.phoneNumber,
          a.apiId ? Number(a.apiId) : null,
          encryptSecret(a.apiHash),
          encryptSecret(forceReauth ? null : (a.sessionString ?? null)),
          forceReauth ? "unauthenticated" : (a.authStatus ?? "unauthenticated"),
          a.proxyId ?? null,
          a.appClientId ?? null,
          a.disabled ? 1 : 0,
        );
      const newId = Number(info.lastInsertRowid);
      // Restore the passkey secret under the newly assigned account id. The passkey (with
      // its home DC) is what lets the account log in after a force-reauth import.
      const pk = importedPasskeyFor(a);
      if (pk) savePasskeySecret({ ...pk, accountId: newId });
      // Restore the generic attributes bag.
      const attrs = foldImportedAttributes(a);
      if (attrs) writeAttributes(newId, attrs);
      imported++;
    }
  })();
  res.json({ imported, skipped });
});

// PUT /:id/tags -- replace the account's user-defined tags while preserving other
// attributes (passkey/restriction/email flags are maintained by their own flows).
router.put("/:id/tags", (req, res) => {
  const existing = loadAccount(req.params.id) as AccountRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const body = req.body as { tags?: unknown };
  if (body.tags !== undefined && (body.tags === null || typeof body.tags !== "object" || Array.isArray(body.tags))) {
    res.status(400).json({ error: "tags must be an object" });
    return;
  }
  const attrs = parseAttributes(existing.additional_attributes);
  const tags = normalizeTags(body.tags ?? {});
  if (Object.keys(tags).length) attrs.tags = tags;
  else delete attrs.tags;
  writeAttributes(Number(req.params.id), attrs);
  const row = loadAccount(req.params.id) as AccountRow;
  res.json(toJson(row));
});

// PUT /bulk-tags -- replace tags on each selected account. One shared tag map is
// intentionally used so the operation is deterministic and easy to retry.
router.put("/bulk-tags", (req, res) => {
  const { ids, tags } = req.body as { ids?: number[]; tags?: unknown };
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    res.status(400).json({ error: "ids must contain positive integer account ids" });
    return;
  }
  if (tags !== undefined && (tags === null || typeof tags !== "object" || Array.isArray(tags))) {
    res.status(400).json({ error: "tags must be an object" });
    return;
  }
  const missing = ids.find((id) =>
    !db.prepare("SELECT 1 FROM tg_accounts WHERE id = ?").get(id),
  );
  if (missing !== undefined) {
    res.status(404).json({ error: `Account ${missing} not found` });
    return;
  }
  const normalized = normalizeTags(tags ?? {});
  const tx = db.transaction(() => {
    for (const id of ids) {
      const row = db.prepare(
        "SELECT additional_attributes FROM tg_accounts WHERE id = ?",
      ).get(id) as { additional_attributes: string | null };
      const attrs = parseAttributes(row.additional_attributes);
      if (Object.keys(normalized).length) attrs.tags = normalized;
      else delete attrs.tags;
      writeAttributes(Number(id), attrs);
    }
  });
  tx();
  res.json({ ok: true, tags: normalized });
});

router.put("/:id", (req, res) => {
  const accountId = Number(req.params.id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    res.status(400).json({ error: "Invalid account id" });
    return;
  }
  const {
    name,
    phoneNumber,
    apiId,
    apiHash,
    proxyId,
    disabled,
    appClientId,
    notes,
  } = (req.body ?? {}) as Record<string, unknown>;
  for (const [field, value] of [
    ["name", name],
    ["phoneNumber", phoneNumber],
    ["apiHash", apiHash],
    ["proxyId", proxyId],
    ["appClientId", appClientId],
    ["notes", notes],
  ] as const) {
    if (value !== undefined && value !== null && typeof value !== "string") {
      res.status(400).json({ error: `${field} must be a string` });
      return;
    }
  }
  if (disabled !== undefined && typeof disabled !== "boolean") {
    res.status(400).json({ error: "disabled must be a boolean" });
    return;
  }
  if (
    apiId !== undefined &&
    apiId !== null &&
    apiId !== "" &&
    ((typeof apiId !== "number" && typeof apiId !== "string") ||
      !Number.isSafeInteger(Number(apiId)) ||
      Number(apiId) <= 0)
  ) {
    res.status(400).json({ error: "apiId must be a positive integer" });
    return;
  }
  const existing = loadAccount(accountId) as AccountRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // undefined = not in payload (keep existing), null/'' = clear
  const newProxyId =
    proxyId !== undefined ? proxyId || null : existing.proxy_id;
  const newDisabled =
    disabled !== undefined ? (disabled ? 1 : 0) : existing.disabled;
  const newAppClientId =
    appClientId !== undefined ? appClientId || null : existing.app_client_id;
  const newNotes = notes !== undefined ? (notes as string) || null : existing.notes;

  db.prepare(
    "UPDATE tg_accounts SET name = ?, phone_number = ?, api_id = ?, api_hash = ?, proxy_id = ?, disabled = ?, app_client_id = ?, notes = ? WHERE id = ?",
  ).run(
    name ?? existing.name,
    phoneNumber ?? existing.phone_number,
    apiId !== undefined ? (apiId === null || apiId === "" ? null : Number(apiId)) : existing.api_id,
    encryptSecret((apiHash as string | null | undefined) ?? existing.api_hash),
    newProxyId,
    newDisabled,
    newAppClientId,
    newNotes,
    accountId,
  );

  const row = loadAccount(accountId) as AccountRow;
  res.json(toJson(row));
});

router.delete("/:id", (req, res) => {
  // checkin/custom jobs can't run without their linked account; deleting it here
  // would silently drop the job out of the scheduler (account_id -> NULL via FK)
  const linkedJobs = db
    .prepare(
      "SELECT name FROM jobs WHERE account_id = ? AND retired IS NULL AND (job_type = 'checkin' OR job_type = 'custom')",
    )
    .all(req.params.id) as Array<{ name: string }>;
  if (linkedJobs.length) {
    res.status(400).json({
      error: `Cannot delete account: ${linkedJobs.length} job(s) still depend on it (${linkedJobs.map((j) => j.name).join(", ")}). Reassign or delete those jobs first.`,
    });
    return;
  }
  db.prepare("DELETE FROM tg_accounts WHERE id = ?").run(req.params.id);
  refreshScheduler();
  res.status(204).send();
});

// ── TG account status check ─────────────────────────────────────────────────

router.post("/:id/check-status", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }

  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const status = await checkAccountStatus(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
      shouldFetchTgAvatar(),
    );
    if (statusNeedsReauth(status)) markSessionExpired(account.id);
    saveTgMeta(
      account.id,
      status.firstName,
      status.lastName,
      status.username,
      status.id,
      status.avatar,
    );
    res.json(status);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account.id);
    internalError(res, err, 'check-status');
  }
});

// POST /:id/refresh-tg-meta -- fetch TG display name/username/id and persist it.
router.post("/:id/refresh-tg-meta", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const status = await checkAccountStatus(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
      shouldFetchTgAvatar(),
    );
    if (statusNeedsReauth(status)) markSessionExpired(account.id);
    saveTgMeta(
      account.id,
      status.firstName,
      status.lastName,
      status.username,
      status.id,
      status.avatar,
    );
    const displayName = [status.firstName, status.lastName]
      .filter(Boolean)
      .join(" ");
    const current = loadAccount(account.id);
    res.json({
      tgDisplayName: displayName || null,
      tgUsername: status.username ?? null,
      tgUserId: status.id ?? null,
      tgAvatar: shouldFetchTgAvatar() ? current?.tg_avatar ?? null : null,
    });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account.id);
    internalError(res, err, 'refresh-tg-meta');
  }
});

// POST /check-enabled-sessions -- check all enabled+authenticated accounts and mark expired ones
router.post("/check-enabled-sessions", async (req, res) => {
  const rows = db
    .prepare(
      "SELECT * FROM tg_accounts WHERE disabled = 0 AND auth_status = 'authenticated'",
    )
    .all() as AccountRow[];
  rows.forEach(decryptAccountRow);

  const results = await Promise.allSettled(
    rows.map(async (account) => {
      if (!account.session_string) return { id: account.id, expired: true };
      try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = parseTgProxy(proxyUrl);
        const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
        const status = await checkAccountStatus(
          apiId,
          apiHash,
          account.session_string,
          proxy,
          deviceParams,
          shouldFetchTgAvatar(),
        );
        if (statusNeedsReauth(status)) {
          markSessionExpired(account.id);
          return { id: account.id, expired: true };
        }
        saveTgMeta(
          account.id,
          status.firstName,
          status.lastName,
          status.username,
          status.id,
          status.avatar,
        );
        return { id: account.id, expired: false };
      } catch (err: any) {
        if (isAuthError(err?.message ?? "")) {
          markSessionExpired(account.id);
          return { id: account.id, expired: true };
        }
        return { id: account.id, expired: false };
      }
    }),
  );

  const expired = results
    .filter(
      (r) =>
        r.status === "fulfilled" &&
        (r as PromiseFulfilledResult<any>).value.expired,
    )
    .map((r) => (r as PromiseFulfilledResult<any>).value.id);

  res.json({ checked: rows.length, expired });
});

// POST /:id/check-spam -- send /start to @SpamBot and return the parsed spam status
router.post("/:id/check-spam", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }

  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const result = await checkSpamStatus(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    // Persist the SpamBot verdict for the account-list badge. A confirmed
    // unrestricted account is deliberately stored as `free`, so "checked and
    // clear" is distinguishable from "never checked".
    if (result.spamStatus === "free") {
      patchAttributes(account.id, { restriction: "free" });
    } else if (result.spamStatus !== "unknown") {
      patchAttributes(account.id, { restriction: result.spamStatus });
    }
    res.json(result);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account.id);
    internalError(res, err, 'check-spam');
  }
});

// POST /:id/fetch-attributes -- refresh all TG meta and extra attributes for one
// account (display name/username, hasEmail, hasPasskey). Deliberately excludes the
// spam check. Each step runs independently so one failure does not block the rest;
// per-step failures are returned as warnings.
router.post("/:id/fetch-attributes", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!requireAuth(account, res)) return;

  let apiId!: number;
  let apiHash!: string;
  let proxy!: ReturnType<typeof parseTgProxy>;
  let deviceParams!: ReturnType<typeof resolveAppClientParams>;
  try {
    ({ apiId, apiHash } = resolveApiCredentials(account));
    proxy = parseTgProxy(resolveProxyUrl(account.proxy_id));
    deviceParams = resolveAppClientParams(account.id, account.app_client_id);
  } catch (err: any) {
    internalError(res, err, "fetch-attributes");
    return;
  }

  const warnings: string[] = [];
  let authExpired = false;
  // Skip remaining steps once the session is known dead; they would only fail too.
  const runStep = async (label: string, fn: () => Promise<void>) => {
    if (authExpired) return;
    try {
      await fn();
    } catch (err: any) {
      if (isAuthError(err?.message ?? "")) {
        markSessionExpired(account.id);
        authExpired = true;
      }
      warnings.push(
        `${label}: ${err?.errorMessage ?? err?.message ?? "failed"}`,
      );
    }
  };

  await runStep("status", async () => {
    const status = await checkAccountStatus(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
      shouldFetchTgAvatar(),
    );
    if (statusNeedsReauth(status)) {
      markSessionExpired(account.id);
      authExpired = true;
    }
    saveTgMeta(
      account.id,
      status.firstName,
      status.lastName,
      status.username,
      status.id,
      status.avatar,
    );
  });
  await runStep("password-info", async () => {
    const info = await getPasswordInfo(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    patchAttributes(account.id, {
      hasEmail: info.loginEmailPattern ? true : undefined,
    });
  });
  await runStep("passkeys", async () => {
    const passkeys = await getPasskeys(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    pruneAccountPasskeySecrets(
      account.id,
      passkeys.map((p) => p.id),
    );
    patchAttributes(account.id, { hasPasskey: passkeys.length > 0 });
  });

  const row = loadAccount(account.id) as AccountRow;
  res.json({ account: toJson(row), warnings, authExpired });
});

// POST /:id/update-2fa -- set, change, or remove the account's 2FA password
router.post("/:id/update-2fa", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  const { currentPassword, newPassword, hint } = req.body as {
    currentPassword?: string;
    newPassword?: string;
    hint?: string;
  };
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    await updateTwoFa(
      apiId,
      apiHash,
      account.session_string,
      { currentPassword, newPassword, hint },
      proxy,
      deviceParams,
    );
    res.json({ success: true });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account.id);
    internalError(res, err, 'update-2fa');
  }
});

// GET /:id/profile -- fetch the account's own Telegram profile (first/last name + bio)
router.get("/:id/profile", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const profile = await getProfile(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    res.json(profile);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account.id);
    internalError(res, err, "profile");
  }
});

// POST /:id/update-profile -- update the account's own Telegram profile
router.post("/:id/update-profile", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  const { firstName, lastName, about } = req.body as {
    firstName?: string;
    lastName?: string;
    about?: string;
  };
  if (!firstName || !firstName.trim()) {
    res.status(400).json({ error: "firstName is required" });
    return;
  }
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const profile = await updateProfile(
      apiId,
      apiHash,
      account.session_string,
      { firstName, lastName, about },
      proxy,
      deviceParams,
    );
    // Keep the cached display name in sync with the new profile
    saveTgMeta(
      account.id,
      profile.firstName,
      profile.lastName,
      account.tg_username ?? undefined,
    );
    const tgDisplayName =
      [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
    res.json({ ...profile, tgDisplayName });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account.id);
    internalError(res, err, "update-profile");
  }
});

// GET /:id/sessions -- list all active Telegram sessions for this account
router.get("/:id/sessions", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const sessions = await getSessions(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    res.json(sessions);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account.id);
    internalError(res, err, 'sessions');
  }
});

// POST /:id/terminate-session -- revoke a specific session by hash
router.post("/:id/terminate-session", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  const { hash } = req.body as { hash?: string };
  if (!hash) {
    res.status(400).json({ error: "hash required" });
    return;
  }
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    await terminateSession(
      apiId,
      apiHash,
      account.session_string,
      hash,
      proxy,
      deviceParams,
    );
    res.json({ success: true });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account.id);
    internalError(res, err, 'terminate-session');
  }
});

// POST /:id/terminate-other-sessions -- revoke all sessions except the current one
router.post("/:id/terminate-other-sessions", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    await terminateOtherSessions(
      apiId,
      apiHash,
      account.session_string,
      proxy,
      deviceParams,
    );
    res.json({ success: true });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account.id);
    internalError(res, err, 'terminate-other-sessions');
  }
});

// POST /:id/force-reauth -- clear session and reset auth status so the account can be re-authenticated
router.post("/:id/force-reauth", (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Capture the account's DC onto its stored passkeys before we drop the session,
  // so a later passkey login can still reach the right data centre.
  if (account.session_string) {
    const dc = getSessionDc(account.session_string);
    if (dc) setAccountPasskeyDc(account.id, dc);
  }
  db.prepare(
    "UPDATE tg_accounts SET session_string = NULL, auth_status = 'unauthenticated' WHERE id = ?",
  ).run(account.id);
  markSessionExpired(account.id);
  const row = loadAccount(account.id) as AccountRow;
  res.json(toJson(row));
});

// ── Login email management ────────────────────────────────────────────────────

function requireAuth(account: AccountRow | undefined, res: any): account is AccountRow & { session_string: string } {
  if (!account) { res.status(404).json({ error: "Not found" }); return false; }
  if (!account.session_string) { res.status(400).json({ error: "Account not authenticated" }); return false; }
  return true;
}

// GET /:id/password-info -- returns 2FA status and masked login email pattern (no password needed)
router.get("/:id/password-info", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!requireAuth(account, res)) return;
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const info = await getPasswordInfo(apiId, apiHash, account.session_string, proxy, deviceParams);
    // Store hasEmail only when a login email is found; drop the flag otherwise.
    patchAttributes(account.id, { hasEmail: info.loginEmailPattern ? true : undefined });
    res.json(info);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account!.id);
    internalError(res, err, "password-info");
  }
});

// POST /:id/login-email/send-code -- send a verification code to a new login email
// Telegram has no API to remove the login email from an authorised session; it can only be replaced.
router.post("/:id/login-email/send-code", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!requireAuth(account, res)) return;
  const { email } = req.body as { email?: string };
  if (!email) { res.status(400).json({ error: "email required" }); return; }
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const result = await sendLoginEmailCode(apiId, apiHash, account.session_string, email, proxy, deviceParams);
    res.json(result);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account!.id);
    if (rpcBadRequest(res, err, "login-email/send-code")) return;
    internalError(res, err, "login-email/send-code");
  }
});

// POST /:id/login-email/auto -- set a Gmail plus-address login email and read
// the confirmation code back over IMAP. Gated by BULK_ACCOUNT_MANAGEMENT.
router.post("/:id/login-email/auto", bulkMgmtGuard, async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!requireAuth(account, res)) return;
  const { gmail, appPassword, tag } = req.body as {
    gmail?: string;
    appPassword?: string;
    tag?: string;
  };
  if (!gmail || !gmail.includes("@") || !appPassword) {
    res.status(400).json({ error: "gmail and appPassword are required" });
    return;
  }
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxy = parseTgProxy(resolveProxyUrl(account.proxy_id));
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const result = await changeLoginEmailViaGmail({
      apiId,
      apiHash,
      sessionString: account.session_string,
      phoneNumber: account.phone_number,
      accountId: account.id,
      proxy,
      deviceParams,
      gmail: gmail.trim(),
      appPassword,
      tag: (tag ?? "").trim(),
    });
    res.json(result);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account!.id);
    if (rpcBadRequest(res, err, "login-email/auto")) return;
    internalError(res, err, "login-email/auto");
  }
});

// POST /:id/login-email/verify -- confirm the new login email with the emailed code
router.post("/:id/login-email/verify", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!requireAuth(account, res)) return;
  const { code } = req.body as { code?: string };
  if (!code) { res.status(400).json({ error: "code required" }); return; }
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const result = await verifyLoginEmail(apiId, apiHash, account.session_string, code, proxy, deviceParams);
    res.json(result);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account!.id);
    if (rpcBadRequest(res, err, "login-email/verify")) return;
    internalError(res, err, "login-email/verify");
  }
});

// ── Passkeys ──────────────────────────────────────────────────────────────────

// GET /:id/passkeys -- list the account's passkeys
router.get("/:id/passkeys", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!requireAuth(account, res)) return;
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxy = parseTgProxy(resolveProxyUrl(account.proxy_id));
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const passkeys = await getPasskeys(apiId, apiHash, account.session_string, proxy, deviceParams);
    // Telegram is authoritative: drop stored keys for passkeys that no longer
    // exist there (e.g. removed when the 2FA password was changed), so storedIds
    // stay accurate.
    pruneAccountPasskeySecrets(account.id, passkeys.map((p) => p.id));
    // Record whether the account has ANY passkey (any device/origin) for the list flag.
    patchAttributes(account.id, { hasPasskey: passkeys.length > 0 });
    const current = loadAccount(account.id) as AccountRow;
    res.json({
      passkeys,
      storedIds: storedPasskeyIdsForAccount(account.id),
      hasBembyPasskey: parseStoredPasskey(current.passkey)?.dcId != null,
    });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account!.id);
    if (rpcBadRequest(res, err, "passkeys/list")) return;
    internalError(res, err, "passkeys/list");
  }
});

// POST /:id/passkeys -- register a new passkey (experimental; WebAuthn ceremony run server-side)
router.post("/:id/passkeys", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!requireAuth(account, res)) return;
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxy = parseTgProxy(resolveProxyUrl(account.proxy_id));
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const origin = typeof req.body?.origin === "string" ? req.body.origin : undefined;
    const result = await registerPasskey(
      apiId,
      apiHash,
      account.session_string,
      origin,
      proxy,
      deviceParams,
    );
    // Persist the private key so the passkey can later be used/verified for login.
    const dc = getSessionDc(account.session_string) ?? {};
    savePasskeySecret({
      accountId: account.id,
      telegramPasskeyId: result.passkey.id,
      credentialId: result.credentialId,
      privateKeyPem: result.privateKeyPem,
      rpId: result.rpId,
      userHandle: result.userHandle,
      createdDate: result.passkey.date,
      ...dc,
    });
    // The account now has a passkey (this one, created by Bemby).
    patchAttributes(account.id, { hasPasskey: true });
    const current = loadAccount(account.id) as AccountRow;
    res.json({
      passkey: result.passkey,
      hasBembyPasskey: parseStoredPasskey(current.passkey)?.dcId != null,
    });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account!.id);
    if (rpcBadRequest(res, err, "passkeys/register")) return;
    internalError(res, err, "passkeys/register");
  }
});

// POST /:id/passkeys/:passkeyId/verify -- prove the passkey works via a real login
router.post("/:id/passkeys/:passkeyId/verify", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!requireAuth(account, res)) return;
  const secret = getPasskeySecret(req.params.passkeyId);
  if (!secret || secret.accountId !== account!.id) {
    res.status(404).json({ error: "no stored key for this passkey" });
    return;
  }
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxy = parseTgProxy(resolveProxyUrl(account.proxy_id));
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const origin = typeof req.body?.origin === "string" ? req.body.origin : undefined;
    const result = await verifyPasskeyLogin(
      apiId,
      apiHash,
      account.session_string,
      secret,
      origin,
      proxy,
      deviceParams,
    );
    res.json(result);
  } catch (err: any) {
    if (rpcBadRequest(res, err, "passkeys/verify")) return;
    internalError(res, err, "passkeys/verify");
  }
});

// DELETE /:id/passkeys/:passkeyId -- revoke a passkey
router.delete("/:id/passkeys/:passkeyId", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!requireAuth(account, res)) return;
  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxy = parseTgProxy(resolveProxyUrl(account.proxy_id));
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);
    const ok = await deletePasskey(
      apiId,
      apiHash,
      account.session_string,
      req.params.passkeyId,
      proxy,
      deviceParams,
    );
    if (ok) deletePasskeySecret(req.params.passkeyId);
    res.json({ ok });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account!.id);
    if (rpcBadRequest(res, err, "passkeys/delete")) return;
    internalError(res, err, "passkeys/delete");
  }
});

// ── Telegram auth flow ──────────────────────────────────────────────────────

router.post("/:id/auth/request", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  try {
    const { apiId, apiHash } = resolveApiCredentials(account);
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.id, account.app_client_id);

    // Prefer passkey login when we hold a usable (DC-known) stored passkey; fall
    // back to the code flow if none exist or the passkey is rejected.
    const secret = accountPasskeySecrets(account.id).find((s) => s.dcId != null);
    if (secret) {
      try {
        const result = await startPasskeyLogin(
          account.id,
          apiId,
          apiHash,
          secret,
          undefined,
          proxy,
        );
        if (result.needsPassword) {
          db.prepare(
            "UPDATE tg_accounts SET auth_status = 'pending_2fa' WHERE id = ?",
          ).run(account.id);
          res.json({ method: "passkey", step: "2fa" });
        } else {
          db.prepare(
            "UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?",
          ).run(encryptSecret(result.session), account.id);
          res.json({ method: "passkey", step: "done" });
        }
        return;
      } catch (err: any) {
        // Passkey unusable -- fall through to the code flow below.
        console.warn(
          `[accounts] passkey login failed for ${account.id}, falling back to code:`,
          err?.errorMessage ?? err?.message ?? err,
        );
      }
    }

    const { isCodeViaApp } = await requestCode(
      account.id,
      apiId,
      apiHash,
      account.phone_number,
      proxy,
      deviceParams,
    );
    db.prepare(
      "UPDATE tg_accounts SET auth_status = 'pending_code' WHERE id = ?",
    ).run(account.id);
    res.json({ method: "code", message: "Verification code sent", isCodeViaApp });
  } catch (err: any) {
    if (rpcBadRequest(res, err, 'auth/request')) return;
    internalError(res, err, 'auth/request');
  }
});

router.post("/:id/auth/resend", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    await resendCodeAsSms(account.id);
    res.json({ ok: true });
  } catch (err: any) {
    if (rpcBadRequest(res, err, 'auth/resend')) return;
    internalError(res, err, 'auth/resend');
  }
});

router.post("/:id/auth/verify", async (req, res) => {
  const account = loadAccount(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const { code, password } = req.body as { code?: string; password?: string };

  try {
    if (account.auth_status === "pending_code" && code) {
      const result = await submitCode(account.id, code);
      if (result.needsPassword) {
        db.prepare(
          "UPDATE tg_accounts SET auth_status = 'pending_2fa' WHERE id = ?",
        ).run(account.id);
        res.json({ step: "2fa" });
      } else {
        db.prepare(
          "UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?",
        ).run(encryptSecret(result.session), account.id);
        res.json({ step: "done" });
      }
    } else if (account.auth_status === "pending_2fa" && password) {
      const session = await submitPassword(account.id, password);
      db.prepare(
        "UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?",
      ).run(encryptSecret(session), account.id);
      res.json({ step: "done" });
    } else {
      res
        .status(400)
        .json({ error: "Invalid auth state or missing credentials" });
    }
  } catch (err: any) {
    if (rpcBadRequest(res, err, 'auth/verify')) return;
    internalError(res, err, 'auth/verify');
  }
});

export default router;
