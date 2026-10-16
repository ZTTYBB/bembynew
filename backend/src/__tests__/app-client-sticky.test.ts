// Tests for resolveAppClientParams (tg/appClient.ts).
//
// When an account has no explicit app client and the global mode is "random",
// a random client must be picked ONCE and then stay stable for that account --
// reused for auth, jobs and the live client -- rather than changing every call.

import Database from "better-sqlite3";

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveAppClientParams } from "../tg/appClient";
import type { TgAppClient } from "../types";

const CLIENTS: TgAppClient[] = [
  { id: "a", name: "A", deviceModel: "DeviceA", systemVersion: "1", appVersion: "1", langCode: "en", langPack: "", systemLangCode: "en", isDefault: false },
  { id: "b", name: "B", deviceModel: "DeviceB", systemVersion: "2", appVersion: "2", langCode: "en", langPack: "", systemLangCode: "en", isDefault: true },
  { id: "c", name: "C", deviceModel: "DeviceC", systemVersion: "3", appVersion: "3", langCode: "en", langPack: "", systemLangCode: "en", isDefault: false },
];

function setMode(mode: string) {
  testDb
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('tg_client_mode', ?)")
    .run(mode);
}

function assignments(): Record<string, string> {
  const row = testDb
    .prepare("SELECT value FROM settings WHERE key = 'tg_client_assignments'")
    .get() as { value: string } | undefined;
  return row?.value ? JSON.parse(row.value) : {};
}

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  testDb
    .prepare("INSERT INTO settings (key, value) VALUES ('tg_app_clients', ?)")
    .run(JSON.stringify(CLIENTS));
});

afterEach(() => {
  vi.restoreAllMocks();
  testDb.close();
});

describe("resolveAppClientParams", () => {
  it("uses the explicitly-set client", () => {
    setMode("random");
    const params = resolveAppClientParams(1, "c");
    expect(params?.deviceModel).toBe("DeviceC");
    // Explicit choice must not create a sticky assignment.
    expect(assignments()).toEqual({});
  });

  it("uses the default client when mode is not random", () => {
    setMode("default");
    const params = resolveAppClientParams(1, null);
    expect(params?.deviceModel).toBe("DeviceB"); // isDefault
    expect(assignments()).toEqual({});
  });

  it("picks a random client and persists it for the account", () => {
    setMode("random");
    // Force the first pick to index 2 ("c").
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const params = resolveAppClientParams(7, null);
    expect(params?.deviceModel).toBe("DeviceC");
    expect(assignments()).toEqual({ "7": "c" });
  });

  it("sticks with the first pick and never re-randomises", () => {
    setMode("random");
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0); // first pick -> "a"
    const first = resolveAppClientParams(7, null);
    expect(first?.deviceModel).toBe("DeviceA");

    // Even if the RNG would now choose a different client, the account stays on "a".
    rnd.mockReturnValue(0.9);
    const second = resolveAppClientParams(7, null);
    expect(second?.deviceModel).toBe("DeviceA");
    const third = resolveAppClientParams(7, null);
    expect(third?.deviceModel).toBe("DeviceA");
    expect(assignments()).toEqual({ "7": "a" });
  });

  it("assigns independently per account", () => {
    setMode("random");
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0); // "a"
    resolveAppClientParams(1, null);
    rnd.mockReturnValue(0.9); // "c"
    resolveAppClientParams(2, null);
    expect(assignments()).toEqual({ "1": "a", "2": "c" });
  });

  it("re-rolls only if the assigned client no longer exists", () => {
    setMode("random");
    // Pre-seed an assignment pointing at a client that isn't in the list.
    testDb
      .prepare("INSERT INTO settings (key, value) VALUES ('tg_client_assignments', ?)")
      .run(JSON.stringify({ "7": "gone" }));
    vi.spyOn(Math, "random").mockReturnValue(0); // re-pick -> "a"
    const params = resolveAppClientParams(7, null);
    expect(params?.deviceModel).toBe("DeviceA");
    expect(assignments()).toEqual({ "7": "a" });
  });
});
