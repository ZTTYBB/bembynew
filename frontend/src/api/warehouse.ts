import { api } from "./client";
import type { JsonValue } from "./automation";
export type WarehouseFolder = { id: number; parentId: number | null; name: string; sortOrder: number; recordCount: number; unprocessedCount: number };
export type WarehouseRecord = { id: number; folderId: number; name: string; data: Record<string, JsonValue>; sensitive: boolean; processed: boolean; sortOrder: number; createdAt: string; updatedAt: string };
export type RecordInput = Pick<WarehouseRecord, "name" | "data" | "sensitive" | "processed"> & { folderId?: number };
export const warehouseApi = {
  folders: async (signal?: AbortSignal) => (await api.get<WarehouseFolder[]>("/warehouse/folders", { signal })).data,
  createFolder: async (data: { name: string; parentId: number | null }) => (await api.post<WarehouseFolder>("/warehouse/folders", data)).data,
  updateFolder: async (id: number, data: { name?: string; parentId?: number | null }) => (await api.put<WarehouseFolder>(`/warehouse/folders/${id}`, data)).data,
  deleteFolder: async (id: number) => { await api.delete(`/warehouse/folders/${id}`); },
  reorderFolders: async (parentId: number | null, ids: number[]) => { await api.put("/warehouse/folders/reorder", { parentId, ids }); },
  records: async (folderId: number, unprocessed = false, signal?: AbortSignal) => (await api.get<WarehouseRecord[]>(`/warehouse/folders/${folderId}/records`, { params: { unprocessed }, signal })).data,
  createRecord: async (folderId: number, data: RecordInput) => (await api.post<WarehouseRecord>(`/warehouse/folders/${folderId}/records`, data)).data,
  updateRecord: async (id: number, data: Partial<RecordInput>) => (await api.put<WarehouseRecord>(`/warehouse/records/${id}`, data)).data,
  deleteRecord: async (id: number) => { await api.delete(`/warehouse/records/${id}`); },
  reorderRecords: async (folderId: number, ids: number[]) => { await api.put("/warehouse/records/reorder", { folderId, ids }); },
  export: async (includeSensitive: boolean) => (await api.get("/warehouse/export", { params: { includeSensitive } })).data,
  import: async (data: unknown) => (await api.post<{ folders: number; records: number; folderIdMap: Record<string, number> }>("/warehouse/import", data)).data,
};
