// GET /logs query hardening: limit clamped to 200, offset floored at 0,
// jobId validated as a positive integer.

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("../jobs/cancellation", () => ({
  cancelJob: vi.fn(),
  isJobRunning: vi.fn().mockReturnValue(false),
  getLiveDetail: vi.fn().mockReturnValue(null),
}));

import { describe, it, expect, vi, beforeAll } from "vitest";
import Database from "better-sqlite3";
import logsRouter from "../routes/logs";
import { persistLogDetailScreenshots } from "../jobs/logShots";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL DEFAULT 'Job',
    job_type   TEXT NOT NULL DEFAULT 'checkin',
    account_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS job_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  INTEGER NOT NULL,
    ran_at  TEXT    NOT NULL,
    status  TEXT    NOT NULL,
    message TEXT,
    detail  TEXT,
    retired INTEGER NOT NULL DEFAULT 0
  );
`;

function routeHandler(method: string, path: string) {
  const layer = (logsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle as (req: any, res: any) => void;
}

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

function list(query: Record<string, string>) {
  const res = makeRes();
  routeHandler("get", "/")({ query }, res);
  return res;
}

function detail(id: number) {
  const res = makeRes();
  routeHandler("get", "/:id")({ params: { id: String(id) } }, res);
  return res;
}

function clearShots(id: number) {
  const res = makeRes();
  routeHandler("delete", "/:id/shots")({ params: { id: String(id) } }, res);
  return res;
}

beforeAll(() => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);
  const { lastInsertRowid: jobId } = testDb
    .prepare("INSERT INTO jobs (name) VALUES ('Job A')")
    .run();
  const insert = testDb.prepare(
    "INSERT INTO job_logs (job_id, ran_at, status) VALUES (?, ?, 'success')",
  );
  for (let i = 0; i < 250; i++) {
    insert.run(Number(jobId), `2024-06-01T00:${String(i % 60).padStart(2, "0")}:00Z`);
  }
});

describe("GET /logs query hardening", () => {
  it("defaults to 50 rows", () => {
    expect(list({}).body).toHaveLength(50);
  });

  it("clamps limit to 200", () => {
    expect(list({ limit: "999999" }).body).toHaveLength(200);
  });

  it("falls back to the default on a non-numeric limit", () => {
    expect(list({ limit: "abc" }).body).toHaveLength(50);
  });

  it("floors a negative offset to 0", () => {
    const res = list({ offset: "-5", limit: "10" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(10);
  });

  it("rejects a non-numeric jobId", () => {
    const res = list({ jobId: "abc" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid jobId");
  });

  it("rejects a non-positive jobId", () => {
    expect(list({ jobId: "0" }).statusCode).toBe(400);
    expect(list({ jobId: "-3" }).statusCode).toBe(400);
  });

  it("accepts a valid jobId", () => {
    const res = list({ jobId: "1", limit: "5" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(5);
    expect(res.body[0].jobId).toBe(1);
  });

  it("includes screenshot size fields and filtered totals in the paged shape", () => {
    const res = list({ page: "1", pageSize: "2" });
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ shotBytes: 0, shotCount: 0 });
    expect(res.body.screenshotBytesTotal).toBe(0);
    expect(res.body.screenshotFilesTotal).toBe(0);
  });
});

describe("GET /logs/:id detail parsing", () => {
  it("returns a diagnostic detail instead of throwing on malformed stored JSON", () => {
    const { lastInsertRowid } = testDb.prepare(
      "INSERT INTO job_logs (job_id, ran_at, status, detail) VALUES (1, ?, 'failed', ?)",
    ).run("2024-07-01T00:00:00Z", "{not-json");

    const res = detail(Number(lastInsertRowid));
    expect(res.statusCode).toBe(200);
    expect(res.body.detail).toEqual({ parseError: true });
  });

  it("clears screenshots without deleting the textual log", () => {
    const { lastInsertRowid } = testDb.prepare(
      "INSERT INTO job_logs (job_id, ran_at, status, detail) VALUES (1, ?, 'success', ?)",
    ).run("2024-08-01T00:00:00Z", JSON.stringify({ message: "keep me" }));
    const res = clearShots(Number(lastInsertRowid));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ removedFiles: 0, removedBytes: 0, removedReferences: 0 });
    expect((testDb.prepare("SELECT detail FROM job_logs WHERE id = ?").get(Number(lastInsertRowid)) as any).detail)
      .toBe(JSON.stringify({ message: "keep me" }));
  });

  it("does not delete files when the detail compare-and-swap loses a race", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bemby-log-clear-race-"));
    const previousDbPath = process.env.DB_PATH;
    process.env.DB_PATH = path.join(tempRoot, "bemby.db");
    const realDb = testDb;
    try {
      const { lastInsertRowid } = realDb.prepare(
        "INSERT INTO job_logs (job_id, ran_at, status, detail) VALUES (1, ?, 'success', NULL)",
      ).run("2024-09-01T00:00:00Z");
      const id = Number(lastInsertRowid);
      const stored = persistLogDetailScreenshots({
        screenshot: `data:image/jpeg;base64,${Buffer.from("old-shot").toString("base64")}`,
      }, id);
      realDb.prepare("UPDATE job_logs SET detail = ? WHERE id = ?")
        .run(JSON.stringify(stored), id);
      const shotPath = path.join(tempRoot, "run-shots", String(id), "shot-000000.jpg");
      expect(fs.existsSync(shotPath)).toBe(true);

      const newer = JSON.stringify({
        screenshot: `/api/logs/${id}/shots/shot-000001.jpg`,
      });
      testDb = {
        prepare(sql: string) {
          if (sql.startsWith("UPDATE job_logs SET detail")) {
            realDb.prepare("UPDATE job_logs SET detail = ? WHERE id = ?").run(newer, id);
            return { run: () => ({ changes: 0 }) };
          }
          return realDb.prepare(sql);
        },
      } as any;

      const res = clearShots(id);
      expect(res.statusCode).toBe(409);
      expect(fs.existsSync(shotPath)).toBe(true);
      expect((realDb.prepare("SELECT detail FROM job_logs WHERE id = ?").get(id) as any).detail)
        .toBe(newer);
    } finally {
      testDb = realDb;
      if (previousDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = previousDbPath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
