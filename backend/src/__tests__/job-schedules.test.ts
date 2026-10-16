import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobScheduleStore, scheduleInstant } from "../db/jobSchedules";
import { managedDb, insertManagedJob } from "./helpers/managedDb";

let database: Database.Database | undefined;
let directory: string | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function initial(jobId: number) {
  return {
    jobId, nextRun: "2024-06-15T18:30:00+08:00", timezone: "Asia/Shanghai",
    pinned: true, state: "pending" as const, origin: "manual" as const,
    scheduleKey: "key", skippedAt: "2024-06-14T00:00:00.000Z",
  };
}

describe("durable job schedules", () => {
  it("round-trips exact instants, zone, pin and skip history after reopening SQLite", () => {
    directory = mkdtempSync(join(tmpdir(), "bemby-schedule-store-"));
    const filename = join(directory, "test.db");
    database = managedDb(filename);
    const jobId = insertManagedJob(database);
    const plan = new JobScheduleStore(database).save(initial(jobId))!;
    expect(plan.nextRun).toBe("2024-06-15T10:30:00.000Z");
    database.close();
    database = managedDb(filename);
    expect(new JobScheduleStore(database).get(jobId)).toEqual(plan);
  });

  it("uses revision compare-and-swap to reject stale updates and deletes", () => {
    database = managedDb();
    const store = new JobScheduleStore(database);
    const id = insertManagedJob(database);
    const first = store.save(initial(id))!;
    const changed = store.save({ ...first, pinned: false }, first.revision)!;
    expect(changed.revision).toBe(first.revision + 1);
    expect(store.save({ ...first, nextRun: "2024-06-16T00:00:00Z" }, first.revision)).toBeUndefined();
    expect(store.remove(id, first.revision)).toBe(false);
    expect(store.get(id)).toEqual(changed);
    expect(store.remove(id, changed.revision)).toBe(true);
  });

  it("claims each due pending revision only once and interrupts only dispatching plans", () => {
    database = managedDb();
    const store = new JobScheduleStore(database);
    const id = insertManagedJob(database);
    const first = store.save(initial(id))!;
    expect(store.claim(id, first.revision, "2024-06-15T10:29:59Z")).toBe(false);
    expect(store.claim(id, first.revision + 1, "2024-06-15T11:00:00Z")).toBe(false);
    expect(store.claim(id, first.revision, "2024-06-15T11:00:00Z")).toBe(true);
    expect(store.claim(id, first.revision, "2024-06-15T11:00:00Z")).toBe(false);
    expect(store.interruptDispatching()).toBe(1);
    expect(store.interruptDispatching()).toBe(0);
    expect(store.get(id)).toMatchObject({ state: "interrupted", revision: first.revision + 1 });
  });

  it("cascades schedules when their jobs are deleted", () => {
    database = managedDb();
    const store = new JobScheduleStore(database);
    const id = insertManagedJob(database);
    store.save(initial(id));
    database.prepare("DELETE FROM jobs WHERE id = ?").run(id);
    expect(store.list()).toEqual([]);
  });

  it("rejects ambiguous times, invalid timestamps, nonexistent jobs and invalid zones", () => {
    database = managedDb();
    const store = new JobScheduleStore(database);
    const id = insertManagedJob(database);
    for (const value of ["2024-06-15T10:30:00", "2024-02-30T10:30:00Z", "not a date"]) {
      expect(() => scheduleInstant(value)).toThrow();
    }
    expect(() => store.save({ ...initial(id), timezone: "Not/AZone" })).toThrow("timezone");
    expect(() => store.save(initial(id + 99))).toThrow("FOREIGN KEY");
  });
});
