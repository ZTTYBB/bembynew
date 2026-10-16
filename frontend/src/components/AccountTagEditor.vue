<template>
  <div class="tag-editor">
    <div v-for="row in modelValue" :key="row.id" class="tag-edit-row">
      <input v-model="row.name" class="form-input" maxlength="96" :placeholder="w('name')" :aria-label="w('name')" :disabled="disabled" />
      <label class="tag-value-toggle">
        <input v-model="row.hasValue" type="checkbox" :disabled="disabled" />
        {{ w("withValue") }}
      </label>
      <input v-model="row.value" class="form-input" maxlength="512" :placeholder="w('value')" :aria-label="w('value')" :disabled="disabled || !row.hasValue" />
      <button type="button" class="btn btn-ghost btn-icon" :title="w('remove')" :aria-label="w('remove')" :disabled="disabled" @click="remove(row.id)">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
    <button type="button" class="btn btn-sm btn-secondary" :disabled="disabled || modelValue.length >= 128" @click="$emit('update:modelValue', [...modelValue, newTagDraft()])">
      <i class="fa-solid fa-plus"></i> {{ w("addTag") }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { t } from "../i18n";
import { newTagDraft, type TagDraft } from "../utils/accountTags";

const props = defineProps<{ modelValue: TagDraft[]; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: TagDraft[]] }>();
const w = (key: string) => t(`accountWorkflow.${key}`);
function remove(id: number) {
  emit("update:modelValue", props.modelValue.filter((row) => row.id !== id));
}
</script>

<style scoped>
.tag-editor { display: grid; gap: 8px; min-width: 0; }
.tag-edit-row { display: grid; grid-template-columns: minmax(100px, 1fr) auto minmax(100px, 1.3fr) 34px; align-items: center; gap: 8px; }
.tag-edit-row .form-input { min-width: 0; width: 100%; }
.tag-value-toggle { display: flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 12px; }
.tag-editor > .btn { justify-self: start; }
@media (max-width: 520px) {
  .tag-edit-row { grid-template-columns: minmax(0, 1fr) auto 34px; }
  .tag-edit-row > .form-input:nth-of-type(2) { grid-column: 1 / 3; grid-row: 2; }
  .tag-edit-row > .btn { grid-column: 3; grid-row: 1 / 3; }
}
</style>
