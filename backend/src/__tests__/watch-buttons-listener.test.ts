import { describe, expect, it, vi } from "vitest";
import { Api } from "telegram";

const { resolvePeerTarget } = vi.hoisted(() => ({
  resolvePeerTarget: vi.fn(),
}));

vi.mock("../tg/peerTarget", () => ({ resolvePeerTarget }));

import { runWatchButtons } from "../jobs/watchButtons";

function markupOf(...labels: string[]) {
  return new Api.ReplyInlineMarkup({
    rows: [
      new Api.KeyboardButtonRow({
        buttons: labels.map((text) => new Api.KeyboardButtonCallback({
          text,
          data: Buffer.from(text),
        })),
      }),
    ],
  });
}

describe("watch_buttons listener lifecycle", () => {
  it("removes only its handlers when the watch is cancelled", async () => {
    const controller = new AbortController();
    const unrelatedBuilder = {};
    const unrelatedCallback = vi.fn();
    const eventBuilders: Array<[unknown, unknown]> = [[unrelatedBuilder, unrelatedCallback]];
    const client = {
      addEventHandler(callback: unknown, event: unknown) {
        eventBuilders.push([event, callback]);
      },
      removeEventHandler(callback: unknown, event: unknown) {
        eventBuilders.splice(
          0,
          eventBuilders.length,
          ...eventBuilders.filter(([builder, handler]) => builder !== event && handler !== callback),
        );
      },
      getMessages: vi.fn(async () => []),
    } as any;
    resolvePeerTarget.mockResolvedValue(new Api.PeerChannel({ channelId: 42n as any }));

    const running = runWatchButtons(
      client,
      { groupId: "c42", button: "领取", maxWaitMs: 60_000 },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await expect(running).rejects.toThrow("Job cancelled");

    expect(eventBuilders).toEqual([[unrelatedBuilder, unrelatedCallback]]);
  });

  it("keeps processing clicks while a callback hook is still pending", async () => {
    const controller = new AbortController();
    const group = new Api.PeerChannel({ channelId: 42n as any });
    const now = Math.floor(Date.now() / 1000);
    const messages = [1, 2].map((id) => ({
      id,
      out: false,
      date: now,
      peerId: group,
      replyMarkup: markupOf("领取"),
      message: "",
    }));
    const callbacks: Array<(event: unknown) => void> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = {
      addEventHandler(callback: (event: unknown) => void) {
        callbacks.push(callback);
      },
      removeEventHandler: vi.fn(),
      getInputEntity: vi.fn(async () => ({})),
      getMessages: vi.fn(async (_peer: unknown, options: { ids?: number[]; limit?: number }) => {
        if (options.ids?.length) return messages.filter((message) => options.ids!.includes(message.id));
        return messages;
      }),
      invoke: vi.fn(async () => ({ message: "ok" })),
    } as any;
    resolvePeerTarget.mockResolvedValue(group);
    const seen: number[] = [];
    const running = runWatchButtons(
      client,
      { groupId: "c42", button: "领取", maxWaitMs: 60_000 },
      controller.signal,
      async (click) => {
        seen.push(click.message.id);
        await gate;
      },
    );

    await vi.waitFor(() => expect(new Set(seen)).toEqual(new Set([1, 2])));
    release();
    controller.abort();
    await expect(running).rejects.toThrow("Job cancelled");
  });

  it("reconnects before seeding when the long-lived client is disconnected", async () => {
    const controller = new AbortController();
    const group = new Api.PeerChannel({ channelId: 42n as any });
    const connect = vi.fn(async () => {
      client.connected = true;
    });
    const client = {
      connected: false,
      connect,
      addEventHandler: vi.fn(),
      removeEventHandler: vi.fn(),
      getMessages: vi.fn(async () => []),
    } as any;
    resolvePeerTarget.mockResolvedValue(group);
    const running = runWatchButtons(
      client,
      { groupId: "c42", button: "领取", maxWaitMs: 60_000 },
      controller.signal,
    );
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(running).rejects.toThrow("Job cancelled");
  });
});
