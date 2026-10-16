import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const rows = vi.hoisted(() => new Map<number, string | null>());

vi.mock("../db/database", () => ({
  getDefaultTgApiCredentials: () => null,
  db: {
    prepare: (sql: string) => ({
      get: (id: number) => rows.has(id) ? { additional_attributes: rows.get(id) } : undefined,
      run: (value: string | null, id: number) => {
        if (!sql.startsWith("UPDATE tg_accounts")) throw new Error("Unexpected write");
        rows.set(id, value);
      },
    }),
  },
}));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));
vi.mock("../jobs/runner", () => ({ parseTgProxy: vi.fn() }));
vi.mock("../tg/liveClient", () => ({ isAuthError: vi.fn(), markSessionExpired: vi.fn() }));

import { getAttributes, normalizeTags, setAccountTag } from "../db/accountAttributes";
import { tagFilterSql } from "../routes/accounts";

beforeEach(() => rows.clear());

describe("setAccountTag", () => {
  it("writes only to the running account and retains its other metadata and tags", () => {
    rows.set(1, JSON.stringify({ hasEmail: true, tags: { old: "keep" } }));
    rows.set(2, JSON.stringify({ tags: { old: "other" } }));

    setAccountTag(1, " points ", "12,345");

    expect(getAttributes(1)).toEqual({ hasEmail: true, tags: { old: "keep", points: "12,345" } });
    expect(getAttributes(2)).toEqual({ tags: { old: "other" } });
  });

  it("overwrites an existing value and preserves false and zero scalars", () => {
    rows.set(1, JSON.stringify({ tags: { points: "old" } }));
    setAccountTag(1, "points", 0);
    setAccountTag(1, "vip", false);
    expect(getAttributes(1).tags).toEqual({ points: 0, vip: false });
  });

  it("removes one tag without removing other account metadata", () => {
    rows.set(1, JSON.stringify({ hasEmail: true, tags: { old: "remove" } }));
    setAccountTag(1, "old", null);
    expect(getAttributes(1)).toEqual({ hasEmail: true });
  });

  it("rejects reserved and oversized keys instead of colliding with another tag", () => {
    expect(() => setAccountTag(1, "__proto__", "x")).toThrow("Tag name");
    expect(() => setAccountTag(1, "x".repeat(97), "x")).toThrow("too long");
    expect(() => setAccountTag(1, "value", "x".repeat(513))).toThrow("too long");
    expect(rows.size).toBe(0);
  });

  it("allows replacing a full tag set but rejects a new 129th tag", () => {
    const tags = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`t${i}`, true]));
    rows.set(1, JSON.stringify({ tags }));
    setAccountTag(1, "t0", "updated");
    expect(() => setAccountTag(1, "new", "x")).toThrow("Too many");
    expect(Object.keys(getAttributes(1).tags as object)).toHaveLength(128);
  });
});

describe("normalizeTags", () => {
  it("drops non-scalar and prototype keys from imported metadata", () => {
    expect(
      normalizeTags(JSON.parse('{"__proto__":"x","nested":{},"vip":true,"points":12}')),
    ).toEqual({ vip: true, points: 12 });
  });
});

describe("account tag filter numbers", () => {
  let filterDb: InstanceType<typeof Database>;
  const values: Record<string, unknown> = {
    Zero: "0",
    One: "1",
    Exponent: "1e3",
    Number: 1000,
    Thousands: "12,345",
    BadSign: "1-2",
    BadPlus: "++",
    BadDecimal: "1.2.3",
    Empty: "",
    Text: "ready",
    Overflow: "1e309",
    Bare: true,
    False: false,
    Null: null,
    Nested: [12],
  };
  const allNames = Object.keys(values).sort();

  beforeAll(() => {
    filterDb = new Database(":memory:");
    filterDb.exec("CREATE TABLE tg_accounts (name TEXT, additional_attributes TEXT)");
  });
  afterAll(() => filterDb?.close());
  beforeEach(() => {
    filterDb.exec("DELETE FROM tg_accounts");
    const insert = filterDb.prepare("INSERT INTO tg_accounts VALUES (?, ?)");
    for (const [name, value] of Object.entries(values)) {
      insert.run(name, JSON.stringify({ tags: { points: value } }));
    }
    insert.run("Missing", "{}");
  });

  function matches(op: Parameters<typeof tagFilterSql>[0]["op"], value?: string): string[] {
    const filter = tagFilterSql({ name: "points", op, value });
    return (filterDb.prepare(
      `SELECT name FROM tg_accounts WHERE (${filter.sql}) ORDER BY name`,
    ).all(...filter.params) as Array<{ name: string }>).map((row) => row.name);
  }

  it("accepts complete exponent and comma-formatted numbers", () => {
    expect(matches("eq", "1000")).toEqual(["Exponent", "Number"]);
    expect(matches("eq", "1e3")).toEqual(["Exponent", "Number"]);
    expect(matches("eq", "12,345")).toEqual(["Thousands"]);
    expect(matches("eq", "12345")).toEqual(["Thousands"]);
    expect(matches("gte", "1e3")).toEqual(["Exponent", "Number", "Thousands"]);
  });

  it("binds a normalized numeric operand as a number rather than text", () => {
    const filter = tagFilterSql({ name: "points", op: "eq", value: "12,345" });
    expect(filter.params).toEqual(["points", 12345]);
    expect(typeof filter.params[1]).toBe("number");
  });

  it("compares large finite values but excludes overflowing values and operands", () => {
    const insert = filterDb.prepare("INSERT INTO tg_accounts VALUES (?, ?)");
    for (const [name, value] of [
      ["HugeFinite", "1e308"],
      ["HugeOverflow", "1e309"],
      ["WideOverflow", "9".repeat(400)],
    ]) {
      insert.run(name, JSON.stringify({ tags: { points: value } }));
    }
    expect(matches("eq", "1e308")).toEqual(["HugeFinite"]);
    expect(matches("gte", "1e308")).toEqual(["HugeFinite"]);
    expect(matches("lt", "1e308")).toEqual(["Exponent", "Number", "One", "Thousands", "Zero"]);
    for (const value of ["1e309", "9".repeat(400)]) {
      for (const op of ["gt", "gte", "lt", "lte"] as const) {
        expect(matches(op, value)).toEqual([]);
      }
    }
  });

  it("never partially casts malformed values or treats bare markers as numbers", () => {
    expect(matches("gt", "0")).toEqual(["Exponent", "Number", "One", "Thousands"]);
    expect(matches("eq", "0")).toEqual(["Zero"]);
    expect(matches("ne", "1000")).toEqual(["One", "Thousands", "Zero"]);
  });

  it.each(["1-2", "++", "1.2.3", "", " ", "ready", "1e309", "true", "[]"])(
    "rejects the invalid ordered-comparison operand %j",
    (value) => {
      for (const op of ["gt", "gte", "lt", "lte"] as const) {
        expect(matches(op, value)).toEqual([]);
      }
    },
  );

  it("compares empty eq/ne as text rather than zero", () => {
    expect(matches("eq", "")).toEqual(["Empty"]);
    expect(matches("ne", "")).toEqual(allNames.filter((name) => name !== "Empty" && name !== "Null"));
    expect(matches("eq")).toEqual(["Empty"]);
  });

  it.each([
    ["1-2", "BadSign"],
    ["++", "BadPlus"],
    ["1.2.3", "BadDecimal"],
    ["ready", "Text"],
    ["1e309", "Overflow"],
  ])("retains exact eq/ne text semantics for %j", (value, name) => {
    expect(matches("eq", value)).toEqual([name]);
    expect(matches("ne", value)).toEqual(allNames.filter((key) => key !== name && key !== "Null"));
  });

  it("requires the tag to exist even for ne; lacks is the explicit missing-tag operator", () => {
    expect(matches("has")).toEqual(allNames);
    expect(matches("lacks")).toEqual(["Missing"]);
    expect(matches("ne", "0")).not.toContain("Missing");
    expect(matches("ne", "")).not.toContain("Missing");
  });
});
