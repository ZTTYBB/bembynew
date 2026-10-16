<template>
  <div class="web-steps-editor">
    <label v-if="depth === 0" class="form-label">{{ t("jobs.web.stepsLabel") }}</label>
    <div v-if="depth === 0" class="steps-hint">{{ t("jobs.web.stepsHint") }}</div>

    <div v-for="(s, i) in steps" :key="i" class="web-step-card">
      <div class="web-step-header">
        <span class="web-step-num">{{ i + 1 }}</span>
        <select v-model="s.type" class="form-select web-step-type" :aria-label="t('jobs.web.stepType')">
          <option
            v-for="ty in WEB_STEP_TYPES"
            :key="ty"
            :value="ty"
            :disabled="aiKeyMissing && AI_WEB_STEP_TYPES.includes(ty)"
          >
            {{ stepTypeLabel(ty)
            }}{{
              aiKeyMissing && AI_WEB_STEP_TYPES.includes(ty)
                ? " (" + t("jobs.noApiKey") + ")"
                : ""
            }}
          </option>
        </select>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" title="上移" :disabled="i === 0" @click="move(i, -1)">
          <i class="fa-solid fa-arrow-up"></i>
        </button>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" title="下移" :disabled="i === steps.length - 1" @click="move(i, 1)">
          <i class="fa-solid fa-arrow-down"></i>
        </button>
        <button type="button" class="btn btn-danger btn-sm btn-icon" :title="t('common.delete')" @click="remove(i)">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <template v-if="s.type === 'web_input'">
        <SelectorField v-model="s.selector" :label="t('jobs.web.labelSelector')" :hint="t('jobs.web.selectorHint')" />
        <TextField v-model="s.text" :label="t('jobs.web.labelText')" :placeholder="t('jobs.web.textPlaceholder')" :hint="t('jobs.web.textHint')" />
      </template>
      <SelectorField
        v-else-if="s.type === 'web_button'"
        v-model="s.selector"
        :label="t('jobs.web.labelSelector')"
        :hint="t('jobs.web.selectorHint')"
      />

      <template v-else-if="s.type === 'web_delay'">
        <NumberField v-model="s.waitMs" :label="t('jobs.web.labelDelay')" :hint="t('jobs.web.delayHint')" />
      </template>
      <template v-else-if="s.type === 'web_wait_element'">
        <SelectorField v-model="s.selector" :label="t('jobs.web.labelSelector')" :hint="t('jobs.web.selectorHint')" />
        <NumberField v-model="s.waitMs" :label="t('jobs.web.labelTimeout')" :hint="t('jobs.web.timeoutHint')" />
      </template>
      <template v-else-if="s.type === 'web_scroll'">
        <div class="form-row">
          <NumberField v-model="s.scrollX" :label="t('jobs.web.labelScrollX')" />
          <NumberField v-model="s.scrollY" :label="t('jobs.web.labelScrollY')" />
        </div>
        <div class="field-hint">{{ t("jobs.web.scrollHint") }}</div>
      </template>
      <div v-else-if="s.type === 'web_turnstile'" class="field-hint">{{ t("jobs.web.turnstileHint") }}</div>

      <template v-else-if="s.type === 'web_eval'">
        <div class="form-row">
          <label class="form-group" :class="{ 'wide-field': s.read === 'console' }">
            <span class="form-label">{{ t("jobs.web.labelRead") }}</span>
            <select v-model="s.read" class="form-select">
              <option v-for="read in WEB_EVAL_READS" :key="read" :value="read">{{ t(`jobs.web.read.${read}`) }}</option>
            </select>
          </label>
          <label class="form-group">
            <span class="form-label">{{ t("jobs.web.labelVariable") }}</span>
            <input v-model.trim="s.resultVariable" class="form-input" maxlength="64" placeholder="page_value" />
          </label>
        </div>
        <SelectorField
          v-if="!['url', 'title'].includes(s.read)"
          v-model="s.selector"
          :label="t('jobs.web.labelSelector')"
          :hint="t('jobs.web.evalSelectorHint')"
        />
        <div v-if="['attribute', 'property'].includes(s.read)" class="form-group">
          <label class="form-label">{{ s.read === 'attribute' ? t("jobs.web.labelAttribute") : t("jobs.web.labelProperty") }}</label>
          <input v-model.trim="s.name" class="form-input" :placeholder="s.read === 'attribute' ? 'data-status' : 'checked'" />
        </div>
        <label v-if="['text', 'textContent', 'innerText', 'value', 'attribute', 'property'].includes(s.read)" class="checkbox-row">
          <input v-model="s.all" type="checkbox" />
          <span>{{ t("jobs.web.labelReadAll") }}</span>
        </label>
        <NumberField v-if="s.all" v-model="s.maxItems" :label="t('jobs.web.labelMaxItems')" :min="1" :max="500" />
        <div class="field-hint">{{ t("jobs.web.evalHint") }}</div>
      </template>

      <template v-else-if="s.type === 'web_set'">
        <SelectorField v-model="s.selector" :label="t('jobs.web.labelSelector')" :hint="t('jobs.web.selectorHint')" />
        <div class="form-row">
          <label class="form-group">
            <span class="form-label">{{ t("jobs.web.labelSet") }}</span>
            <select v-model="s.set" class="form-select">
              <option v-for="mode in WEB_SET_MODES" :key="mode" :value="mode">{{ t(`jobs.web.set.${mode}`) }}</option>
            </select>
          </label>
          <label v-if="s.set !== 'click'" class="form-group">
            <span class="form-label">{{ t("jobs.web.labelValueType") }}</span>
            <select v-model="s.valueType" class="form-select">
              <option value="text">{{ t("jobs.web.valueType.text") }}</option>
              <option value="number">{{ t("jobs.web.valueType.number") }}</option>
              <option value="boolean">{{ t("jobs.web.valueType.boolean") }}</option>
              <option value="json">{{ t("jobs.web.valueType.json") }}</option>
            </select>
          </label>
          <label v-if="s.set !== 'click' && s.valueType !== 'boolean'" class="form-group">
            <span class="form-label">{{ t("jobs.web.labelValue") }}</span>
            <input v-model="s.valueDraft" class="form-input" :placeholder="s.valueType === 'json' ? '{&quot;ok&quot;:true}' : ''" />
          </label>
          <label v-else-if="s.set !== 'click'" class="form-group">
            <span class="form-label">{{ t("jobs.web.labelValue") }}</span>
            <select v-model="s.valueDraft" class="form-select">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </label>
        </div>
        <div v-if="['attribute', 'property'].includes(s.set)" class="form-group">
          <label class="form-label">{{ s.set === 'attribute' ? t("jobs.web.labelAttribute") : t("jobs.web.labelProperty") }}</label>
          <input v-model.trim="s.name" class="form-input" :placeholder="s.set === 'attribute' ? 'data-status' : 'checked'" />
        </div>
        <TextField v-model.trim="s.resultVariable" :label="t('jobs.web.labelResultVariable')" placeholder="set_result" />
        <div class="field-hint">{{ t("jobs.web.setHint") }}</div>
      </template>

      <template v-else-if="s.type === 'web_if'">
        <div class="form-row">
          <label class="form-group">
            <span class="form-label">{{ t("jobs.web.labelConditionMode") }}</span>
            <select v-model="s.conditionMode" class="form-select">
              <option value="variable">{{ t("jobs.web.conditionModeVariable") }}</option>
              <option value="page">{{ t("jobs.web.conditionModePage") }}</option>
            </select>
          </label>
        </div>
        <template v-if="s.conditionMode === 'page'">
          <SelectorField
            v-model="s.conditionSelector"
            :label="t('jobs.web.labelConditionSelector')"
            :hint="t('jobs.web.conditionSelectorHint')"
          />
          <div class="form-row">
            <label class="form-group">
              <span class="form-label">{{ t("jobs.web.labelConditionOperator") }}</span>
              <select v-model="s.conditionPageOperator" class="form-select">
                <option
                  v-for="operator in WEB_PAGE_CONDITION_OPERATORS"
                  :key="operator"
                  :value="operator"
                >
                  {{ t(`jobs.web.conditionPage.${operator}`) }}
                </option>
              </select>
            </label>
            <label
              v-if="!['exists', 'visible'].includes(s.conditionPageOperator)"
              class="form-group"
            >
              <span class="form-label">{{ t("jobs.web.labelConditionRight") }}</span>
              <input v-model="s.conditionPageValue" class="form-input" />
            </label>
          </div>
        </template>
        <div v-else class="form-row">
          <label class="form-group">
            <span class="form-label">{{ t("jobs.web.labelConditionLeft") }}</span>
            <input v-model="s.conditionLeft" class="form-input" placeholder="{points}" />
          </label>
          <label class="form-group">
            <span class="form-label">{{ t("jobs.web.labelConditionOperator") }}</span>
            <select v-model="s.conditionOperator" class="form-select">
              <option v-for="operator in WEB_CONDITION_OPERATORS" :key="operator" :value="operator">{{ t(`jobs.web.condition.${operator}`) }}</option>
            </select>
          </label>
          <label v-if="!['exists', 'empty'].includes(s.conditionOperator)" class="form-group">
            <span class="form-label">{{ t("jobs.web.labelConditionRight") }}</span>
            <input v-model="s.conditionRight" class="form-input" />
          </label>
        </div>
        <details open class="web-branch">
          <summary>{{ t("jobs.web.thenSteps") }}</summary>
          <WebStepsEditor :steps="s.thenSteps" :ai-key-missing="aiKeyMissing" :depth="depth + 1" />
        </details>
        <details class="web-branch">
          <summary>{{ t("jobs.web.elseSteps") }}</summary>
          <WebStepsEditor :steps="s.elseSteps" :ai-key-missing="aiKeyMissing" :depth="depth + 1" />
        </details>
      </template>

      <template v-else-if="s.type === 'web_repeat'">
        <div class="form-row">
          <NumberField v-model="s.count" :label="t('jobs.web.labelRepeatCount')" :min="0" :max="500" />
          <TextField v-model.trim="s.indexVariable" :label="t('jobs.web.labelIndexVariable')" placeholder="loop_index" />
        </div>
        <details open class="web-branch">
          <summary>{{ t("jobs.web.repeatSteps") }}</summary>
          <WebStepsEditor :steps="s.steps" :ai-key-missing="aiKeyMissing" :depth="depth + 1" />
        </details>
      </template>

      <template v-else-if="s.type === 'web_for_each'">
        <SelectorField v-model="s.selector" :label="t('jobs.web.labelSelector')" :hint="t('jobs.web.forEachSelectorHint')" />
        <div class="form-row">
          <TextField v-model.trim="s.itemVariable" :label="t('jobs.web.labelItemVariable')" placeholder="item" />
          <TextField v-model.trim="s.indexVariable" :label="t('jobs.web.labelIndexVariable')" placeholder="loop_index" />
          <NumberField v-model="s.maxIterations" :label="t('jobs.web.labelMaxIterations')" :min="1" :max="500" />
        </div>
        <div class="form-row">
          <TextField v-model.trim="s.forEachAttribute" :label="t('jobs.web.labelForEachAttribute')" placeholder="data-id" />
          <TextField v-model="s.forEachTextContains" :label="t('jobs.web.labelForEachTextContains')" />
        </div>
        <details open class="web-branch">
          <summary>{{ t("jobs.web.forEachSteps") }}</summary>
          <WebStepsEditor :steps="s.steps" :ai-key-missing="aiKeyMissing" :depth="depth + 1" />
        </details>
      </template>

      <template v-else-if="s.type === 'web_finish'">
        <div class="form-row">
          <label class="form-group">
            <span class="form-label">{{ t("jobs.web.labelFinishStatus") }}</span>
            <select v-model="s.status" class="form-select">
              <option value="success">{{ t("jobs.web.finishSuccess") }}</option>
              <option value="failed">{{ t("jobs.web.finishFailed") }}</option>
            </select>
          </label>
          <TextField v-model="s.message" :label="t('jobs.web.labelFinishMessage')" placeholder="签到完成" />
        </div>
      </template>

      <template v-else-if="s.type === 'ai_web_button' || s.type === 'ai_web_input' || s.type === 'ai_web_click_xy'">
        <TextField v-model.trim="s.hint" :label="t('jobs.web.labelHint')" :placeholder="hintPlaceholder(s.type)" :hint="s.type === 'ai_web_click_xy' ? t('jobs.web.hintXyHint') : t('jobs.web.hintHint')" />
        <TextField v-if="s.type === 'ai_web_input'" v-model="s.text" :label="t('jobs.web.labelAiText')" :placeholder="t('jobs.web.aiTextPlaceholder')" :hint="t('jobs.web.aiTextHint')" />
      </template>
    </div>

    <button v-if="depth < MAX_DEPTH" type="button" class="btn btn-ghost btn-sm add-step" @click="add">
      <i class="fa-solid fa-plus"></i> {{ t("jobs.web.addStep") }}
    </button>
    <div v-else class="field-hint">{{ t("jobs.web.maxDepthHint") }}</div>
  </div>
</template>

<script setup lang="ts">
import { defineComponent, h } from "vue";
import { t } from "../i18n";
import {
  AI_WEB_STEP_TYPES,
  MAX_DEPTH,
  WEB_CONDITION_OPERATORS,
  WEB_EVAL_READS,
  WEB_PAGE_CONDITION_OPERATORS,
  WEB_SET_MODES,
  WEB_STEP_TYPES,
  defaultWebStep,
  type WebStepForm,
  type WebStepType,
} from "../composables/webSteps";

defineOptions({ name: "WebStepsEditor" });
const props = withDefaults(defineProps<{ steps: WebStepForm[]; aiKeyMissing: boolean; depth?: number }>(), { depth: 0 });

function stepTypeLabel(type: WebStepType): string {
  return t("jobs.web.type." + type);
}
function hintPlaceholder(type: WebStepType): string {
  if (type === "ai_web_input") return t("jobs.web.hintInputPlaceholder");
  if (type === "ai_web_click_xy") return t("jobs.web.hintXyPlaceholder");
  return t("jobs.web.hintButtonPlaceholder");
}
function add() {
  props.steps.push(defaultWebStep());
}
function remove(index: number) {
  props.steps.splice(index, 1);
}
function move(index: number, offset: number) {
  const target = index + offset;
  if (target < 0 || target >= props.steps.length) return;
  const [item] = props.steps.splice(index, 1);
  props.steps.splice(target, 0, item);
}

// These small local controls keep the recursive editor readable. They intentionally use
// v-model-compatible `modelValue` props instead of introducing another form abstraction.
const SelectorField = defineComponent({
  props: { modelValue: { type: String, required: true }, label: { type: String, required: true }, hint: { type: String, default: "" } },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () => h("div", { class: "form-group" }, [
      h("label", { class: "form-label" }, props.label),
      h("input", { class: "form-input", value: props.modelValue, onInput: (e: Event) => emit("update:modelValue", (e.target as HTMLInputElement).value) }),
      props.hint ? h("div", { class: "field-hint" }, props.hint) : null,
    ]);
  },
});
const TextField = defineComponent({
  props: { modelValue: { type: String, required: true }, label: { type: String, required: true }, placeholder: { type: String, default: "" }, hint: { type: String, default: "" } },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () => h("div", { class: "form-group" }, [
      h("label", { class: "form-label" }, props.label),
      h("input", { class: "form-input", value: props.modelValue, placeholder: props.placeholder, onInput: (e: Event) => emit("update:modelValue", (e.target as HTMLInputElement).value) }),
      props.hint ? h("div", { class: "field-hint" }, props.hint) : null,
    ]);
  },
});
const NumberField = defineComponent({
  props: { modelValue: { type: Number, required: true }, label: { type: String, required: true }, hint: { type: String, default: "" }, min: { type: Number, default: 0 }, max: { type: Number, default: undefined } },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () => h("label", { class: "form-group" }, [
      h("span", { class: "form-label" }, props.label),
      h("input", { class: "form-input", type: "number", min: props.min, max: props.max, value: props.modelValue, onInput: (e: Event) => emit("update:modelValue", Number((e.target as HTMLInputElement).value)) }),
      props.hint ? h("div", { class: "field-hint" }, props.hint) : null,
    ]);
  },
});
</script>

<style scoped>
.web-step-card { border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; background: #fff; }
.web-step-header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.web-step-num { min-width: 20px; height: 20px; border-radius: 50%; background: #4a9eff; color: #fff; font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.web-step-type { flex: 1; min-width: 0; }
.steps-hint, .field-hint { font-size: 11px; color: #888; margin: -2px 0 6px; overflow-wrap: anywhere; }
.field-hint { margin: 3px 0 8px; }
.form-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.form-row > .form-group { flex: 1; min-width: 130px; margin-bottom: 0; }
.wide-field { min-width: 220px !important; }
.web-branch { margin: 8px 0; border-left: 2px solid #d5dce2; padding-left: 8px; }
.web-branch summary { cursor: pointer; font-size: 12px; font-weight: 600; padding: 4px 0; }
.add-step { margin-top: 6px; }
@media (max-width: 600px) { .web-step-header { flex-wrap: wrap; } .web-step-type { min-width: 130px; } .form-row > .form-group { min-width: 100%; } }
</style>
