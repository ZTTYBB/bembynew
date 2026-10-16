import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api } from "telegram";

const { client, records, setProcessed } = vi.hoisted(() => ({
  client: {
    connect: vi.fn().mockResolvedValue(undefined), destroy: vi.fn().mockResolvedValue(undefined),
    invoke: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ id: 10, date: 1, peerId: { channelId: { toString: () => "123" } } }),
    getPeerId: vi.fn().mockResolvedValue("123"), getMessages: vi.fn().mockResolvedValue([]),
    addEventHandler: vi.fn(), removeEventHandler: vi.fn(),
  },
  records: vi.fn(), setProcessed: vi.fn(),
}));
vi.mock("telegram", async (importOriginal) => ({ ...await importOriginal<typeof import("telegram")>(), TelegramClient: vi.fn(() => client) }));
vi.mock("../db/database", () => ({ db: {} }));
vi.mock("../db/accountAttributes", () => ({ setAccountTag: vi.fn() }));
vi.mock("../db/warehouse", () => ({ warehouse: { records, setProcessed }, warehouseId: (value: number) => value }));
vi.mock("../tg/peerTarget", () => ({ resolvePeerTarget: async (_client: unknown, value: string) => value }));
vi.mock("../jobs/checkin", () => ({
  hasAiInput: () => false, expandCommand: (value: string) => value.replace(/\{uuid\}/g, "generated-id"),
  parseMessages: vi.fn().mockResolvedValue({ html: "", images: [], hasMedia: false, buttons: [] }),
}));
import {
  extractVerificationChannelLinks,
  isReplyToMessage,
  leaveChatTarget,
  runCustom,
} from "../jobs/custom";
import type { CustomAction, CustomConfig } from "../types";
import { CONNECT_TIMEOUT_MS } from "../util/timeout";

const run = (actions: CustomAction[], extra: Partial<CustomConfig> = {}, signal?: AbortSignal) =>
  runCustom(1, "hash", "", "bot", { actions, ...extra }, signal);
beforeEach(() => { vi.clearAllMocks(); });

describe("recursive custom workflow", () => {
  it("extracts invite and public channel links from prompt text and entities", () => {
    const text = "Join https://t.me/news and the private channel";
    const message = {
      message: text,
      entities: [
        new Api.MessageEntityTextUrl({
          offset: 42,
          length: 14,
          url: "https://t.me/+secret_hash",
        }),
      ],
    } as any;
    expect(extractVerificationChannelLinks(message)).toEqual([
      { kind: "public", username: "news" },
      { kind: "invite", hash: "secret_hash" },
    ]);
  });

  it("recognises only a direct Telegram reply to the sent group message", () => {
    expect(
      isReplyToMessage(
        { replyTo: { replyToMsgId: 42 } } as any,
        42,
      ),
    ).toBe(true);
    expect(
      isReplyToMessage(
        { replyTo: { replyToMsgId: 41 } } as any,
        42,
      ),
    ).toBe(false);
    expect(isReplyToMessage({} as any, 0)).toBe(true);
  });

  it("treats an invite preview as already not subscribed when leaving", async () => {
    client.invoke.mockResolvedValueOnce(new Api.ChatInvitePeek({
      chat: new Api.ChatEmpty({ id: BigInt(1) as any }),
      expires: 0,
    }));
    await expect(
      leaveChatTarget(client as any, "https://t.me/+preview"),
    ).resolves.toBe(false);
    expect(client.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ hash: "preview" }),
    );
  });

  it("keeps placeholder-shaped variable values literal while expanding template built-ins", async () => {
    await run([
      { type: "set_variables", variables: [{ name: "copied", value: "prefix {literal}" }] },
      { type: "send_command", content: "{copied} {literal} {uuid}" },
      { type: "send_contact_message", contact: "@group", content: "{literal} {uuid}" },
    ], { variables: { literal: "{uuid}" } });
    expect(client.sendMessage.mock.calls.map((call) => call[1].message)).toEqual([
      "prefix {uuid} {uuid} generated-id", "{uuid} generated-id",
    ]);
  });

  it("removes delay cancellation listeners after each normal completion", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await run([{ type: "repeat", count: 12, actions: [{ type: "delay", waitMs: 0 }] }], {}, controller.signal);
    // The connection deadline also watches the job signal; the remaining listeners
    // are the twelve per-delay guards exercised by this test.
    expect(add).toHaveBeenCalledTimes(13);
    expect(remove).toHaveBeenCalledTimes(13);
    for (const [, listener] of add.mock.calls) {
      expect(remove.mock.calls.some((call) => call[1] === listener)).toBe(true);
    }
    add.mockRestore();
    remove.mockRestore();
  });

  it("cancels a pending delay and does not execute later actions", async () => {
    const controller = new AbortController();
    const pending = run([{ type: "delay", waitMs: 5000 }, { type: "send_command", content: "never" }], {}, controller.signal);
    const rejection = expect(pending).rejects.toThrow("Job cancelled");
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await rejection;
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("bounds a Telegram connection that never settles and still destroys the client", async () => {
    vi.useFakeTimers();
    client.connect.mockImplementationOnce(() => new Promise<void>(() => {}));
    const pending = run([], {});
    const assertion = expect(pending).rejects.toThrow("Telegram connect timed out (custom job)");
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    await assertion;
    expect(client.destroy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("shares variables across branches, loops and legacy actions in execution order", async () => {
    const log = await run([
      { type: "set_variables", variables: [{ name: "names", value: ["Alice", "Bob"] }] },
      { type: "for_each", source: "variable", variable: "names", actions: [
        { type: "if_check", condition: { left: "{item}", operator: "eq", right: "Alice" }, thenActions: [
          { type: "set_variables", variables: [{ name: "prefix", value: "Hello" }] },
        ], elseActions: [{ type: "set_variables", variables: [{ name: "prefix", value: "Bye" }] }] },
        { type: "send_command", content: "{prefix} {item} #{loop_index}" },
      ] },
    ]);
    expect(client.sendMessage.mock.calls.map((call) => call[1].message)).toEqual(["Hello Alice #1", "Bye Bob #2"]);
    expect(log.steps.map((step) => step.path)).toContain("2[2].2");
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("restores shadowed loop variables but retains assignments made in the body", async () => {
    await run([
      { type: "repeat", count: 2, actions: [
        { type: "set_variables", variables: [{ name: "last", value: "{loop_index}" }] },
      ] },
      { type: "send_command", content: "{loop_index} {last}" },
    ], { variables: { loop_index: "outer" } });
    expect(client.sendMessage).toHaveBeenLastCalledWith("bot", { message: "outer 2" });
  });

  it("finish success ends the whole workflow and finish failed is not retried", async () => {
    const log = await run([
      { type: "repeat", count: 3, actions: [{ type: "finish", status: "success", message: "Enough" }] },
      { type: "send_command", content: "never" },
    ], { maxRetries: 3 });
    expect(log.steps.at(-1)).toMatchObject({ actionType: "finish", result: "Enough" });
    expect(client.sendMessage).not.toHaveBeenCalled();
    await expect(run([{ type: "finish", status: "failed", message: "Stop" }], { maxRetries: 3 })).rejects.toThrow("Stop");
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it("can end the whole workflow when an account is already in a group", async () => {
    client.invoke.mockRejectedValueOnce(new Error("ALREADY_PARTICIPANT"));
    const log = await run([
      { type: "join_group", groupId: "https://t.me/+invite", alreadyMemberEndsTask: true },
      { type: "send_command", content: "never" },
    ]);

    expect(log.steps).toHaveLength(1);
    expect(log.steps[0]).toMatchObject({
      actionType: "join_group",
      result: "Already a member",
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("does not continue a branch or mark a warehouse record processed after failure", async () => {
    records.mockReturnValue([{ id: 5, data: { code: "ABC" } }]);
    client.sendMessage.mockRejectedValueOnce(new Error("bot refused"));
    await expect(run([
      { type: "for_each", source: "warehouse", folderId: 1, markProcessed: true, actions: [
        { type: "send_command", content: "{item.code}" },
        { type: "send_command", content: "never" },
      ] },
      { type: "send_command", content: "also never" },
    ])).rejects.toThrow("bot refused");
    expect(client.sendMessage).toHaveBeenCalledOnce();
    expect(setProcessed).not.toHaveBeenCalled();
  });

  it("marks warehouse records only after successful body completion", async () => {
    records.mockReturnValue([{ id: 5, data: { code: "ABC" } }, { id: 6, data: { code: "DEF" } }]);
    await run([{ type: "for_each", source: "warehouse", folderId: 1, markProcessed: true, actions: [
      { type: "send_command", content: "{item.code}" },
    ] }]);
    expect(setProcessed.mock.calls).toEqual([[5, true], [6, true]]);
  });

  it("can skip a failed warehouse item and continue with later items", async () => {
    records.mockReturnValue([{ id: 5, data: { code: "ABC" } }, { id: 6, data: { code: "DEF" } }]);
    client.sendMessage.mockRejectedValueOnce(new Error("first item refused"));
    const log = await run([{ type: "for_each", source: "warehouse", folderId: 1, markProcessed: true, onError: "continue", actions: [
      { type: "send_command", content: "{item.code}" },
    ] }]);
    expect(client.sendMessage.mock.calls.map((call) => call[1].message)).toEqual(["ABC", "DEF"]);
    expect(setProcessed.mock.calls).toEqual([[6, true]]);
    expect([...log.steps].reverse().find((step) => step.actionType === "for_each")?.result)
      .toContain("skipped 1");
  });

  it("does not mark the current warehouse record when finish terminates its body", async () => {
    records.mockReturnValue([{ id: 5, data: { code: "ABC" } }]);
    await run([{ type: "for_each", source: "warehouse", folderId: 1, markProcessed: true, actions: [
      { type: "finish", status: "success" },
    ] }]);
    expect(setProcessed).not.toHaveBeenCalled();
  });

  it("refuses overlapping loop bindings and system variables before executing the body", async () => {
    await expect(run([{ type: "for_each", source: "variable", variable: "items", itemVariable: "value", indexVariable: "value", actions: [] }], { variables: { items: [1] } })).rejects.toThrow("different names");
    await expect(run([{ type: "repeat", count: 1, indexVariable: "reply_text", actions: [] }])).rejects.toThrow("reserved");
  });

  it("rejects oversize loops and a shared nested step budget", async () => {
    await expect(run([{ type: "repeat", count: 501, actions: [] }])).rejects.toThrow("Iteration");
    await expect(run([{ type: "repeat", count: 500, actions: [
      { type: "repeat", count: 500, actions: [] },
    ] }])).rejects.toThrow("budget");
  });

  it("cancellation stops a live loop without later actions", async () => {
    const controller = new AbortController();
    client.sendMessage.mockImplementationOnce(async () => { controller.abort(); return { id: 1, date: 1 } as any; });
    await expect(run([{ type: "repeat", count: 3, actions: [{ type: "send_command", content: "once" }] }], {}, controller.signal)).rejects.toThrow("Job cancelled");
    expect(client.sendMessage).toHaveBeenCalledOnce();
  });

  it("saves a real channel message link into a reusable variable", async () => {
    await run([
      { type: "send_contact_message", contact: "@group", content: "hello" },
      { type: "save_message_link", variable: "message_link" },
      { type: "send_command", content: "{message_link}" },
    ]);
    expect(client.sendMessage).toHaveBeenLastCalledWith("bot", { message: "https://t.me/c/123/10" });
  });

  it("uses the latest sent contact message instead of an older cached bot reply", async () => {
    client.getMessages.mockResolvedValueOnce([{ id: 11, message: "ready", out: false, peerId: { userId: 1 } }] as any);
    await run([
      { type: "send_command", content: "/start" },
      { type: "wait_reply", maxWaitMs: 100, successContains: "ready" },
      { type: "send_contact_message", contact: "@group", content: "hello" },
      { type: "save_message_link", variable: "message_link" },
      { type: "send_command", content: "{message_link}" },
    ]);
    expect(client.sendMessage).toHaveBeenLastCalledWith("bot", { message: "https://t.me/c/123/10" });
  });

  it("uses a newer received channel message rather than the previous sent message", async () => {
    client.getMessages.mockResolvedValueOnce([{ id: 11, message: "ready", out: false, peerId: { channelId: { toString: () => "456" } } }] as any);
    await run([
      { type: "send_command", content: "/start" },
      { type: "wait_reply", maxWaitMs: 100, successContains: "ready" },
      { type: "save_message_link", variable: "message_link" },
      { type: "send_command", content: "{message_link}" },
    ]);
    expect(client.sendMessage).toHaveBeenLastCalledWith("bot", { message: "https://t.me/c/456/11" });
  });

  it("reports that private replies have no Telegram message links", async () => {
    client.getMessages.mockResolvedValueOnce([{ id: 11, message: "ready", out: false, peerId: { userId: 1 } }] as any);
    await expect(run([
      { type: "send_command", content: "/start" },
      { type: "wait_reply", maxWaitMs: 100, successContains: "ready" },
      { type: "save_message_link", variable: "message_link" },
    ])).rejects.toThrow("private chats");
  });
});
