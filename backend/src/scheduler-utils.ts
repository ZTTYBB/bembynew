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
  return day.startOf("day").plus({ minutes: minuteOfDay });
}

/**
 * Picks a random minute in [startDt, endDt), staying at least gapMinutes away
 * from every occupied slot. Handles multi-hour and overnight spans across day boundaries.
 */
function pickTimeRange(
  startDt: DateTime,
  endDt: DateTime,
  opts: PickNextRunOptions,
): DateTime {
  const span = Math.max(1, Math.floor(endDt.diff(startDt, "minutes").minutes));
  const randomPick = () =>
    startDt.plus({ minutes: Math.floor(Math.random() * span) });

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

  let best = startDt;
  let bestClearance = clearance(best);
  for (let m = 1; m < span; m++) {
    const candidate = startDt.plus({ minutes: m });
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
  const isOvernight = startMin > endMin;

  if (daysAhead === 0) {
    if (!isOvernight) {
      const nowMin = now.hour * 60 + now.minute;
      if (nowMin < startMin) {
        return pickTimeRange(atMinute(now, startMin), atMinute(now, endMin), options);
      }
      if (nowMin + 1 < endMin) {
        return pickTimeRange(atMinute(now, nowMin + 1), atMinute(now, endMin), options);
      }
      // Past window or under a minute left -- make it up now when the caller says
      // this is an overdue job, otherwise schedule tomorrow
      if (options.catchUp) return now.plus({ milliseconds: CATCH_UP_DELAY_MS });
      daysAhead = 1;
    } else {
      // Overnight window (e.g. 23:00 to 02:00)
      const earlyMorningEnd = atMinute(now, endMin);
      const tonightStart = atMinute(now, startMin);
      const tomorrowEnd = atMinute(now.plus({ days: 1 }), endMin);

      if (now < earlyMorningEnd) {
        // In early morning tail of the overnight window (e.g. 01:15 AM)
        const earliest = now.startOf("minute").plus({ minutes: 1 });
        if (earliest < earlyMorningEnd) {
          return pickTimeRange(earliest, earlyMorningEnd, options);
        }
        if (options.catchUp) return now.plus({ milliseconds: CATCH_UP_DELAY_MS });
        // The morning tail closed; the next window opens tonight at startMin
        return pickTimeRange(tonightStart, tomorrowEnd, options);
      }

      if (now < tonightStart) {
        // Daytime: after morning window closed, before tonight's window opens (e.g. 10:00 AM)
        return pickTimeRange(tonightStart, tomorrowEnd, options);
      }

      // Late night: currently inside tonight's window (e.g. 23:30 PM)
      const earliest = now.startOf("minute").plus({ minutes: 1 });
      if (earliest < tomorrowEnd) {
        return pickTimeRange(earliest, tomorrowEnd, options);
      }
      if (options.catchUp) return now.plus({ milliseconds: CATCH_UP_DELAY_MS });
      daysAhead = 1;
    }
  }

  // Future day (daysAhead > 0)
  const targetDay = now.plus({ days: daysAhead });
  const startDt = atMinute(targetDay, startMin);
  const endDt = isOvernight
    ? atMinute(targetDay.plus({ days: 1 }), endMin)
    : atMinute(targetDay, endMin);
  return pickTimeRange(startDt, endDt, options);
}
