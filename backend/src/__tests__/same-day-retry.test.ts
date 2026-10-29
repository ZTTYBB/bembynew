import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { pickSameDayRetry } from "../scheduler-utils";
import { normalizeJobOptions } from "../jobs/jobOptions";

const TZ = "Asia/Shanghai";
const at = (time: string) => DateTime.fromISO(`2026-10-29T${time}`, { zone: TZ });

/** Sample many draws so a bound that holds only by luck still fails. */
function draws(now: DateTime, hours: number, options = {}) {
  return Array.from({ length: 200 }, () => pickSameDayRetry(now, hours, options));
}

describe("pickSameDayRetry", () => {
  it("lands the configured number of hours later, with a few minutes of jitter", () => {
    const now = at("08:00:00");
    for (const retry of draws(now, 6)) {
      expect(retry).not.toBeNull();
      const minutes = retry!.diff(now, "minutes").minutes;
      expect(minutes).toBeGreaterThanOrEqual(6 * 60);
      expect(minutes).toBeLessThanOrEqual(6 * 60 + 10);
      expect(retry!.hasSame(now, "day")).toBe(true);
    }
  });

  it("falls back to the last hour of the day when the interval would cross midnight", () => {
    const now = at("20:00:00"); // +6h = 02:00 tomorrow
    for (const retry of draws(now, 6)) {
      expect(retry).not.toBeNull();
      expect(retry!.hasSame(now, "day")).toBe(true);
      expect(retry!.hour).toBe(23);
    }
  });

  it("spreads the last-hour fallback across the hour instead of one minute", () => {
    const minutes = new Set(draws(at("20:00:00"), 6).map((r) => r!.minute));
    expect(minutes.size).toBeGreaterThan(20);
  });

  it("does not retry a failure that happens in the last hour", () => {
    expect(pickSameDayRetry(at("23:00:00"), 6)).toBeNull();
    expect(pickSameDayRetry(at("23:30:00"), 1)).toBeNull();
    expect(pickSameDayRetry(at("23:59:59"), 1)).toBeNull();
  });

  it("still retries one minute before the last hour begins", () => {
    const retry = pickSameDayRetry(at("22:59:00"), 6);
    expect(retry).not.toBeNull();
    expect(retry!.hasSame(at("22:59:00"), "day")).toBe(true);
    expect(retry!.hour).toBe(23);
  });

  it("never schedules the fallback sooner than ten minutes after the failure", () => {
    const now = at("22:55:00");
    for (const retry of draws(now, 6)) {
      expect(retry!.diff(now, "minutes").minutes).toBeGreaterThanOrEqual(10);
      expect(retry!.hasSame(now, "day")).toBe(true);
    }
  });

  it("never returns a time on the next day", () => {
    for (const time of ["00:00:00", "06:30:00", "12:00:00", "18:45:00", "22:59:59"]) {
      for (const hours of [1, 3, 6, 12, 23]) {
        for (const retry of draws(at(time), hours)) {
          expect(retry).not.toBeNull();
          expect(retry!.hasSame(at(time), "day")).toBe(true);
        }
      }
    }
  });

  it("moves a retry out of the 20:00-23:00 peak when the job avoids peak hours", () => {
    const now = at("14:00:00"); // +6h = 20:00-20:10, in the peak
    for (const retry of draws(now, 6, { avoidPeakHours: true })) {
      expect(retry!.hour).toBe(23);
    }
  });

  it("leaves a peak-hour retry alone when the job does not avoid peak hours", () => {
    const now = at("14:00:00");
    for (const retry of draws(now, 6)) {
      expect(retry!.hour).toBe(20);
    }
  });

  it("is off for 0 and for values that are not whole hours in range", () => {
    const now = at("08:00:00");
    expect(pickSameDayRetry(now, 0)).toBeNull();
    expect(pickSameDayRetry(now, -1)).toBeNull();
    expect(pickSameDayRetry(now, 24)).toBeNull();
    expect(pickSameDayRetry(now, 1.5)).toBeNull();
    expect(pickSameDayRetry(now, Number.NaN)).toBeNull();
  });

  it("uses the clock of the zone it is given, not UTC", () => {
    // 15:30 UTC is 23:30 in Shanghai: the last hour there, so no retry.
    const utc = DateTime.fromISO("2026-10-29T15:30:00Z", { zone: "utc" });
    expect(pickSameDayRetry(utc.setZone(TZ), 6)).toBeNull();
    // The same instant read in UTC is mid-afternoon, which does retry.
    expect(pickSameDayRetry(utc, 6)).not.toBeNull();
  });
});

describe("normalizeJobOptions retrySameDayHours", () => {
  it("defaults to off", () => {
    expect(normalizeJobOptions({}).retrySameDayHours).toBe(0);
  });

  it("accepts whole hours from 0 to 23", () => {
    expect(normalizeJobOptions({ retrySameDayHours: 6 }).retrySameDayHours).toBe(6);
    expect(normalizeJobOptions({ retrySameDayHours: 23 }).retrySameDayHours).toBe(23);
    expect(normalizeJobOptions({ retrySameDayHours: 0 }).retrySameDayHours).toBe(0);
  });

  it("rejects values outside the range or not whole numbers", () => {
    for (const bad of [-1, 24, 1.5, "6", null, Number.NaN]) {
      expect(() => normalizeJobOptions({ retrySameDayHours: bad })).toThrow(/retrySameDayHours/);
    }
  });

  it("falls back to the stored value when the request omits it", () => {
    expect(normalizeJobOptions({}, { retrySameDayHours: 4 }).retrySameDayHours).toBe(4);
  });

  it("lets the request override the stored value, including back to off", () => {
    expect(normalizeJobOptions({ retrySameDayHours: 0 }, { retrySameDayHours: 4 }).retrySameDayHours).toBe(0);
  });
});
