<template>
  <section :class="collapsible ? 'card sched-card' : 'sched-page'">
    <div class="sched-head">
      <button v-if="collapsible" class="sched-toggle" :aria-expanded="open" @click="open = !open">
        <i :class="open ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'"></i>
        {{ t('jobs.nextRuns') }}
      </button>
      <span class="sched-count">{{ items.length }}</span>
      <span v-if="nextItem" class="sched-summary" :title="`${nextItem.jobName} · ${fmtDateTime(nextItem)} · ${nextItem.timezone}`">
        {{ t('jobs.nextUp') }}: <strong>{{ nextItem.jobName }}</strong> · {{ fmtDateTime(nextItem) }}
      </span>
      <button
        class="btn btn-sm btn-ghost btn-icon"
        :disabled="loading || !!busy || !items.length" :title="t('schedules.shuffleAll')" :aria-label="t('schedules.shuffleAll')"
        @click="confirmShuffle()"
      ><i class="fa-solid fa-shuffle"></i></button>
      <button
        class="btn btn-sm btn-ghost btn-icon sched-refresh"
        :disabled="loading || !!busy" :title="t('schedules.refresh')" :aria-label="t('schedules.refresh')"
        @click="load"
      ><i :class="loading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-rotate'"></i></button>
    </div>
    <div v-if="!collapsible || open" :class="collapsible ? 'sched-body' : ''">
      <div v-if="loadError" class="error-msg sched-feedback" role="alert">{{ loadError }}</div>
      <div v-if="notice" class="sched-notice" role="status">
        <span>{{ notice }}</span>
        <button class="btn btn-sm btn-ghost btn-icon" :title="t('schedules.close')" :aria-label="t('schedules.close')" @click="notice = ''"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <ScheduleBody
        :by-day="byDay" :next-job-id="nextItem?.jobId ?? null" :skipping="skipping"
        :scroll="!!collapsible" :busy="!!busy"
        :empty-message="loading && !items.length ? t('schedules.loading') : search ? t('schedules.noMatch') : t('schedules.noSchedules')"
        v-model:search="search"
        @inspect="inspect" @pin="pin" @skip="confirmSkip" @shuffle="confirmShuffle"
      />
    </div>
    <Teleport to="body">
      <div v-if="showDialog" class="modal-backdrop" @click.self="closeDialog">
        <form ref="dialogElement" class="modal sched-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title" @submit.prevent="confirmation ? executeConfirmation() : save()">
          <div class="sched-dialog-head">
            <h3 id="schedule-dialog-title" class="modal-title">{{ confirmation ? t(confirmation.kind === 'skip' ? 'schedules.skip' : 'schedules.shuffle') : t(editing ? 'schedules.editTime' : 'schedules.details') }}</h3>
            <button type="button" class="btn btn-sm btn-ghost btn-icon" :disabled="!!busy" :title="t('schedules.close')" :aria-label="t('schedules.close')" @click="closeDialog"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="modal-body">
            <div v-if="dialogError" class="error-msg" role="alert">{{ dialogError }}</div>
            <p v-if="confirmation" class="sched-confirm-copy">{{ confirmationText }}</p>
            <template v-else-if="selected">
              <h4 class="sched-job-name">{{ selected.jobName }}</h4>
              <dl class="sched-details">
                <dt>{{ t('schedules.type') }}</dt><dd>{{ t(`logs.jobType.${selected.jobType}`) }}</dd>
                <dt>{{ t('schedules.state') }}</dt><dd>{{ t(`schedules.${selected.state}`) }}</dd>
                <dt>{{ t('schedules.nextRun') }}</dt><dd>{{ fmtDateTime(selected, true) }}</dd>
                <dt>{{ t('schedules.timezone') }}</dt><dd>{{ selected.timezone }}</dd>
                <dt>{{ t('schedules.utcTime') }}</dt><dd class="sched-instant">{{ selected.nextRun }}</dd>
                <dt>{{ t('schedules.pin') }}</dt><dd>{{ t(selected.pinned ? 'common.yes' : 'common.no') }}</dd>
                <dt>{{ t('schedules.jobId') }} / {{ t('schedules.revision') }}</dt><dd>{{ selected.jobId }} / {{ selected.revision }}</dd>
              </dl>
              <fieldset v-if="editing" class="sched-edit-fields" :disabled="!!busy">
                <div class="form-group">
                  <label class="form-label" for="schedule-timezone">{{ t('schedules.timezone') }}</label>
                  <input id="schedule-timezone" v-model.trim="form.timezone" class="form-input" list="schedule-timezones" required autocomplete="off" @input="form.instant = ''" />
                  <datalist id="schedule-timezones"><option v-for="zone in timezoneOptions" :key="zone" :value="zone" /></datalist>
                </div>
                <div class="form-group">
                  <label class="form-label" for="schedule-next-run">{{ t('schedules.nextRun') }}</label>
                  <input id="schedule-next-run" v-model="form.localTime" class="form-input" type="datetime-local" step="1" required @input="form.instant = ''" />
                </div>
                <div v-if="timeResolution.candidates.length > 1" class="form-group">
                  <label class="form-label" for="schedule-offset">{{ t('schedules.utcOffset') }}</label>
                  <select id="schedule-offset" v-model="form.instant" class="form-select" required>
                    <option value="" disabled>{{ t('schedules.utcOffset') }}</option>
                    <option v-for="instant in timeResolution.candidates" :key="instant" :value="instant">{{ utcOffsetLabel(instant, form.timezone) }}</option>
                  </select>
                </div>
                <div v-if="selectedInstant" class="sched-preview">{{ selectedInstant }}</div>
                <label class="form-check"><input v-model="form.pinned" type="checkbox" /><span>{{ t('schedules.pinNext') }}</span></label>
              </fieldset>
            </template>
          </div>
          <div class="modal-footer sched-dialog-footer">
            <button type="button" class="btn btn-secondary" :disabled="!!busy" @click="cancelDialog">{{ t('schedules.cancel') }}</button>
            <button v-if="confirmation" type="submit" class="btn" :class="confirmation.kind === 'skip' ? 'btn-danger' : 'btn-primary'" :disabled="!!busy">
              <i :class="busy ? 'fa-solid fa-spinner fa-spin' : confirmation.kind === 'skip' ? 'fa-solid fa-forward-step' : 'fa-solid fa-shuffle'"></i>{{ t('schedules.confirm') }}
            </button>
            <button v-else-if="editing" type="submit" class="btn btn-primary" :disabled="!!busy"><i :class="busy ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-floppy-disk'"></i>{{ t('schedules.save') }}</button>
            <button v-else-if="selected" type="button" class="btn btn-primary" :disabled="!!busy || selected.state === 'dispatching'" @click="beginEdit"><i class="fa-solid fa-pen"></i>{{ t('schedules.editTime') }}</button>
          </div>
        </form>
      </div>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { schedulesApi, type ScheduledJob } from '../api/schedules';
import { t, locale } from '../i18n';
import { usePersistedRef } from '../composables/usePersistedRef';
import ScheduleBody from './ScheduleBody.vue';
import { resolveZonedInput, utcOffsetLabel, zonedInput } from '../utils/scheduleTime';

// Upcoming scheduled runs. Rendered either as the collapsible card on the jobs page or as a
// page of its own (see the schedulePage setting), so both stay in step from one place.
defineProps<{ collapsible?: boolean }>();
const emit = defineEmits<{ changed: [] }>();

const items = ref<ScheduledJob[]>([]);
const loading = ref(false);
const search = ref('');
const skipping = ref<number | null>(null);
const open = usePersistedRef<boolean>('bemby:jobs:schedOpen', true);
const busy = ref('');
const loadError = ref('');
const dialogError = ref('');
const notice = ref('');
const selectedId = ref<number | null>(null);
const editing = ref(false);
const editingRevision = ref(0);
const confirmation = ref<{ kind: 'skip'; jobId: number; name: string } | { kind: 'shuffle'; date?: string; count: number } | null>(null);
const dialogElement = ref<HTMLElement | null>(null);
const form = reactive({ localTime: '', timezone: 'UTC', instant: '', pinned: false });
const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const timezoneOptions = [...new Set([browserTimezone, 'UTC', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles'])];
const selected = computed(() => items.value.find((item) => item.jobId === selectedId.value) ?? null);
const showDialog = computed(() => confirmation.value !== null || selected.value !== null);
const timeResolution = computed(() => {
  if (!editing.value) return { candidates: [] as string[], error: '' };
  try { return { candidates: resolveZonedInput(form.localTime, form.timezone), error: '' }; }
  catch (error) { return { candidates: [] as string[], error: error instanceof Error ? error.message : 'invalidTime' }; }
});
const selectedInstant = computed(() => timeResolution.value.candidates.length === 1
  ? timeResolution.value.candidates[0]
  : timeResolution.value.candidates.includes(form.instant) ? form.instant : '');
const confirmationText = computed(() => {
  const value = confirmation.value;
  if (!value) return '';
  return value.kind === 'skip'
    ? t('schedules.confirmSkip').replace('{name}', value.name)
    : (value.date ? t('schedules.confirmShuffle').replace('{date}', value.date) : t('schedules.confirmShuffleAll'))
      .replace('{n}', String(value.count));
});
let disposed = false;
let requestNumber = 0;
let activeRequest: AbortController | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let previousFocus: HTMLElement | null = null;

const sorted = computed(() =>
  [...items.value].sort((a, b) => a.nextRun.localeCompare(b.nextRun)),
);
const nextItem = computed(() => sorted.value.find((item) => item.state === 'pending') ?? null);

/** A day's shuffle uses each plan's timezone, so its group must use the same date. */
const byDay = computed(() => {
  const q = search.value.toLowerCase();
  const filtered = q
    ? sorted.value.filter((s) => s.jobName.toLowerCase().includes(q))
    : sorted.value;
  const groups = new Map<string, { key: string; label: string; items: ScheduledJob[] }>();
  for (const s of filtered) {
    const key = zonedInput(s.nextRun, s.timezone).slice(0, 10);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: fmtDayLabel(key), items: [] };
      groups.set(key, g);
    }
    g.items.push(s);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
});

function localeTag() {
  return ({ en: 'en-AU', zh: 'zh-CN' } as Record<string, string>)[locale.value] ?? 'en-AU';
}

function fmtDateTime(item: ScheduledJob, full = false) {
  return new Date(item.nextRun).toLocaleString(localeTag(), {
    ...(full ? { year: 'numeric' as const, second: '2-digit' as const } : {}),
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: item.timezone,
  });
}

function fmtDayLabel(date: string) {
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString(localeTag(), { weekday: 'short', timeZone: 'UTC' });
  return `${date} · ${weekday}`;
}

async function load() {
  const sequence = ++requestNumber;
  activeRequest?.abort();
  const controller = new AbortController();
  activeRequest = controller;
  loading.value = true;
  loadError.value = '';
  try {
    const rows = await schedulesApi.list(controller.signal);
    if (disposed || sequence !== requestNumber) return;
    items.value = rows.map((row) => ({
      ...row, timezone: row.timezone || browserTimezone, pinned: !!row.pinned,
      state: row.state || 'pending', revision: row.revision || 1,
    }));
  } catch (error: any) {
    if (!disposed && !controller.signal.aborted && sequence === requestNumber) {
      loadError.value = error.response?.data?.error ?? t('schedules.loadFailed');
    }
  } finally {
    if (!disposed && sequence === requestNumber) loading.value = false;
  }
}

function inspect(jobId: number) {
  selectedId.value = jobId;
  editing.value = false;
  dialogError.value = '';
}

function beginEdit() {
  if (!selected.value || selected.value.state === 'dispatching') return;
  editing.value = false;
  form.timezone = selected.value.timezone;
  form.localTime = zonedInput(selected.value.nextRun, form.timezone);
  form.instant = new Date(selected.value.nextRun).toISOString();
  form.pinned = selected.value.pinned;
  editingRevision.value = selected.value.revision;
  dialogError.value = '';
  editing.value = true;
  void nextTick(() => dialogElement.value?.querySelector<HTMLInputElement>('#schedule-timezone')?.focus());
}

function closeDialog() {
  if (busy.value) return;
  selectedId.value = null;
  confirmation.value = null;
  editing.value = false;
  dialogError.value = '';
}

function cancelDialog() {
  if (busy.value) return;
  if (confirmation.value && selected.value) confirmation.value = null;
  else if (editing.value) editing.value = false;
  else closeDialog();
  dialogError.value = '';
}

async function pin(jobId: number, pinned: boolean) {
  if (busy.value) return;
  busy.value = `pin:${jobId}`;
  try {
    await schedulesApi.pin(jobId, pinned);
    await load();
    if (!disposed) { notice.value = t('schedules.pinSaved'); emit('changed'); }
  } catch (error: any) {
    if (!disposed) loadError.value = error.response?.data?.error ?? t('schedules.actionFailed');
  } finally { busy.value = ''; }
}

async function save() {
  const item = selected.value;
  if (!item || !editing.value || confirmation.value || busy.value) return;
  dialogError.value = '';
  if (timeResolution.value.error) { dialogError.value = t(`schedules.${timeResolution.value.error}`); return; }
  if (!selectedInstant.value) { dialogError.value = t('schedules.ambiguousTime'); return; }
  if (Date.parse(selectedInstant.value) <= Date.now()) { dialogError.value = t('schedules.futureTime'); return; }
  if (item.revision !== editingRevision.value) { dialogError.value = t('schedules.stalePlan'); return; }
  busy.value = `save:${item.jobId}`;
  try {
    await schedulesApi.update(item.jobId, {
      nextRun: selectedInstant.value, timezone: form.timezone, pinned: form.pinned,
      expectedRevision: editingRevision.value,
    });
    await load();
    if (!disposed) {
      editing.value = false;
      selectedId.value = null;
      notice.value = t('schedules.saved');
      emit('changed');
    }
  } catch (error: any) {
    if (!disposed) dialogError.value = error.response?.data?.error ?? t('schedules.saveFailed');
  } finally { busy.value = ''; }
}

function confirmSkip(jobId: number) {
  if (busy.value) return;
  const item = items.value.find((row) => row.jobId === jobId);
  if (!item || item.state !== 'pending') return;
  dialogError.value = '';
  confirmation.value = { kind: 'skip', jobId, name: item.jobName };
}

function confirmShuffle(date?: string) {
  if (busy.value) return;
  dialogError.value = '';
  confirmation.value = { kind: 'shuffle', date,
    count: items.value.filter((item) => date === undefined || zonedInput(item.nextRun, item.timezone).slice(0, 10) === date).length };
}

async function executeConfirmation() {
  const action = confirmation.value;
  if (!action || busy.value) return;
  busy.value = action.kind;
  dialogError.value = '';
  try {
    let message = '';
    if (action.kind === 'skip') {
      skipping.value = action.jobId;
      await schedulesApi.skip(action.jobId);
      message = t('schedules.skipDone');
    } else {
      const result = await schedulesApi.shuffle(action.date);
      message = t('schedules.shuffleResult').replace('{moved}', String(result.moved)).replace('{protected}', String(result.protected));
    }
    await load();
    if (!disposed) {
      confirmation.value = null;
      selectedId.value = null;
      editing.value = false;
      notice.value = message;
      emit('changed');
    }
  } catch (error: any) {
    if (!disposed) dialogError.value = error.response?.data?.error ?? t('schedules.actionFailed');
  } finally {
    skipping.value = null;
    busy.value = '';
  }
}

function onDialogKey(event: KeyboardEvent) {
  if (!showDialog.value) return;
  if (event.key === 'Escape') { event.preventDefault(); closeDialog(); return; }
  if (event.key !== 'Tab') return;
  const controls = [...(dialogElement.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])];
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first || !last) { event.preventDefault(); return; }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

watch(showDialog, async (visible) => {
  if (visible) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    dialogElement.value?.querySelector<HTMLElement>(
      confirmation.value ? 'button[type="submit"]:not(:disabled)' : 'button:not(:disabled)',
    )?.focus();
  } else previousFocus?.focus();
});

onMounted(() => {
  void load();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !busy.value && !showDialog.value) void load();
  }, 15_000);
  document.addEventListener('keydown', onDialogKey);
});
onUnmounted(() => {
  disposed = true;
  activeRequest?.abort();
  if (pollTimer) clearInterval(pollTimer);
  document.removeEventListener('keydown', onDialogKey);
});
defineExpose({ reload: load });
</script>

<style scoped>
.sched-card {
  margin-bottom: 16px;
  padding: 0;
  overflow: hidden;
}
.sched-head {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  text-align: left;
}
.sched-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  border: 0;
  background: none;
  padding: 0;
  color: #555;
  cursor: pointer;
  min-width: 0;
  letter-spacing: 0;
}
.sched-toggle .fa-solid {
  font-size: 11px;
  color: #aaa;
}
.sched-body {
  padding: 0 18px 14px;
}
.sched-page > .sched-head {
  padding: 0 0 12px;
}
.sched-count {
  font-size: 11px;
  font-weight: 600;
  color: #555;
  background: #eef0f4;
  border-radius: 4px;
  padding: 1px 8px;
  letter-spacing: 0;
}
.sched-summary {
  font-size: 13px;
  color: #888;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.sched-summary strong {
  color: #333;
}
.sched-refresh {
  margin-left: auto;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
}
.sched-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 10px;
  margin-bottom: 10px;
  background: #edf7f2;
  color: #246447;
  font-size: 13px;
}
.sched-feedback {
  margin-bottom: 10px;
}
.sched-dialog {
  width: 520px;
  border-radius: 8px;
}
.sched-dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.sched-dialog-head .modal-title {
  margin-bottom: 16px;
}
.sched-job-name {
  margin: 0 0 16px;
  font-size: 16px;
  overflow-wrap: anywhere;
}
.sched-details {
  display: grid;
  grid-template-columns: minmax(85px, 1fr) minmax(0, 2fr);
  gap: 10px 16px;
  margin: 0;
  font-size: 13px;
}
.sched-details dt {
  color: #7b8190;
}
.sched-details dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.sched-instant,
.sched-preview {
  font-variant-numeric: tabular-nums;
}
.sched-edit-fields {
  margin: 18px 0 0;
  padding: 18px 0 0;
  border: 0;
  border-top: 1px solid #e9edf2;
  min-width: 0;
}
.sched-edit-fields input {
  min-width: 0;
}
.sched-preview {
  color: #647387;
  font-size: 12px;
  overflow-wrap: anywhere;
  margin: -4px 0 14px;
}
.sched-confirm-copy {
  margin: 0;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.sched-dialog-footer {
  flex-wrap: wrap;
}
@media (max-width: 600px) {
  .sched-head {
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px;
  }
  .sched-summary {
    order: 2;
    width: 100%;
  }
  .sched-body {
    padding: 0 12px 12px;
  }
  .sched-dialog {
    padding: 18px;
  }
  .sched-details {
    grid-template-columns: minmax(75px, 1fr) minmax(0, 1.7fr);
    gap: 10px;
  }
}
</style>
