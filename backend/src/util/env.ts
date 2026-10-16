/**
 * Environment-variable parsing that cannot produce a value worse than the
 * default.
 *
 * These feed `setTimeout` delays and cache caps, where the obvious failure mode
 * is silent and severe: `setTimeout(fn, NaN)` fires *immediately*, so a typo in
 * a timeout variable would make every connect fail instantly and every job
 * report a watchdog timeout, instead of being ignored. Likewise a NaN cap makes
 * `size <= cap` false forever, so a bounded cache degrades to "evict everything".
 *
 * Anything missing, empty, unparseable or non-positive therefore falls back.
 */
export function positiveEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
