import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { managedDb } from "./helpers/managedDb";

let testDb: Database.Database;

const refreshScheduler = vi.hoisted(() => vi.fn());

vi.mock("../db/database", () => ({
  get db() { return testDb; },
  getDefaultTgApiCredentials: () => null,
}));
vi.mock("../scheduler", () => ({
  refreshScheduler,
  refreshRunSlots: vi.fn(),
  rescheduleAfterOutcome: vi.fn(),
}));
vi.mock("../jobs/execution", () => ({
  executeManagedJob: vi.fn(),
  getExecutionStatus: () => ({ running: [], queued: [] }),
}));
vi.mock("../jobs/taskQueue", () => ({
  hasActiveBatchJob: () => false,
}));
vi.mock("../jobs/embywatch", () => ({
  testEmbyConnection: vi.fn(),
}));
vi.mock("../jobs/outcome", () => ({
  getJobOutcome: vi.fn(),
  markJobOutcome: vi.fn(),
  JobOutcomeError: class extends Error {},
}));

import jobsRouter from "../routes/jobs";

function put(id: number, body: unknown) {
  const layer = jobsRouter.stack.find(
    (item: any) => item.route?.path === "/:id" && item.route.methods.put,
  );
  if (!layer?.route?.stack?.[0]?.handle) throw new Error("PUT /:id handler not found");
  const response: any = { statusCode: 200, body: undefined };
  response.status = (value: number) => {
    response.statusCode = value;
    return response;
  };
  response.json = (value: unknown) => {
    response.body = value;
    return response;
  };
  (layer.route.stack[0].handle as any)(
    { body, params: { id: String(id) } },
    response,
    () => undefined,
  );
  return response;
}

function insertJob(jobType: string, botUsername = "bot") {
  return Number(testDb.prepare(`
    INSERT INTO jobs (name, job_type, bot_username, account_id)
    VALUES (?, ?, ?, NULL)
  `).run("Job", jobType, botUsername).lastInsertRowid);
}

beforeEach(() => {
  testDb = managedDb();
  refreshScheduler.mockClear();
});

afterEach(() => {
  testDb.close();
});

describe("job binding validation on partial updates", () => {
  it.each(["checkin", "custom", "autoreg"])(
    "rejects clearing the account on an existing %s job",
    (jobType) => {
      const id = insertJob(jobType);
      const response = put(id, { accountId: null });

      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({
        error: "accountId is required for checkin, custom and autoreg jobs",
      });
      expect(testDb.prepare("SELECT account_id FROM jobs WHERE id = ?").get(id))
        .toEqual({ account_id: null });
      expect(refreshScheduler).not.toHaveBeenCalled();
    },
  );

  it.each(["checkin", "custom", "autoreg"])(
    "rejects switching an embywatch job to %s without an account",
    (jobType) => {
      const id = insertJob("embywatch", "https://emby.example.com");
      const response = put(id, { jobType });

      expect(response.statusCode).toBe(400);
      expect(response.body.error).toBe(
        "accountId is required for checkin, custom and autoreg jobs",
      );
      expect(testDb.prepare("SELECT job_type FROM jobs WHERE id = ?").get(id))
        .toEqual({ job_type: "embywatch" });
      expect(refreshScheduler).not.toHaveBeenCalled();
    },
  );

  it("rejects binding to an account id that does not exist", () => {
    const id = insertJob("checkin", "bot");
    const response = put(id, { accountId: 999 });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "Account not found" });
    expect(testDb.prepare("SELECT account_id FROM jobs WHERE id = ?").get(id))
      .toEqual({ account_id: null });
    expect(refreshScheduler).not.toHaveBeenCalled();
  });

  it("rejects clearing botUsername for a non-custom job", () => {
    const id = insertJob("embywatch", "https://emby.example.com");
    const response = put(id, { botUsername: "" });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: "botUsername is required for every type except custom",
    });
    expect(testDb.prepare("SELECT bot_username FROM jobs WHERE id = ?").get(id))
      .toEqual({ bot_username: "https://emby.example.com" });
    expect(refreshScheduler).not.toHaveBeenCalled();
  });

  it("allows a custom job to keep an empty botUsername once it has an account", () => {
    testDb.prepare(
      "INSERT INTO tg_accounts (id, name, phone_number) VALUES (1, 'Account', '')",
    ).run();
    const id = insertJob("custom", "");

    const response = put(id, { accountId: 1 });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      id,
      accountId: 1,
      jobType: "custom",
      botUsername: "",
    });
    expect(refreshScheduler).toHaveBeenCalledOnce();
  });
});
