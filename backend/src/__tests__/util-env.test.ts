import { describe, it, expect, afterEach } from "vitest";
import { positiveEnvNumber } from "../util/env";

const KEY = "BEMBY_TEST_ENV_NUMBER";

afterEach(() => {
  delete process.env[KEY];
});

describe("positiveEnvNumber", () => {
  it("uses the fallback when the variable is unset", () => {
    expect(positiveEnvNumber(KEY, 42)).toBe(42);
  });

  it("uses the fallback for an empty string", () => {
    process.env[KEY] = "";
    expect(positiveEnvNumber(KEY, 42)).toBe(42);
  });

  it("reads a valid value", () => {
    process.env[KEY] = "1500";
    expect(positiveEnvNumber(KEY, 42)).toBe(1500);
    process.env[KEY] = "0.5";
    expect(positiveEnvNumber(KEY, 42)).toBe(0.5);
  });

  it("falls back for an unparseable value instead of yielding NaN", () => {
    // The whole point: NaN would reach setTimeout and fire immediately, or make
    // a `size <= cap` bound permanently false.
    for (const bad of ["abc", "1e", "--5", "10ms", "  ", "NaN"]) {
      process.env[KEY] = bad;
      expect(positiveEnvNumber(KEY, 42)).toBe(42);
    }
  });

  it("falls back for zero and negative values", () => {
    process.env[KEY] = "0";
    expect(positiveEnvNumber(KEY, 42)).toBe(42);
    process.env[KEY] = "-1";
    expect(positiveEnvNumber(KEY, 42)).toBe(42);
  });

  it("falls back for Infinity", () => {
    process.env[KEY] = "Infinity";
    expect(positiveEnvNumber(KEY, 42)).toBe(42);
  });

  it("never returns a value that would break setTimeout", () => {
    for (const raw of ["abc", "", "0", "-1", "Infinity", "NaN", "1e999"]) {
      process.env[KEY] = raw;
      const n = positiveEnvNumber(KEY, 1000);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });
});
