import type Database from "better-sqlite3";

const ready = new WeakSet<Database.Database>();

/**
 * Cross-account de-duplication for watch_buttons private drops.
 *
 * The table deliberately stores only a short fingerprint and routing metadata:
 * private message text may contain credentials and is never persisted here.
 */
export function ensureWatchButtonForwardSchema(database: Database.Database): void {
  if (ready.has(database)) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS watch_button_forwards (
      fingerprint TEXT PRIMARY KEY,
      code TEXT,
      source_peer_id TEXT NOT NULL,
      source_message_id INTEGER,
      target TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watch_button_forwards_created
      ON watch_button_forwards(created_at);
  `);
  if (!database.inTransaction) ready.add(database);
}

export type WatchButtonForwardClaim = {
  fingerprint: string;
  code?: string | null;
  sourcePeerId: string;
  sourceMessageId?: number | null;
  target: string;
  createdAt?: string;
};

/**
 * Atomically claim a forward. A false result means another account/process has
 * already forwarded the same drop. Old rows are pruned opportunistically so an
 * installation cannot accumulate an unbounded de-duplication table.
 */
export function claimWatchButtonForward(
  database: Database.Database,
  claim: WatchButtonForwardClaim,
): boolean {
  ensureWatchButtonForwardSchema(database);
  const createdAt = claim.createdAt ?? new Date().toISOString();
  return database.transaction(() => {
    database.prepare(
      "DELETE FROM watch_button_forwards WHERE created_at < datetime('now', '-90 days')",
    ).run();
    const result = database.prepare(`
      INSERT OR IGNORE INTO watch_button_forwards
        (fingerprint, code, source_peer_id, source_message_id, target, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      claim.fingerprint,
      claim.code ?? null,
      claim.sourcePeerId,
      claim.sourceMessageId ?? null,
      claim.target,
      createdAt,
    );
    return result.changes === 1;
  })();
}
