// A free CloakBrowser key allows one concurrent session, so the pool has to hand each
// running browser a different key and never the same one twice -- and it must never let a
// raw key back out to the client.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const rows = new Map<string, string>();

vi.mock("../db/database", () => ({
  db: {
    prepare: (sql: string) => ({
      get: (key: string) =>
        sql.includes("SELECT") && rows.has(key) ? { value: rows.get(key) } : undefined,
      run: (key: string, value: string) => rows.set(key, value),
      all: () => [],
    }),
  },
}));

import {
  CF_KEYS_SETTING,
  cfLicenseKeys,
  cfLicenseKeysForClient,
  cfLicenseUsage,
  leaseCfLicenseKey,
  maskKey,
  saveCfLicenseKeys,
} from "../jobs/cfLicense";

const active: Array<{ release: () => void }> = [];
async function take(waitMs?: number) {
  const lease = await leaseCfLicenseKey(waitMs);
  if (lease.key) active.push(lease);
  return lease;
}

beforeEach(() => {
  rows.clear();
  delete process.env.CLOAKBROWSER_LICENSE_KEY;
  saveCfLicenseKeys([]);
});
afterEach(() => {
  for (const lease of active.splice(0)) lease.release();
  delete process.env.CLOAKBROWSER_LICENSE_KEY;
  saveCfLicenseKeys([]);
});

describe("stored keys", () => {
  it("keeps what was saved and drops entries with no key", () => {
    saveCfLicenseKeys([
      { label: "acct-a", key: "cb_aaaaaaaaaaaa" },
      { label: "blank", key: "  " },
    ]);
    expect(cfLicenseKeys()).toEqual([{ label: "acct-a", key: "cb_aaaaaaaaaaaa" }]);
  });

  it("never sends a raw key to the client", () => {
    saveCfLicenseKeys([{ label: "acct-a", key: "cb_aaaaaaaaaaaa" }]);
    const view = cfLicenseKeysForClient();
    expect(view).toEqual([{ label: "acct-a", masked: maskKey("cb_aaaaaaaaaaaa") }]);
    expect(JSON.stringify(view)).not.toContain("cb_aaaaaaaaaaaa");
  });

  // The client only ever holds masked values, so a save that echoes one back has to keep
  // the stored key rather than replacing it with the mask.
  it("keeps the stored key when the client sends the masked value back", () => {
    saveCfLicenseKeys([{ label: "acct-a", key: "cb_aaaaaaaaaaaa" }]);
    saveCfLicenseKeys([{ label: "renamed", key: maskKey("cb_aaaaaaaaaaaa") }]);
    expect(cfLicenseKeys()).toEqual([{ label: "renamed", key: "cb_aaaaaaaaaaaa" }]);
  });

  it("drops a duplicate of a key already in the list", () => {
    saveCfLicenseKeys([
      { label: "a", key: "cb_aaaaaaaaaaaa" },
      { label: "a again", key: "cb_aaaaaaaaaaaa" },
    ]);
    expect(cfLicenseKeys()).toHaveLength(1);
  });

  it("stores under the documented settings key", () => {
    saveCfLicenseKeys([{ label: "a", key: "cb_aaaaaaaaaaaa" }]);
    expect(rows.get(CF_KEYS_SETTING)).toContain("cb_aaaaaaaaaaaa");
  });
});

describe("leasing", () => {
  beforeEach(() => {
    saveCfLicenseKeys([
      { label: "a", key: "cb_aaaaaaaaaaaa" },
      { label: "b", key: "cb_bbbbbbbbbbbb" },
    ]);
  });

  it("hands two concurrent browsers different keys", async () => {
    const first = await take();
    const second = await take();
    expect(first.key).toBeDefined();
    expect(second.key).toBeDefined();
    expect(first.key).not.toBe(second.key);
    expect(cfLicenseUsage()).toEqual({ total: 2, inUse: 2 });
  });

  // Doubling up would put two sessions on one seat, which the licence server refuses. A
  // caller that will not wait gets no key rather than a seat somebody else is sitting in.
  it("gives no key out once every seat is taken", async () => {
    await take();
    await take();
    expect((await take()).key).toBeUndefined();
  });

  it("offers a key again once its browser has closed", async () => {
    const first = await take();
    await take();
    first.release();
    expect((await take()).key).toBe(first.key);
  });

  // The point of waiting: concurrency follows how many keys the operator has, instead of
  // the launch failing or running the keyed build unlicensed.
  it("hands a waiting launch the seat the moment one is released", async () => {
    const first = await take();
    await take();
    const queued = leaseCfLicenseKey(5_000);
    first.release();
    const handed = await queued;
    if (handed.key) active.push(handed);
    expect(handed.key).toBe(first.key);
    // still held, by the waiter this time
    expect(cfLicenseUsage().inUse).toBe(2);
  });

  it("serves waiters in the order they arrived", async () => {
    const first = await take();
    const second = await take();
    const earlier = leaseCfLicenseKey(5_000);
    const later = leaseCfLicenseKey(5_000);
    first.release();
    second.release();
    const earlierLease = await earlier;
    const laterLease = await later;
    if (earlierLease.key) active.push(earlierLease);
    if (laterLease.key) active.push(laterLease);
    expect(earlierLease.key).toBe(first.key);
    expect(laterLease.key).toBe(second.key);
  });

  it("gives up with no key when the wait runs out", async () => {
    await take();
    await take();
    expect((await take(20)).key).toBeUndefined();
  });

  it("does not wait when no key is configured at all", async () => {
    saveCfLicenseKeys([]);
    expect((await take(5_000)).key).toBeUndefined();
    expect(cfLicenseUsage()).toEqual({ total: 0, inUse: 0 });
  });

  // Releasing twice would hand the same seat out to two waiters.
  it("ignores a second release of the same lease", async () => {
    const first = await take();
    first.release();
    first.release();
    expect(cfLicenseUsage().inUse).toBe(0);
  });

  it("counts the environment key as one concurrent seat", async () => {
    process.env.CLOAKBROWSER_LICENSE_KEY = "cb_from_env";
    const first = await take();
    expect(first.key).toBe("cb_from_env");
    expect((await take()).key).toBeUndefined();
    expect(cfLicenseUsage()).toEqual({ total: 1, inUse: 1 });
  });

  it("dispatches a queued launch to a newly configured key", async () => {
    await take();
    await take();
    const queued = leaseCfLicenseKey(5_000);
    saveCfLicenseKeys([{ label: "c", key: "cb_cccccccccccc" }]);
    const handed = await queued;
    if (handed.key) active.push(handed);
    expect(handed.key).toBe("cb_cccccccccccc");
  });
});
