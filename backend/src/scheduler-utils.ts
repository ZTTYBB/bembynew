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
  /** Avoid scheduling within peak hours (20:00 - 23:00 local time). */
  avoidPeakHours?: boolean;
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

  // Peak hours check: 20:00 to 23:00 (hours 20, 21, 22)
  const isPeak = (dt: DateTime) => Boolean(opts.avoidPeakHours && dt.hour >= 20 && dt.hour < 23);
  const validOffsets: number[] = [];
  if (opts.avoidPeakHours) {
    for (let m = 0; m < span; m++) {
      if (!isPeak(startDt.plus({ minutes: m }))) {
        validOffsets.push(m);
      }
    }
  }

  const randomPick = () => {
    if (validOffsets.length > 0) {
      const offset = validOffsets[Math.floor(Math.random() * validOffsets.length)];
      return startDt.plus({ minutes: offset });
    }
    return startDt.plus({ minutes: Math.floor(Math.random() * span) });
  };

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

  const searchOffsets = validOffsets.length > 0 ? validOffsets : Array.from({ length: span }, (_, i) => i);
  let best = startDt.plus({ minutes: searchOffsets[0] ?? 0 });
  let bestClearance = clearance(best);
  for (let idx = 1; idx < searchOffsets.length; idx++) {
    const candidate = startDt.plus({ minutes: searchOffsets[idx] });
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

/** Bounds for a job's same-day retry interval, in hours. 0 turns the feature off. */
export const SAME_DAY_RETRY_MAX_HOURS = 23;

/** A retry never lands closer than this to the failure that triggered it. */
const SAME_DAY_RETRY_MIN_GAP_MINUTES = 10;

/** Random slack added to the interval so retries do not fall on a fixed beat. */
const SAME_DAY_RETRY_JITTER_MINUTES = 10;

/** First hour of the day's closing slot. A failure at or after it is not retried. */
const LAST_HOUR = 23;

/**
 * When to run a job again after it failed, or null to leave it to the normal
 * schedule.
 *
 * The retry is for the rest of today only. It lands `hours` after `now` (plus a
 * few minutes of jitter). When that would fall on the next day, or inside the
 * peak hours a job asked to avoid, the job instead runs once at a random minute
 * of the day's last hour. A failure that happens in that last hour is not
 * retried, so nothing carries into tomorrow.
 *
 * The job's own time window is deliberately ignored: the point is to try again
 * soon, not to wait for the window.
 */
export function pickSameDayRetry(
  now: DateTime,
  hours: number,
  options: { avoidPeakHours?: boolean } = {},
): DateTime | null {
  if (!Number.isInteger(hours) || hours < 1 || hours > SAME_DAY_RETRY_MAX_HOURS) return null;
  if (now.hour >= LAST_HOUR) return null;

  const jitter = Math.floor(Math.random() * (SAME_DAY_RETRY_JITTER_MINUTES + 1));
  const candidate = now.plus({ hours, minutes: jitter });
  const peak = Boolean(options.avoidPeakHours) && candidate.hour >= 20 && candidate.hour < 23;
  if (candidate.hasSame(now, "day") && !peak) return candidate;

  const endOfDay = now.startOf("day").plus({ days: 1 });
  const earliest = DateTime.max(
    now.startOf("day").set({ hour: LAST_HOUR }),
    now.plus({ minutes: SAME_DAY_RETRY_MIN_GAP_MINUTES }),
  );
  const span = Math.floor(endOfDay.diff(earliest, "minutes").minutes);
  if (span < 1) return null;
  return earliest.plus({ minutes: Math.floor(Math.random() * span) });
}
