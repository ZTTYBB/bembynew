// Regression test for the account-deletion guard (routes/accounts.ts DELETE /:id).
//
// checkin/custom jobs can't run without their linked tg_accounts row. Before this
// fix, deleting the account silently set the job's account_id to NULL (via the
// jobs.account_id ON DELETE SET NULL foreign key), permanently dropping the job
// out of the scheduler with no warning — while embywatch jobs, which don't need
// an account, kept working. This made it look like "only Emby Watch jobs run".

import Database from "better-sqlite3";
import http from "http";
import express from "express";
import { encryptSecret, resetSecretKeyCache } from "../db/secretColumns";

let testDb!: InstanceType<typeof Database>;
const refreshScheduler = vi.fn();

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
  getDefaultTgApiCredentials: () => null,
}));
vi.mock("../scheduler", () => ({ refreshScheduler }));
vi.mock("../auth/tgAuth", () => ({
  requestCode: vi.fn(),
  submitCode: vi.fn(),
  submitPassword: vi.fn(),
  checkAccountStatus: vi.fn(),
  resendCodeAsSms: vi.fn(),
  updateTwoFa: vi.fn(),
  getSessions: vi.fn(),
  terminateSession: vi.fn(),
  terminateOtherSessions: vi.fn(),
}));
vi.mock("../jobs/checkin", () => ({ checkSpamStatus: vi.fn() }));
vi.mock("../jobs/runner", () => ({ parseTgProxy: vi.fn() }));
vi.mock("../tg/liveClient", () => ({
  isAuthError: vi.fn(),
  markSessionExpired: vi.fn(),
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    phone_number   TEXT    NOT NULL DEFAULT '',
    api_id         INTEGER NOT NULL DEFAULT 0,
    api_hash       TEXT    NOT NULL DEFAULT '',
    session_string TEXT,
    auth_status    TEXT    NOT NULL DEFAULT 'unauthenticated',
    proxy_id       TEXT,
    disabled       INTEGER NOT NULL DEFAULT 0,
    app_client_id  TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    account_id            INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL DEFAULT '',
    enabled               INTEGER NOT NULL DEFAULT 1,
    retired               TEXT
  );
`;

function insertAccount(name = "Acct") {
  const { lastInsertRowid } = testDb
    .prepare("INSERT INTO tg_accounts (name) VALUES (?)")
    .run(name);
  return lastInsertRowid as number;
}

function insertJob(accountId: number | null, jobType: string, name = "Job") {
  const { lastInsertRowid } = testDb
    .prepare(
      "INSERT INTO jobs (name, account_id, job_type) VALUES (?, ?, ?)",
    )
    .run(name, accountId, jobType);
  return lastInsertRowid as number;
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(SCHEMA);

  const { default: accountsRouter } = await import("../routes/accounts");
  const app = express();
  app.use(express.json());
  app.use("/accounts", accountsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  testDb.exec("DELETE FROM jobs; DELETE FROM tg_accounts;");
});

describe("DELETE /accounts/:id — linked job guard", () => {
  it("blocks deletion when a checkin job still depends on the account", async () => {
    const accountId = insertAccount();
    insertJob(accountId, "checkin", "My Checkin");

    const res = await fetch(`${baseUrl}/accounts/${accountId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("My Checkin");
    const row = testDb
      .prepare("SELECT id FROM tg_accounts WHERE id = ?")
      .get(accountId);
    expect(row).toBeDefined();
    expect(refreshScheduler).not.toHaveBeenCalled();
  });

  it("blocks deletion when a custom job still depends on the account", async () => {
    const accountId = insertAccount();
    insertJob(accountId, "custom", "My Custom Job");

    const res = await fetch(`${baseUrl}/accounts/${accountId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(400);
    const row = testDb
      .prepare("SELECT id FROM tg_accounts WHERE id = ?")
      .get(accountId);
    expect(row).toBeDefined();
  });

  it("allows deletion when the account has no linked jobs", async () => {
    const accountId = insertAccount();

    const res = await fetch(`${baseUrl}/accounts/${accountId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    const row = testDb
      .prepare("SELECT id FROM tg_accounts WHERE id = ?")
      .get(accountId);
    expect(row).toBeUndefined();
    expect(refreshScheduler).toHaveBeenCalledTimes(1);
  });

  it("allows deletion when the account is only linked to an embywatch job", async () => {
    const accountId = insertAccount();
    insertJob(accountId, "embywatch", "Watch job");

    const res = await fetch(`${baseUrl}/accounts/${accountId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    const row = testDb
      .prepare("SELECT id FROM tg_accounts WHERE id = ?")
      .get(accountId);
    expect(row).toBeUndefined();
  });
});

describe("POST /accounts/export — encrypted credential integrity", () => {
  it("refuses a lossy export when the at-rest key cannot decrypt a credential", async () => {
    const previousKey = process.env.BEMBY_DATA_KEY;
    try {
      const accountId = insertAccount("Encrypted");
      process.env.BEMBY_DATA_KEY = "source-key";
      resetSecretKeyCache();
      const encrypted = encryptSecret("api-hash");
      testDb
        .prepare("UPDATE tg_accounts SET api_hash = ? WHERE id = ?")
        .run(encrypted, accountId);

      process.env.BEMBY_DATA_KEY = "wrong-key";
      resetSecretKeyCache();
      const res = await fetch(`${baseUrl}/accounts/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: "backup-secret" }),
      });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain("could not be read completely");
    } finally {
      if (previousKey === undefined) delete process.env.BEMBY_DATA_KEY;
      else process.env.BEMBY_DATA_KEY = previousKey;
      resetSecretKeyCache();
    }
  });

  it("rejects malformed account ids instead of falling back to exporting all accounts", async () => {
    const res = await fetch(`${baseUrl}/accounts/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["all"] }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("positive integer");
  });
});

describe("POST /accounts/import — option validation", () => {
  it("rejects string forceReauth values instead of treating them as truthy", async () => {
    const res = await fetch(`${baseUrl}/accounts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: { version: "1", accounts: [] },
        forceReauth: "false",
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid import options");
  });

  it("rejects unsupported account export versions before touching the database", async () => {
    const res = await fetch(`${baseUrl}/accounts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: { version: "2", accounts: [] },
        forceReauth: false,
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("unsupported account export");
  });

  it("rejects malformed account fields instead of surfacing a database 500", async () => {
    const res = await fetch(`${baseUrl}/accounts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: {
          version: "1",
          accounts: [{ phoneNumber: "+1", apiId: "not-a-number", apiHash: "hash" }],
        },
        forceReauth: false,
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("apiId");
  });
});
