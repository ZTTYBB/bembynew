<template>
  <div class="candidate-filters">
    <label class="candidate-toggle"><input v-model="filters.excludeLinked" type="checkbox" :disabled="disabled" />{{ w("excludeLinked") }}</label>
    <label class="candidate-toggle"><input v-model="filters.excludeRestricted" type="checkbox" :disabled="disabled" />{{ w("excludeRestricted") }}</label>
    <label class="candidate-field"><span class="form-label">{{ w("includeKeywords") }}</span><input v-model="filters.includeKeywords" class="form-input" :placeholder="w('keywordsPlaceholder')" :disabled="disabled" /></label>
    <label class="candidate-field"><span class="form-label">{{ w("excludeKeywords") }}</span><input v-model="filters.excludeKeywords" class="form-input" :placeholder="w('keywordsPlaceholder')" :disabled="disabled" /></label>
    <label class="candidate-field candidate-template"><span class="form-label">{{ w("succeededTemplate") }}</span>
      <select v-model="filters.succeededTemplateId" class="form-select" :disabled="disabled" :aria-label="w('succeededTemplate')">
        <option value="">{{ w("anyTemplate") }}</option>
        <option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option>
      </select>
    </label>
  </div>
</template>

<script setup lang="ts">
import type { JobTemplate } from "../api/client";
import type { CandidateFilters } from "../utils/templateWorkflow";
import { t } from "../i18n";

defineProps<{ templates: JobTemplate[]; disabled?: boolean }>();
const filters = defineModel<CandidateFilters>({ required: true });
const w = (key: string) => t(`templateWorkflow.${key}`);
</script>

<style scoped>
.candidate-filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; padding: 12px 0; border-top: 1px solid #e3e7ec; border-bottom: 1px solid #e3e7ec; margin-bottom: 14px; }
.candidate-toggle { display: flex; align-items: center; gap: 7px; font-size: 13px; }
.candidate-field { min-width: 0; }
.candidate-field .form-input, .candidate-field .form-select { width: 100%; min-width: 0; }
.candidate-template { grid-column: 1 / -1; }
@media (max-width: 600px) { .candidate-filters { grid-template-columns: minmax(0, 1fr); } }
</style>
