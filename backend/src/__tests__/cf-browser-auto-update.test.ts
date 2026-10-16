import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ settings: new Map<string, string>(), timezone: "Australia/Sydney" }));
vi.mock("../db/database", () => ({
  FALLBACK_TIMEZONE: "Australia/Sydney",
  getDefaultTimezone: () => store.timezone,
  db: {
    prepare: () => ({
      get: (key: string) => store.settings.has(key) ? { value: store.settings.get(key) } : undefined,
      run: (key: string, value: string) => store.settings.set(key, value),
    }),
  },
}));
vi.mock("../jobs/cfBrowserUpdate", () => ({ updateInstalledCfBrowsers: vi.fn() }));

import {
  browserAutoUpdateConfig, browserAutoUpdateState, createBrowserAutoUpdater, validBrowserUpdateTime,
  CF_AUTO_UPDATE_ENABLED, CF_AUTO_UPDATE_STATE, CF_AUTO_UPDATE_TIME, type BrowserAutoUpdateState,
} from "../jobs/cfBrowserAutoUpdate";

function harness(iso = "2026-10-14T21:00:00Z", timezone = "Asia/Shanghai") {
  let now = Date.parse(iso);
  let state: BrowserAutoUpdateState | undefined;
  const config = { enabled: true, time: "05:00", timezone };
  const release = vi.fn();
  const acquire = vi.fn<() => (() => void) | undefined>(() => release);
  const update = vi.fn(async () => ({ status: "success" as const, message: "free: up to date" }));
  const write = vi.fn((value: BrowserAutoUpdateState) => { state = value; });
  const deps = { config: () => config, read: () => state, write, acquire, update, now: () => now };
  return {
    config, release, acquire, update, write, deps,
    updater: createBrowserAutoUpdater(deps),
    state: () => state,
    setState: (value: BrowserAutoUpdateState) => { state = value; },
    setNow: (value: string) => { now = Date.parse(value); },
  };
}

beforeEach(() => { store.settings.clear(); store.timezone = "Australia/Sydney"; });
afterEach(() => { vi.useRealTimers(); });

describe("daily browser update settings", () => {
  it("defaults to enabled at 05:00 in the panel timezone", () => {
    expect(browserAutoUpdateConfig()).toEqual({ enabled: true, time: "05:00", timezone: "Australia/Sydney" });
    store.timezone = "Asia/Shanghai";
    store.settings.set(CF_AUTO_UPDATE_ENABLED, "false");
    store.settings.set(CF_AUTO_UPDATE_TIME, "23:45");
    expect(browserAutoUpdateConfig()).toEqual({ enabled: false, time: "23:45", timezone: "Asia/Shanghai" });
    store.timezone = "Not/A_Zone";
    expect(browserAutoUpdateConfig().timezone).toBe("Australia/Sydney");
  });

  it.each(["00:00", "05:00", "23:59"])("accepts a strict HH:mm time %s", (value) => {
    expect(validBrowserUpdateTime(value)).toBe(true);
  });
  it.each(["5:00", "24:00", "05:60", "", "05:00:00", null, 500])("rejects invalid time %s", (value) => {
    expect(validBrowserUpdateTime(value)).toBe(false);
  });

  it("falls back from a corrupt time and ignores malformed persisted status", () => {
    store.settings.set(CF_AUTO_UPDATE_TIME, "invalid");
    expect(browserAutoUpdateConfig().time).toBe("05:00");
    store.settings.set(CF_AUTO_UPDATE_STATE, "{");
    expect(browserAutoUpdateState()).toBeUndefined();
    store.settings.set(CF_AUTO_UPDATE_STATE, JSON.stringify({ status: "success" }));
    expect(browserAutoUpdateState()).toBeUndefined();
    const state = { day: "2026-10-15", timezone: "UTC", checkedAt: "2026-10-15T05:00:00Z", status: "success", message: "done" };
    store.settings.set(CF_AUTO_UPDATE_STATE, JSON.stringify(state));
    expect(browserAutoUpdateState()).toEqual(state);
  });
});

describe("daily browser update scheduler", () => {
  it("does not run before local 05:00 or when disabled", async () => {
    const h = harness("2026-10-14T20:59:59Z");
    await h.updater.tick();
    expect(h.update).not.toHaveBeenCalled();
    h.setNow("2026-10-14T21:00:00Z");
    h.config.enabled = false;
    await h.updater.tick();
    expect(h.acquire).not.toHaveBeenCalled();
    h.config.enabled = true;
    await h.updater.tick();
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.state()).toMatchObject({ day: "2026-10-15", timezone: "Asia/Shanghai", status: "success" });
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("persists a terminal daily result across scheduler recreation", async () => {
    const h = harness();
    await h.updater.tick();
    const restarted = createBrowserAutoUpdater(h.deps);
    await restarted.tick();
    expect(h.update).toHaveBeenCalledTimes(1);
    h.setNow("2026-10-15T21:00:00Z");
    await restarted.tick();
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.state()?.day).toBe("2026-10-16");
  });

  it.each(["success", "failed", "skipped"] as const)("does not repeat a persisted %s day", async (status) => {
    const h = harness();
    h.setState({ day: "2026-10-15", timezone: "Asia/Shanghai", checkedAt: "", status, message: "" });
    await h.updater.tick();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("retries busy checks each minute, stopping after the three-hour window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-14T21:00:00Z");
    const h = harness();
    h.acquire.mockReturnValue(undefined);
    const updater = createBrowserAutoUpdater({ ...h.deps, now: () => Date.now() });
    updater.start();
    expect(h.state()?.status).toBe("waiting");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.acquire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.acquire).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(179 * 60_000);
    expect(h.state()?.status).toBe("skipped");
    expect(h.acquire).toHaveBeenCalledTimes(180);
    expect(h.update).not.toHaveBeenCalled();
    updater.stop();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(h.acquire).toHaveBeenCalledTimes(180);
  });

  it("runs when a busy browser becomes idle within the window", async () => {
    const h = harness();
    h.acquire.mockReturnValueOnce(undefined);
    await h.updater.tick();
    expect(h.state()?.status).toBe("waiting");
    h.setNow("2026-10-14T21:01:00Z");
    await h.updater.tick();
    expect(h.state()?.status).toBe("success");
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it("does not start late after a restart outside the window", async () => {
    const h = harness("2026-10-15T00:00:00Z");
    await h.updater.tick();
    expect(h.state()?.status).toBe("skipped");
    expect(h.acquire).not.toHaveBeenCalled();
  });

  it("retries an interrupted running state within the window", async () => {
    const h = harness();
    h.setState({ day: "2026-10-15", timezone: "Asia/Shanghai", checkedAt: "", status: "running", message: "" });
    await h.updater.tick();
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it("prevents overlapping asynchronous checks and releases the lock on failure", async () => {
    const h = harness();
    let reject!: (error: Error) => void;
    h.update.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const first = h.updater.tick();
    await h.updater.tick();
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.state()?.status).toBe("running");
    expect(h.release).not.toHaveBeenCalled();
    reject(new Error("download unavailable"));
    await first;
    expect(h.state()).toMatchObject({ status: "failed", message: "download unavailable" });
    expect(h.release).toHaveBeenCalledTimes(1);
    await h.updater.tick();
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it("releases maintenance even if persistence itself fails", async () => {
    const h = harness();
    h.write.mockImplementation(() => { throw new Error("database unavailable"); });
    await expect(h.updater.tick()).rejects.toThrow("database unavailable");
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("uses UTC for an invalid configured timezone", async () => {
    const h = harness("2026-10-15T05:00:00Z", "Not/A_Zone");
    await h.updater.tick();
    expect(h.state()?.timezone).toBe("UTC");
  });

  it("moves a nonexistent DST time forward and runs once in a repeated hour", async () => {
    const spring = harness("2026-10-03T16:29:00Z", "Australia/Sydney");
    spring.config.time = "02:30";
    await spring.updater.tick();
    expect(spring.update).not.toHaveBeenCalled();
    spring.setNow("2026-10-03T16:30:00Z");
    await spring.updater.tick();
    expect(spring.update).toHaveBeenCalledTimes(1);
    const autumn = harness("2026-04-04T15:30:00Z", "Australia/Sydney");
    autumn.config.time = "02:30";
    await autumn.updater.tick();
    autumn.setNow("2026-04-04T16:30:00Z");
    await autumn.updater.tick();
    expect(autumn.update).toHaveBeenCalledTimes(1);
  });
});
