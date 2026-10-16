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

import { describe, it, expect, vi } from "vitest";
import { Api, type TelegramClient } from "telegram";
import { buttonMatches, findPinnedButtonMessage } from "../jobs/checkin";

/** Builds a ReplyInlineMarkup holding the given button labels. */
function markupOf(...labels: string[]) {
  return new Api.ReplyInlineMarkup({
    rows: [
      new Api.KeyboardButtonRow({
        buttons: labels.map(
          (text) => new Api.KeyboardButtonCallback({ text, data: Buffer.from(text) }),
        ),
      }),
    ],
  });
}

function fakeClient(messages: unknown[] | (() => Promise<unknown[]>)) {
  const getMessages = vi.fn(
    typeof messages === "function" ? messages : async () => messages,
  );
  return { client: { getMessages } as unknown as TelegramClient, getMessages };
}

const pinned = (label: string, withMarkup = true) => ({
  id: 1,
  pinned: true,
  replyMarkup: withMarkup ? markupOf(label) : undefined,
});

describe("buttonMatches", () => {
  it("matches exactly when asked to", () => {
    expect(buttonMatches({ text: "签到" }, "签到", true)).toBe(true);
    expect(buttonMatches({ text: "每日签到" }, "签到", true)).toBe(false);
  });

  it("matches on a substring when asked to", () => {
    expect(buttonMatches({ text: "每日签到" }, "签到", false)).toBe(true);
    expect(buttonMatches({ text: "Check In" }, "签到", false)).toBe(false);
  });

  it("rejects a missing or empty label", () => {
    expect(buttonMatches(undefined, "签到", false)).toBe(false);
    expect(buttonMatches({}, "签到", false)).toBe(false);
    expect(buttonMatches({ text: "" }, "", true)).toBe(false);
  });
});

describe("findPinnedButtonMessage", () => {
  it("returns the pinned message whose button matches", async () => {
    const { client } = fakeClient([
      { id: 1, pinned: false, replyMarkup: markupOf("签到") },
      pinned("签到"),
    ]);

    const hit = await findPinnedButtonMessage(client, "SomeBot", "签到", false);

    expect(hit?.msg.id).toBe(1);
    expect(hit?.rows).toHaveLength(1);
  });

  it("returns a pinned menu when the caller has no target text yet", async () => {
    // This is the path used when the reply has no inline markup and the job
    // uses {anyBtn} or {aiBtn}; the target is resolved from these rows later.
    const { client } = fakeClient([pinned("签到")]);

    const hit = await findPinnedButtonMessage(client, "SomeBot", "", true);

    expect(hit?.msg.id).toBe(1);
    expect(hit?.rows[0].buttons[0]).toMatchObject({ text: "签到" });
  });

  it("ignores unpinned messages even when they carry the button", async () => {
    const { client } = fakeClient([
      { id: 7, pinned: false, replyMarkup: markupOf("签到") },
    ]);

    expect(await findPinnedButtonMessage(client, "SomeBot", "签到", false)).toBeUndefined();
  });

  it("ignores a pinned message without the button", async () => {
    const { client } = fakeClient([pinned("提现")]);

    expect(await findPinnedButtonMessage(client, "SomeBot", "签到", false)).toBeUndefined();
  });

  it("ignores a pinned message that has no buttons at all", async () => {
    const { client } = fakeClient([pinned("签到", false)]);

    expect(await findPinnedButtonMessage(client, "SomeBot", "签到", false)).toBeUndefined();
  });

  it("respects exact-match mode", async () => {
    const { client } = fakeClient([pinned("每日签到")]);

    expect(await findPinnedButtonMessage(client, "SomeBot", "签到", true)).toBeUndefined();
    expect(await findPinnedButtonMessage(client, "SomeBot", "签到", false)).toBeDefined();
  });

  it("never fails the run when the lookup itself throws", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("FLOOD_WAIT_30");
    });

    await expect(
      findPinnedButtonMessage(client, "SomeBot", "签到", false),
    ).resolves.toBeUndefined();
  });

  it("returns nothing when the job is already cancelled", async () => {
    const { client, getMessages } = fakeClient([pinned("签到")]);
    const controller = new AbortController();
    controller.abort();

    expect(
      await findPinnedButtonMessage(client, "SomeBot", "签到", false, controller.signal),
    ).toBeUndefined();
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("picks the first matching pinned message when several are pinned", async () => {
    const { client } = fakeClient([
      { id: 1, pinned: true, replyMarkup: markupOf("提现") },
      { id: 2, pinned: true, replyMarkup: markupOf("每日签到") },
    ]);

    expect((await findPinnedButtonMessage(client, "SomeBot", "签到", false))?.msg.id).toBe(2);
  });
});
