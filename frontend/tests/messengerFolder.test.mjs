import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMessengerFolderSelection,
  readMessengerFolder,
  restoreMessengerFolder,
  writeMessengerFolder,
} from "../src/utils/messengerFolder.ts";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

test("reads and writes folder selections per account", () => {
  const store = storage();
  writeMessengerFolder(store, "folders", 7, 12);
  writeMessengerFolder(store, "folders", 8, "all");
  assert.equal(readMessengerFolder(store, "folders", 7), 12);
  assert.equal(readMessengerFolder(store, "folders", 8), "all");
  assert.equal(readMessengerFolder(store, "folders", 9), "all");
});

test("invalid persisted values fall back to all", () => {
  const store = storage({ folders: JSON.stringify({ "7": "not-a-folder", "8": -1, "9": 3.5 }) });
  assert.equal(readMessengerFolder(store, "folders", 7), "all");
  assert.equal(readMessengerFolder(store, "folders", 8), "all");
  assert.equal(readMessengerFolder(store, "folders", 9), "all");
  assert.equal(parseMessengerFolderSelection("42"), 42);
  assert.equal(parseMessengerFolderSelection(0), "all");
});

test("does not restore a folder removed from Telegram", () => {
  assert.equal(restoreMessengerFolder(12, new Set([12, 14])), 12);
  assert.equal(restoreMessengerFolder(12, new Set([14])), "all");
  assert.equal(restoreMessengerFolder("all", new Set()), "all");
});
