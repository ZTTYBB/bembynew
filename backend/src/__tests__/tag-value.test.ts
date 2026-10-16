import { describe, expect, it } from "vitest";
import { extractTagValue } from "../jobs/tagValue";

describe("extractTagValue", () => {
  it("uses a directly entered value without a reply", () => {
    expect(extractTagValue({ value: " ready " }, [])).toBe("ready");
  });

  it("prefers capture group 1 over the directly entered value", () => {
    expect(
      extractTagValue(
        { value: "old", regex: "points:\\s*([\\d,]+)" },
        ["Check-in complete", "Points: 12,345"],
      ),
    ).toBe("12,345");
  });

  it("takes the full match when the regex has no capture group", () => {
    expect(extractTagValue({ regex: "\\d+" }, ["Points: 42"])).toBe("42");
  });

  it("accepts delimited patterns and flags like other regex fields", () => {
    expect(
      extractTagValue({ regex: "/^points:\\s*(\\d+)$/im" }, ["Done\nPOINTS: 123"]),
    ).toBe("123");
  });

  it("does not fall back to a direct value when extraction fails", () => {
    expect(() =>
      extractTagValue({ value: "old", regex: "Points: (\\d+)" }, ["No balance"]),
    ).toThrow("did not match");
  });

  it("rejects invalid, oversized and empty values", () => {
    expect(() => extractTagValue({ regex: "[" }, ["x"])).toThrow("Invalid tag regex");
    expect(() => extractTagValue({ regex: "x".repeat(501) }, ["x"])).toThrow("too long");
    expect(() => extractTagValue({ value: " " }, [])).toThrow("required");
    expect(() => extractTagValue({ regex: "()" }, ["x"])).toThrow("required");
    expect(() => extractTagValue({ value: "x".repeat(513) }, [])).toThrow("too long");
  });
});
