import { describe, expect, it, vi } from "vitest";

const { mockDb, mockRemoveLogShots } = vi.hoisted(() => {
  const mockRemoveLogShots = vi.fn();
  const mockDb = {
    prepare: vi.fn(),
  };
  return { mockDb, mockRemoveLogShots };
});

vi.mock("../db/database", () => ({ db: mockDb }));
vi.mock("../jobs/cancellation", () => ({
  cancelJob: vi.fn(),
  isJobRunning: vi.fn().mockReturnValue(false),
  getLiveDetail: vi.fn().mockReturnValue(null),
}));
vi.mock("../auth/mediaTickets", () => ({
  issueMediaTicket: vi.fn().mockReturnValue({ ticket: "ticket" }),
}));
vi.mock("../middleware/auth", () => ({
  mediaAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../jobs/logShots", () => ({
  resolveLogShot: vi.fn(),
  logShotStats: vi.fn().mockReturnValue({ files: 1, bytes: 12 }),
  removeLogShots: mockRemoveLogShots,
  clearLogShotReferences: vi.fn().mockReturnValue({
    detail: { text: "kept" },
    removed: 1,
  }),
}));

import logsRouter from "../routes/logs";

function routeHandler(method: string, path: string) {
  const layer = (logsRouter as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle as (req: any, res: any) => void;
}

function response() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res;
}

describe("DELETE /logs/:id/shots concurrency guard", () => {
  it("does not remove files when the detail compare-and-swap loses", () => {
    mockRemoveLogShots.mockClear();
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT detail")) {
        return { get: () => ({ detail: JSON.stringify({ shot: "/api/logs/7/shots/shot-000000.jpg" }), status: "success" }) };
      }
      if (sql.startsWith("UPDATE job_logs")) return { run: () => ({ changes: 0 }) };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const res = response();
    routeHandler("delete", "/:id/shots")({ params: { id: "7" } }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("changed");
    expect(mockRemoveLogShots).not.toHaveBeenCalled();
  });

  it("removes files only after the compare-and-swap succeeds", () => {
    mockRemoveLogShots.mockClear();
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT detail")) {
        return { get: () => ({ detail: JSON.stringify({ shot: "/api/logs/7/shots/shot-000000.jpg" }), status: "success" }) };
      }
      if (sql.startsWith("UPDATE job_logs")) return { run: () => ({ changes: 1 }) };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const res = response();
    routeHandler("delete", "/:id/shots")({ params: { id: "7" } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ removedFiles: 1, removedBytes: 12, removedReferences: 1 });
    expect(mockRemoveLogShots).toHaveBeenCalledWith(7);
  });

  it("refuses cleanup while the run is still active", () => {
    mockRemoveLogShots.mockClear();
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT detail")) {
        return { get: () => ({ detail: "{}", status: "running" }) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const res = response();
    routeHandler("delete", "/:id/shots")({ params: { id: "7" } }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("running");
    expect(mockRemoveLogShots).not.toHaveBeenCalled();
  });
});
