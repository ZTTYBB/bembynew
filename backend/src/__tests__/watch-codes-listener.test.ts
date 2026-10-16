import { describe, expect, it, vi } from "vitest";
import { Api } from "telegram";

const { resolvePeerTarget } = vi.hoisted(() => ({ resolvePeerTarget: vi.fn() }));
vi.mock("../tg/peerTarget", () => ({ resolvePeerTarget }));

import { runWatchCodes } from "../jobs/watchCodes";

describe("watch_codes listener", () => {
  it("skips codes older than the grace window and continues after the accepted reply", async () => {
    const group = new Api.PeerChannel({ channelId: 42n as any });
    const bot = new Api.PeerUser({ userId: 7n as any });
    resolvePeerTarget.mockResolvedValue(group);
    const now = Math.floor(Date.now() / 1000);
    const oldMessage = {
      id: 1,
      out: false,
      date: now - 11 * 60,
      peerId: group,
      message: "CODE-OLD",
    };
    const freshMessage = {
      id: 2,
      out: false,
      date: now,
      peerId: group,
      message: "CODE-NEW",
    };
    const handlers: Array<{ callback: (event: any) => unknown; builder: unknown }> = [];
    const unrelated = { builder: {}, callback: vi.fn() };
    const client = {
      addEventHandler(callback: any, builder: any) { handlers.push({ callback, builder }); },
      removeEventHandler(callback: any, builder: any) {
        for (let i = handlers.length - 1; i >= 0; i--) {
          if (handlers[i].callback === callback && handlers[i].builder === builder) handlers.splice(i, 1);
        }
      },
      getPeerId: vi.fn(async () => "7"),
      getMessages: vi.fn(async (target: unknown, options: any) => {
        if (target === group && options?.ids) {
          return [options.ids[0] === freshMessage.id ? freshMessage : oldMessage];
        }
        if (target === group) return [oldMessage, freshMessage];
        return [];
      }),
      sendMessage: vi.fn(async () => {
        const sent = { id: 10, out: true, date: now, peerId: bot, message: "/start CODE-NEW" };
        setTimeout(() => {
          for (const handler of [...handlers]) {
            void handler.callback({ message: {
              id: 11,
              out: false,
              date: now,
              peerId: bot,
              fromId: bot,
              message: "accepted",
            } });
          }
        }, 0);
        return sent;
      }),
    } as any;
    const claimed: string[] = [];
    const running = runWatchCodes(
      client,
      {
        groupId: "@codes",
        regex: "/(CODE-[A-Z]+)/",
        command: "/start {code}",
        maxWaitMs: 5_000,
        // API callers can bypass the UI's numeric input validation. A malformed
        // age must fall back to the default grace window, not disable filtering.
        maxCodeAgeMs: Number.NaN,
        replyWaitMs: 2_000,
        failContains: "invalid|used",
      },
      "@bot",
      undefined,
      (code) => { claimed.push(code); return true; },
    );
    const result = await running;

    expect(claimed).toEqual(["CODE-NEW"]);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.success?.code).toBe("CODE-NEW");
    expect(result.success?.replies[0].message).toBe("accepted");
    expect(handlers).toEqual([]);
    void unrelated;
  });

  it("accepts a same-second event when maxCodeAgeMs is zero without replaying startup history", async () => {
    const group = new Api.PeerChannel({ channelId: 43n as any });
    const bot = new Api.PeerUser({ userId: 8n as any });
    resolvePeerTarget.mockResolvedValue(group);
    const now = Math.floor(Date.now() / 1000);
    const startup = {
      id: 20,
      out: false,
      date: now,
      peerId: group,
      message: "CODE-STARTUP",
    };
    const fresh = {
      id: 21,
      out: false,
      date: now,
      peerId: group,
      message: "CODE-LIVE",
    };
    const handlers: Array<{ callback: (event: any) => unknown; builder: unknown }> = [];
    let historyCalls = 0;
    const client = {
      addEventHandler(callback: any, builder: any) { handlers.push({ callback, builder }); },
      removeEventHandler(callback: any, builder: any) {
        for (let i = handlers.length - 1; i >= 0; i--) {
          if (handlers[i].callback === callback && handlers[i].builder === builder) handlers.splice(i, 1);
        }
      },
      getPeerId: vi.fn(async () => "8"),
      getMessages: vi.fn(async (target: unknown, options: any) => {
        if (target === group && options?.ids) return [options.ids[0] === fresh.id ? fresh : startup];
        historyCalls++;
        if (historyCalls === 1) {
          setTimeout(() => {
            for (const handler of [...handlers]) {
              void handler.callback({ message: fresh });
            }
          }, 0);
        }
        return [startup];
      }),
      sendMessage: vi.fn(async () => {
        const sent = { id: 30, out: true, date: now, peerId: bot, message: "/start CODE-LIVE" };
        setTimeout(() => {
          for (const handler of [...handlers]) {
            void handler.callback({ message: {
              id: 31, out: false, date: now, peerId: bot, fromId: bot, message: "accepted",
            } });
          }
        }, 0);
        return sent;
      }),
    } as any;
    const claimed: string[] = [];
    const result = await runWatchCodes(
      client,
      {
        groupId: "@codes",
        regex: "/(CODE-[A-Z]+)/",
        maxWaitMs: 1_000,
        maxCodeAgeMs: 0,
        replyWaitMs: 500,
      },
      "@bot",
      undefined,
      (code) => { claimed.push(code); return true; },
    );

    expect(claimed).toEqual(["CODE-LIVE"]);
    expect(result.success?.code).toBe("CODE-LIVE");
    expect(handlers).toEqual([]);
  });
});
