// embywatch pulls in undici, whose native webidl bindings do not load under the
// Node used to run these tests -- the same stubs the embywatch suite uses.
vi.mock("undici", () => ({
  fetch: vi.fn(),
  ProxyAgent: vi.fn(),
  Agent: vi.fn(),
}));
vi.mock("node:dns", () => ({ lookup: vi.fn() }));

vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));

import { describe, it, expect, vi } from "vitest";
import { positiveSeconds, resolvePlayDuration, resolvePlaybackBudget } from "../jobs/embywatch";

const FALLBACK = 300;

describe("positiveSeconds", () => {
  it("passes a usable number through", () => {
    expect(positiveSeconds(600, FALLBACK)).toBe(600);
    expect(positiveSeconds("450", FALLBACK)).toBe(450);
    expect(positiveSeconds(1, FALLBACK)).toBe(1);
  });

  it("falls back for an empty string, which otherwise becomes a zero-second budget", () => {
    // '' ?? x is '' (?? only catches null/undefined), and '' * 1.1 is 0 -- so the
    // old code silently played for zero seconds instead of using the default.
    expect(Number("") * 1.1).toBe(0);
    expect(positiveSeconds("", FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for absent or null values", () => {
    expect(positiveSeconds(undefined, FALLBACK)).toBe(FALLBACK);
    expect(positiveSeconds(null, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for a malformed string", () => {
    expect(positiveSeconds("abc", FALLBACK)).toBe(FALLBACK);
    expect(positiveSeconds("1e", FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for zero and negatives", () => {
    expect(positiveSeconds(0, FALLBACK)).toBe(FALLBACK);
    expect(positiveSeconds(-30, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for Infinity and NaN", () => {
    expect(positiveSeconds(Infinity, FALLBACK)).toBe(FALLBACK);
    expect(positiveSeconds(NaN, FALLBACK)).toBe(FALLBACK);
  });

  it("nests, so a bad system default also degrades to the built-in value", () => {
    // Mirrors runEmbywatch: job value first, then the system default, then 300.
    const resolve = (jobValue: unknown, settingValue: unknown) =>
      positiveSeconds(jobValue, positiveSeconds(settingValue, FALLBACK));

    expect(resolve(undefined, "600")).toBe(600);
    expect(resolve("", "600")).toBe(600);
    expect(resolve("", "")).toBe(FALLBACK);
    expect(resolve(undefined, undefined)).toBe(FALLBACK);
    expect(resolve(NaN, "abc")).toBe(FALLBACK);
  });
});

describe("resolved playback budget", () => {
  it("does not add jitter beyond an explicit range's upper bound", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999999);
    try {
      expect(resolvePlaybackBudget(500, 1800, FALLBACK)).toBe(1800);
    } finally {
      random.mockRestore();
    }
  });

  it("keeps the single-duration 0-10 percent jitter", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(resolvePlaybackBudget(1200, undefined, FALLBACK)).toBe(1200);
      random.mockReturnValue(0.999999);
      expect(resolvePlaybackBudget(1200, undefined, FALLBACK)).toBe(1319);
    } finally {
      random.mockRestore();
    }
  });

  it("does not add jitter when an explicit upper bound equals the minimum", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999999);
    try {
      expect(resolvePlaybackBudget(600, 600, FALLBACK)).toBe(600);
    } finally {
      random.mockRestore();
    }
  });
});

describe("resolvePlayDuration", () => {
  it("uses the fixed value when no upper bound is given", () => {
    expect(resolvePlayDuration(600, undefined, FALLBACK)).toBe(600);
    expect(resolvePlayDuration(600, null, FALLBACK)).toBe(600);
    expect(resolvePlayDuration(600, "", FALLBACK)).toBe(600);
  });

  it("falls back to the system default when the job minimum is unusable", () => {
    expect(resolvePlayDuration(undefined, undefined, FALLBACK)).toBe(FALLBACK);
    expect(resolvePlayDuration("", "", FALLBACK)).toBe(FALLBACK);
    expect(resolvePlayDuration("abc", undefined, FALLBACK)).toBe(FALLBACK);
  });

  it("accepts equal bounds but rejects a bound below the actual minimum", () => {
    expect(resolvePlayDuration(600, 600, FALLBACK)).toBe(600);
    expect(() => resolvePlayDuration(600, 300, FALLBACK)).toThrow("effective playDuration");
    expect(() => resolvePlayDuration(undefined, 60, FALLBACK)).toThrow("effective playDuration");
    expect(() => resolvePlayDuration(600, 0, FALLBACK)).toThrow("at least 30 seconds");
    expect(() => resolvePlayDuration(600, -60, FALLBACK)).toThrow("at least 30 seconds");
  });

  it("draws a value inside [min, max] when a range is set", () => {
    for (let i = 0; i < 200; i++) {
      const n = resolvePlayDuration(300, 900, FALLBACK);
      expect(n).toBeGreaterThanOrEqual(300);
      expect(n).toBeLessThanOrEqual(900);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it("actually varies across draws", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(resolvePlayDuration(300, 900, FALLBACK));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("can reach both ends of the range", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(resolvePlayDuration(300, 302, FALLBACK));
    expect(seen).toEqual(new Set([300, 301, 302]));
  });

  it("falls back for the floor before applying the range", () => {
    // Floor unusable -> the system default becomes the floor
    for (let i = 0; i < 50; i++) {
      const n = resolvePlayDuration("", 900, FALLBACK);
      expect(n).toBeGreaterThanOrEqual(FALLBACK);
      expect(n).toBeLessThanOrEqual(900);
    }
  });

  it.each(["abc", " ", true, {}, [], Infinity, NaN, 30.5, "1e3", Number.MAX_SAFE_INTEGER + 1])(
    "rejects a malformed bound %j instead of silently ignoring it",
    (maximum) => {
      expect(() => resolvePlayDuration(600, maximum, FALLBACK)).toThrow("at least 30 seconds");
    },
  );

  it("applies a valid upper bound to a minimum inherited from the system", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999999);
    try {
      expect(resolvePlaybackBudget(undefined, 600, 450)).toBe(600);
    } finally {
      random.mockRestore();
    }
  });
});
