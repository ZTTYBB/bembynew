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
import { waitForBotReply, matchesDirectCheckinText, DIRECT_CHECKIN_SUCCESS_RE } from "../jobs/checkin";

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

describe("waitForBotReply ReplyKeyboardMarkup & earlyTextMatch", () => {
  it("ignores ReplyKeyboardMarkup until ReplyInlineMarkup arrives", async () => {
    vi.useFakeTimers();
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 10_000, undefined, BOT_PEER_ID);

    // Simulates Msg 1 from 天启开户: "✅ 正在签到,请稍后..." with a persistent reply keyboard
    emit({
      id: 10,
      peerId: new Api.PeerUser({ userId: BOT_PEER_ID as unknown as never }),
      message: "✅ 正在签到,请稍后...",
      replyMarkup: new Api.ReplyKeyboardMarkup({ rows: [] }),
    });
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Msg 2 arrives 1s later with the real inline markup + result
    await vi.advanceTimersByTimeAsync(1_000);
    emit({
      id: 11,
      peerId: new Api.PeerUser({ userId: BOT_PEER_ID as unknown as never }),
      message: "🎉签到成功🎉\n您已经获得 1 积分。",
      replyMarkup: new Api.ReplyInlineMarkup({ rows: [] }),
    });

    const msgs = await p;
    expect(msgs).toHaveLength(2);
    expect((msgs[1] as { message?: string }).message).toContain("签到成功");
  });

  it("resolves via earlyTextMatch after settle delay when no inline buttons arrive", async () => {
    vi.useFakeTimers();
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 40_000, undefined, BOT_PEER_ID, {
      earlyTextMatch: (m) =>
        matchesDirectCheckinText((m as { message?: string }).message || "", {
          successContains: "成功",
        }) !== null,
      earlySettleMs: 1_500,
    });

    // Non-matching progress text should not start early settle
    emit({
      id: 20,
      peerId: new Api.PeerUser({ userId: BOT_PEER_ID as unknown as never }),
      message: "正在查询...",
    });
    await vi.advanceTimersByTimeAsync(2_000);

    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Matching command-only reply resolves 1500ms later without waiting 40s
    emit({
      id: 21,
      peerId: new Api.PeerUser({ userId: BOT_PEER_ID as unknown as never }),
      message: "🎉 出席率 成功！",
    });
    await vi.advanceTimersByTimeAsync(1_501);

    const msgs = await p;
    expect(msgs).toHaveLength(2);
    expect(settled).toBe(true);
  });

  it("short-circuits immediately if an inline button arrives during earlySettleMs", async () => {
    vi.useFakeTimers();
    const { client, emit } = fakeClient();
    const p = waitForBotReply(client, "SomeBot", 40_000, undefined, BOT_PEER_ID, {
      earlyTextMatch: (m) =>
        matchesDirectCheckinText((m as { message?: string }).message || "") !== null,
      earlySettleMs: 1_500,
    });

    emit({
      id: 30,
      peerId: new Api.PeerUser({ userId: BOT_PEER_ID as unknown as never }),
      message: "🎉签到成功🎉",
    });
    await vi.advanceTimersByTimeAsync(300);
    emit({
      id: 31,
      peerId: new Api.PeerUser({ userId: BOT_PEER_ID as unknown as never }),
      message: "赞助广告",
      replyMarkup: new Api.ReplyInlineMarkup({ rows: [] }),
    });

    const msgs = await p;
    expect(msgs).toHaveLength(2);
  });
});

describe("matchesDirectCheckinText", () => {
  it("recognizes command-only success phrases and custom successContains", () => {
    expect(DIRECT_CHECKIN_SUCCESS_RE.test("🎉签到成功🎉\n您已经获得 1 积分。")).toBe(true);
    expect(DIRECT_CHECKIN_SUCCESS_RE.test("签到成功！此次签到获得积分:7")).toBe(true);
    expect(DIRECT_CHECKIN_SUCCESS_RE.test("🎉 出席率 成功！")).toBe(true);
    expect(matchesDirectCheckinText("🎉签到成功🎉\n您已经获得 1 积分。", {})).toBe("direct_success");
    expect(matchesDirectCheckinText("🎉 出席率 成功！", { successContains: "成功" })).toBe("success_contains");
    expect(matchesDirectCheckinText("✅ 正在签到,请稍后...", {})).toBeNull();
  });

  it("guards against negative phrases, failContains, and cfChallenge", () => {
    expect(matchesDirectCheckinText("未签到成功，请点击下方签到按钮", {})).toBeNull();
    expect(matchesDirectCheckinText("签到失败：未加入频道", { failContains: "失败" })).toBe("fail");
    expect(matchesDirectCheckinText("今天已经签到过了", { cfChallenge: true })).toBe("already");
    expect(matchesDirectCheckinText("🎉签到成功🎉", { cfChallenge: true, successContains: "成功" })).toBeNull();
  });
});
