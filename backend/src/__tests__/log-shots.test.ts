import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  persistLogDetailScreenshots,
  clearLogShotReferences,
  logShotStats,
  migrateInlineLogShots,
  removeLogShots,
  resolveLogShot,
  sweepOrphanedLogShots,
} from "../jobs/logShots";

const previousDbPath = process.env.DB_PATH;
let tempRoot = "";

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = "";
  if (previousDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = previousDbPath;
});

function setup(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bemby-run-shots-"));
  process.env.DB_PATH = path.join(tempRoot, "bemby.db");
  return tempRoot;
}

function dataImage(bytes: number, fill = 0x41): string {
  return `data:image/jpeg;base64,${Buffer.alloc(bytes, fill).toString("base64")}`;
}

describe("run-shots storage", () => {
  it("writes screenshots outside the detail and resolves a safe file", () => {
    setup();
    const detail = { steps: [{ screenshot: dataImage(12), outcome: "ok" }] };
    const stored = persistLogDetailScreenshots(detail, 7);
    expect(stored.steps[0].screenshot).toBe("/api/logs/7/shots/shot-000000.jpg");
    const shot = resolveLogShot(7, "shot-000000.jpg");
    expect(shot).toBeTruthy();
    expect(fs.readFileSync(shot!)).toHaveLength(12);
    // Windows does not expose POSIX mode bits even though the write is created
    // with a private mode on Unix.
  });

  it("deduplicates files while preserving references in every step", () => {
    setup();
    const same = dataImage(5);
    const stored = persistLogDetailScreenshots({ a: same, b: same }, 8);
    // The detail compactor keeps the newest occurrence before files are
    // written, so the final reference belongs to `b`.
    expect(stored.a).toBeUndefined();
    expect(stored.b).toBe("/api/logs/8/shots/shot-000000.jpg");
    expect(fs.readdirSync(path.join(tempRoot, "run-shots", "8"))).toEqual(["shot-000000.jpg"]);
  });

  it("rejects traversal and removes a run directory", () => {
    setup();
    persistLogDetailScreenshots({ screenshot: dataImage(2) }, 9);
    expect(resolveLogShot(9, "../9/shot-000000.jpg")).toBeUndefined();
    expect(resolveLogShot(9, "shot-000000.txt")).toBeUndefined();
    removeLogShots(9);
    expect(fs.existsSync(path.join(tempRoot, "run-shots", "9"))).toBe(false);
  });

  it("sweeps only numeric directories not represented by live logs", () => {
    setup();
    persistLogDetailScreenshots({ screenshot: dataImage(2) }, 10);
    persistLogDetailScreenshots({ screenshot: dataImage(2) }, 11);
    expect(sweepOrphanedLogShots(new Set([10]))).toBe(1);
    expect(fs.existsSync(path.join(tempRoot, "run-shots", "10"))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, "run-shots", "11"))).toBe(false);
  });

  it("does not create a directory when the budget removes every image", () => {
    setup();
    const detail = { screenshot: dataImage(20) };
    const stored = persistLogDetailScreenshots(detail, 12, { maxBytes: 0 });
    expect(stored.screenshot).toBeUndefined();
    expect(fs.existsSync(path.join(tempRoot, "run-shots", "12"))).toBe(false);
  });

  it("reports only retained screenshot files and clears their references", () => {
    setup();
    const stored = persistLogDetailScreenshots(
      { screenshot: dataImage(7), nested: ["keep", dataImage(3)] },
      15,
    );
    const stats = logShotStats(15);
    expect(stats).toEqual({ files: 2, bytes: 10 });
    const cleared = clearLogShotReferences(stored, 15);
    expect(cleared.removed).toBe(2);
    expect(cleared.detail).toEqual({ nested: ["keep"] });
  });

  it("migrates valid historical rows and leaves malformed details alone", () => {
    setup();
    const original = JSON.stringify({ screenshot: dataImage(4) });
    const updates: unknown[][] = [];
    const database = {
      prepare(sql: string) {
        if (sql.includes("SELECT id, detail")) {
          return { all: () => [
            { id: 13, detail: original },
            { id: 14, detail: "{broken" },
          ], run: () => ({ changes: 0 }) };
        }
        return {
          all: () => [],
          run: (...params: unknown[]) => {
            updates.push(params);
            return { changes: 1 };
          },
        };
      },
    };
    expect(migrateInlineLogShots(database)).toBe(1);
    expect(updates[0][1]).toBe(13);
    expect(String(updates[0][0])).toContain("/api/logs/13/shots/shot-000000.jpg");
    expect(fs.existsSync(path.join(tempRoot, "run-shots", "13", "shot-000000.jpg"))).toBe(true);
  });
});

