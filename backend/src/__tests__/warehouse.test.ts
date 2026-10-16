import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../db/database", () => ({ db: {} }));
import { WarehouseStore, ensureWarehouseSchema } from "../db/warehouse";
import { resetSecretKeyCache } from "../db/secretColumns";

let database: Database.Database;
let store: WarehouseStore;
const originalKey = process.env.BEMBY_DATA_KEY;
beforeEach(() => {
  database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  store = new WarehouseStore(database);
  delete process.env.BEMBY_DATA_KEY;
  resetSecretKeyCache();
});
afterEach(() => {
  database.close();
  if (originalKey == null) delete process.env.BEMBY_DATA_KEY; else process.env.BEMBY_DATA_KEY = originalKey;
  resetSecretKeyCache();
});

describe("warehouse persistence", () => {
  it("recovers the lazy schema after its first transaction rolls back", () => {
    expect(() => database.transaction(() => {
      store.createFolder({ name: "Rolled back" });
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(store.folders()).toEqual([]);
    expect(store.createFolder({ name: "After rollback" }).name).toBe("After rollback");
  });

  it("creates the independent schema idempotently and preserves record status", () => {
    ensureWarehouseSchema(database);
    ensureWarehouseSchema(database);
    const folder = store.createFolder({ name: "Codes" });
    const record = store.createRecord(folder.id, { name: "First", data: { code: "ABC", count: 2 } });
    expect(store.folders()[0]).toMatchObject({ recordCount: 1, unprocessedCount: 1 });
    store.setProcessed(record.id, true);
    expect(store.records(folder.id, true)).toEqual([]);
    expect(new WarehouseStore(database).getRecord(record.id).processed).toBe(true);
    store.updateRecord(record.id, { processed: false });
    expect(store.records(folder.id, true)).toHaveLength(1);
  });

  it("prevents folder cycles and rejects deleting parents with children", () => {
    const parent = store.createFolder({ name: "Parent" });
    const child = store.createFolder({ name: "Child", parentId: parent.id });
    expect(() => store.updateFolder(parent.id, { parentId: child.id })).toThrow("ancestor");
    expect(() => store.deleteFolder(parent.id)).toThrow("child folders");
    store.deleteFolder(child.id);
    store.deleteFolder(parent.id);
    expect(store.folders()).toEqual([]);
  });

  it("reorders only complete lists in the requested folder", () => {
    const folder = store.createFolder({ name: "One" });
    const a = store.createRecord(folder.id, { name: "A", data: {} });
    const b = store.createRecord(folder.id, { name: "B", data: {} });
    expect(() => store.reorder("records", folder.id, [a.id])).toThrow("every item");
    expect(() => store.reorder("records", folder.id, [a.id, a.id])).toThrow("Duplicate");
    store.reorder("records", folder.id, [b.id, a.id]);
    expect(store.records(folder.id).map((record) => record.id)).toEqual([b.id, a.id]);
  });

  it("rejects invalid JSON, nonboolean flags and oversize records before writing", () => {
    const folder = store.createFolder({ name: "Test" });
    expect(() => store.createRecord(folder.id, { name: "Unsafe", data: JSON.parse('{"constructor":1}') })).toThrow("Unsafe");
    expect(() => store.createRecord(folder.id, { name: "Bad", data: [], processed: true })).toThrow("object");
    expect(() => store.createRecord(folder.id, { name: "Bad", data: {}, processed: "false" })).toThrow("boolean");
    expect(() => store.createRecord(folder.id, { name: "Large", data: { x: "x".repeat(65536) } })).toThrow("large");
    expect(store.records(folder.id)).toEqual([]);
  });

  it("requires a key for sensitive records and excludes them from ordinary export", () => {
    const folder = store.createFolder({ name: "Secrets" });
    expect(() => store.createRecord(folder.id, { name: "Login", data: { password: "secret" }, sensitive: true })).toThrow("BEMBY_DATA_KEY");
    process.env.BEMBY_DATA_KEY = "a long local test key";
    resetSecretKeyCache();
    const record = store.createRecord(folder.id, { name: "Login", data: { password: "secret" }, sensitive: true });
    const raw = database.prepare("SELECT data FROM warehouse_records WHERE id = ?").get(record.id) as { data: string };
    expect(raw.data).toMatch(/^enc:v1:/);
    expect(raw.data).not.toContain("secret");
    expect(store.getRecord(record.id).data).toEqual({ password: "secret" });
    expect(store.export()).toMatchObject({ omittedSensitive: 1, folders: [{ records: [] }] });
    expect(store.export(true).folders[0].records[0].data).toEqual({ password: "secret" });
  });

  it("imports atomically and round-trips hierarchy, ordering and status", () => {
    const parent = store.createFolder({ name: "Parent" });
    const child = store.createFolder({ name: "Child", parentId: parent.id });
    store.createRecord(child.id, { name: "Used", data: { code: "ABC" }, processed: true });
    const exported = store.export();
    const result = store.import(exported);
    expect(result).toMatchObject({ folders: 2, records: 1 });
    const copiedParent = store.folders().find((folder) => folder.name === "Parent" && folder.id !== parent.id)!;
    const copiedChild = store.folders().find((folder) => folder.parentId === copiedParent.id)!;
    expect(result.folderIdMap).toEqual({ [parent.id]: copiedParent.id, [child.id]: copiedChild.id });
    expect(store.records(copiedChild.id)[0]).toMatchObject({ name: "Used", processed: true, data: { code: "ABC" } });
    const before = store.folders().length;
    expect(() => store.import({ version: 1, folders: [
      { key: "a", parentKey: null, name: "Good", records: [] },
      { key: "b", parentKey: null, name: "Bad", records: [{ name: "Broken", data: [] }] },
    ] })).toThrow();
    expect(store.folders()).toHaveLength(before);
  });

  it("round-trips an export above 5 MiB and 20000 aggregate JSON nodes", () => {
    const original = { version: 1, folders: [{
      key: "large", parentKey: null, name: "Large warehouse",
      records: Array.from({ length: 200 }, (_, index) => ({
        name: `Code ${index}`, data: { payload: "x".repeat(30000), values: Array.from({ length: 110 }, (_, value) => value) },
        processed: index % 2 === 0, sensitive: false,
      })),
    }] };
    expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(5 * 1024 * 1024);
    store.import(original);
    const exported = store.export();
    const imported = store.import(exported);
    expect(imported).toMatchObject({ folders: 1, records: 200 });
    const copiedFolder = imported.folderIdMap[exported.folders[0].key];
    expect(store.records(copiedFolder)).toHaveLength(200);
    expect(store.records(copiedFolder)[199]).toMatchObject({ name: "Code 199", processed: false });
  });

  it("preserves sibling folder order even if an early child precedes its reordered parent in the export", () => {
    const b = store.createFolder({ name: "B" });
    const child1 = store.createFolder({ name: "Child 1", parentId: b.id });
    const child2 = store.createFolder({ name: "Child 2", parentId: b.id });
    const first = store.createRecord(child1.id, { name: "First", data: { code: "A" } });
    const second = store.createRecord(child1.id, { name: "Second", data: { code: "B" } });
    const a = store.createFolder({ name: "A" });
    store.reorder("folders", null, [a.id, b.id]);
    store.reorder("folders", b.id, [child2.id, child1.id]);
    store.reorder("records", child1.id, [second.id, first.id]);
    const exported = store.export();
    expect(exported.folders[0].name).toBe("Child 2");
    const imported = store.import(exported);
    expect(store.folders().filter((folder) => folder.parentId === null).map((folder) => folder.name)).toEqual(["A", "B", "A", "B"]);
    expect(store.folders().filter((folder) => folder.parentId === imported.folderIdMap[b.id]).map((folder) => folder.name)).toEqual(["Child 2", "Child 1"]);
    expect(store.records(imported.folderIdMap[child1.id]).map((record) => record.name)).toEqual(["Second", "First"]);
  });

  it("can export ordinary records even when the sensitive encryption key is unavailable", () => {
    const folder = store.createFolder({ name: "Mixed" });
    process.env.BEMBY_DATA_KEY = "original key";
    resetSecretKeyCache();
    store.createRecord(folder.id, { name: "Private", data: { password: "secret" }, sensitive: true });
    store.createRecord(folder.id, { name: "Public", data: { status: "ready" } });
    delete process.env.BEMBY_DATA_KEY;
    resetSecretKeyCache();
    expect(store.export()).toMatchObject({ omittedSensitive: 1, folders: [{ records: [{ name: "Public" }] }] });
    expect(() => store.export(true)).toThrow("cannot be decrypted");
  });

  it("rejects imported cycles and missing parents without partial records", () => {
    expect(() => store.import({ version: 1, folders: [
      { key: "a", parentKey: "b", name: "A", records: [] },
      { key: "b", parentKey: "a", name: "B", records: [] },
    ] })).toThrow("cycle");
    expect(() => store.import({ version: 1, folders: [
      { key: "a", parentKey: "missing", name: "A", records: [] },
    ] })).toThrow("parent");
    expect(store.folders()).toEqual([]);
  });
});
