import { describe, expect, it } from "vitest";
import { Api } from "telegram";
import { claimWatchButtonForward } from "../db/watchButtonForwards";
import {
  forwardFingerprint,
  parseButtonCountdown,
  parseForwardCode,
  parseRedPacketShare,
  renderForwardMessage,
  waitForPrivateDrop,
} from "../jobs/watchButtons";

describe("watch_buttons message parsing", () => {
  it("parses Chinese totals and share counts", () => {
    expect(parseRedPacketShare("总积分：1,200，共 6 份")).toEqual({
      total: 1200,
      shares: 6,
      perShare: 200,
    });
  });

  it("parses decimal English amounts", () => {
    expect(parseRedPacketShare("Total 12.5 points / 5 shares")).toEqual({
      total: 12.5,
      shares: 5,
      perShare: 2.5,
    });
  });

  it("leaves code batches without an amount unfiltered", () => {
    expect(parseRedPacketShare("群猜码还有 3 份")).toBeNull();
  });

  it("recognises countdowns and rejects unrelated numbers", () => {
    expect(parseButtonCountdown("本批已满，倒计时 15 秒后开放")).toBe(15);
    expect(parseButtonCountdown("剩余 2 minutes")).toBe(120);
    expect(parseButtonCountdown("共 10 份")).toBeNull();
  });

  it("extracts and renders a masked code without persisting message text", () => {
    expect(parseForwardCode("群猜码： AB_*12")).toBe("AB_*12");
    expect(parseForwardCode("gift code: Qx-77")).toBe("Qx-77");
    expect(renderForwardMessage("红包 {gift} / {code}\n{message}", {
      gift: "LuckyHouse",
      code: "AB_*12",
      message: "群猜码： AB_*12",
    })).toBe("红包 LuckyHouse / AB_*12\n群猜码： AB_*12");
    expect(forwardFingerprint({
      target: "@Drops",
      sourcePeerId: "123",
      sourceMessageId: 9,
      code: " AB_*12 ",
    })).toBe("code:ab_*12");
  });

  it("accepts only a new private message from the clicked source peer", async () => {
    const source = new Api.PeerUser({ userId: 99n as any });
    let handler: ((event: any) => Promise<void>) | undefined;
    const client = {
      getInputEntity: async () => ({}),
      getMessages: async () => [],
      addEventHandler: (callback: any) => { handler = callback; },
      removeEventHandler: () => {},
    } as any;
    const pending = waitForPrivateDrop(client, source, Date.now(), 5_000);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await handler?.({ message: {
      id: 1, out: false, date: Math.floor(Date.now() / 1000),
      peerId: source, fromId: source, message: "code: AB_*12",
    } });
    await expect(pending).resolves.toMatchObject({
      sourcePeerId: "99",
      message: { id: 1 },
    });
  });

  it("rejects immediately when the forwarding signal was already aborted", async () => {
    const source = new Api.PeerUser({ userId: 100n as any });
    const controller = new AbortController();
    controller.abort();
    const client = {
      getInputEntity: async () => ({}),
      getMessages: async () => [],
      addEventHandler: () => {},
      removeEventHandler: () => {},
    } as any;
    await expect(
      waitForPrivateDrop(client, source, Date.now(), 5_000, controller.signal),
    ).rejects.toThrow("Job cancelled");
  });

  it("claims a forwarding fingerprint once across accounts", () => {
    const fingerprints = new Set<string>();
    const fakeDb = {
      inTransaction: false,
      exec: () => {},
      transaction: (fn: () => boolean) => () => fn(),
      prepare: (sql: string) => ({
        run: (...args: unknown[]) => {
          if (sql.trimStart().startsWith("INSERT OR IGNORE")) {
            const fingerprint = String(args[0]);
            if (fingerprints.has(fingerprint)) return { changes: 0 };
            fingerprints.add(fingerprint);
            return { changes: 1 };
          }
          return { changes: 0 };
        },
      }),
    } as any;
    const claim = {
      fingerprint: "code:@drops:ab_*12",
      code: "AB_*12",
      sourcePeerId: "99",
      sourceMessageId: 1,
      target: "@Drops",
    };
    expect(claimWatchButtonForward(fakeDb, claim)).toBe(true);
    expect(claimWatchButtonForward(fakeDb, claim)).toBe(false);
  });
});

