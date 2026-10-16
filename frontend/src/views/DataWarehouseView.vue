<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">数据仓库</h2>
      <div class="warehouse-tools">
        <button class="btn btn-secondary" @click="openTransfer('import')"><i class="fa-solid fa-file-import"></i> 导入</button>
        <button class="btn btn-secondary" @click="openTransfer('export')"><i class="fa-solid fa-file-export"></i> 导出</button>
        <button class="btn btn-primary" @click="openRecord()" :disabled="!selectedFolderId"><i class="fa-solid fa-plus"></i> 添加记录</button>
      </div>
    </div>
    <div v-if="error" class="error-msg">{{ error }}</div>
    <div v-if="notice" class="success-msg">{{ notice }}</div>
    <div class="warehouse-layout">
      <aside class="warehouse-folders">
        <div class="warehouse-sidebar-header">
          <strong>文件夹</strong>
          <button class="btn btn-ghost btn-sm btn-icon" title="新建文件夹" @click="openFolder()"><i class="fa-solid fa-folder-plus"></i></button>
        </div>
        <div v-if="loadingFolders" class="empty">加载中...</div>
        <div v-else-if="!folders.length" class="empty">暂无文件夹</div>
        <div v-for="folder in orderedFolders" :key="folder.id" class="folder-row" :class="{ active: folder.id === selectedFolderId }">
          <button class="folder-select" :style="{ paddingLeft: `${8 + Math.min(folder.depth, 5) * 12}px` }" @click="selectFolder(folder.id)">
            <i class="fa-solid fa-folder" aria-hidden="true"></i><span>{{ folder.name }}</span><small>{{ folder.unprocessedCount }}/{{ folder.recordCount }}</small>
          </button>
          <button class="btn btn-ghost btn-sm btn-icon" :title="`编辑 ${folder.name}`" @click="openFolder(folder)"><i class="fa-solid fa-pen"></i></button>
        </div>
      </aside>
      <section class="warehouse-records">
        <div class="warehouse-table-tools">
          <h3>{{ selectedFolder?.name || '数据记录' }}</h3>
          <input v-model="search" class="form-input" aria-label="搜索记录" placeholder="搜索名称或字段" />
          <label class="form-check"><input v-model="onlyUnprocessed" type="checkbox" />仅未处理</label>
          <button class="btn btn-ghost btn-sm btn-icon" title="刷新" :disabled="loadingRecords" @click="reload"><i class="fa-solid fa-rotate-right"></i></button>
        </div>
        <PaginationBar :page="page" :page-size="pageSize" :total="filteredRecords.length" @update:page="page = $event" @update:page-size="changePageSize" />
        <div class="table-wrap">
          <table>
            <thead><tr><th>名称</th><th>字段</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-if="loadingRecords"><td colspan="4" class="empty">加载中...</td></tr>
              <tr v-else-if="!visibleRecords.length"><td colspan="4" class="empty">{{ selectedFolderId ? '暂无记录' : '暂无文件夹' }}</td></tr>
              <tr v-for="record in visibleRecords" v-else :key="record.id">
                <td class="record-name"><i v-if="record.sensitive" class="fa-solid fa-lock" title="敏感记录"></i> {{ record.name }}</td>
                <td><div class="record-preview">{{ record.sensitive ? '敏感数据' : preview(record) }}</div></td>
                <td><button class="status-toggle" :class="record.processed ? 'processed' : ''" :disabled="busy" :title="record.processed ? '重置为未处理' : '标记已处理'" @click="toggleProcessed(record)"><i :class="record.processed ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle'"></i> {{ record.processed ? '已处理' : '未处理' }}</button></td>
                <td><div class="actions">
                  <button class="btn btn-ghost btn-sm btn-icon" title="上移" :disabled="busy || hasFilter || records[0]?.id === record.id" @click="moveRecord(record, -1)"><i class="fa-solid fa-arrow-up"></i></button>
                  <button class="btn btn-ghost btn-sm btn-icon" title="下移" :disabled="busy || hasFilter || records.at(-1)?.id === record.id" @click="moveRecord(record, 1)"><i class="fa-solid fa-arrow-down"></i></button>
                  <button class="btn btn-ghost btn-sm btn-icon" title="编辑记录" @click="openRecord(record)"><i class="fa-solid fa-pen"></i></button>
                  <button class="btn btn-danger btn-sm btn-icon" title="删除记录" :disabled="busy" @click="deleteRecord(record)"><i class="fa-solid fa-trash"></i></button>
                </div></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <div v-if="folderFormVisible" class="modal-backdrop">
      <form class="modal" style="width:440px" @submit.prevent="saveFolder">
        <h3 class="modal-title">{{ editingFolder ? '编辑文件夹' : '新建文件夹' }}</h3>
        <div class="modal-body">
          <div v-if="formError" class="error-msg">{{ formError }}</div>
          <label class="form-group"><span class="form-label">名称</span><input v-model.trim="folderForm.name" class="form-input" maxlength="120" required /></label>
          <label class="form-group"><span class="form-label">上级文件夹</span><select v-model="folderForm.parentId" class="form-select"><option :value="null">根目录</option><option v-for="folder in allowedParents" :key="folder.id" :value="folder.id">{{ folder.name }}</option></select></label>
          <div v-if="editingFolder" class="warehouse-tools">
            <button type="button" class="btn btn-ghost btn-sm btn-icon" title="上移文件夹" :disabled="busy || !canMoveFolder(-1)" @click="moveFolder(-1)"><i class="fa-solid fa-arrow-up"></i></button>
            <button type="button" class="btn btn-ghost btn-sm btn-icon" title="下移文件夹" :disabled="busy || !canMoveFolder(1)" @click="moveFolder(1)"><i class="fa-solid fa-arrow-down"></i></button>
            <button type="button" class="btn btn-danger btn-sm" :disabled="busy" @click="deleteFolder"><i class="fa-solid fa-trash"></i> 删除文件夹</button>
          </div>
        </div>
        <div class="modal-footer"><button type="button" class="btn btn-ghost" :disabled="busy" @click="folderFormVisible = false">取消</button><button class="btn btn-primary" :disabled="busy"><i class="fa-solid fa-check"></i> 保存</button></div>
      </form>
    </div>

    <div v-if="recordFormVisible" class="modal-backdrop">
      <form class="modal" style="width:600px" @submit.prevent="saveRecord">
        <h3 class="modal-title">{{ editingRecord ? '编辑记录' : '添加记录' }}</h3>
        <div class="modal-body">
          <div v-if="formError" class="error-msg">{{ formError }}</div>
          <label class="form-group"><span class="form-label">名称</span><input v-model.trim="recordForm.name" class="form-input" maxlength="120" required /></label>
          <label class="form-group"><span class="form-label">文件夹</span><select v-model.number="recordForm.folderId" class="form-select"><option v-for="folder in orderedFolders" :key="folder.id" :value="folder.id">{{ folder.name }}</option></select></label>
          <label class="form-group"><span class="form-label">JSON 数据</span><textarea v-model="recordForm.dataText" class="form-input record-json" rows="10" spellcheck="false" required /></label>
          <div class="warehouse-tools">
            <label class="form-check"><input v-model="recordForm.processed" type="checkbox" />已处理</label>
            <label class="form-check"><input v-model="recordForm.sensitive" type="checkbox" />敏感数据（加密存储）</label>
          </div>
        </div>
        <div class="modal-footer"><button type="button" class="btn btn-ghost" :disabled="busy" @click="recordFormVisible = false">取消</button><button class="btn btn-primary" :disabled="busy"><i class="fa-solid fa-check"></i> 保存</button></div>
      </form>
    </div>

    <div v-if="transferMode" class="modal-backdrop">
      <form class="modal" style="width:600px" @submit.prevent="transfer">
        <h3 class="modal-title">{{ transferMode === 'import' ? '导入数据仓库' : '导出数据仓库' }}</h3>
        <div class="modal-body">
          <div v-if="formError" class="error-msg">{{ formError }}</div>
          <template v-if="transferMode === 'import'">
            <input type="file" accept=".json,application/json" aria-label="JSON 文件" @change="readImportFile" />
            <textarea v-model="importText" class="form-input record-json" rows="12" aria-label="导入 JSON" style="margin-top:12px" />
          </template>
          <label v-else class="form-check"><input v-model="includeSensitive" type="checkbox" />包含敏感记录（明文导出）</label>
        </div>
        <div class="modal-footer"><button type="button" class="btn btn-ghost" :disabled="busy" @click="transferMode = null">取消</button><button class="btn btn-primary" :disabled="busy"><i :class="transferMode === 'import' ? 'fa-solid fa-file-import' : 'fa-solid fa-download'"></i> {{ transferMode === 'import' ? '导入' : '下载' }}</button></div>
      </form>
    </div>

    <div v-if="deleteTarget" class="modal-backdrop" @click.self="closeDelete">
      <form ref="deleteDialog" class="modal" style="width:420px" tabindex="-1" role="alertdialog" aria-modal="true" aria-labelledby="warehouse-delete-title" @submit.prevent="executeDelete" @keydown.esc.prevent="closeDelete" @keydown.enter.self.prevent="executeDelete">
        <h3 id="warehouse-delete-title" class="modal-title">确认删除</h3>
        <div class="modal-body">
          <div v-if="deleteError" class="error-msg">{{ deleteError }}</div>
          <p style="overflow-wrap:anywhere">{{ deleteTarget.kind === 'folder' ? `删除文件夹“${deleteTarget.name}”及其中的全部记录？` : `删除记录“${deleteTarget.name}”？` }}</p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" :disabled="busy" @click="closeDelete">取消</button>
          <button type="submit" class="btn btn-danger" :disabled="busy"><i class="fa-solid fa-trash"></i> 删除</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import PaginationBar from "../components/PaginationBar.vue";
import { warehouseApi, type WarehouseFolder, type WarehouseRecord } from "../api/warehouse";
import { usePersistedRef } from "../composables/usePersistedRef";
import { createLatestRequest } from "../utils/latestRequest";

const folders = ref<WarehouseFolder[]>([]);
const records = ref<WarehouseRecord[]>([]);
const selectedFolderId = usePersistedRef<number | null>("bemby:warehouse:folder", null);
const loadingFolders = ref(false);
const loadingRecords = ref(false);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const search = ref("");
const onlyUnprocessed = ref(false);
const page = ref(1);
const pageSize = usePersistedRef("bemby:warehouse:pageSize", 25);
const selectedFolder = computed(() => folders.value.find((folder) => folder.id === selectedFolderId.value));
const hasFilter = computed(() => !!search.value.trim() || onlyUnprocessed.value);
const orderedFolders = computed(() => {
  const result: (WarehouseFolder & { depth: number })[] = [];
  const visit = (parentId: number | null, depth: number) => {
    for (const folder of folders.value.filter((item) => item.parentId === parentId)) {
      result.push({ ...folder, depth });
      visit(folder.id, depth + 1);
    }
  };
  visit(null, 0);
  return result;
});
const filteredRecords = computed(() => records.value.filter((record) => {
  if (onlyUnprocessed.value && record.processed) return false;
  const needle = search.value.trim().toLocaleLowerCase();
  return !needle || record.name.toLocaleLowerCase().includes(needle) || (!record.sensitive && JSON.stringify(record.data).toLocaleLowerCase().includes(needle));
}));
const visibleRecords = computed(() => filteredRecords.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
watch([search, onlyUnprocessed], () => { page.value = 1; });
watch(() => filteredRecords.value.length, (length) => { page.value = Math.min(page.value, Math.max(1, Math.ceil(length / pageSize.value))); });
const listRequest = createLatestRequest({
  onStart: () => { error.value = ""; },
  onFinish: () => { loadingFolders.value = false; loadingRecords.value = false; },
  onError: (err) => { error.value = message(err); },
});
function message(err: any) { return err.response?.data?.error || err.message || "操作失败"; }
function preview(record: WarehouseRecord) { return Object.entries(record.data).slice(0, 4).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · "); }
async function loadList(includeFolders: boolean) {
  return listRequest.run(async ({ signal, isCurrent, commit }) => {
    loadingFolders.value = includeFolders;
    if (includeFolders) {
      const list = await warehouseApi.folders(signal);
      if (!commit(() => {
        folders.value = list;
        if (!list.some((folder) => folder.id === selectedFolderId.value)) selectedFolderId.value = list[0]?.id ?? null;
        loadingFolders.value = false;
      })) return;
    }
    if (!isCurrent()) return;
    const folderId = selectedFolderId.value;
    if (!folderId) { commit(() => { records.value = []; }); return; }
    loadingRecords.value = true;
    const result = await warehouseApi.records(folderId, false, signal);
    commit(() => { records.value = result; });
    return result;
  });
}
async function reload() { return loadList(true); }
async function selectFolder(id: number) {
  selectedFolderId.value = id; records.value = []; page.value = 1;
  return loadList(false);
}
function changePageSize(value: number) { pageSize.value = value; page.value = 1; }
onMounted(reload);
onUnmounted(() => listRequest.dispose());

const folderFormVisible = ref(false);
const editingFolder = ref<WarehouseFolder | null>(null);
const folderForm = reactive({ name: "", parentId: null as number | null });
const recordFormVisible = ref(false);
const editingRecord = ref<WarehouseRecord | null>(null);
const recordForm = reactive({ name: "", folderId: 0, dataText: "{}", processed: false, sensitive: false });
const formError = ref("");
const allowedParents = computed(() => {
  const excluded = new Set<number>();
  const visit = (id: number) => { excluded.add(id); for (const folder of folders.value.filter((item) => item.parentId === id)) visit(folder.id); };
  if (editingFolder.value) visit(editingFolder.value.id);
  return orderedFolders.value.filter((folder) => !excluded.has(folder.id));
});
function openFolder(folder?: WarehouseFolder) {
  editingFolder.value = folder ?? null;
  Object.assign(folderForm, { name: folder?.name ?? "", parentId: folder?.parentId ?? null });
  formError.value = ""; folderFormVisible.value = true;
}
function openRecord(record?: WarehouseRecord) {
  editingRecord.value = record ?? null;
  Object.assign(recordForm, { name: record?.name ?? "", folderId: record?.folderId ?? selectedFolderId.value, dataText: record ? JSON.stringify(record.data, null, 2) : "{}", processed: record?.processed ?? false, sensitive: record?.sensitive ?? false });
  formError.value = ""; recordFormVisible.value = true;
}
async function saveFolder() {
  busy.value = true; formError.value = "";
  try {
    if (editingFolder.value) await warehouseApi.updateFolder(editingFolder.value.id, folderForm);
    else selectedFolderId.value = (await warehouseApi.createFolder(folderForm)).id;
    folderFormVisible.value = false; await reload();
  } catch (err) { formError.value = message(err); } finally { busy.value = false; }
}
async function saveRecord() {
  formError.value = ""; let data: any;
  try { data = JSON.parse(recordForm.dataText); } catch { formError.value = "JSON 格式无效"; return; }
  if (!data || Array.isArray(data) || typeof data !== "object") { formError.value = "记录数据必须是 JSON 对象"; return; }
  busy.value = true;
  try {
    const payload = { name: recordForm.name, data, processed: recordForm.processed, sensitive: recordForm.sensitive, folderId: recordForm.folderId };
    if (editingRecord.value) await warehouseApi.updateRecord(editingRecord.value.id, payload);
    else await warehouseApi.createRecord(recordForm.folderId, payload);
    selectedFolderId.value = recordForm.folderId; recordFormVisible.value = false; await reload();
  } catch (err) { formError.value = message(err); } finally { busy.value = false; }
}
function deleteFolder() {
  if (!editingFolder.value || busy.value) return;
  deleteTarget.value = { kind: "folder", id: editingFolder.value.id, name: editingFolder.value.name };
}
function folderSiblings() { return folders.value.filter((folder) => folder.parentId === editingFolder.value?.parentId); }
function canMoveFolder(offset: number) { const siblings = folderSiblings(); const index = siblings.findIndex((folder) => folder.id === editingFolder.value?.id); return index >= 0 && index + offset >= 0 && index + offset < siblings.length; }
async function moveFolder(offset: number) {
  if (!editingFolder.value || !canMoveFolder(offset)) return;
  busy.value = true; formError.value = "";
  try {
    const siblings = folderSiblings(); const index = siblings.findIndex((folder) => folder.id === editingFolder.value!.id);
    [siblings[index], siblings[index + offset]] = [siblings[index + offset], siblings[index]];
    await warehouseApi.reorderFolders(editingFolder.value.parentId, siblings.map((folder) => folder.id)); await reload();
  } catch (err) { formError.value = message(err); } finally { busy.value = false; }
}
async function rowOperation(operation: () => Promise<unknown>) {
  busy.value = true; error.value = "";
  try { await operation(); await reload(); } catch (err) { error.value = message(err); } finally { busy.value = false; }
}
function deleteRecord(record: WarehouseRecord) {
  if (!busy.value) deleteTarget.value = { kind: "record", id: record.id, name: record.name };
}
function toggleProcessed(record: WarehouseRecord) { rowOperation(() => warehouseApi.updateRecord(record.id, { processed: !record.processed })); }
function moveRecord(record: WarehouseRecord, offset: number) {
  if (hasFilter.value || !selectedFolderId.value) return;
  const ids = records.value.map((item) => item.id); const index = ids.indexOf(record.id);
  if (index < 0 || index + offset < 0 || index + offset >= ids.length) return;
  [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
  rowOperation(() => warehouseApi.reorderRecords(selectedFolderId.value!, ids));
}

const transferMode = ref<"import" | "export" | null>(null);
const importText = ref("");
const includeSensitive = ref(false);
const deleteTarget = ref<{ kind: "folder" | "record"; id: number; name: string } | null>(null);
const deleteError = ref("");
const deleteDialog = ref<HTMLFormElement | null>(null);
watch(deleteTarget, async (target) => { deleteError.value = ""; if (target) { await nextTick(); deleteDialog.value?.focus(); } });
function closeDelete() { if (!busy.value) deleteTarget.value = null; }
async function executeDelete() {
  if (!deleteTarget.value || busy.value) return;
  busy.value = true; deleteError.value = "";
  const target = deleteTarget.value;
  try {
    if (target.kind === "folder") { await warehouseApi.deleteFolder(target.id); folderFormVisible.value = false; }
    else await warehouseApi.deleteRecord(target.id);
    deleteTarget.value = null;
    await reload();
  } catch (err) { deleteError.value = message(err); } finally { busy.value = false; }
}
function openTransfer(mode: "import" | "export") { transferMode.value = mode; importText.value = ""; includeSensitive.value = false; formError.value = ""; }
async function readImportFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 32 * 1024 * 1024) { formError.value = "导入文件不能超过 32 MB"; return; }
  try { importText.value = await file.text(); formError.value = ""; } catch (err) { formError.value = message(err); }
}
async function transfer() {
  busy.value = true; formError.value = ""; notice.value = "";
  try {
    if (transferMode.value === "import") {
      if (new TextEncoder().encode(importText.value).length > 32 * 1024 * 1024) throw new Error("导入数据不能超过 32 MB");
      const result = await warehouseApi.import(JSON.parse(importText.value));
      notice.value = `已导入 ${result.folders} 个文件夹、${result.records} 条记录`;
      await reload();
    } else {
      const result = await warehouseApi.export(includeSensitive.value);
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "bemby-warehouse.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      notice.value = result.omittedSensitive ? `已导出，排除了 ${result.omittedSensitive} 条敏感记录` : "已导出";
    }
    transferMode.value = null;
  } catch (err) { formError.value = message(err); } finally { busy.value = false; }
}
</script>

<style scoped>
.warehouse-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.warehouse-layout { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 20px; border-top: 1px solid #dce1e6; margin-top: 14px; }
.warehouse-folders { border-right: 1px solid #dce1e6; min-width: 0; padding: 12px 12px 12px 0; }
.warehouse-sidebar-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-size: 13px; }
.folder-row { display: flex; align-items: center; margin-bottom: 3px; border-radius: 4px; }
.folder-row.active { background: #e5eef3; }
.folder-select { display: flex; align-items: center; gap: 8px; border: 0; background: transparent; text-align: left; padding: 9px 4px; min-width: 0; flex: 1; cursor: pointer; color: inherit; }
.folder-select span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-select small { color: #777; white-space: nowrap; }
.warehouse-records { min-width: 0; padding-top: 12px; }
.warehouse-table-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.warehouse-table-tools h3 { margin: 0 auto 0 0; font-size: 15px; overflow-wrap: anywhere; }
.warehouse-table-tools .form-input { width: 200px; }
.record-name { width: 25%; min-width: 80px; max-width: 200px; overflow-wrap: break-word; word-break: normal; }
.record-preview { max-width: 350px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: #66717b; }
.status-toggle { border: 0; background: transparent; color: #777; white-space: nowrap; cursor: pointer; padding: 4px 0; min-height: 28px; }
.status-toggle.processed { color: #19815e; }
.record-json { font-family: monospace; resize: vertical; overflow-wrap: anywhere; }
@media (max-width: 850px) {
  .warehouse-layout { grid-template-columns: 1fr; gap: 8px; }
  .warehouse-folders { border-right: 0; border-bottom: 1px solid #dce1e6; padding: 8px 0; max-height: 220px; overflow-y: auto; }
  .warehouse-table-tools .form-input { flex: 1; min-width: 140px; }
  .record-preview { max-width: 180px; }
}
</style>
