import { describe, expect, it } from "vitest";
import { assertSafeRegexSource } from "../util/regexSafety";

describe("operator regular-expression safety guard", () => {
  it("rejects common nested-quantifier backtracking", () => {
    expect(() => assertSafeRegexSource("(a+)+$")).toThrow(/nested quantifiers/i);
    expect(() => assertSafeRegexSource("(?:.*)+")).toThrow(/nested quantifiers/i);
  });

  it("allows ordinary captures, character classes, and escaped syntax", () => {
    expect(() => assertSafeRegexSource("CODE-(?<value>[A-Z0-9_-]{4,32})")).not.toThrow();
    expect(() => assertSafeRegexSource(String.raw`\(\w+\)\?`)).not.toThrow();
  });

  it("rejects incomplete expressions and oversized sources", () => {
    expect(() => assertSafeRegexSource("[abc")).toThrow(/incomplete/i);
    expect(() => assertSafeRegexSource("a".repeat(501))).toThrow(/at most/i);
  });
});
