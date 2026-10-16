import { DateTime } from "luxon";

export function toMinutes(hhmm: number): number {
  return Math.floor(hhmm / 100) * 60 + (hhmm % 100);
}

export type PickNextRunOptions = {
  /** Epoch millis of other jobs' scheduled runs to stay clear of. */
  occupied?: number[];
  /** Minimum spacing from occupied slots, in minutes. 0 disables staggering. */
  gapMinutes?: number;
  /**
   * When today's window has already closed, run shortly from now instead of
   * waiting for tomorrow. For a job that was due today but never got to run --
   * the process was down through its window, say -- waiting a whole day loses a
   * cycle for no reason. Ignored while the window is still open.
   */
  catchUp?: boolean;
};

/** How long after a catch-up decision the run is placed. */
const CATCH_UP_DELAY_MS = 30_000;

const MAX_RANDOM_ATTEMPTS = 20;

function atMinute(day: DateTime, minuteOfDay: number): DateTime {
  return day.set({
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    second: 0,
    millisecond: 0,
  });
}

/**
 * Picks a random minute in [startMin, endMin) on the given day, staying at
 * least gapMinutes away from every occupied slot. When the window is too
 * crowded to honour the gap, falls back to the minute furthest from its
 * nearest neighbour so behaviour degrades gracefully.
 */
function pickMinute(
  day: DateTime,
  startMin: number,
  endMin: number,
  opts: PickNextRunOptions,
): DateTime {
  const span = Math.max(1, endMin - startMin);
  const randomPick = () =>
    atMinute(day, startMin + Math.floor(Math.random() * span));

  const gapMs = (opts.gapMinutes ?? 0) * 60_000;
  const occupied = opts.occupied ?? [];
  if (gapMs <= 0 || occupied.length === 0) return randomPick();

  const clearance = (candidate: DateTime) => {
    const ms = candidate.toMillis();
    return Math.min(...occupied.map((slot) => Math.abs(slot - ms)));
  };

  for (let i = 0; i < MAX_RANDOM_ATTEMPTS; i++) {
    const candidate = randomPick();
    if (clearance(candidate) >= gapMs) return candidate;
  }

  let best = atMinute(day, startMin);
  let bestClearance = clearance(best);
  for (let m = startMin + 1; m < endMin; m++) {
    const candidate = atMinute(day, m);
    const c = clearance(candidate);
    if (c > bestClearance) {
      best = candidate;
      bestClearance = c;
    }
  }
  return best;
}

export function pickNextRun(
  windowStart: number,
  windowEnd: number,
  tz: string,
  daysAhead = 0,
  options: PickNextRunOptions = {},
): DateTime {
  const startMin = toMinutes(windowStart);
  const endMin = toMinutes(windowEnd);
  const now = DateTime.now().setZone(tz);
  const nowMin = now.hour * 60 + now.minute;

  if (daysAhead === 0) {
    if (nowMin < startMin) return pickMinute(now, startMin, endMin, options);
    if (nowMin + 1 < endMin)
      return pickMinute(now, nowMin + 1, endMin, options);
    // Past window or under a minute left -- make it up now when the caller says
    // this is an overdue job, otherwise schedule tomorrow
    if (options.catchUp) return now.plus({ milliseconds: CATCH_UP_DELAY_MS });
    daysAhead = 1;
  }

  return pickMinute(now.plus({ days: daysAhead }), startMin, endMin, options);
}
