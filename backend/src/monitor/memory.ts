/**
 * Memory watermark recording.
 *
 * A container hitting its cgroup limit is SIGKILLed, so the process gets no chance to
 * report its own death -- the log simply stops. The only way to know how much memory it
 * was holding, and which run was in flight, is to persist a sample *before* it dies and
 * read that back on the next boot.
 *
 * Tracks RSS and `external` rather than just the heap on purpose. The embywatch OOM that
 * prompted this was a whole media file in an ArrayBuffer, which lives in `external` and is
 * not bounded by --max-old-space-size, so a heap-only reading would have shown nothing
 * unusual right up to the kill.
 */
import { totalmem } from "node:os";
import { db } from "../db/database";
import { runningLogIds } from "../jobs/cancellation";

const WATERMARK_KEY = "memory_watermark";
const SHUTDOWN_KEY = "memory_clean_shutdown";

const SAMPLE_INTERVAL_MS = Number(process.env.MEMORY_SAMPLE_SECONDS ?? 30) * 1000;
// Warn once past this share of the memory ceiling, re-arming only after it recedes, so a
// sustained high-water mark doesn't reprint every sample.
const WARN_AT = Number(process.env.MEMORY_WARN_PERCENT ?? 75) / 100;
const REARM_AT = 0.6;

export type MemorySample = {
  at: string;
  rssMb: number;
  externalMb: number;
  heapUsedMb: number;
  /** Runs in flight when the sample was taken. */
  runs: Array<{ logId: number; jobName: string }>;
};

export type MemoryReport = {
  limitMb: number | null;
  current: MemorySample;
  peak: MemorySample | null;
  /** Previous process's last sample, present only when it did not shut down cleanly. */
  lastBeforeCrash: MemorySample | null;
};

const mb = (bytes: number): number => Math.round(bytes / 1048576);

/**
 * The ceiling to measure against: the cgroup limit where there is one, otherwise total
 * RAM. Node reports UINT64_MAX for "unconstrained", which is not a usable number.
 */
export function memoryLimitMb(): number | null {
  const constrained =
    typeof process.constrainedMemory === "function" ? process.constrainedMemory() : 0;
  if (constrained && constrained > 0 && constrained < Number.MAX_SAFE_INTEGER) {
    return mb(constrained);
  }
  const total = totalmem();
  return total > 0 ? mb(total) : null;
}

function describeRuns(): MemorySample["runs"] {
  const ids = runningLogIds();
  if (!ids.length) return [];
  try {
    const rows = db
      .prepare(
        `SELECT l.id AS logId, j.name AS jobName FROM job_logs l
         JOIN jobs j ON j.id = l.job_id
         WHERE l.id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as Array<{ logId: number; jobName: string }>;
    return rows;
  } catch {
    // Never let bookkeeping break the sampler
    return ids.map((logId) => ({ logId, jobName: "?" }));
  }
}

export function sampleMemory(): MemorySample {
  const m = process.memoryUsage();
  return {
    at: new Date().toISOString(),
    rssMb: mb(m.rss),
    externalMb: mb(m.external),
    heapUsedMb: mb(m.heapUsed),
    runs: describeRuns(),
  };
}

function readJson<T>(key: string): T | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ? (JSON.parse(row.value) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      key,
      JSON.stringify(value),
    );
  } catch {
    /* a failed write must not take the server down */
  }
}

let peak: MemorySample | null = null;
let warned = false;
let lastBeforeCrash: MemorySample | null = null;

/** Exposed for the status endpoint. */
export function memoryReport(): MemoryReport {
  return {
    limitMb: memoryLimitMb(),
    current: sampleMemory(),
    peak,
    lastBeforeCrash,
  };
}

/** One sampling tick: update the peak, persist it, and warn on a threshold crossing. */
export function recordMemory(): MemorySample {
  const current = sampleMemory();
  if (!peak || current.rssMb > peak.rssMb) peak = current;

  writeJson(WATERMARK_KEY, { current, peak });

  const limit = memoryLimitMb();
  if (limit) {
    const share = current.rssMb / limit;
    if (share >= WARN_AT && !warned) {
      warned = true;
      const where = current.runs.length
        ? ` while running ${current.runs.map((r) => `"${r.jobName}" (log ${r.logId})`).join(", ")}`
        : " with no job running";
      console.warn(
        `[memory] ${current.rssMb}MB of ~${limit}MB (${Math.round(share * 100)}%)` +
          `, external ${current.externalMb}MB${where}`,
      );
    } else if (share < REARM_AT) {
      warned = false;
    }
  }
  return current;
}

/**
 * Reports what the previous process was doing if it went away without a clean shutdown.
 * Call before reconcileOrphanedRuns so the two lines read together in the log.
 */
export function reportPreviousShutdown(): void {
  const clean = readJson<{ at: string }>(SHUTDOWN_KEY);
  const saved = readJson<{ current: MemorySample; peak: MemorySample }>(WATERMARK_KEY);
  // Consume the marker so the next abrupt exit is not read as clean
  writeJson(SHUTDOWN_KEY, null);

  if (clean || !saved?.current) return;
  lastBeforeCrash = saved.current;

  const c = saved.current;
  const where = c.runs?.length
    ? c.runs.map((r) => `"${r.jobName}" (log ${r.logId})`).join(", ")
    : "no job";
  const limit = memoryLimitMb();
  console.warn(
    `[memory] Previous process exited without shutting down cleanly. Last sample ${c.at}: ` +
      `rss ${c.rssMb}MB${limit ? ` of ~${limit}MB` : ""}, external ${c.externalMb}MB, ` +
      `heap ${c.heapUsedMb}MB, running ${where}. Peak seen ${saved.peak?.rssMb ?? c.rssMb}MB. ` +
      `An rss figure near the limit means the kernel OOM-killed it.`,
  );
}

export function markCleanShutdown(): void {
  writeJson(SHUTDOWN_KEY, { at: new Date().toISOString() });
}

export function startMemoryMonitor(): void {
  reportPreviousShutdown();
  recordMemory();
  // unref() so sampling never holds the process (or a test run) open
  setInterval(recordMemory, SAMPLE_INTERVAL_MS).unref();
}
