import type Database from "better-sqlite3";
import { db } from "./database";
import { decryptSecret, encryptSecret, isSecretEncryptionEnabled } from "./secretColumns";
import { assertJson, type JsonValue } from "../jobs/automation";

export const WAREHOUSE_LIMITS = { folders: 500, records: 20000, perFolder: 5000, recordBytes: 65536, importBytes: 32 * 1024 * 1024, storageBytes: 16 * 1024 * 1024 };
export type WarehouseFolder = { id: number; parentId: number | null; name: string; sortOrder: number; recordCount: number; unprocessedCount: number };
export type WarehouseRecord = { id: number; folderId: number; name: string; data: Record<string, JsonValue>; sensitive: boolean; processed: boolean; sortOrder: number; createdAt: string; updatedAt: string };
type RecordInput = Pick<WarehouseRecord, "name" | "data" | "sensitive" | "processed">;
export type WarehouseDataEntry = { name: string; data: Record<string, JsonValue> };

export class WarehouseError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

const ready = new WeakSet<Database.Database>();
export function ensureWarehouseSchema(database: Database.Database = db): void {
  if (ready.has(database)) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS warehouse_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES warehouse_folders(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS warehouse_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL REFERENCES warehouse_folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      sensitive INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_warehouse_folders_parent ON warehouse_folders(parent_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_warehouse_records_folder ON warehouse_records(folder_id, processed, sort_order, id);
  `);
  if (!database.inTransaction) ready.add(database);
}

export function warehouseId(value: unknown): number {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || Number(id) < 1) throw new WarehouseError("Invalid warehouse id");
  return Number(id);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WarehouseError("Expected an object");
  return value as Record<string, unknown>;
}

function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) throw new WarehouseError("Name must contain 1 to 120 characters");
  return value.trim();
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw new WarehouseError("Expected a boolean");
  return value;
}

export function validateWarehouseRecord(raw: unknown, previous?: RecordInput): RecordInput {
  const input = object(raw);
  const data = input.data === undefined && previous ? previous.data : input.data;
  try { assertJson(data, WAREHOUSE_LIMITS.recordBytes); } catch (error: any) { throw new WarehouseError(error.message); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new WarehouseError("Record data must be a JSON object");
  const sensitive = bool(input.sensitive, previous?.sensitive ?? false);
  if (sensitive && !isSecretEncryptionEnabled()) throw new WarehouseError("Sensitive records require BEMBY_DATA_KEY");
  return {
    name: input.name === undefined && previous ? previous.name : name(input.name),
    data,
    sensitive,
    processed: bool(input.processed, previous?.processed ?? false),
  };
}

export class WarehouseStore {
  constructor(private readonly suppliedDatabase?: Database.Database) {}
  private get database(): Database.Database { return this.suppliedDatabase ?? db; }
  private init() { ensureWarehouseSchema(this.database); }
  private count(sql: string, ...params: unknown[]) {
    return (this.database.prepare(sql).get(...params) as { count: number }).count;
  }
  private requireFolder(id: number) {
    if (!this.database.prepare("SELECT id FROM warehouse_folders WHERE id = ?").get(id)) throw new WarehouseError("Folder not found", 404);
  }
  private requireCapacity(data: string, previousBytes = 0) {
    const used = this.count("SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS count FROM warehouse_records");
    if (used - previousBytes + Buffer.byteLength(data, "utf8") > WAREHOUSE_LIMITS.storageBytes) throw new WarehouseError("Warehouse storage limit reached");
  }
  private decode(row: any): WarehouseRecord {
    const plain = decryptSecret(row.data);
    if (plain == null) throw new WarehouseError("Record cannot be decrypted; restore BEMBY_DATA_KEY", 409);
    return {
      id: row.id, folderId: row.folder_id, name: row.name, data: JSON.parse(plain),
      sensitive: Boolean(row.sensitive), processed: Boolean(row.processed), sortOrder: row.sort_order,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
  folders(): WarehouseFolder[] {
    this.init();
    return this.database.prepare(`
      SELECT f.id, f.parent_id AS parentId, f.name, f.sort_order AS sortOrder,
        COUNT(r.id) AS recordCount, COALESCE(SUM(CASE WHEN r.processed = 0 THEN 1 ELSE 0 END), 0) AS unprocessedCount
      FROM warehouse_folders f LEFT JOIN warehouse_records r ON r.folder_id = f.id
      GROUP BY f.id ORDER BY f.sort_order, f.id
    `).all() as WarehouseFolder[];
  }
  createFolder(raw: unknown): WarehouseFolder {
    this.init();
    const input = object(raw);
    const folderName = name(input.name);
    const parent = input.parentId == null ? null : warehouseId(input.parentId);
    return this.database.transaction(() => {
      if (parent) this.requireFolder(parent);
      if (this.count("SELECT COUNT(*) AS count FROM warehouse_folders") >= WAREHOUSE_LIMITS.folders) throw new WarehouseError("Folder limit reached");
      const result = this.database.prepare("INSERT INTO warehouse_folders(name, parent_id, sort_order) VALUES (?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM warehouse_folders WHERE parent_id IS ?), 0))").run(folderName, parent, parent);
      return this.folders().find((folder) => folder.id === Number(result.lastInsertRowid))!;
    })();
  }
  updateFolder(id: number, raw: unknown): WarehouseFolder {
    this.init();
    const input = object(raw);
    return this.database.transaction(() => {
      const current = this.folders().find((folder) => folder.id === id);
      if (!current) throw new WarehouseError("Folder not found", 404);
      const parent = input.parentId === undefined ? current.parentId : input.parentId == null ? null : warehouseId(input.parentId);
      if (parent) this.requireFolder(parent);
      let ancestor = parent;
      while (ancestor != null) {
        if (ancestor === id) throw new WarehouseError("A folder cannot be its own ancestor");
        ancestor = (this.database.prepare("SELECT parent_id FROM warehouse_folders WHERE id = ?").get(ancestor) as { parent_id: number | null }).parent_id;
      }
      this.database.prepare("UPDATE warehouse_folders SET name = ?, parent_id = ? WHERE id = ?").run(input.name === undefined ? current.name : name(input.name), parent, id);
      return this.folders().find((folder) => folder.id === id)!;
    })();
  }
  deleteFolder(id: number): void {
    this.init();
    this.database.transaction(() => {
      this.requireFolder(id);
      if (this.database.prepare("SELECT id FROM warehouse_folders WHERE parent_id = ? LIMIT 1").get(id)) throw new WarehouseError("Move or delete child folders first", 409);
      this.database.prepare("DELETE FROM warehouse_records WHERE folder_id = ?").run(id);
      this.database.prepare("DELETE FROM warehouse_folders WHERE id = ?").run(id);
    })();
  }
  records(folderId: number, onlyUnprocessed = false): WarehouseRecord[] {
    this.init();
    this.requireFolder(folderId);
    return this.database.prepare(`SELECT * FROM warehouse_records WHERE folder_id = ?${onlyUnprocessed ? " AND processed = 0" : ""} ORDER BY sort_order, id`).all(folderId).map((row) => this.decode(row));
  }
  getRecord(id: number): WarehouseRecord {
    this.init();
    const row = this.database.prepare("SELECT * FROM warehouse_records WHERE id = ?").get(id);
    if (!row) throw new WarehouseError("Record not found", 404);
    return this.decode(row);
  }
  createRecord(folderId: number, raw: unknown): WarehouseRecord {
    this.init();
    const value = validateWarehouseRecord(raw);
    return this.database.transaction(() => {
      this.requireFolder(folderId);
      if (this.count("SELECT COUNT(*) AS count FROM warehouse_records") >= WAREHOUSE_LIMITS.records ||
          this.count("SELECT COUNT(*) AS count FROM warehouse_records WHERE folder_id = ?", folderId) >= WAREHOUSE_LIMITS.perFolder) throw new WarehouseError("Record limit reached");
      const stored = value.sensitive ? encryptSecret(JSON.stringify(value.data)) : JSON.stringify(value.data);
      this.requireCapacity(stored);
      const result = this.database.prepare("INSERT INTO warehouse_records(folder_id, name, data, sensitive, processed, sort_order) VALUES (?, ?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM warehouse_records WHERE folder_id = ?), 0))").run(
        folderId, value.name, stored, Number(value.sensitive), Number(value.processed), folderId,
      );
      return this.getRecord(Number(result.lastInsertRowid));
    })();
  }
  updateRecord(id: number, raw: unknown): WarehouseRecord {
    this.init();
    return this.database.transaction(() => {
      const previous = this.getRecord(id);
      const input = object(raw);
      const value = validateWarehouseRecord(input, previous);
      const folderId = input.folderId === undefined ? previous.folderId : warehouseId(input.folderId);
      this.requireFolder(folderId);
      if (folderId !== previous.folderId && this.count("SELECT COUNT(*) AS count FROM warehouse_records WHERE folder_id = ?", folderId) >= WAREHOUSE_LIMITS.perFolder) throw new WarehouseError("Folder record limit reached");
      const stored = value.sensitive ? encryptSecret(JSON.stringify(value.data)) : JSON.stringify(value.data);
      const previousBytes = this.count("SELECT length(CAST(data AS BLOB)) AS count FROM warehouse_records WHERE id = ?", id);
      this.requireCapacity(stored, previousBytes);
      this.database.prepare("UPDATE warehouse_records SET folder_id = ?, name = ?, data = ?, sensitive = ?, processed = ?, updated_at = datetime('now') WHERE id = ?").run(
        folderId, value.name, stored, Number(value.sensitive), Number(value.processed), id,
      );
      return this.getRecord(id);
    })();
  }
  deleteRecord(id: number): void {
    this.init();
    if (!this.database.prepare("DELETE FROM warehouse_records WHERE id = ?").run(id).changes) throw new WarehouseError("Record not found", 404);
  }
  setProcessed(id: number, processed: boolean): void {
    this.init();
    if (!this.database.prepare("UPDATE warehouse_records SET processed = ?, updated_at = datetime('now') WHERE id = ?").run(Number(processed), id).changes) throw new WarehouseError("Record not found", 404);
  }
  /**
   * Add named records without overwriting an existing key in the folder.
   * The check and inserts share one transaction so two matches in one run cannot
   * overwrite one another, and a rerun remains idempotent by record name.
   */
  saveData(folderId: number, entries: WarehouseDataEntry[]): { saved: number; skipped: number } {
    this.init();
    if (!Array.isArray(entries) || entries.length > 500) throw new WarehouseError("Too many data records");
    return this.database.transaction(() => {
      this.requireFolder(folderId);
      let saved = 0;
      let skipped = 0;
      const existing = new Set(
        (this.database.prepare("SELECT name FROM warehouse_records WHERE folder_id = ?").all(folderId) as Array<{ name: string }>)
          .map((row) => row.name),
      );
      for (const entry of entries) {
        const recordName = name(entry?.name);
        if (existing.has(recordName)) {
          skipped++;
          continue;
        }
        const data = entry?.data;
        try { assertJson(data, WAREHOUSE_LIMITS.recordBytes); } catch (error: any) {
          throw new WarehouseError(error?.message ?? "Invalid record data");
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw new WarehouseError("Record data must be a JSON object");
        }
        const stored = JSON.stringify(data);
        this.requireCapacity(stored);
        if (
          this.count("SELECT COUNT(*) AS count FROM warehouse_records") >= WAREHOUSE_LIMITS.records ||
          this.count("SELECT COUNT(*) AS count FROM warehouse_records WHERE folder_id = ?", folderId) >= WAREHOUSE_LIMITS.perFolder
        ) throw new WarehouseError("Record limit reached");
        this.database.prepare(
          "INSERT INTO warehouse_records(folder_id, name, data, sensitive, processed, sort_order) VALUES (?, ?, ?, 0, 0, COALESCE((SELECT MAX(sort_order) + 1 FROM warehouse_records WHERE folder_id = ?), 0))",
        ).run(folderId, recordName, stored, folderId);
        existing.add(recordName);
        saved++;
      }
      return { saved, skipped };
    })();
  }
  reorder(kind: "folders" | "records", scopeId: number | null, rawIds: unknown): void {
    this.init();
    if (!Array.isArray(rawIds)) throw new WarehouseError("ids must be an array");
    const ids = rawIds.map(warehouseId);
    if (new Set(ids).size !== ids.length) throw new WarehouseError("Duplicate ids");
    this.database.transaction(() => {
      if (kind === "records" && scopeId == null) throw new WarehouseError("folderId is required");
      const table = kind === "folders" ? "warehouse_folders" : "warehouse_records";
      const scope = kind === "folders" ? "parent_id" : "folder_id";
      const current = this.database.prepare(`SELECT id FROM ${table} WHERE ${scope} IS ?`).all(scopeId) as { id: number }[];
      if (current.length !== ids.length || current.some((row) => !ids.includes(row.id))) throw new WarehouseError("Reorder must include every item in this folder");
      const update = this.database.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
      ids.forEach((id, order) => update.run(order, id));
    })();
  }
  export(includeSensitive = false) {
    const folders = this.folders();
    let omittedSensitive = 0;
    const result = folders.map((folder) => ({
      key: String(folder.id), parentKey: folder.parentId == null ? null : String(folder.parentId), name: folder.name,
      records: (() => {
        if (!includeSensitive) omittedSensitive += this.count("SELECT COUNT(*) AS count FROM warehouse_records WHERE folder_id = ? AND sensitive = 1", folder.id);
        return this.database.prepare(`SELECT * FROM warehouse_records WHERE folder_id = ?${includeSensitive ? "" : " AND sensitive = 0"} ORDER BY sort_order, id`).all(folder.id)
          .map((row) => this.decode(row))
          .map(({ name, data, sensitive, processed }) => ({ name, data, sensitive, processed }));
      })(),
    }));
    return { version: 1 as const, folders: result, omittedSensitive };
  }
  import(raw: unknown): { folders: number; records: number; folderIdMap: Record<string, number> } {
    this.init();
    let serialized: string | undefined;
    try { serialized = JSON.stringify(raw); } catch { throw new WarehouseError("Invalid warehouse JSON"); }
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > WAREHOUSE_LIMITS.importBytes) throw new WarehouseError("Warehouse import is too large");
    const input = object(raw);
    if (input.version !== 1 || !Array.isArray(input.folders) || input.folders.length > WAREHOUSE_LIMITS.folders) throw new WarehouseError("Invalid warehouse export");
    let recordCount = 0;
    const folderInputs = input.folders.map((entry) => {
      const folder = object(entry);
      if (typeof folder.key !== "string" || !folder.key || (folder.parentKey !== null && typeof folder.parentKey !== "string") || !Array.isArray(folder.records) || folder.records.length > WAREHOUSE_LIMITS.perFolder) throw new WarehouseError("Invalid imported folder");
      recordCount += folder.records.length;
      if (recordCount > WAREHOUSE_LIMITS.records) throw new WarehouseError("Warehouse import exceeds capacity");
      return { key: folder.key, parentKey: folder.parentKey as string | null, name: name(folder.name), records: folder.records.map((record) => validateWarehouseRecord(record)) };
    });
    const byKey = new Map(folderInputs.map((folder) => [folder.key, folder]));
    if (byKey.size !== folderInputs.length) throw new WarehouseError("Duplicate imported folder key");
    for (const folder of folderInputs) {
      const seen = new Set([folder.key]);
      let parent = folder.parentKey;
      while (parent !== null) {
        if (!byKey.has(parent)) throw new WarehouseError("Imported folder parent not found");
        if (seen.has(parent)) throw new WarehouseError("Imported folder cycle");
        seen.add(parent);
        parent = byKey.get(parent)!.parentKey;
      }
    }
    return this.database.transaction(() => {
      if (this.count("SELECT COUNT(*) AS count FROM warehouse_folders") + folderInputs.length > WAREHOUSE_LIMITS.folders ||
          this.count("SELECT COUNT(*) AS count FROM warehouse_records") + recordCount > WAREHOUSE_LIMITS.records) throw new WarehouseError("Warehouse import exceeds capacity");
      const ids = new Map<string, number>();
      const addChildren = (parentKey: string | null): void => {
        const parentId = parentKey === null ? null : ids.get(parentKey)!;
        for (const folder of folderInputs.filter((entry) => entry.parentKey === parentKey)) {
          const created = this.createFolder({ name: folder.name, parentId });
          ids.set(folder.key, created.id);
          for (const record of folder.records) this.createRecord(created.id, record);
          addChildren(folder.key);
        }
      };
      addChildren(null);
      return { folders: folderInputs.length, records: recordCount, folderIdMap: Object.fromEntries(ids) };
    })();
  }
}

export const warehouse = new WarehouseStore();
