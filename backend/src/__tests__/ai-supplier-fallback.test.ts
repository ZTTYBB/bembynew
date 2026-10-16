// The same model id can exist under multiple suppliers (e.g. two accounts of
// the same provider). Credential resolution must prefer a supplier with a key,
// and fallback must try the other supplier's copy rather than skipping it.

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { callAI, recognizeCaptchaWithAI } from "../jobs/checkin";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_suppliers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    base_url   TEXT    NOT NULL,
    api_key    TEXT    NOT NULL DEFAULT '',
    timeout_ms INTEGER NOT NULL DEFAULT 25000
  );
  CREATE TABLE IF NOT EXISTS ai_models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES ai_suppliers(id) ON DELETE CASCADE,
    model_id    TEXT    NOT NULL,
    label       TEXT
  );
`;

const MODEL = "some/vision-model";
const IMG = "data:image/png;base64,abc";

function insertSupplier(name: string, apiKey: string, modelIds: string[]): number {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO ai_suppliers (name, base_url, api_key) VALUES (?, ?, ?)")
    .run(name, `https://api.${name.replace(/\s+/g, "")}.test/v1`, apiKey);
  const supplierId = Number(lastInsertRowid);
  for (const m of modelIds) {
    testDb.prepare("INSERT INTO ai_models (supplier_id, model_id) VALUES (?, ?)").run(supplierId, m);
  }
  return supplierId;
}

function modelRowId(supplierId: number): number {
  return (testDb
    .prepare("SELECT id FROM ai_models WHERE supplier_id = ?")
    .get(supplierId) as { id: number }).id;
}

function setSetting(key: string, value: string) {
  testDb
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

function aiResponse(text: string, finishReason = "stop") {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text }, finish_reason: finishReason }] }),
    { status: 200 },
  );
}

const fetchMock = vi.fn<typeof fetch>();

function authKeyOfCall(call: number): string | undefined {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string>)?.Authorization?.replace("Bearer ", "");
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);
  vi.stubGlobal("fetch", fetchMock);
});

beforeEach(() => {
  fetchMock.mockReset();
  testDb.exec("DELETE FROM ai_models; DELETE FROM ai_suppliers; DELETE FROM settings;");
  setSetting("ai_model", MODEL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", fetchMock);
});

describe("credential resolution with duplicate model ids", () => {
  it("prefers a supplier with a non-empty key over an earlier keyless one", async () => {
    insertSupplier("vercel", "", [MODEL]);
    insertSupplier("vercel 2", "key-2", [MODEL]);
    fetchMock.mockResolvedValueOnce(aiResponse("ok"));

    await callAI([IMG], "prompt");

    expect(authKeyOfCall(0)).toBe("key-2");
  });
});

describe("pinned default model (ai_default_model_id)", () => {
  it("uses the pinned supplier's key even when an earlier supplier has one", async () => {
    insertSupplier("vercel", "key-1", [MODEL]);
    const supplier2 = insertSupplier("vercel 2", "key-2", [MODEL]);
    setSetting("ai_default_model_id", String(modelRowId(supplier2)));
    fetchMock.mockResolvedValueOnce(aiResponse("ok"));

    await callAI([IMG], "prompt");

    expect(authKeyOfCall(0)).toBe("key-2");
  });

  it("makes the pinned account primary and the other the fallback", async () => {
    insertSupplier("vercel", "key-1", [MODEL]);
    const supplier2 = insertSupplier("vercel 2", "key-2", [MODEL]);
    setSetting("ai_default_model_id", String(modelRowId(supplier2)));
    fetchMock
      .mockResolvedValueOnce(new Response("quota exceeded", { status: 429 }))
      .mockResolvedValueOnce(aiResponse("ABCD"));

    const result = await recognizeCaptchaWithAI([IMG]);

    expect(result.text).toBe("ABCD");
    expect(authKeyOfCall(0)).toBe("key-2");
    expect(authKeyOfCall(1)).toBe("key-1");
  });

  it("falls back to model-string resolution when the pinned row is gone", async () => {
    insertSupplier("vercel", "key-1", [MODEL]);
    setSetting("ai_default_model_id", "9999");
    fetchMock.mockResolvedValueOnce(aiResponse("ok"));

    await callAI([IMG], "prompt");

    expect(authKeyOfCall(0)).toBe("key-1");
  });

  it("ignores the pin when an explicit model override is given", async () => {
    const supplier1 = insertSupplier("vercel", "key-1", [MODEL]);
    insertSupplier("other", "key-other", ["other/model"]);
    setSetting("ai_default_model_id", String(modelRowId(supplier1)));
    fetchMock.mockResolvedValueOnce(aiResponse("ok"));

    await callAI([IMG], "prompt", 200, "other/model");

    expect(authKeyOfCall(0)).toBe("key-other");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe("other/model");
  });
});

describe("reasoning-model responses", () => {
  it("strips inline <think> chain-of-thought from the answer", async () => {
    insertSupplier("deepseek", "key-1", [MODEL]);
    fetchMock.mockResolvedValueOnce(aiResponse("<think>the code reads 1 2 3 4</think>1234"));

    const result = await recognizeCaptchaWithAI([IMG]);

    expect(result.text).toBe("1234");
  });

  it("gives a clear error when the token budget is exhausted before an answer", async () => {
    insertSupplier("deepseek", "key-1", [MODEL]);
    setSetting("ai_fallback_enabled", "false");
    fetchMock.mockResolvedValue(aiResponse("<think>still reasoning", "length"));

    await expect(recognizeCaptchaWithAI([IMG])).rejects.toThrow(/finish_reason=length/);
  });

  it("sends a generous token budget so reasoning models can answer", async () => {
    insertSupplier("deepseek", "key-1", [MODEL]);
    fetchMock.mockResolvedValueOnce(aiResponse("ABCD"));

    await recognizeCaptchaWithAI([IMG]);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.max_tokens).toBeGreaterThanOrEqual(1000);
  });
});

describe("fallback across suppliers sharing a model id", () => {
  it("tries the second supplier's copy of the same model when the first fails", async () => {
    insertSupplier("vercel", "key-1", [MODEL]);
    insertSupplier("vercel 2", "key-2", [MODEL]);
    fetchMock
      .mockResolvedValueOnce(new Response("quota exceeded", { status: 429 }))
      .mockResolvedValueOnce(aiResponse("ABCD"));

    const result = await recognizeCaptchaWithAI([IMG]);

    expect(result.text).toBe("ABCD");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authKeyOfCall(0)).toBe("key-1");
    expect(authKeyOfCall(1)).toBe("key-2");
  });

  it("does not retry identical credentials twice", async () => {
    insertSupplier("vercel", "key-1", [MODEL]);
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(recognizeCaptchaWithAI([IMG])).rejects.toThrow(/AI API error 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips other suppliers when fallback is disabled", async () => {
    insertSupplier("vercel", "key-1", [MODEL]);
    insertSupplier("vercel 2", "key-2", [MODEL]);
    setSetting("ai_fallback_enabled", "false");
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(recognizeCaptchaWithAI([IMG])).rejects.toThrow(/AI API error 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
