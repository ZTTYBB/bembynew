// vi.mock calls are hoisted before imports, preventing the DB from opening
vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));

import { describe, it, expect, vi, afterEach } from "vitest";
import { Api, type TelegramClient } from "telegram";
import { waitForBotReply } from "../jobs/checkin";

const BOT_PEER_ID = "12345";
const OTHER_PEER_ID = "99999";

/**
 * Stands in for a TelegramClient: captures the handler the function registers
 * so a test can drive it, and exposes `emit` to push a message through.
 */
function fakeClient() {
  let handler: ((event: unknown) => void) | undefined;
  const stub = {
    addEventHandler(h: (event: unknown) => void) {
      handler = h;
    },
    removeEventHandler() {
      handler = undefined;
    },
  };
  return {
    client: stub as unknown as TelegramClient,
    emit(message: unknown) {
      handler?.({ message });
    },
    get hasHandler() {
      return handler !== undefined;
    },
  };
}

function messageFrom(peerUserId: string, withButtons: boolean, date?: number) {
  return {
    id: 1,
    peerId: new Api.PeerUser({ userId: peerUserId as unknown as never }),
    ...(date !== undefined ? { date } : {}),
    ...(withButtons ? { replyMarkup: { rows: [] } } : {}),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForBotReply peer filtering", () => {
  it("ignores the same bot posting in another chat", async () => {
    vi.useFakeTimers();
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 10_000, undefined, BOT_PEER_ID);

    // The bot announcing something in a group carries a replyMarkup too, but it
    // is not this conversation -- it must not satisfy the wait.
    emit(messageFrom(OTHER_PEER_ID, true));
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit(messageFrom(BOT_PEER_ID, true));
    await expect(p).resolves.toHaveLength(1);
  });

  it("accepts a reply in the bot's own conversation", async () => {
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 10_000, undefined, BOT_PEER_ID);
    emit(messageFrom(BOT_PEER_ID, true));
    await expect(p).resolves.toHaveLength(1);
  });

  it("keeps waiting until a message with buttons arrives", async () => {
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 10_000, undefined, BOT_PEER_ID);

    emit(messageFrom(BOT_PEER_ID, false));
    emit(messageFrom(BOT_PEER_ID, false));
    emit(messageFrom(BOT_PEER_ID, true));

    const messages = await p;
    expect(messages).toHaveLength(3);
  });

  it("filters by sender only when no peer id is known", async () => {
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 10_000);
    // Without a peer id the old sender-only behaviour stands
    emit(messageFrom(OTHER_PEER_ID, true));
    await expect(p).resolves.toHaveLength(1);
  });

  it("does not collect unrelated traffic in the partial payload on timeout", async () => {
    vi.useFakeTimers();
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 5_000, undefined, BOT_PEER_ID);
    const assertion = p.then(
      () => null,
      (err: { partial: unknown[] }) => err,
    );

    emit(messageFrom(OTHER_PEER_ID, false));
    emit(messageFrom(OTHER_PEER_ID, false));
    await vi.advanceTimersByTimeAsync(5_001);

    const err = (await assertion) as { partial: unknown[] };
    expect(err.partial).toHaveLength(0);
  });
});

describe("waitForBotReply only accepts messages that arrive now", () => {
  it("ignores a stale delivery queued before the command went out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T08:00:00Z"));
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 10_000, undefined, BOT_PEER_ID);

    // A client that just connected can be handed updates queued while it was
    // offline. This one is ten minutes old and carries buttons, so without the
    // age check it would satisfy the wait as if it were the reply.
    emit(messageFrom(BOT_PEER_ID, true, Math.floor(Date.now() / 1000) - 600));
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit(messageFrom(BOT_PEER_ID, true, Math.floor(Date.now() / 1000)));
    await expect(p).resolves.toHaveLength(1);
  });

  it("accepts a message dated now", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T08:00:00Z"));
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 10_000, undefined, BOT_PEER_ID);

    emit(messageFrom(BOT_PEER_ID, true, Math.floor(Date.now() / 1000)));
    await expect(p).resolves.toHaveLength(1);
  });

  it("tolerates a small clock offset between us and Telegram", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T08:00:00Z"));
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 10_000, undefined, BOT_PEER_ID);

    // Dated marginally before our own clock -- a few seconds of skew must not
    // make us drop a genuine reply.
    emit(messageFrom(BOT_PEER_ID, true, Math.floor(Date.now() / 1000) - 2));
    await expect(p).resolves.toHaveLength(1);
  });

  it("stops collecting once the command is out, so the timeout payload stays empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T08:00:00Z"));
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 5_000, undefined, BOT_PEER_ID);
    const assertion = p.then(
      () => null,
      (err: { partial: unknown[] }) => err,
    );

    emit(messageFrom(BOT_PEER_ID, false, Math.floor(Date.now() / 1000) - 300));
    await vi.advanceTimersByTimeAsync(5_001);

    const err = (await assertion) as { partial: unknown[] };
    expect(err.partial).toHaveLength(0);
  });

  it("does not apply the age check when a message carries no date", async () => {
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 10_000, undefined, BOT_PEER_ID);

    emit(messageFrom(BOT_PEER_ID, true));
    await expect(p).resolves.toHaveLength(1);
  });
});
