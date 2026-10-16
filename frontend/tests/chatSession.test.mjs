import { test } from "node:test";
import assert from "node:assert/strict";
import { isChatSessionCurrent } from "../src/utils/chatSession.ts";

const session = { accountId: 7, chatId: "chat-a", generation: 3 };

test("accepts the exact account, chat, and generation", () => {
  assert.equal(isChatSessionCurrent(session, { ...session }), true);
});

test("rejects stale account, chat, or generation", () => {
  assert.equal(
    isChatSessionCurrent(session, { ...session, accountId: 8 }),
    false,
  );
  assert.equal(
    isChatSessionCurrent(session, { ...session, chatId: "chat-b" }),
    false,
  );
  assert.equal(
    isChatSessionCurrent(session, { ...session, generation: 4 }),
    false,
  );
});
