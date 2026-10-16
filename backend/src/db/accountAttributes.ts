import { db } from "./database";

// Loose per-account metadata bag stored as JSON in tg_accounts.additional_attributes.
// Holds UI-safe flags such as email or restriction status. The passkey secret lives in
// its own tg_accounts.passkey column (see tg/passkeyStore.ts), never in this bag.
export type AccountAttributes = Record<string, unknown>;

/** A tag is either a bare marker (true) or a small scalar value. */
export type AccountTagValue = string | number | boolean | null;
export type AccountTags = Record<string, AccountTagValue>;

const MAX_TAGS = 128;
const MAX_TAG_NAME = 96;
const MAX_TAG_VALUE = 512;

/**
 * Keep tags deliberately boring: they are user-entered metadata, not executable
 * configuration. Invalid/oversized entries are ignored rather than making an
 * account row impossible to load.
 */
export function normalizeTags(input: unknown): AccountTags {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: AccountTags = {};
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.trim().slice(0, MAX_TAG_NAME);
    if (!name || Object.keys(out).length >= MAX_TAGS) continue;
    if (name === "__proto__" || name === "constructor" || name === "prototype") continue;
    if (
      rawValue !== null &&
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      continue;
    }
    if (typeof rawValue === "number" && !Number.isFinite(rawValue)) continue;
    out[name] =
      typeof rawValue === "string" ? rawValue.slice(0, MAX_TAG_VALUE) : rawValue;
  }
  return out;
}

export function tagsFromAttributes(attrs: AccountAttributes): AccountTags {
  return normalizeTags(attrs.tags);
}

export function publicTags(input: unknown): AccountTags {
  return normalizeTags(input);
}

/** Set or remove one user tag while preserving the rest of the attributes bag. */
export function setAccountTag(
  accountId: number,
  name: string,
  value: AccountTagValue,
): void {
  const key = name.trim();
  if (!key || key === "__proto__" || key === "constructor" || key === "prototype") {
    throw new Error("Tag name is required");
  }
  if (key.length > MAX_TAG_NAME) throw new Error("Tag name is too long");
  const attrs = getAttributes(accountId);
  const tags = normalizeTags(attrs.tags);
  if (value === undefined || value === null || value === "") {
    delete tags[key];
  } else {
    if (!Object.prototype.hasOwnProperty.call(tags, key) && Object.keys(tags).length >= MAX_TAGS) {
      throw new Error("Too many account tags");
    }
    if (typeof value === "string" && value.length > MAX_TAG_VALUE) {
      throw new Error("Tag value is too long");
    }
    const next = normalizeTags({ [key]: value });
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      throw new Error("Invalid tag value");
    }
    tags[key] = next[key];
  }
  if (Object.keys(tags).length) attrs.tags = tags;
  else delete attrs.tags;
  writeAttributes(accountId, attrs);
}

// Legacy settings key where passkeys lived before they moved onto the account row.
// Retained so old backups can still be recognised (and skipped) on import.
export const LEGACY_PASSKEY_STORE_KEY = "tg_passkey_secrets";

export function parseAttributes(
  raw: string | null | undefined,
): AccountAttributes {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as AccountAttributes) : {};
  } catch {
    return {};
  }
}

export function getAttributes(accountId: number): AccountAttributes {
  const row = db
    .prepare("SELECT additional_attributes FROM tg_accounts WHERE id = ?")
    .get(accountId) as { additional_attributes: string | null } | undefined;
  return parseAttributes(row?.additional_attributes);
}

export function writeAttributes(
  accountId: number,
  attrs: AccountAttributes,
): void {
  const empty = !attrs || Object.keys(attrs).length === 0;
  db.prepare(
    "UPDATE tg_accounts SET additional_attributes = ? WHERE id = ?",
  ).run(empty ? null : JSON.stringify(attrs), accountId);
}

// Merge a partial patch into the bag; a key set to undefined is removed.
export function patchAttributes(
  accountId: number,
  patch: AccountAttributes,
): void {
  const next = { ...getAttributes(accountId) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  writeAttributes(accountId, next);
}

// The bag as safe to expose to the UI. Defence in depth: strips a `passkey` key in case
// a legacy row still has the secret embedded (it belongs in the dedicated passkey column).
export function publicAttributes(attrs: AccountAttributes): AccountAttributes {
  const { passkey: _passkey, tags: _tags, ...rest } = attrs;
  const tags = publicTags(attrs.tags);
  return Object.keys(tags).length ? { ...rest, tags } : rest;
}

// The attributes bag to store for an imported account (null when absent/empty).
export function foldImportedAttributes(item: any): AccountAttributes | null {
  const bag = item?.additionalAttributes;
  if (bag && typeof bag === "object" && Object.keys(bag).length) {
    const attrs = { ...(bag as AccountAttributes) };
    if ("tags" in attrs) {
      const tags = normalizeTags(attrs.tags);
      if (Object.keys(tags).length) attrs.tags = tags;
      else delete attrs.tags;
    }
    return attrs;
  }
  return null;
}
