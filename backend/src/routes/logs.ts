import { Router } from 'express';
import { db } from '../db/database';
import { cancelJob, isJobRunning, getLiveDetail } from '../jobs/cancellation';
import { issueMediaTicket } from '../auth/mediaTickets';
import { mediaAuth } from '../middleware/auth';
import {
  clearLogShotReferences,
  logShotStats,
  logShotStatsForLogs,
  removeLogShots,
  resolveLogShot,
} from '../jobs/logShots';
import fs from 'node:fs';
import path from 'node:path';
import { parsePaging, textParam, escapeLike } from './list-query';

const router = Router();
export const logShotsRouter = Router();

function parseDetail(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // A partially-written row (or an older third-party backup) must not make
    // the entire log details endpoint fail with a 500. Do not echo the
    // potentially huge or sensitive broken payload back to the browser.
    return { parseError: true };
  }
}

function decorateShotReferences(value: unknown, logId: number, ticket: string): unknown {
  if (typeof value === "string") {
    const prefix = `/api/logs/${logId}/shots/`;
    if (!value.startsWith(prefix) || value.includes("?")) return value;
    return `${value}?ticket=${encodeURIComponent(ticket)}`;
  }
  if (Array.isArray(value)) return value.map((item) => decorateShotReferences(item, logId, ticket));
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      copy[key] = decorateShotReferences(child, logId, ticket);
    }
    return copy;
  }
  return value;
}

/**
 * Browser-loaded screenshots cannot set Authorization headers. A short-lived
 * media ticket is accepted here, exactly like Telegram inline media.
 */
logShotsRouter.get(
  '/:id/shots/:file',
  mediaAuth('log', (req) => ({ logId: Number(req.params.id) })),
  (req, res) => {
    const logId = Number(req.params.id);
    const fileName = req.params.file;
    const row = db.prepare('SELECT 1 FROM job_logs WHERE id = ?').get(logId);
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    const shotPath = resolveLogShot(logId, fileName);
    if (!shotPath) { res.status(404).json({ error: 'Not found' }); return; }
    try {
      const stat = fs.lstatSync(shotPath);
      if (stat.isSymbolicLink()) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (!stat.isFile() || stat.size > 2_000_000) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const ext = path.extname(fileName).toLowerCase();
      const contentType = ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp'
          : ext === '.gif' ? 'image/gif'
            : 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.sendFile(shotPath);
    } catch {
      res.status(404).json({ error: 'Not found' });
    }
  },
);

/** Parses a positive integer query param, clamped to [1, max]. */
function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`
    SELECT l.id, l.job_id, l.ran_at, l.status, l.message, l.detail,
           j.name AS job_name, j.job_type,
           a.name AS account_name
    FROM job_logs l
    LEFT JOIN jobs j ON l.job_id = j.id
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    WHERE l.id = ?
  `).get(id) as any;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  const liveDetail = getLiveDetail(id);
  const mediaTicket = issueMediaTicket('log', { logId: id }).ticket;
  const detail = liveDetail ?? parseDetail(row.detail);
  const shotStats = logShotStats(id);
  res.json({
    id: row.id,
    jobId: row.job_id,
    jobName: row.job_name,
    jobType: row.job_type ?? null,
    accountName: row.account_name,
    ranAt: row.ran_at,
    status: row.status,
    message: row.message,
    detail: decorateShotReferences(detail, id, mediaTicket),
    shotBytes: shotStats.bytes,
    shotCount: shotStats.files,
  });
});

router.get('/', (req, res) => {
  const { jobId, limit, offset, showRetired = '0' } = req.query as Record<string, string>;
  const query = req.query as Record<string, unknown>;
  const paging = parsePaging(query);
  const search = textParam(query.search);
  const status = textParam(query.status);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (jobId) {
    const parsedJobId = Number(jobId);
    if (!Number.isInteger(parsedJobId) || parsedJobId <= 0) {
      res.status(400).json({ error: 'Invalid jobId' });
      return;
    }
    conditions.push('l.job_id = ?');
    params.push(parsedJobId);
  }
  if (showRetired !== '1') { conditions.push('l.retired = 0'); }
  if (status) {
    conditions.push('l.status = ?');
    params.push(status);
  }
  if (search) {
    conditions.push(`(
      COALESCE(j.name, '') LIKE ? ESCAPE '\\'
      OR COALESCE(a.name, '') LIKE ? ESCAPE '\\'
      OR COALESCE(l.message, '') LIKE ? ESCAPE '\\'
    )`);
    const like = `%${escapeLike(search)}%`;
    params.push(like, like, like);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const baseSql = `
    FROM job_logs l
    LEFT JOIN jobs j ON l.job_id = j.id
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    ${where}
  `;
  const selectSql = `
    SELECT l.id, l.job_id, l.ran_at, l.status, l.message, l.retired,
           j.name AS job_name, j.job_type,
           a.name AS account_name
    ${baseSql}
    ORDER BY l.ran_at DESC
    LIMIT ? OFFSET ?
  `;
  const toJson = (r: any, stats?: Map<number, { files: number; bytes: number }>) => {
    const shotStats = stats?.get(Number(r.id)) ?? logShotStats(Number(r.id));
    return {
      id: r.id,
      jobId: r.job_id,
      jobName: r.job_name,
      jobType: r.job_type ?? null,
      accountName: r.account_name,
      ranAt: r.ran_at,
      status: r.status,
      message: r.message,
      retired: r.retired === 1,
      shotBytes: shotStats.bytes,
      shotCount: shotStats.files,
    };
  };

  if (!paging) {
    // Legacy limit/offset shape
    const parsedLimit = parsePositiveInt(limit, 50, 200);
    const parsedOffset = parseNonNegativeInt(offset, 0);
    const rows = db.prepare(selectSql).all(...params, parsedLimit, parsedOffset) as any[];
    const stats = logShotStatsForLogs(new Set(rows.map((row) => Number(row.id))));
    res.json(rows.map((row) => toJson(row, stats)));
    return;
  }

  const totalRow = db.prepare(`SELECT COUNT(*) AS total ${baseSql}`).get(...params) as { total: number };
  const rows = db.prepare(selectSql).all(...params, paging.limit, paging.offset) as any[];

  const storage = db.prepare(`SELECT l.id ${baseSql}`).all(...params) as Array<{ id: number }>;
  const stats = logShotStatsForLogs(new Set(storage.map((row) => Number(row.id))));
  const storageTotals = [...stats.values()].reduce(
    (totals, row) => {
      totals.bytes += row.bytes;
      totals.files += row.files;
      return totals;
    },
    { bytes: 0, files: 0 },
  );

  res.json({
    items: rows.map((row) => toJson(row, stats)),
    total: totalRow.total,
    page: paging.page,
    pageSize: paging.pageSize,
    screenshotBytesTotal: storageTotals.bytes,
    screenshotFilesTotal: storageTotals.files,
  });
});

/**
 * Explicitly remove a run's screenshots while preserving its textual log.
 * The detail row is updated atomically with a compare-and-swap so a live run
 * cannot have a newer detail overwritten by a cleanup request.
 */
router.delete('/:id/shots', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid log id' });
    return;
  }
  const row = db.prepare('SELECT detail, status FROM job_logs WHERE id = ?').get(id) as
    | { detail: string | null; status: string }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (row.status === 'running') {
    res.status(409).json({ error: 'Cannot clear screenshots while the job is running' });
    return;
  }

  const stats = logShotStats(id);
  let removedReferences = 0;
  let nextDetail = row.detail;
  if (typeof row.detail === 'string' && row.detail) {
    try {
      const parsed = JSON.parse(row.detail);
      const cleaned = clearLogShotReferences(parsed, id);
      if (cleaned.removed > 0) {
        nextDetail = JSON.stringify(cleaned.detail);
        removedReferences = cleaned.removed;
      }
    } catch {
      // Keep malformed historical details intact; the files can still be
      // removed without turning cleanup into a destructive log rewrite.
    }
  }
  // Even a no-op cleanup needs a compare-and-swap. If a live writer changed
  // detail after the initial read, deleting the directory could remove its
  // newly persisted screenshots. `IS` also matches a NULL detail.
  const updated = db.prepare(
    'UPDATE job_logs SET detail = ? WHERE id = ? AND detail IS ?',
  ).run(nextDetail, id, row.detail) as { changes?: number };
  if (updated.changes !== 1) {
    res.status(409).json({ error: 'Log changed while clearing screenshots; retry' });
    return;
  }
  removeLogShots(id);
  res.json({
    removedFiles: stats.files,
    removedBytes: stats.bytes,
    removedReferences,
  });
});

router.patch('/:id/retire', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT retired FROM job_logs WHERE id = ?').get(id) as { retired: number } | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  const newVal = row.retired ? 0 : 1;
  db.prepare('UPDATE job_logs SET retired = ? WHERE id = ?').run(newVal, id);
  res.json({ retired: newVal === 1 });
});

router.post('/:id/cancel', (req, res) => {
  const logId = Number(req.params.id);
  if (isJobRunning(logId)) {
    cancelJob(logId);
    res.json({ message: 'Cancel signal sent' });
    return;
  }
  // No live process: the row is likely orphaned after a restart. Force-mark a
  // stuck 'running' row as failed so it can be cleared from the UI. (issue #18)
  const row = db.prepare('SELECT status FROM job_logs WHERE id = ?').get(logId) as
    | { status: string }
    | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  if (row.status !== 'running') {
    res.status(404).json({ error: 'No running job found for this log entry' });
    return;
  }
  db.prepare("UPDATE job_logs SET status = 'failed', message = 'Force stopped' WHERE id = ?").run(logId);
  res.json({ message: 'Force stopped' });
});

export default router;
