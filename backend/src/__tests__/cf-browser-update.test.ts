import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../jobs/cfBrowser", () => ({
  cloakCacheDir: () => "unused",
  installedCfBuilds: () => [],
}));
vi.mock("../jobs/cfLicense", () => ({ anyCfLicenseKey: () => undefined }));

import { updateInstalledCfBrowsers } from "../jobs/cfBrowserUpdate";
type Tier = "free" | "keyed";
let cache: string;
const oldVersion = "150.0.7871.114.4";
const newVersion = "151.0.7922.34.1";
const exeName = process.platform === "darwin"
  ? "Chromium.app/Contents/MacOS/Chromium" : process.platform === "win32" ? "chrome.exe" : "chrome";
function build(version: string, tier: Tier, root = cache) {
  const executable = path.join(root, `chromium-${version}${tier === "keyed" ? "-pro" : ""}`, exeName);
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, "mock browser", { mode: 0o755 });
  return { version, tier, path: executable };
}
const options = () => ({ cache, env: {}, licenseKey: "" });

beforeEach(() => {
  cache = mkdtempSync(path.join(os.tmpdir(), "bemby-browser-update-"));
  spawnMock.mockReset();
});
afterEach(() => { vi.useRealTimers(); rmSync(cache, { recursive: true, force: true }); });

describe("safe installed-browser upgrades", () => {
  it.each(["CLOAKBROWSER_BINARY_PATH", "CLOAKBROWSER_VERSION", "CLOAKBROWSER_DOWNLOAD_URL"])(
    "honours explicit %s configuration without touching installed builds", async (key) => {
      const old = build(oldVersion, "free");
      const download = vi.fn();
      const result = await updateInstalledCfBrowsers({ ...options(), env: { [key]: "pinned" }, builds: [old], download });
      expect(result.status).toBe("skipped");
      expect(download).not.toHaveBeenCalled();
      expect(existsSync(old.path)).toBe(true);
    },
  );

  it("does not install a missing tier", async () => {
    const download = vi.fn();
    expect((await updateInstalledCfBrowsers({ ...options(), builds: [], download })).status).toBe("skipped");
    expect(download).not.toHaveBeenCalled();
  });

  it("upgrades both installed tiers beside old builds, then removes only old managed versions", async () => {
    const free = build(oldVersion, "free");
    const olderFree = build("149.0.7800.1", "free");
    const keyed = build(oldVersion, "keyed");
    const unrelated = path.join(cache, "keep-me");
    mkdirSync(unrelated);
    const download = vi.fn(async (input) => {
      expect(existsSync(input.tier === "keyed" ? keyed.path : free.path)).toBe(true);
      expect(input.cache).toBe(cache);
      expect(input.licenseKey).toBe(input.tier === "keyed" ? "test-key" : undefined);
      const fresh = build(newVersion, input.tier, input.staging);
      return { version: newVersion, executable: fresh.path };
    });
    const result = await updateInstalledCfBrowsers({
      ...options(), licenseKey: "test-key", builds: [free, olderFree, keyed], download,
    });
    expect(result.status).toBe("success");
    expect(download).toHaveBeenCalledTimes(2);
    expect(existsSync(free.path)).toBe(false);
    expect(existsSync(olderFree.path)).toBe(false);
    expect(existsSync(keyed.path)).toBe(false);
    expect(existsSync(path.join(cache, `chromium-${newVersion}`, exeName))).toBe(true);
    expect(existsSync(path.join(cache, `chromium-${newVersion}-pro`, exeName))).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(readdirSync(cache).some((name) => name.startsWith(".bemby-update-"))).toBe(false);
  });

  it("keeps the original build and cleans temporary partial downloads on failure", async () => {
    const old = build(oldVersion, "free");
    const result = await updateInstalledCfBrowsers({
      ...options(), builds: [old], download: async (input) => {
        build(newVersion, "free", input.staging);
        throw new Error("checksum failure");
      },
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(result.message).toContain("checksum failure");
    expect(existsSync(old.path)).toBe(true);
    expect(readdirSync(cache)).toEqual([`chromium-${oldVersion}`]);
  });

  it.each([oldVersion, "149.0.9999.1"])("never removes old builds for same or older version %s", async (version) => {
    const old = build(oldVersion, "free");
    const result = await updateInstalledCfBrowsers({
      ...options(), builds: [old], download: async () => ({ version }),
    });
    expect(result.status).toBe("success");
    expect(existsSync(old.path)).toBe(true);
  });

  it("retains an installed keyed build without a key but still upgrades free", async () => {
    const keyed = build(oldVersion, "keyed");
    const free = build(oldVersion, "free");
    const download = vi.fn(async (input) => ({ version: newVersion, executable: build(newVersion, input.tier, input.staging).path }));
    const result = await updateInstalledCfBrowsers({ ...options(), builds: [keyed, free], download });
    expect(result.status).toBe("failed");
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][0].tier).toBe("free");
    expect(existsSync(keyed.path)).toBe(true);
    expect(existsSync(free.path)).toBe(false);
  });

  it("does not overwrite an existing target directory", async () => {
    const old = build(oldVersion, "free");
    const target = path.join(cache, `chromium-${newVersion}`);
    mkdirSync(target);
    writeFileSync(path.join(target, "keep-me"), "existing target");
    const result = await updateInstalledCfBrowsers({
      ...options(), builds: [old], download: async (input) => ({
        version: newVersion, executable: build(newVersion, "free", input.staging).path,
      }),
    });
    expect(result.status).toBe("failed");
    expect(existsSync(old.path)).toBe(true);
    expect(existsSync(path.join(target, "keep-me"))).toBe(true);
  });

  it.each(["../../outside", "151..0.1", "NaN", "999999999999999999999.0.0.0"])(
    "rejects malformed downloaded version %s without deleting old data", async (version) => {
      const old = build(oldVersion, "free");
      const result = await updateInstalledCfBrowsers({
        ...options(), builds: [old], download: async () => ({ version, executable: old.path }),
      });
      expect(result.status).toBe("failed");
      expect(existsSync(old.path)).toBe(true);
    },
  );

  it("rejects a download whose executable is outside the expected build", async () => {
    const old = build(oldVersion, "free");
    const result = await updateInstalledCfBrowsers({
      ...options(), builds: [old], download: async () => ({ version: newVersion, executable: old.path }),
    });
    expect(result.status).toBe("failed");
    expect(existsSync(old.path)).toBe(true);
  });

  it("ignores build records pointing outside the managed version directory", async () => {
    const old = build(oldVersion, "free");
    const download = vi.fn();
    const result = await updateInstalledCfBrowsers({
      ...options(), builds: [{ ...old, path: path.join(cache, "custom.exe") }], download,
    });
    expect(result.status).toBe("skipped");
    expect(download).not.toHaveBeenCalled();
    expect(existsSync(old.path)).toBe(true);
  });

  it("redacts configured keys from persisted download failures", async () => {
    const key = "unit-test-key";
    const old = build(oldVersion, "keyed");
    const result = await updateInstalledCfBrowsers({
      ...options(), builds: [old], licenseKey: key, download: async () => { throw new Error(`failed: ${key}`); },
    });
    expect(result.message).not.toContain(key);
    expect(result.message).toContain("[redacted]");
    expect(existsSync(old.path)).toBe(true);
  });
});

describe("isolated SDK download adapter", () => {
  function childResult(output: string, code = 0) {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    });
    queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.emit("close", code); });
    return child;
  }

  it("uses the active cache and never places the key on the command line", async () => {
    const old = build(oldVersion, "keyed");
    spawnMock.mockImplementation(() => childResult(`BEMBY_BROWSER_UPDATE=${JSON.stringify({ version: oldVersion })}\n`));
    expect((await updateInstalledCfBrowsers({ ...options(), builds: [old], licenseKey: "secret-test-key" })).status).toBe("success");
    const [binary, args, input] = spawnMock.mock.calls[0];
    expect(binary).toBe(process.execPath);
    expect(args.join(" ")).not.toContain("secret-test-key");
    expect(input.env.CLOAKBROWSER_CACHE_DIR).toBe(cache);
    expect(input.env.CLOAKBROWSER_AUTO_UPDATE).toBe("false");
    expect(input.env.CLOAKBROWSER_LICENSE_KEY).toBe("secret-test-key");
    expect(input.windowsHide).toBe(true);
  });

  it("does not pass a stored licence to a free build check", async () => {
    const old = build(oldVersion, "free");
    spawnMock.mockImplementation(() => childResult(`BEMBY_BROWSER_UPDATE={"version":"${oldVersion}"}\n`));
    await updateInstalledCfBrowsers({ ...options(), builds: [old], licenseKey: "secret-test-key" });
    expect(spawnMock.mock.calls[0][2].env.CLOAKBROWSER_LICENSE_KEY).toBe("");
  });

  it("keeps the old build and redacts child failure output", async () => {
    const old = build(oldVersion, "keyed");
    spawnMock.mockImplementation(() => childResult("network failed for secret-test-key", 1));
    const result = await updateInstalledCfBrowsers({ ...options(), builds: [old], licenseKey: "secret-test-key" });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("[redacted]");
    expect(result.message).not.toContain("secret-test-key");
    expect(existsSync(old.path)).toBe(true);
  });

  it("waits for the timed-out child to close before cleaning its staging files", async () => {
    vi.useFakeTimers();
    const old = build(oldVersion, "free");
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    });
    spawnMock.mockReturnValue(child);
    let settled = false;
    const pending = updateInstalledCfBrowsers({ ...options(), builds: [old] }).then((value) => {
      settled = true;
      return value;
    });
    const staging = spawnMock.mock.calls[0][2].env.BEMBY_UPDATE_STAGING;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(existsSync(staging)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    child.emit("close", null);
    expect((await pending).status).toBe("failed");
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(old.path)).toBe(true);
  });

  it("waits for child close after an error before releasing its download directory", async () => {
    const old = build(oldVersion, "free");
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    });
    spawnMock.mockReturnValue(child);
    let settled = false;
    const pending = updateInstalledCfBrowsers({ ...options(), builds: [old] }).then((value) => {
      settled = true;
      return value;
    });
    child.emit("error", new Error("child process error"));
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", 1);
    expect((await pending).status).toBe("failed");
    expect(existsSync(old.path)).toBe(true);
  });
});
