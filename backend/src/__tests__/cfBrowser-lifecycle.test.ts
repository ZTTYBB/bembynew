import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  releaseUse: vi.fn(),
  releaseLease: vi.fn(),
  killBrowser: vi.fn(),
  hangClose: false,
  rejectLease: false,
  launchPersistentContext: vi.fn(),
  context: undefined as any,
}));

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined }) },
}));
vi.mock("../jobs/cfTuning", () => ({
  cfTuning: () => ({
    budgetMs: 30_000,
    navTimeoutMs: 5_000,
    protocolTimeoutMs: 5_000,
    maxProfiles: 12,
    windowWidth: 0,
    windowHeight: 0,
  }),
}));
vi.mock("../jobs/cfFonts", () => ({ applyCfFontEnv: () => {} }));
vi.mock("../jobs/cfLicense", () => ({
  anyCfLicenseKey: () => "test-license",
  cfLicenseUsage: () => ({ total: 1, inUse: 1 }),
  leaseCfLicenseKey: vi.fn(async () => {
    if (state.rejectLease) throw new Error("lease unavailable");
    return { key: "test-license", release: state.releaseLease };
  }),
}));
vi.mock("../jobs/cfBrowserMaintenance", () => ({
  acquireCfBrowserUse: vi.fn(async () => state.releaseUse),
}));
vi.mock("../jobs/cloakLoader", () => ({
  loadCloakBrowser: () => Promise.resolve({
    launchPersistentContext: state.launchPersistentContext,
  }),
}));
vi.mock("../tg/proxyProviders", () => ({ cfExitGeo: () => undefined }));

let tempDir: string;
let browser: typeof import("../jobs/cfBrowser");

function fakeContext() {
  const page = { bringToFront: vi.fn(async () => {}) };
  const context = Object.assign(new EventEmitter(), {
    pages: () => [page],
    browser: () => ({ _channel: { killForTests: state.killBrowser } }),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    close: vi.fn(async () => {
      if (state.hangClose) return new Promise<void>(() => {});
      context.emit("close");
    }),
  });
  return context;
}

beforeEach(async () => {
  vi.resetModules();
  state.releaseUse.mockReset();
  state.releaseLease.mockReset();
  state.killBrowser.mockReset();
  state.hangClose = false;
  state.rejectLease = false;
  state.launchPersistentContext.mockReset();
  tempDir = mkdtempSync(path.join(os.tmpdir(), "bemby-cf-lifecycle-"));
  process.env.DB_PATH = path.join(tempDir, "bemby.db");
  const pinned = path.join(tempDir, "cloakbrowser.exe");
  writeFileSync(pinned, "");
  process.env.CLOAKBROWSER_BINARY_PATH = pinned;
  process.env.DISPLAY = ":99";
  const socket = path.join("/tmp", ".X11-unix", "X99");
  mkdirSync(path.dirname(socket), { recursive: true });
  if (!existsSync(socket)) writeFileSync(socket, "");
  state.context = fakeContext();
  state.launchPersistentContext.mockResolvedValue(state.context);
  browser = await import("../jobs/cfBrowser");
});

afterEach(() => {
  delete process.env.DB_PATH;
  delete process.env.CLOAKBROWSER_BINARY_PATH;
  delete process.env.DISPLAY;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Cloudflare browser resource lifecycle", () => {
  it("releases every resource when Chromium closes unexpectedly", async () => {
    const launched = await browser.launchCfBrowser();
    expect(browser.cfBrowsersRunning()).toBe(1);

    state.context.emit("close");

    expect(browser.cfBrowsersRunning()).toBe(0);
    expect(state.releaseUse).toHaveBeenCalledTimes(1);
    expect(state.releaseLease).toHaveBeenCalledTimes(1);

    // A later explicit close is harmless and cannot release the same lease twice.
    await launched.close();
    expect(state.releaseUse).toHaveBeenCalledTimes(1);
    expect(state.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("force-kills a context that ignores close before releasing its lease", async () => {
    const launched = await browser.launchCfBrowser();
    state.hangClose = true;
    vi.useFakeTimers();
    try {
      const closing = launched.close();
      await vi.advanceTimersByTimeAsync(15_000);
      await closing;
    } finally {
      vi.useRealTimers();
    }

    expect(state.killBrowser).toHaveBeenCalledTimes(1);
    expect(state.releaseUse).toHaveBeenCalledTimes(1);
    expect(state.releaseLease).toHaveBeenCalledTimes(1);
    expect(browser.cfBrowsersRunning()).toBe(0);
  });

  it("rolls back the profile, lease, and maintenance reservation if startup fails", async () => {
    state.launchPersistentContext.mockRejectedValueOnce(new Error("browser failed"));

    await expect(browser.launchCfBrowser(undefined, { tier: "free" })).rejects.toThrow("browser failed");
    expect(browser.cfBrowsersRunning()).toBe(0);
    expect(state.releaseUse).toHaveBeenCalledTimes(1);
    expect(state.releaseLease).not.toHaveBeenCalled();
  });

  it("rolls back the profile and maintenance reservation when a lease lookup fails", async () => {
    state.rejectLease = true;

    await expect(browser.launchCfBrowser()).rejects.toThrow("lease unavailable");
    expect(browser.cfBrowsersRunning()).toBe(0);
    expect(state.releaseUse).toHaveBeenCalledTimes(1);
    expect(state.releaseLease).not.toHaveBeenCalled();
  });
});
