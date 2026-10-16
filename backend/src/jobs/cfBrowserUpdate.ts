import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { cloakCacheDir, installedCfBuilds } from "./cfBrowser";
import { anyCfLicenseKey } from "./cfLicense";

type Tier = "keyed" | "free";
type Build = { tier: Tier; version: string; path: string };
export type BrowserUpdateResult = { status: "success" | "failed" | "skipped"; message: string };
type DownloadResult = { version: string; executable?: string };
type Download = (input: {
  tier: Tier; current: string; staging: string; cache: string; licenseKey?: string;
}) => Promise<DownloadResult>;

function validVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+(?:\.\d+){3,4}$/.test(value) &&
    value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

function executablePath(directory: string): string {
  return path.join(directory, process.platform === "darwin"
    ? "Chromium.app/Contents/MacOS/Chromium" : process.platform === "win32" ? "chrome.exe" : "chrome");
}

function newer(a: string, b: string): boolean {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0);
  }
  return false;
}

function childPath(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// The SDK's published index omits its blocking keyed updater. Resolve the adjacent
// download adapter in an isolated ESM child and fail closed if that SDK API changes.
const DOWNLOAD_SCRIPT = `
const root = import.meta.resolve("cloakbrowser");
const binary = await import(new URL("./download.js", root));
const license = await import(new URL("./license.js", root));
const sdk = await import("cloakbrowser");
const tier = process.env.BEMBY_UPDATE_TIER;
const key = tier === "keyed" ? process.env.CLOAKBROWSER_LICENSE_KEY : undefined;
if (tier === "keyed" && (!key || !(await sdk.validateLicense(key))?.valid)) {
  throw new Error("A valid configured CloakBrowser key is required to update the installed keyed build");
}
const latest = tier === "keyed"
  ? (await license.getProLatestRelease())?.version
  : await binary.getLatestChromiumVersion();
if (!latest || !/^\\d+(?:\\.\\d+){3,4}$/.test(latest)) throw new Error("Could not determine the newest browser build");
const newer = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
};
let result = { version: process.env.BEMBY_UPDATE_CURRENT };
if (newer(latest, result.version)) {
  process.env.CLOAKBROWSER_CACHE_DIR = process.env.BEMBY_UPDATE_STAGING;
  if (tier === "free") delete process.env.CLOAKBROWSER_LICENSE_KEY;
  const executable = await sdk.ensureBinary(key, latest);
  result = { version: latest, executable };
}
console.log("BEMBY_BROWSER_UPDATE=" + JSON.stringify(result));
`;

const downloadBuild: Download = (input) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", DOWNLOAD_SCRIPT], {
    cwd: path.resolve(__dirname, "../.."),
    windowsHide: true,
    env: {
      ...process.env,
      CLOAKBROWSER_AUTO_UPDATE: "false",
      CLOAKBROWSER_CACHE_DIR: input.cache,
      CLOAKBROWSER_LICENSE_KEY: input.licenseKey ?? "",
      BEMBY_UPDATE_TIER: input.tier,
      BEMBY_UPDATE_CURRENT: input.current,
      BEMBY_UPDATE_STAGING: input.staging,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let timedOut = false;
  let processError: Error | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
    killTimer = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
    killTimer.unref();
  }, 20 * 60_000);
  timeout.unref();
  const append = (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-16_000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.once("error", (error) => {
    processError = error;
  });
  child.once("close", (code) => {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    if (timedOut) { reject(new Error("Browser update timed out; installed builds were retained")); return; }
    if (processError) { reject(processError); return; }
    if (code !== 0) {
      const safeOutput = input.licenseKey ? output.split(input.licenseKey).join("[redacted]") : output;
      reject(new Error(safeOutput.trim().slice(-1200) || `Browser updater exited with code ${code}`));
      return;
    }
    const line = output.split(/\r?\n/).reverse().find((entry) => entry.startsWith("BEMBY_BROWSER_UPDATE="));
    try {
      if (!line) throw new Error("Browser updater did not return a result");
      resolve(JSON.parse(line.slice("BEMBY_BROWSER_UPDATE=".length)) as DownloadResult);
    } catch (error) { reject(error); }
  });
});

/** Call only while holding the shared browser maintenance lock. */
export async function updateInstalledCfBrowsers(options: {
  cache?: string;
  builds?: Build[];
  licenseKey?: string;
  download?: Download;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<BrowserUpdateResult> {
  const env = options.env ?? process.env;
  if (env.CLOAKBROWSER_BINARY_PATH?.trim() || env.CLOAKBROWSER_VERSION?.trim() ||
    env.CLOAKBROWSER_DOWNLOAD_URL?.trim()) {
    return { status: "skipped", message: "Automatic update skipped: a browser path, version, or download mirror is pinned" };
  }
  const cache = path.resolve(options.cache ?? cloakCacheDir());
  const builds = (options.builds ?? installedCfBuilds()).filter((build) => {
    if (!validVersion(build.version) || !["keyed", "free"].includes(build.tier)) return false;
    const directory = path.join(cache, `chromium-${build.version}${build.tier === "keyed" ? "-pro" : ""}`);
    try {
      return childPath(cache, directory) && path.resolve(build.path) === executablePath(directory) &&
        !lstatSync(directory).isSymbolicLink() && childPath(realpathSync(cache), realpathSync(build.path));
    } catch { return false; }
  });
  if (!builds.length) return { status: "skipped", message: "No managed browser build is installed" };
  const key = options.licenseKey ?? anyCfLicenseKey();
  const messages: string[] = [];
  let failed = false;
  for (const tier of ["keyed", "free"] as const) {
    const installed = builds.filter((build) => build.tier === tier);
    const current = installed.reduce<Build | undefined>((best, build) =>
      !best || newer(build.version, best.version) ? build : best, undefined);
    if (!current) continue;
    if (tier === "keyed" && !key) {
      failed = true;
      messages.push("keyed: no configured licence key; existing build retained");
      continue;
    }
    let staging: string | undefined;
    try {
      mkdirSync(cache, { recursive: true });
      staging = mkdtempSync(path.join(cache, ".bemby-update-"));
      const result = await (options.download ?? downloadBuild)({
        tier, current: current.version, staging, cache, licenseKey: tier === "keyed" ? key : undefined,
      });
      if (!validVersion(result?.version)) throw new Error("Invalid downloaded browser version");
      if (!newer(result.version, current.version)) {
        messages.push(`${tier}: ${current.version} is up to date`);
        continue;
      }
      const name = `chromium-${result.version}${tier === "keyed" ? "-pro" : ""}`;
      const source = path.join(staging, name);
      const executable = result.executable ? path.resolve(result.executable) : "";
      if (executable !== executablePath(source) || !existsSync(executable) ||
        lstatSync(source).isSymbolicLink() || !childPath(realpathSync(source), realpathSync(executable))) {
        throw new Error("Verified download did not produce the expected browser executable");
      }
      accessSync(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      const target = path.join(cache, name);
      if (!childPath(cache, target) || existsSync(target)) throw new Error("New build target already exists; existing builds retained");
      renameSync(source, target);
      // Nothing old is removed until a verified replacement is in its final directory.
      for (const previous of installed) {
        const previousDir = path.join(cache, `chromium-${previous.version}${tier === "keyed" ? "-pro" : ""}`);
        if (previousDir !== target && childPath(cache, previousDir)) rmSync(previousDir, { recursive: true, force: true });
      }
      messages.push(`${tier}: ${current.version} -> ${result.version}`);
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      messages.push(`${tier}: ${key ? message.split(key).join("[redacted]") : message}`);
    } finally {
      if (staging && childPath(cache, staging)) {
        try { rmSync(staging, { recursive: true, force: true }); }
        catch {
          failed = true;
          messages.push(`${tier}: could not remove temporary download directory`);
        }
      }
    }
  }
  return { status: failed ? "failed" : "success", message: messages.join("\n").slice(-3000) };
}
