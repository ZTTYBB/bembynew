import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

const ready = new WeakSet<Database.Database>();

/**
 * A watch_codes claim is intentionally small.  The code itself can be sensitive
 * (invite/registration codes), so only a one-way key is retained for
 * cross-account de-duplication.
 */
export function ensureWatchCodeClaimsSchema(database: Database.Database): void {
  if (ready.has(database)) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS watch_code_claims (
      code_key TEXT PRIMARY KEY,
      source_peer_id TEXT,
      source_message_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watch_code_claims_created
      ON watch_code_claims(created_at);
  `);
  if (!database.inTransaction) ready.add(database);
}

export type WatchCodeClaim = {
  /** Normalised code, not a raw message. It is hashed before storage. */
  code: string;
  sourcePeerId?: string | null;
  sourceMessageId?: number | null;
  createdAt?: string;
};

/**
 * Atomically claim a code for this Bemby installation. Returning false means
 * another account (or another process) already attempted the same code.
 * Claims are retained for 90 days, long enough to cover a normal group-watch
 * lifetime without allowing the table to grow forever.
 */
export function claimWatchCode(
  database: Database.Database,
  claim: WatchCodeClaim,
): boolean {
  ensureWatchCodeClaimsSchema(database);
  const code = claim.code.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  if (!code) return false;
  const createdAt = claim.createdAt ?? new Date().toISOString();
  // Hash the normalised value without persisting the code itself. This keeps
  // the deduplication table useful while avoiding raw invite-code storage.
  const key = createCodeKey(code);
  return database.transaction(() => {
    database.prepare(
      "DELETE FROM watch_code_claims WHERE datetime(created_at) < datetime('now', '-90 days')",
    ).run();
    const result = database.prepare(`
      INSERT OR IGNORE INTO watch_code_claims
        (code_key, source_peer_id, source_message_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      key,
      claim.sourcePeerId ?? null,
      claim.sourceMessageId ?? null,
      createdAt,
    );
    return result.changes === 1;
  })();
}

function createCodeKey(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Exposed for tests and diagnostics without exposing stored raw codes. */
export function watchCodeKey(value: string): string {
  return createCodeKey(value.trim().replace(/\s+/g, " ").toLocaleLowerCase());
}
