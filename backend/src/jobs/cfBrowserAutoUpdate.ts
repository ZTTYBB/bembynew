import { DateTime, IANAZone } from "luxon";
import { db, getDefaultTimezone, FALLBACK_TIMEZONE } from "../db/database";
import { tryAcquireCfBrowserMaintenance } from "./cfBrowserMaintenance";
import { updateInstalledCfBrowsers, type BrowserUpdateResult } from "./cfBrowserUpdate";

export const CF_AUTO_UPDATE_ENABLED = "cf_browser_auto_update_enabled";
export const CF_AUTO_UPDATE_TIME = "cf_browser_auto_update_time";
export const CF_AUTO_UPDATE_STATE = "cf_browser_auto_update_state";
export type BrowserAutoUpdateState = {
  day: string;
  timezone: string;
  checkedAt: string;
  status: "waiting" | "running" | "success" | "failed" | "skipped";
  message: string;
};
type UpdateConfig = { enabled: boolean; time: string; timezone: string };
type Dependencies = {
  config: () => UpdateConfig;
  read: () => BrowserAutoUpdateState | undefined;
  write: (state: BrowserAutoUpdateState) => void;
  acquire: () => (() => void) | undefined;
  update: () => Promise<BrowserUpdateResult>;
  now?: () => number;
};

export function validBrowserUpdateTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function createBrowserAutoUpdater(deps: Dependencies) {
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  async function tick(): Promise<void> {
    if (running) return;
    const config = deps.config();
    if (!config.enabled) return;
    const timezone = IANAZone.isValidZone(config.timezone) ? config.timezone : "UTC";
    const now = DateTime.fromMillis(deps.now?.() ?? Date.now(), { zone: timezone });
    const [hour, minute] = (validBrowserUpdateTime(config.time) ? config.time : "05:00").split(":").map(Number);
    const due = now.startOf("day").set({ hour, minute });
    if (now < due) return;
    const day = now.toISODate()!;
    const prior = deps.read();
    if (prior?.day === day && prior.timezone === timezone &&
      ["success", "failed", "skipped"].includes(prior.status)) return;
    const state = (status: BrowserAutoUpdateState["status"], message: string): BrowserAutoUpdateState => ({
      day, timezone, checkedAt: now.toUTC().toISO()!, status, message,
    });
    if (now.toMillis() - due.toMillis() >= 3 * 60 * 60_000) {
      deps.write(state("skipped", "Today's three-hour update window has closed"));
      return;
    }
    const release = deps.acquire();
    if (!release) {
      deps.write(state("waiting", "Browser in use or installation in progress; retrying each minute"));
      return;
    }
    running = true;
    try {
      deps.write(state("running", "Checking installed browser builds"));
      const result = await deps.update();
      deps.write({ ...state(result.status, result.message), checkedAt: new Date(deps.now?.() ?? Date.now()).toISOString() });
    } catch (error) {
      deps.write(state("failed", error instanceof Error ? error.message : String(error)));
    } finally {
      release();
      running = false;
    }
  }
  const safeTick = () => { void tick().catch((error) => console.warn("[browser-update] check failed:", error)); };
  return {
    tick,
    start() {
      if (timer) return;
      safeTick();
      timer = setInterval(safeTick, 60_000);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
  };
}

function readSetting(key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function browserAutoUpdateConfig(): UpdateConfig {
  const time = readSetting(CF_AUTO_UPDATE_TIME);
  const timezone = getDefaultTimezone() || FALLBACK_TIMEZONE;
  return {
    enabled: readSetting(CF_AUTO_UPDATE_ENABLED) !== "false",
    time: validBrowserUpdateTime(time) ? time : "05:00",
    timezone: IANAZone.isValidZone(timezone) ? timezone : FALLBACK_TIMEZONE,
  };
}

export function browserAutoUpdateState(): BrowserAutoUpdateState | undefined {
  try {
    const state = JSON.parse(readSetting(CF_AUTO_UPDATE_STATE) ?? "null");
    return state && typeof state.day === "string" && typeof state.timezone === "string" &&
      typeof state.checkedAt === "string" && typeof state.message === "string" &&
      ["waiting", "running", "success", "failed", "skipped"].includes(state.status) ? state : undefined;
  } catch { return undefined; }
}

const updater = createBrowserAutoUpdater({
  config: browserAutoUpdateConfig,
  read: browserAutoUpdateState,
  write: (state) => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run(CF_AUTO_UPDATE_STATE, JSON.stringify(state));
  },
  acquire: tryAcquireCfBrowserMaintenance,
  update: () => updateInstalledCfBrowsers(),
});
export const startBrowserAutoUpdate = () => updater.start();
export const stopBrowserAutoUpdate = () => updater.stop();
