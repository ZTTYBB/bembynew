<template>
  <section class="task-queue-panel">
    <div class="queue-heading">
      <button type="button" class="queue-toggle" :aria-expanded="expanded" @click="toggleExpanded">
        <i class="fa-solid" :class="expanded ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
        <strong>{{ w("queue") }}</strong>
        <span v-if="batches.length" class="badge badge-grey">{{ batches.length }}</span>
        <span v-if="activeCount" class="badge badge-blue">{{ w("running") }} {{ activeCount }}</span>
      </button>
      <button type="button" class="btn btn-sm btn-ghost btn-icon" :disabled="loading" :title="w('refresh')" :aria-label="w('refresh')" @click="refresh">
        <i class="fa-solid fa-arrows-rotate" :class="{ 'fa-spin': loading }"></i>
      </button>
    </div>
    <div v-if="expanded" class="queue-body">
      <div v-if="error" class="error-msg" role="alert">{{ error }}</div>
      <div v-if="!batches.length && !loading" class="queue-empty">{{ w("noBatches") }}</div>
      <template v-if="batches.length">
        <label class="queue-batch-select">
          <span>{{ w("batch") }}</span>
          <select v-model="selectedId" class="form-select" @change="refresh">
            <option v-for="batch in batches" :key="batch.id" :value="batch.id">
              {{ batch.createdAt ? formatTime(batch.createdAt) : batch.id.slice(0, 8) }} · {{ w(batch.state) }} · {{ batch.done }}/{{ batch.total }}
            </option>
          </select>
        </label>
        <template v-if="selectedBatch">
          <div class="queue-summary">
            <span :class="stateClass(selectedBatch.state)">{{ w(selectedBatch.state) }}</span>
            <span>{{ w("progress") }} {{ selectedBatch.done }} / {{ selectedBatch.total }}</span>
            <span>{{ w("failed") }} {{ selectedBatch.failed }}</span>
            <span>{{ w("concurrency") }} {{ selectedBatch.concurrency }}</span>
            <span>{{ w("startInterval") }} {{ selectedBatch.startIntervalSeconds }}</span>
            <div class="queue-tools">
              <button v-if="selectedBatch.state === 'running'" type="button" class="btn btn-sm btn-secondary btn-icon" :disabled="actionBusy" :title="w('pause')" :aria-label="w('pause')" @click="act('pause')"><i class="fa-solid fa-pause"></i></button>
              <button v-if="selectedBatch.state === 'paused'" type="button" class="btn btn-sm btn-secondary btn-icon" :disabled="actionBusy" :title="w('resume')" :aria-label="w('resume')" @click="act('resume')"><i class="fa-solid fa-play"></i></button>
              <button v-if="selectedBatch.state === 'running' || selectedBatch.state === 'paused'" type="button" class="btn btn-sm btn-danger btn-icon" :disabled="actionBusy" :title="w('stop')" :aria-label="w('stop')" @click="confirmation = 'cancel'"><i class="fa-solid fa-stop"></i></button>
              <button v-if="selectedBatch.failed > 0 && selectedBatch.state !== 'cancelled'" type="button" class="btn btn-sm btn-secondary btn-icon" :disabled="actionBusy" :title="w('retry')" :aria-label="w('retry')" @click="confirmation = 'retry-failed'"><i class="fa-solid fa-rotate-right"></i></button>
            </div>
          </div>
          <progress :max="Math.max(1, selectedBatch.total)" :value="selectedBatch.done" :aria-label="w('progress')"></progress>
          <div v-if="confirmation" class="queue-confirm" role="alert">
            <span>{{ w(confirmation === "cancel" ? "confirmCancel" : "confirmRetry") }}</span>
            <button type="button" class="btn btn-sm btn-ghost" :disabled="actionBusy" @click="confirmation = null">{{ w("cancel") }}</button>
            <button type="button" class="btn btn-sm" :class="confirmation === 'cancel' ? 'btn-danger' : 'btn-primary'" :disabled="actionBusy" @click="act(confirmation)">
              <i class="fa-solid" :class="confirmation === 'cancel' ? 'fa-stop' : 'fa-rotate-right'"></i> {{ w(confirmation === "cancel" ? "stop" : "retry") }}
            </button>
          </div>
          <ul class="queue-items">
            <li v-for="item in selectedBatch.items" :key="item.id" class="queue-item">
              <span :class="stateClass(item.status)">{{ w(item.status) }}</span>
              <div class="queue-item-names"><strong>{{ item.jobName }}</strong><span>{{ item.accountName || '-' }}</span></div>
              <span v-if="item.logId" class="queue-log-id">{{ w("log") }} #{{ item.logId }}</span>
              <span v-if="item.error" class="queue-item-error" :title="item.error">{{ item.error }}</span>
            </li>
          </ul>
        </template>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { t, locale } from "../i18n";
import { taskQueueApi, type TaskBatch, type TaskBatchSummary } from "../api/taskQueue";

const emit = defineEmits<{ changed: [] }>();
const w = (key: string) => t(`accountWorkflow.${key}`);
const expanded = ref(false);
const batches = ref<TaskBatchSummary[]>([]);
const selectedId = ref("");
const selectedBatch = ref<TaskBatch | null>(null);
const loading = ref(false);
const error = ref("");
const actionBusy = ref(false);
const confirmation = ref<"cancel" | "retry-failed" | null>(null);
const activeCount = computed(() => batches.value.filter((batch) => batch.state === "running" || batch.state === "paused").length);
let timer: ReturnType<typeof setTimeout> | undefined;
let requestId = 0;
let disposed = false;
let previousDone = new Map<string, number>();

function stateClass(state: string) {
  const color = state === "success" || state === "completed" ? "green"
    : state === "failed" ? "red" : state === "running" ? "blue"
      : state === "paused" || state === "pending" ? "orange" : "grey";
  return `badge badge-${color}`;
}
function formatTime(value: string) {
  return new Date(value).toLocaleString(locale.value === "zh" ? "zh-CN" : "en-AU", { dateStyle: "short", timeStyle: "short" });
}
function scheduleRefresh() {
  if (timer) clearTimeout(timer);
  if (!disposed && !document.hidden && (activeCount.value || expanded.value)) {
    timer = setTimeout(() => void refresh(), error.value ? 5000 : 2000);
  }
}
async function refresh() {
  if (disposed) return;
  if (timer) clearTimeout(timer);
  const request = ++requestId;
  loading.value = true;
  try {
    const list = await taskQueueApi.list();
    if (disposed || request !== requestId) return;
    const changed = list.some((batch) => previousDone.has(batch.id) && previousDone.get(batch.id) !== batch.done);
    previousDone = new Map(list.map((batch) => [batch.id, batch.done]));
    batches.value = list;
    if (!list.some((batch) => batch.id === selectedId.value)) selectedId.value = list[0]?.id ?? "";
    if (expanded.value && selectedId.value) {
      const selected = selectedId.value;
      const detail = await taskQueueApi.get(selected);
      if (disposed || request !== requestId || selected !== selectedId.value) return;
      selectedBatch.value = detail;
    } else {
      selectedBatch.value = null;
    }
    error.value = "";
    if (changed) emit("changed");
  } catch (err: any) {
    if (!disposed && request === requestId) error.value = err.response?.data?.error ?? w("loadFailed");
  } finally {
    if (!disposed && request === requestId) {
      loading.value = false;
      scheduleRefresh();
    }
  }
}
function toggleExpanded() {
  expanded.value = !expanded.value;
  void refresh();
}
async function focusBatch(id: string) {
  selectedId.value = id;
  expanded.value = true;
  await refresh();
}
async function act(action: "pause" | "resume" | "cancel" | "retry-failed") {
  if (actionBusy.value || !selectedId.value) return;
  const id = selectedId.value;
  actionBusy.value = true;
  try {
    const updated = await taskQueueApi.action(id, action);
    if (disposed || selectedId.value !== id) return;
    selectedBatch.value = updated;
    confirmation.value = null;
    error.value = "";
    emit("changed");
    await refresh();
  } catch (err: any) {
    if (!disposed) error.value = err.response?.data?.error ?? w("saveFailed");
  } finally {
    actionBusy.value = false;
  }
}
function onVisibility() {
  if (!document.hidden) void refresh();
  else if (timer) clearTimeout(timer);
}
watch(selectedId, () => { confirmation.value = null; selectedBatch.value = null; });
onMounted(() => {
  void refresh();
  document.addEventListener("visibilitychange", onVisibility);
});
onUnmounted(() => {
  disposed = true;
  requestId++;
  if (timer) clearTimeout(timer);
  document.removeEventListener("visibilitychange", onVisibility);
});
defineExpose({ focusBatch, refresh });
</script>

<style scoped>
.task-queue-panel { border-top: 1px solid #dce1e7; border-bottom: 1px solid #dce1e7; margin: 0 0 16px; padding: 8px 0; min-width: 0; }
.queue-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.queue-toggle { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; padding: 6px 0; border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.queue-toggle > i { width: 14px; font-size: 11px; }
.queue-toggle strong { font-size: 14px; }
.queue-body { display: grid; gap: 12px; padding: 10px 0; min-width: 0; }
.queue-empty { color: #68717e; padding: 8px 0; }
.queue-batch-select { display: flex; align-items: center; gap: 10px; min-width: 0; }
.queue-batch-select .form-select { min-width: 0; flex: 1; max-width: 580px; }
.queue-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 12px; }
.queue-tools { display: flex; gap: 6px; margin-left: auto; }
progress { display: block; width: 100%; height: 8px; accent-color: #187d69; }
.queue-confirm { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 10px; border-left: 3px solid #bd751b; background: #fff5e5; }
.queue-confirm > span { margin-right: auto; font-size: 13px; }
.queue-items { list-style: none; display: grid; max-height: 320px; overflow: auto; padding: 0; }
.queue-item { display: grid; grid-template-columns: 70px minmax(0, 1fr) auto; align-items: start; gap: 6px 12px; padding: 9px 0; border-bottom: 1px solid #e5e8ec; }
.queue-item > .badge { justify-self: start; }
.queue-item-names { display: grid; gap: 3px; min-width: 0; overflow-wrap: anywhere; }
.queue-item-names strong { font-size: 13px; font-weight: 500; }
.queue-item-names > span, .queue-log-id { color: #68717e; font-size: 12px; }
.queue-item-error { grid-column: 2 / -1; color: #b53838; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 520px) {
  .queue-batch-select { display: grid; gap: 5px; }
  .queue-item { grid-template-columns: 62px minmax(0, 1fr); gap: 6px 8px; }
  .queue-log-id, .queue-item-error { grid-column: 2; }
}
</style>
