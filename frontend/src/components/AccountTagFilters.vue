<template>
  <form class="tag-filter-panel" @submit.prevent="apply">
    <div class="filter-panel-heading">
      <strong>{{ w("allConditions") }}</strong>
      <span>{{ draft.length }} / 32</span>
    </div>
    <div v-for="(row, index) in draft" :key="index" class="tag-filter-row">
      <input v-model="row.name" class="form-input" maxlength="96" list="account-tag-names" :placeholder="w('name')" :aria-label="w('name')" />
      <select v-model="row.op" class="form-select" :aria-label="w('filters')">
        <option v-for="op in TAG_FILTER_OPS" :key="op" :value="op">{{ w(op) }}</option>
      </select>
      <input v-model="row.value" class="form-input" :disabled="row.op === 'has' || row.op === 'lacks'" :placeholder="w('value')" :aria-label="w('value')" />
      <button type="button" class="btn btn-ghost btn-icon" :title="w('remove')" :aria-label="w('remove')" @click="draft.splice(index, 1)">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
    <datalist id="account-tag-names">
      <option v-for="name in tagNames" :key="name" :value="name"></option>
    </datalist>
    <div v-if="error" class="error-msg" role="alert">{{ w(error) }}</div>
    <div class="filter-panel-actions">
      <button type="button" class="btn btn-sm btn-secondary" :disabled="draft.length >= 32" @click="draft.push({ name: '', op: 'has' })">
        <i class="fa-solid fa-plus"></i> {{ w("addCondition") }}
      </button>
      <div class="filter-submit-actions">
        <button type="button" class="btn btn-sm btn-ghost" @click="clear"><i class="fa-solid fa-filter-circle-xmark"></i> {{ w("clear") }}</button>
        <button type="submit" class="btn btn-sm btn-primary"><i class="fa-solid fa-filter"></i> {{ w("apply") }}</button>
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { t } from "../i18n";
import { TAG_FILTER_OPS, normalizeTagFilters, validateTagFilters, type AccountTagFilter } from "../utils/accountTags";

const props = defineProps<{ modelValue: AccountTagFilter[]; tagNames: string[] }>();
const emit = defineEmits<{ "update:modelValue": [value: AccountTagFilter[]] }>();
const draft = ref<AccountTagFilter[]>([]);
const error = ref("");
const w = (key: string) => t(`accountWorkflow.${key}`);
watch(() => props.modelValue, (value) => {
  draft.value = value.map((row) => ({ ...row }));
  error.value = "";
}, { immediate: true });
function apply() {
  error.value = validateTagFilters(draft.value) ?? "";
  if (!error.value) emit("update:modelValue", normalizeTagFilters(draft.value));
}
function clear() {
  draft.value = [];
  error.value = "";
  emit("update:modelValue", []);
}
</script>

<style scoped>
.tag-filter-panel { margin-bottom: 16px; padding: 12px 0 16px; border-bottom: 1px solid #dce1e7; display: grid; gap: 10px; }
.filter-panel-heading, .filter-panel-actions, .filter-submit-actions { display: flex; align-items: center; gap: 8px; }
.filter-panel-heading { justify-content: space-between; font-size: 13px; }
.filter-panel-heading span { color: #68717e; font-size: 12px; }
.filter-panel-actions { justify-content: space-between; flex-wrap: wrap; }
.tag-filter-row { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(130px, .7fr) minmax(140px, 1fr) 34px; gap: 8px; align-items: center; }
.tag-filter-row > .form-input, .tag-filter-row > .form-select { width: 100%; min-width: 0; }
@media (max-width: 600px) {
  .tag-filter-row { grid-template-columns: minmax(0, 1fr) minmax(110px, .8fr) 34px; }
  .tag-filter-row > .form-input:nth-of-type(2) { grid-column: 1 / 3; grid-row: 2; }
  .tag-filter-row > .btn { grid-column: 3; grid-row: 1 / 3; }
}
</style>
