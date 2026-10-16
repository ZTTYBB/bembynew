import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalEnv = {
  DB_PATH: process.env.DB_PATH,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  ADMIN_PASSWORD_RESET: process.env.ADMIN_PASSWORD_RESET,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

async function loadReset(flag: string | undefined, username?: string, password?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bemby-password-reset-"));
  process.env.DB_PATH = path.join(dir, "bemby.db");
  if (flag === undefined) delete process.env.ADMIN_PASSWORD_RESET;
  else process.env.ADMIN_PASSWORD_RESET = flag;
  if (username === undefined) delete process.env.ADMIN_USERNAME;
  else process.env.ADMIN_USERNAME = username;
  if (password === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = password;
  vi.resetModules();
  const auth = await import("../routes/auth");
  const database = await import("../db/database");
  return {
    ...auth,
    db: database.db,
    close: () => {
      database.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("ADMIN_PASSWORD_RESET", () => {
  it("writes Argon2 credentials, marks the migration, and advances the token epoch", async () => {
    const loaded = await loadReset("1", "new-admin", "new-password");
    try {
      await expect(loaded.applyPasswordResetFromEnv()).resolves.toBe(true);
      expect(loaded.db.prepare("SELECT value FROM settings WHERE key = 'admin_username'").get())
        .toEqual({ value: "new-admin" });
      const hash = loaded.db.prepare(
        "SELECT value FROM settings WHERE key = 'admin_password_hash'",
      ).get() as { value: string };
      expect(hash.value).toMatch(/^\$argon2/);
      expect(loaded.db.prepare(
        "SELECT value FROM settings WHERE key = 'migration:admin_password_reset_seen'",
      ).get()).toEqual({ value: "1" });
      const epoch = loaded.db.prepare(
        "SELECT value FROM settings WHERE key = 'token_epoch'",
      ).get() as { value: string };
      expect(Number(epoch.value)).toBeGreaterThan(0);
    } finally {
      loaded.close();
    }
  });

  it("does not repeat while the flag remains set, but can be armed again after removal", async () => {
    const loaded = await loadReset("1", "admin", "first-password");
    try {
      await expect(loaded.applyPasswordResetFromEnv()).resolves.toBe(true);
      const firstHash = (loaded.db.prepare(
        "SELECT value FROM settings WHERE key = 'admin_password_hash'",
      ).get() as { value: string }).value;
      await expect(loaded.applyPasswordResetFromEnv()).resolves.toBe(false);
      expect((loaded.db.prepare(
        "SELECT value FROM settings WHERE key = 'admin_password_hash'",
      ).get() as { value: string }).value).toBe(firstHash);

      delete process.env.ADMIN_PASSWORD_RESET;
      await expect(loaded.applyPasswordResetFromEnv()).resolves.toBe(false);
      process.env.ADMIN_PASSWORD_RESET = "1";
      process.env.ADMIN_PASSWORD = "second-password";
      await expect(loaded.applyPasswordResetFromEnv()).resolves.toBe(true);
      expect((loaded.db.prepare(
        "SELECT value FROM settings WHERE key = 'admin_password_hash'",
      ).get() as { value: string }).value).not.toBe(firstHash);
    } finally {
      loaded.close();
    }
  });

  it("fails closed when the reset flag is set without both credentials", async () => {
    const loaded = await loadReset("1", "admin");
    try {
      await expect(loaded.applyPasswordResetFromEnv()).rejects.toThrow(
        /requires both ADMIN_USERNAME and ADMIN_PASSWORD/,
      );
      expect(loaded.db.prepare(
        "SELECT 1 FROM settings WHERE key = 'migration:admin_password_reset_seen'",
      ).get()).toBeUndefined();
    } finally {
      loaded.close();
    }
  });
});
