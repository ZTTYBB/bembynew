import { db } from "../db/database";
import { decryptSecret, encryptSecret } from "../db/secretColumns";

// Bemby stores a single passkey per account in the dedicated tg_accounts.passkey column
// (JSON). One passkey per account keeps export/import trivial: the passkey travels with
// the account and needs no id remapping. It is kept in its own column, out of the UI-safe
// additional_attributes bag, because it holds a private key -- treat as sensitive and
// never serialise it to the client.

export type PasskeySecret = {
  accountId: number;
  telegramPasskeyId: string;
  credentialId: string; // base64url, used for the assertion's id/raw_id
  privateKeyPem: string;
  rpId: string;
  userHandle: string; // base64url user.id from the registration options
  createdDate: number;
  // Account's home DC, captured while a session exists so passkey login still
  // works after force-reauth clears the session string.
  dcId?: number;
  serverAddress?: string;
  port?: number;
};

// The persisted form omits accountId -- it is the row's own id, injected on read.
export type StoredPasskey = Omit<PasskeySecret, "accountId">;

/**
 * Reads the stored passkey. The column is encrypted at rest when a data key is configured
 * (see db/secretColumns), so decryption happens here, at the one place the raw column value
 * is turned into an object, rather than at every caller.
 */
export function parseStoredPasskey(
  raw: string | null | undefined,
): StoredPasskey | null {
  const plain = decryptSecret(raw ?? null);
  if (!plain) return null;
  try {
    const value = JSON.parse(plain);
    return value && typeof value === "object" ? (value as StoredPasskey) : null;
  } catch {
    return null;
  }
}

export function getAccountPasskey(accountId: number): PasskeySecret | null {
  const row = db
    .prepare("SELECT passkey FROM tg_accounts WHERE id = ?")
    .get(accountId) as { passkey: string | null } | undefined;
  const stored = parseStoredPasskey(row?.passkey);
  return stored ? { accountId, ...stored } : null;
}

export function savePasskeySecret(secret: PasskeySecret): void {
  const { accountId, ...stored } = secret;
  db.prepare("UPDATE tg_accounts SET passkey = ? WHERE id = ?").run(
    encryptSecret(JSON.stringify(stored)),
    accountId,
  );
}

export function getPasskeySecret(
  telegramPasskeyId: string,
): PasskeySecret | undefined {
  const rows = db
    .prepare("SELECT id, passkey FROM tg_accounts WHERE passkey IS NOT NULL")
    .all() as Array<{ id: number; passkey: string }>;
  for (const r of rows) {
    const stored = parseStoredPasskey(r.passkey);
    if (stored?.telegramPasskeyId === telegramPasskeyId)
      return { accountId: r.id, ...stored };
  }
  return undefined;
}

function clearPasskey(accountId: number): void {
  db.prepare("UPDATE tg_accounts SET passkey = NULL WHERE id = ?").run(accountId);
}

export function deletePasskeySecret(telegramPasskeyId: string): void {
  const secret = getPasskeySecret(telegramPasskeyId);
  if (secret) clearPasskey(secret.accountId);
}

// Drop the stored secret when its passkey no longer exists on Telegram.
export function pruneAccountPasskeySecrets(
  accountId: number,
  liveIds: string[],
): void {
  const secret = getAccountPasskey(accountId);
  if (secret && !liveIds.includes(secret.telegramPasskeyId)) clearPasskey(accountId);
}

// Telegram passkey ids we hold the private key for (0 or 1 for a given account).
export function storedPasskeyIdsForAccount(accountId: number): string[] {
  const secret = getAccountPasskey(accountId);
  return secret ? [secret.telegramPasskeyId] : [];
}

// Kept returning an array so existing callers (export, .find(dcId)) are unchanged.
export function accountPasskeySecrets(accountId: number): PasskeySecret[] {
  const secret = getAccountPasskey(accountId);
  return secret ? [secret] : [];
}

// Backfill/refresh the account's home DC on the stored secret.
export function setAccountPasskeyDc(
  accountId: number,
  dc: { dcId: number; serverAddress: string; port: number },
): void {
  const secret = getAccountPasskey(accountId);
  if (!secret) return;
  savePasskeySecret({ ...secret, ...dc });
}

// Resolves the passkey to store for an imported account, tolerating older export shapes:
// a single `passkey` object (current), or a `passkeys` array (interim builds).
export function importedPasskeyFor(item: any): StoredPasskey | null {
  const raw =
    item?.passkey && typeof item.passkey === "object"
      ? item.passkey
      : Array.isArray(item?.passkeys)
        ? item.passkeys.find((p: any) => p?.dcId != null) ?? item.passkeys[0]
        : null;
  if (!raw || typeof raw !== "object") return null;
  const { accountId: _omit, ...stored } = raw as Record<string, unknown>;
  return stored as unknown as StoredPasskey;
}
