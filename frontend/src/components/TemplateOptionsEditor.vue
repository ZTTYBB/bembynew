<template>
  <section v-if="options.length || editable" class="template-options-editor">
    <div class="template-options-title">{{ editable ? "模板选项" : "任务选项" }}</div>
    <div v-if="!options.length" class="template-options-empty">暂无可配置选项</div>
    <div v-for="(option, index) in options" :key="index" class="template-option-row">
      <div v-if="editable" class="template-option-fields">
        <input v-model.trim="option.name" class="form-input" maxlength="64" placeholder="变量名，例如 mode" aria-label="选项变量名" />
        <input v-model.trim="option.label" class="form-input" maxlength="128" placeholder="显示名称" aria-label="选项显示名称" />
        <button type="button" class="btn btn-danger btn-sm btn-icon" title="删除选项" @click="options.splice(index, 1)"><i class="fa-solid fa-trash"></i></button>
      </div>
      <label v-if="!editable" class="form-label">{{ option.label || option.name }}</label>
      <input
        v-if="editable"
        class="form-input"
        :value="choiceText(option)"
        maxlength="2048"
        placeholder="候选值，用逗号分隔，例如 fast,slow"
        aria-label="候选值"
        @input="setChoices(option, inputValue($event))"
      />
      <select
        v-else
        class="form-select"
        :value="encodedValue(values[option.name] === undefined ? option.default : values[option.name])"
        @change="setValue(option, inputValue($event))"
      >
        <option v-for="(choice, choiceIndex) in option.options" :key="choiceIndex" :value="encodedValue(choice)">
          {{ String(choice) }}
        </option>
      </select>
      <select v-if="editable && option.options.length" v-model="option.default" class="form-select" aria-label="默认值">
        <option v-for="(choice, choiceIndex) in option.options" :key="choiceIndex" :value="choice">{{ String(choice) }}</option>
      </select>
    </div>
    <button v-if="editable" type="button" class="btn btn-ghost btn-sm" @click="addOption">
      <i class="fa-solid fa-plus"></i> 添加选项
    </button>
  </section>
</template>

<script setup lang="ts">
type Primitive = string | number | boolean;
export type TemplateOptionDraft = {
  name: string;
  label: string;
  options: Primitive[];
  default: Primitive;
};

const props = withDefaults(defineProps<{
  options: TemplateOptionDraft[];
  values?: Record<string, Primitive>;
  editable?: boolean;
}>(), { values: () => ({}), editable: false });

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}
function choiceText(option: TemplateOptionDraft): string {
  return option.options.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(",");
}
function parseChoice(value: string): Primitive {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed !== "" && Number.isFinite(Number(trimmed)) && /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
function setChoices(option: TemplateOptionDraft, text: string): void {
  const values = text.split(",").map(parseChoice).filter((value) => value !== "");
  option.options = [...new Set(values.map((value) => JSON.stringify(value)))].map((value) => JSON.parse(value) as Primitive);
  if (!option.options.some((value) => Object.is(value, option.default))) option.default = option.options[0] ?? "";
}
function encodedValue(value: Primitive): string {
  return JSON.stringify(value);
}
function setValue(option: TemplateOptionDraft, encoded: string): void {
  const selected = option.options.find((value) => encodedValue(value) === encoded);
  if (selected !== undefined) props.values[option.name] = selected;
}
function addOption(): void {
  props.options.push({ name: "", label: "", options: ["value"], default: "value" });
}
</script>

<style scoped>
.template-options-editor { border-top: 1px solid #e0e5eb; border-bottom: 1px solid #e0e5eb; padding: 10px 0; margin: 12px 0; }
.template-options-title { font-weight: 600; margin-bottom: 8px; }
.template-options-empty { color: #8a949e; font-size: 12px; margin-bottom: 8px; }
.template-option-row { display: grid; gap: 6px; margin-bottom: 10px; }
.template-option-fields { display: flex; gap: 6px; align-items: center; }
.template-option-fields .form-input { flex: 1; min-width: 0; }
@media (max-width: 600px) { .template-option-fields { flex-wrap: wrap; } }
</style>
