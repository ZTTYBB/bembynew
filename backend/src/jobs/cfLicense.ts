import { db } from "../db/database";

// CloakBrowser licence keys. The binary that ships without a key is the old free build,
// which ages as detection moves on; a key -- free, one per GitHub sign-in -- gets the
// current build instead. A free key allows one concurrent session, so several of them are
// kept here and one is leased per running browser: with two keys two jobs can solve at
// once, which is what Bemby's scheduler runs.
//
// Keys are stored in the settings table and never sent back to the client in full.

export const CF_KEYS_SETTING = "cf_cloak_keys";

export type CfLicenseKey = {
  /** Free-text label, e.g. which account the key came from. */
  label: string;
  key: string;
};

/** What the client is allowed to see: the label, and enough of the key to recognise it. */
export type CfLicenseKeyView = {
  label: string;
  /** First and last few characters, e.g. "cb_1a2b****9z8y". */
  masked: string;
};

export function maskKey(key: string): string {
  if (key.length <= 10) return "****";
  return `${key.slice(0, 7)}****${key.slice(-4)}`;
}

function readKeys(): CfLicenseKey[] {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CF_KEYS_SETTING) as
      | { value: string }
      | undefined;
    const parsed = JSON.parse(row?.value ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry: any) => ({ label: String(entry?.label ?? ""), key: String(entry?.key ?? "").trim() }))
      .filter((entry) => entry.key);
  } catch {
    return [];
  }
}

export function cfLicenseKeys(): CfLicenseKey[] {
  return readKeys();
}

export function cfLicenseKeysForClient(): CfLicenseKeyView[] {
  return readKeys().map((entry) => ({ label: entry.label, masked: maskKey(entry.key) }));
}

/**
 * Replaces the stored keys. An entry whose key is the masked form the client was given
 * keeps whatever is stored under that label, so editing a label does not require the
 * operator to paste every key again.
 */
export function saveCfLicenseKeys(incoming: Array<{ label?: string; key?: string }>): CfLicenseKey[] {
  const existing = readKeys();
  const kept: CfLicenseKey[] = [];
  const seen = new Set<string>();

  for (const entry of incoming) {
    const label = String(entry?.label ?? "").trim();
    const raw = String(entry?.key ?? "").trim();
    const key = raw.includes("****") ? existing.find((e) => maskKey(e.key) === raw)?.key : raw;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push({ label, key });
  }

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    CF_KEYS_SETTING,
    JSON.stringify(kept),
  );
  // Do not clear `leased`: a browser that is still open keeps its seat even if
  // the operator removes or edits the key in Settings. Releasing that seat is
  // the only safe point at which it can become available again. New keys are
  // dispatched to waiting launches immediately.
  dispatchWaiters();
  return kept;
}

// Keys handed out to a browser that is still running. A free key is one concurrent
// session, so a key in here is not offered again until its browser closes.
const leased = new Set<string>();

// Launches waiting for a seat, oldest first. A released key goes straight to the head of
// this queue rather than back to the pool, so a waiter cannot be jumped.
type Waiter = { resolve: (lease: LeasedKey) => void; timer: ReturnType<typeof setTimeout> };
const waiting: Waiter[] = [];

export type LeasedKey = {
  /** The key to launch with, or undefined when there is none free (or none at all). */
  key?: string;
  release: () => void;
};

const NO_KEY: LeasedKey = { release: () => {} };

function handOut(key: string): LeasedKey {
  let released = false;
  return {
    key,
    release: () => {
      if (released) return;
      released = true;
      leased.delete(key);
      dispatchWaiters();
    },
  };
}

function configuredKeys(): string[] {
  const envKey = process.env.CLOAKBROWSER_LICENSE_KEY?.trim();
  if (envKey) return [envKey];
  return readKeys().map((entry) => entry.key);
}

/**
 * Give waiting launches the oldest available seat. A key removed from Settings
 * remains in `leased` until its browser closes, but is never handed to a new
 * browser.
 */
function dispatchWaiters(): void {
  for (;;) {
    const waiter = waiting[0];
    if (!waiter) return;
    const key = configuredKeys().find((candidate) => !leased.has(candidate));
    if (!key) return;
    waiting.shift();
    clearTimeout(waiter.timer);
    leased.add(key);
    waiter.resolve(handOut(key));
  }
}

/**
 * Takes a key for one browser.
 *
 * A free key is a single concurrent session, so when every key is out this waits for one
 * rather than doubling up -- which the licence server refuses -- for up to `waitMs`.
 * Waiting is the honest answer: it makes how many solvers run at once follow how many keys
 * the operator has, instead of failing the job or quietly running an unlicensed build.
 *
 * Gives up with no key when the wait runs out, or when none is configured at all.
 */
export function leaseCfLicenseKey(waitMs = 0): Promise<LeasedKey> {
  const free = configuredKeys().find((key) => !leased.has(key));
  if (free) {
    leased.add(free);
    return Promise.resolve(handOut(free));
  }
  if (!configuredKeys().length || waitMs <= 0) return Promise.resolve(NO_KEY);

  return new Promise((resolve) => {
    const waiter: Waiter = {
      resolve,
      timer: setTimeout(() => {
        const at = waiting.indexOf(waiter);
        if (at >= 0) waiting.splice(at, 1);
        resolve(NO_KEY);
      }, waitMs),
    };
    waiting.push(waiter);
  });
}

/**
 * A key to identify the account with, without taking a seat. Downloading a build is not a
 * browser session, so the installer must not hold one -- and must not be told there is no
 * key just because every seat is currently in a running browser.
 */
export function anyCfLicenseKey(): string | undefined {
  return process.env.CLOAKBROWSER_LICENSE_KEY?.trim() || readKeys()[0]?.key;
}

/** How many keys are configured and how many are in use right now, for the settings view. */
export function cfLicenseUsage(): { total: number; inUse: number } {
  return { total: configuredKeys().length, inUse: leased.size };
}
