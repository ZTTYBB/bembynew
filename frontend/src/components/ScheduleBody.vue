<template>
  <div>
    <input
      :value="search"
      class="form-input sched-search"
      :placeholder="t('jobs.filterPlaceholder')"
      @input="$emit('update:search', ($event.target as HTMLInputElement).value)"
    />
    <div :class="scroll ? 'sched-scroll' : ''">
      <div v-for="day in byDay" :key="day.key" class="sched-day">
        <div class="sched-day-head">
          <span class="sched-day-label">{{ day.label }}</span>
          <span class="sched-day-count">{{ day.items.length }}</span>
          <button
            class="btn btn-sm btn-ghost btn-icon sched-day-shuffle"
            :disabled="busy"
            :title="`${t('schedules.shuffle')} · ${day.key}`"
            :aria-label="`${t('schedules.shuffle')} ${day.key}`"
            @click="$emit('shuffle', day.key)"
          ><i class="fa-solid fa-shuffle"></i></button>
        </div>
        <div class="sched-day-items">
          <span
            v-for="s in day.items"
            :key="s.jobId"
            class="sched-chip"
            :class="[`sched-type-${s.jobType}`, { 'sched-chip-next': s.jobId === nextJobId, 'sched-chip-interrupted': s.state === 'interrupted' }]"
          >
            <button
              class="sched-open"
              :title="`${t('schedules.details')} · ${s.jobName}`"
              :aria-label="`${t('schedules.details')} ${s.jobName}`"
              @click="$emit('inspect', s.jobId)"
            >
              <i class="sched-type-icon" :class="typeIcon(s.jobType)"></i>
              <span class="sched-chip-content">
                <span class="sched-primary">
                  <span class="sched-time">{{ fmtTime(s.nextRun, s.timezone) }}</span>
                  <span class="sched-name">{{ s.jobName }}</span>
                </span>
                <span class="sched-meta">{{ s.timezone }}<template v-if="s.state !== 'pending'"> · {{ t(`schedules.${s.state}`) }}</template></span>
              </span>
            </button>
            <button
              class="sched-tool"
              :class="{ 'sched-tool-pinned': s.pinned }"
              :disabled="busy || s.state !== 'pending'"
              :aria-pressed="s.pinned"
              :title="t(s.pinned ? 'schedules.unpin' : 'schedules.pin')"
              :aria-label="`${t(s.pinned ? 'schedules.unpin' : 'schedules.pin')} ${s.jobName}`"
              @click="$emit('pin', s.jobId, !s.pinned)"
            ><i class="fa-solid fa-thumbtack"></i></button>
            <button
              class="sched-tool sched-skip"
              :disabled="busy || s.state !== 'pending'"
              :title="t('jobs.skipRunHint')"
              :aria-label="`${t('schedules.skip')} ${s.jobName}`"
              @click.stop="$emit('skip', s.jobId)"
            >
              <i
                :class="
                  skipping === s.jobId
                    ? 'fa-solid fa-spinner fa-spin'
                    : 'fa-solid fa-xmark'
                "
              ></i>
            </button>
          </span>
        </div>
      </div>
      <div v-if="!byDay.length" class="sched-empty">{{ emptyMessage || t('schedules.noMatch') }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t, locale } from '../i18n';
import type { ScheduledJob } from '../api/schedules';

// The chips themselves, shared by the card and the full page so a change lands in both.
defineProps<{
  byDay: Array<{ key: string; label: string; items: ScheduledJob[] }>;
  nextJobId: number | null;
  skipping: number | null;
  search: string;
  scroll: boolean;
  busy: boolean;
  emptyMessage?: string;
}>();
defineEmits<{
  'update:search': [string];
  skip: [number];
  inspect: [number];
  pin: [number, boolean];
  shuffle: [string];
}>();

// One icon and colour per job type, so a crowded day is readable at a glance
const TYPE_ICONS: Record<string, string> = {
  checkin: 'fa-solid fa-circle-check',
  embywatch: 'fa-solid fa-film',
  custom: 'fa-solid fa-list-check',
  autoreg: 'fa-solid fa-user-plus',
};

function typeIcon(type: string): string {
  return TYPE_ICONS[type] ?? 'fa-solid fa-clock';
}

function fmtTime(iso: string, timezone: string) {
  const tag = ({ en: 'en-AU', zh: 'zh-CN' } as Record<string, string>)[locale.value] ?? 'en-AU';
  return new Date(iso).toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit', timeZone: timezone });
}
</script>

<style scoped>
.sched-search {
  width: 100%;
  height: 32px;
  font-size: 13px;
  padding: 0 10px;
  margin-bottom: 12px;
}
.sched-scroll {
  max-height: 340px;
  overflow-y: auto;
}
.sched-day {
  margin-bottom: 12px;
}
.sched-day-head {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0 6px;
  margin-bottom: 6px;
  background: #fff;
  border-bottom: 1px solid #eef0f4;
  z-index: 1;
}
.sched-day-label {
  font-size: 12px;
  font-weight: 600;
  color: #444;
}
.sched-day-count {
  font-size: 11px;
  color: #999;
  background: #f2f3f6;
  border-radius: 4px;
  padding: 0 7px;
}
.sched-day-items {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
  gap: 6px;
}
.sched-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12.5px;
  padding: 3px 6px 3px 9px;
  border-radius: 6px;
  background: #f5f6f8;
  border: 1px solid transparent;
  border-left: 3px solid #c9ced8;
}
.sched-type-icon {
  font-size: 10.5px;
  color: #8b93a3;
  flex-shrink: 0;
}
.sched-time {
  font-weight: 600;
  color: #4361ee;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.sched-name {
  min-width: 0;
  color: #444;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sched-tool {
  border: none;
  background: none;
  width: 28px;
  height: 30px;
  padding: 0;
  font-size: 12px;
  line-height: 1;
  color: #b6bcc8;
  cursor: pointer;
  flex-shrink: 0;
}
.sched-skip:hover:not(:disabled) {
  color: #e63946;
}
.sched-tool:disabled {
  opacity: 0.45;
  cursor: default;
}
.sched-tool-pinned {
  color: #b45309;
}
.sched-tool:hover:not(:disabled) {
  background: #e9edf4;
  border-radius: 4px;
}
.sched-day-shuffle {
  margin-left: auto;
  width: 28px;
  height: 28px;
}
.sched-open {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  border: 0;
  padding: 4px 0;
  background: none;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.sched-open:focus-visible,
.sched-tool:focus-visible {
  outline: 2px solid #4361ee;
  outline-offset: 2px;
}
.sched-chip-content {
  min-width: 0;
  flex: 1;
}
.sched-primary {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sched-meta {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
  font-size: 10px;
  color: #737c89;
}
.sched-chip-interrupted {
  background: #fff5f4;
  border-color: #f2cbc8;
}

/* Colour by job type: the left edge and the icon, so the chip stays readable */
.sched-type-checkin {
  border-left-color: #4361ee;
}
.sched-type-checkin .sched-type-icon {
  color: #4361ee;
}
.sched-type-embywatch {
  border-left-color: #8b5cf6;
}
.sched-type-embywatch .sched-type-icon {
  color: #8b5cf6;
}
.sched-type-custom {
  border-left-color: #0d9488;
}
.sched-type-custom .sched-type-icon {
  color: #0d9488;
}
.sched-type-autoreg {
  border-left-color: #d97706;
}
.sched-type-autoreg .sched-type-icon {
  color: #d97706;
}

.sched-chip-next {
  background: #eef1ff;
  border-color: #c7d0ff;
}
.sched-chip-next .sched-name {
  color: #2c3a99;
  font-weight: 600;
}
.sched-empty {
  font-size: 13px;
  color: #999;
  text-align: center;
  padding: 16px 0;
}
</style>
