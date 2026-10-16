import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let testDb!: Database.Database;
vi.mock("../db/database", () => ({ get db() { return testDb; } }));
import router from "../routes/warehouse";

function handler(method: string, path: string) {
  const layer = (router as any).stack.find((item: any) => item.route?.path === path && item.route.methods[method]);
  if (!layer) throw new Error(`Missing route ${method} ${path}`);
  return layer.route.stack[0].handle;
}
function call(method: string, path: string, req: any) {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  const result = handler(method, path)(req, res);
  return { res, result };
}
beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
});
afterEach(() => testDb.close());
describe("warehouse HTTP contracts", () => {
  it("uses normal REST status codes and validates route ids", () => {
    const created = call("post", "/folders", { body: { name: "Codes", parentId: null } });
    expect(created.res.statusCode).toBe(201);
    expect(created.res.body).toMatchObject({ name: "Codes" });
    const list = call("get", "/folders", {});
    expect(list.res.body).toHaveLength(1);
    const bad = call("get", "/folders/:id/records", { params: { id: "nope" }, query: {} });
    expect(bad.res.statusCode).toBe(400);
    expect(bad.res.body.error).toMatch(/id/i);
  });
  it("does not return internal errors or permit malformed query values", () => {
    const badQuery = call("get", "/export", { query: { includeSensitive: "yes" } });
    expect(badQuery.res.statusCode).toBe(400);
    expect(badQuery.res.body).toEqual({ error: "Invalid includeSensitive option" });
    const badBody = call("post", "/folders", { body: { name: { toString: () => "bad" } } });
    expect(badBody.res.statusCode).toBe(400);
    expect(badBody.res.body).not.toHaveProperty("stack");
  });
});
