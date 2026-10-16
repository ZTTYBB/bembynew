import { beforeEach, describe, expect, it, vi } from "vitest";

const { client, setAccountTag } = vi.hoisted(() => ({
  client: {
    connect: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ id: 10, date: 1 }),
    getPeerId: vi.fn().mockResolvedValue("123"),
    getMessages: vi.fn().mockResolvedValue([]),
    addEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
  },
  setAccountTag: vi.fn(),
}));

vi.mock("telegram", async (importOriginal) => ({
  ...await importOriginal<typeof import("telegram")>(),
  TelegramClient: vi.fn(() => client),
}));
vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));
vi.mock("../db/accountAttributes", () => ({ setAccountTag }));
vi.mock("../jobs/checkin", () => ({
  hasAiInput: () => false,
  expandCommand: (value: string) => value,
  parseMessages: vi.fn().mockResolvedValue({ html: "", images: [], hasMedia: false, buttons: [] }),
}));

import { CustomJobError, runCustom } from "../jobs/custom";
import type { CustomConfig } from "../types";

function run(config: CustomConfig, accountId?: number) {
  return runCustom(1, "hash", "", "bot", config, undefined, undefined, undefined, undefined, undefined, accountId);
}

beforeEach(() => {
  vi.clearAllMocks();
  client.addEventHandler.mockImplementation((handler, event) => {
    if (event.constructor.name === "NewMessage") {
      queueMicrotask(() => handler({ message: { id: 11, message: "Points: 12,345" } }));
    }
  });
});

describe("runCustom save_tag", () => {
  it("writes a direct value to the linked account and records a step", async () => {
    const log = await run({ actions: [{ type: "save_tag", name: "status", value: "ready" }] }, 7);
    expect(setAccountTag).toHaveBeenCalledWith(7, "status", "ready");
    expect(log.steps[0]).toMatchObject({ actionType: "save_tag", result: 'Saved "status": ready' });
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("extracts from the latest reply batch, including after a delay", async () => {
    await run({
      actions: [
        { type: "send_command", content: "/balance" },
        { type: "wait_reply", maxWaitMs: 5000, successContains: "Points" },
        { type: "delay", waitMs: 1 },
        { type: "save_tag", name: "points", regex: "Points:\\s*([\\d,]+)" },
      ],
    }, 7);
    expect(setAccountTag).toHaveBeenCalledWith(7, "points", "12,345");
  });

  it("refuses to save without an account link", async () => {
    await expect(run({ actions: [{ type: "save_tag", name: "status", value: "ready" }] }))
      .rejects.toThrow("account-linked");
    expect(setAccountTag).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("does not reuse an earlier reply after a new command is sent", async () => {
    await expect(run({
      actions: [
        { type: "send_command", content: "/balance" },
        { type: "wait_reply", maxWaitMs: 5000, successContains: "Points" },
        { type: "send_command", content: "/new" },
        { type: "save_tag", name: "points", regex: "\\d+" },
      ],
    }, 7)).rejects.toThrow("did not match the latest reply");
    expect(setAccountTag).not.toHaveBeenCalled();
  });

  it("does not write a fallback value when the regex does not match", async () => {
    await expect(run({
      actions: [{ type: "save_tag", name: "points", value: "old", regex: "\\d+" }],
    }, 7)).rejects.toBeInstanceOf(CustomJobError);
    expect(setAccountTag).not.toHaveBeenCalled();
  });
});
