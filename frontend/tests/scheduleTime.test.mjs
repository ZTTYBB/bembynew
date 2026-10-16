import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveZonedInput, utcOffsetLabel, zonedInput } from "../src/utils/scheduleTime.ts";

test("resolves a wall time in its selected timezone, not the browser timezone", () => {
  assert.deepEqual(resolveZonedInput("2099-06-15T10:23:45", "Asia/Shanghai"), ["2099-06-15T02:23:45.000Z"]);
  assert.equal(zonedInput("2099-06-15T02:23:45.000Z", "Asia/Shanghai"), "2099-06-15T10:23:45");
});

test("preserves half-hour and quarter-hour offsets", () => {
  assert.deepEqual(resolveZonedInput("2099-06-15T10:00", "Asia/Kathmandu"), ["2099-06-15T04:15:00.000Z"]);
  assert.equal(utcOffsetLabel("2099-06-15T00:00:00.000Z", "Asia/Kathmandu"), "UTC+05:45");
  assert.equal(utcOffsetLabel("2099-06-15T00:00:00.000Z", "Australia/Adelaide"), "UTC+09:30");
});

test("offers both repeated DST instants for explicit selection", () => {
  assert.deepEqual(resolveZonedInput("2024-11-03T01:30", "America/New_York"), [
    "2024-11-03T05:30:00.000Z", "2024-11-03T06:30:00.000Z",
  ]);
});

test("rejects the nonexistent DST spring-forward hour", () => {
  assert.throws(() => resolveZonedInput("2024-03-10T02:30", "America/New_York"), /nonexistentTime/);
});

test("recognizes a half-hour DST overlap", () => {
  assert.deepEqual(resolveZonedInput("2024-04-07T01:45", "Australia/Lord_Howe"), [
    "2024-04-06T14:45:00.000Z", "2024-04-06T15:15:00.000Z",
  ]);
});

test("rejects nonexistent calendar days and malformed inputs", () => {
  for (const value of ["2024-02-30T10:00", "2024-06-15T25:00", "n/a", "2024-06-15T10:00Z"]) {
    assert.throws(() => resolveZonedInput(value, "UTC"), /invalidTime/);
  }
});

test("rejects invalid timezones without changing the input", () => {
  assert.throws(() => resolveZonedInput("2099-06-15T10:00", "Not/AZone"), /invalidTimezone/);
});

test("keeps a local calendar day across the UTC date boundary", () => {
  assert.equal(zonedInput("2099-06-15T15:30:00Z", "Asia/Tokyo").slice(0, 10), "2099-06-16");
});
