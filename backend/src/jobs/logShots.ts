import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths";
import { compactLogDetail, type LogScreenshotBudget } from "./logDetail";

const SHOT_ROOT = "run-shots";
const LOG_ID_PATTERN = /^[1-9]\d*$/;
const FILE_PATTERN = /^shot-\d{6}\.(?:jpg|png|webp|gif)$/i;

type DataImage = {
  mime: string;
  bytes: Buffer;
  extension: "jpg" | "png" | "webp" | "gif";
};

export type LogShotStats = {
  files: number;
  bytes: number;
};

function validLogId(logId: number): boolean {
  return Number.isSafeInteger(logId) && logId > 0;
}

function rootPath(): string {
  return path.join(dataDir(), SHOT_ROOT);
}

function logDirectory(logId: number): string | undefined {
  if (!validLogId(logId)) return undefined;
  return path.join(rootPath(), String(logId));
}

function extensionForMime(mime: string): DataImage["extension"] {
  switch (mime.toLowerCase()) {
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "jpg";
  }
}

function decodeImage(value: string): DataImage | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+)(;base64)?,([\s\S]*)$/i.exec(value);
  if (!match) return undefined;
  const mime = match[1].toLowerCase();
  if (!["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"].includes(mime)) {
    return undefined;
  }
  const payload = match[3];
  try {
    const bytes = match[2]
      ? Buffer.from(payload.replace(/\s/g, ""), "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    if (!bytes.length) return undefined;
    return { mime, bytes, extension: extensionForMime(mime) };
  } catch {
    return undefined;
  }
}

function statsForDirectory(directory: string): LogShotStats {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return { files: 0, bytes: 0 };
  }
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !FILE_PATTERN.test(entry.name)) continue;
    try {
      const stat = fs.lstatSync(path.join(directory, entry.name));
      if (stat.isSymbolicLink() || !stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) continue;
      files++;
      bytes += stat.size;
    } catch {}
  }
  return { files, bytes };
}

function publicReference(logId: number, fileName: string): string {
  return `/api/logs/${logId}/shots/${fileName}`;
}

/**
 * Returns the size of one run's retained screenshots. Only the same
 * allow-listed file names accepted by resolveLogShot are counted; unrelated
 * files in the directory must never inflate the value shown in the panel.
 */
export function logShotStats(logId: number): LogShotStats {
  const directory = logDirectory(logId);
  if (!directory) return { files: 0, bytes: 0 };
  return statsForDirectory(directory);
}

/**
 * Reads the screenshot directories for a set of logs with one root scan. List
 * endpoints can then reuse the same result for both row values and the filtered
 * total instead of doing one directory read per matching database row.
 */
export function logShotStatsForLogs(logIds: ReadonlySet<number>): Map<number, LogShotStats> {
  const result = new Map<number, LogShotStats>();
  if (!logIds.size) return result;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootPath(), { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !LOG_ID_PATTERN.test(entry.name)) continue;
    const logId = Number(entry.name);
    if (!logIds.has(logId)) continue;
    result.set(logId, statsForDirectory(path.join(rootPath(), entry.name)));
  }
  return result;
}

/**
 * Removes references to externally stored screenshots from a detail value.
 * This is used by the explicit "clear screenshots" action so the UI does not
 * retain links to files that have just been deleted. It deliberately leaves
 * all non-screenshot fields untouched and does not treat arbitrary URLs as
 * media references.
 */
export function clearLogShotReferences<T>(detail: T, logId: number): { detail: T; removed: number } {
  if (!validLogId(logId)) return { detail, removed: 0 };
  const prefix = `/api/logs/${logId}/shots/`;
  let removed = 0;
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value === prefix || (value.startsWith(prefix) && !value.slice(prefix.length).includes("/"))) {
        removed++;
        return undefined;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => rewrite(item))
        .filter((item) => item !== undefined);
    }
    if (value && typeof value === "object") {
      const copy: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        const next = rewrite(child);
        if (next !== undefined) copy[key] = next;
      }
      return copy;
    }
    return value;
  };
  return { detail: rewrite(detail) as T, removed };
}

/**
 * Stores the retained data:image values outside SQLite and replaces them with
 * authenticated API references. If the filesystem is unavailable, the
 * compacted data URI is kept so logging never changes the job result.
 */
export function persistLogDetailScreenshots<T>(
  detail: T,
  logId: number,
  budget: LogScreenshotBudget = {},
): T {
  const compacted = compactLogDetail(detail, budget);
  const directory = logDirectory(logId);
  if (!directory) return compacted;

  const written = new Map<string, string>();
  let nextFile = 0;
  const ensureDirectory = (): boolean => {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      return true;
    } catch {
      return false;
    }
  };

  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!/^data:image\//i.test(value)) return value;
      const existing = written.get(value);
      if (existing) return existing;
      const image = decodeImage(value);
      if (!image || !ensureDirectory()) return value;
      const name = `shot-${String(nextFile++).padStart(6, "0")}.${image.extension}`;
      try {
        fs.writeFileSync(path.join(directory, name), image.bytes, { mode: 0o600 });
        const reference = publicReference(logId, name);
        written.set(value, reference);
        return reference;
      } catch {
        // A read-only volume should not turn an otherwise successful run into
        // a failed run. Leave this URI inline as a safe fallback.
        return value;
      }
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      const copy: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) copy[key] = rewrite(child);
      return copy;
    }
    return value;
  };

  const result = rewrite(compacted) as T;
  if (!written.size) {
    // Avoid leaving an empty directory behind when all images were invalid or
    // the configured budget removed them.
    try {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    } catch {}
  }
  return result;
}

/** Resolves a shot path only after validating both path components. */
export function resolveLogShot(logId: number, fileName: string): string | undefined {
  if (!validLogId(logId) || !LOG_ID_PATTERN.test(String(logId)) || !FILE_PATTERN.test(fileName)) {
    return undefined;
  }
  const directory = logDirectory(logId);
  if (!directory) return undefined;
  const resolvedRoot = path.resolve(rootPath());
  const resolved = path.resolve(directory, fileName);
  if (resolved !== path.join(resolvedRoot, String(logId), fileName)) return undefined;
  return resolved;
}

/** Removes one run's screenshot directory; missing paths are already clean. */
export function removeLogShots(logId: number): void {
  const directory = logDirectory(logId);
  if (!directory) return;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {}
}

/**
 * Deletes screenshot directories which no longer have a corresponding log row.
 * This is intentionally driven by a caller-provided ID set so the file module
 * does not depend on the SQLite singleton.
 */
export function sweepOrphanedLogShots(existingLogIds: ReadonlySet<number>): number {
  const root = rootPath();
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !LOG_ID_PATTERN.test(entry.name)) continue;
    const id = Number(entry.name);
    if (existingLogIds.has(id)) continue;
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return removed;
}

type LogDetailDatabase = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes?: number };
  };
};

/**
 * Moves old inline screenshots in small batches. The compare-and-update keeps
 * a live run from being overwritten if another writer changed its detail while
 * this best-effort migration was working.
 */
export function migrateInlineLogShots(database: LogDetailDatabase, batchSize = 25): number {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) return 0;
  let rows: Array<{ id: number; detail: string | null }>;
  try {
    rows = database.prepare(`
      SELECT id, detail
      FROM job_logs
      WHERE detail IS NOT NULL AND detail LIKE '%data:image/%'
      ORDER BY id
      LIMIT ?
    `).all(batchSize) as Array<{ id: number; detail: string | null }>;
  } catch {
    return 0;
  }
  let migrated = 0;
  for (const row of rows) {
    if (!validLogId(Number(row.id)) || typeof row.detail !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.detail);
    } catch {
      continue;
    }
    const stored = persistLogDetailScreenshots(parsed, Number(row.id));
    const serialized = JSON.stringify(stored);
    if (serialized === row.detail) continue;
    try {
      const result = database.prepare(
        "UPDATE job_logs SET detail = ? WHERE id = ? AND detail = ?",
      ).run(serialized, row.id, row.detail);
      if ((result.changes ?? 1) > 0) migrated++;
    } catch {
      // A read-only/old schema is not a reason to interrupt the scheduler.
    }
  }
  return migrated;
}

/**
 * Starts a low-priority migration loop for historical logs. The first pass is
 * delayed so startup remains responsive; subsequent passes continue while a
 * batch is found and then settle to a five-minute sweep for newly restored
 * backups.
 */
export function startLogShotMigration(database: LogDetailDatabase): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = () => {
    if (stopped) return;
    const migrated = migrateInlineLogShots(database);
    timer = setTimeout(run, migrated > 0 ? 1_000 : 5 * 60_000);
    timer.unref?.();
  };
  timer = setTimeout(run, 5_000);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

