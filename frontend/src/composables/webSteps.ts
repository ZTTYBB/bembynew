import type { WebStep } from "../api/client";
import type { JsonValue } from "../api/automation";

// Page steps are deliberately represented by one form shape. It keeps the editor stable
// when a user changes a node's type, while the serializer drops fields not used by that node.
export type WebStepType = WebStep["type"];
export type WebEvalRead = Extract<WebStep, { type: "web_eval" }>["mode"];
export type WebSetMode = Extract<WebStep, { type: "web_set" }>["mode"];
export type WebConditionMode = "variable" | "page";
export type WebSetValueType = "text" | "number" | "boolean" | "json";
export type WebConditionOperator =
  | "eq"
  | "ne"
  | "contains"
  | "not_contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "empty";
export type WebPageConditionOperator =
  | "exists"
  | "visible"
  | "text_contains"
  | "text_not_contains"
  | "text_equals"
  | "value_equals";

export type WebStepForm = {
  type: WebStepType;
  selector: string;
  text: string;
  hint: string;
  waitMs: number;
  scrollX: number;
  scrollY: number;
  read: WebEvalRead;
  name: string;
  all: boolean;
  maxItems: number;
  resultVariable: string;
  attribute: string;
  property: string;
  set: WebSetMode;
  valueType: WebSetValueType;
  value: JsonValue;
  valueDraft: string;
  conditionMode: WebConditionMode;
  conditionLeft: string;
  conditionOperator: WebConditionOperator;
  conditionRight: string;
  conditionSelector: string;
  conditionPageOperator: WebPageConditionOperator;
  conditionPageValue: string;
  thenSteps: WebStepForm[];
  elseSteps: WebStepForm[];
  count: number;
  indexVariable: string;
  steps: WebStepForm[];
  itemVariable: string;
  maxIterations: number;
  forEachAttribute: string;
  forEachTextContains: string;
  status: "success" | "failed";
  message: string;
};

export const WEB_STEP_TYPES: WebStepType[] = [
  "web_input",
  "web_button",
  "web_set",
  "web_eval",
  "web_wait_element",
  "web_delay",
  "web_scroll",
  "web_turnstile",
  "ai_web_input",
  "ai_web_button",
  "ai_web_click_xy",
  "web_if",
  "web_repeat",
  "web_for_each",
  "web_finish",
];

export const AI_WEB_STEP_TYPES: WebStepType[] = [
  "ai_web_input",
  "ai_web_button",
  "ai_web_click_xy",
];

export const WEB_EVAL_READS: WebEvalRead[] = [
  "text",
  "textContent",
  "innerText",
  "value",
  "attribute",
  "property",
  "exists",
  "visible",
  "count",
  "url",
  "title",
];

export const WEB_SET_MODES: WebSetMode[] = [
  "value",
  "text",
  "textContent",
  "attribute",
  "property",
  "click",
];

export const WEB_CONDITION_OPERATORS: WebConditionOperator[] = [
  "eq",
  "ne",
  "contains",
  "not_contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "empty",
];
export const WEB_PAGE_CONDITION_OPERATORS: WebPageConditionOperator[] = [
  "exists",
  "visible",
  "text_contains",
  "text_not_contains",
  "text_equals",
  "value_equals",
];

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype", "account_id", "reply_text"]);
const SAFE_DOM_NAME =
  /^(?!(?:__proto__|prototype|constructor|innerHTML|outerHTML|srcdoc|contentWindow|contentDocument|ownerDocument|on[A-Za-z_$][\w$-]*)$)[A-Za-z_$][\w$-]{0,63}$/i;
const SAFE_DOM_ATTRIBUTE = /^(?!on)[A-Za-z_:][A-Za-z0-9_.:-]{0,127}$/i;
const MAX_SELECTOR_LENGTH = 2048;
const MAX_PAGE_OPERATION_TIMEOUT = 300_000;
export const MAX_DEPTH = 8;

function validVariableName(name: string): boolean {
  return !name || (VARIABLE_NAME.test(name) && !RESERVED_NAMES.has(name));
}

function integerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function safeSelector(value: string, label = "CSS 选择器"): string {
  const selector = value.trim();
  if (!selector) {
    const message = label.includes(" CSS 选择器")
      ? label.replace(" CSS 选择器", "需要 CSS 选择器")
      : `${label}需要 CSS 选择器`;
    fail(message);
  }
  if (
    selector.length > MAX_SELECTOR_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(selector)
  ) {
    fail(`${label}无效或过长`);
  }
  return selector;
}

function safeDomName(value: string, mode: "attribute" | "property"): string {
  const name = value.trim();
  const valid = mode === "attribute" ? SAFE_DOM_ATTRIBUTE.test(name) : SAFE_DOM_NAME.test(name);
  if (!valid) fail(`${mode === "attribute" ? "HTML 属性名" : "DOM 属性名"}不合法`);
  return name;
}

function validateJsonValue(value: unknown, depth = 0): void {
  if (depth > 16) fail("JSON 值嵌套过深");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item) => validateJsonValue(item, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") fail("JSON 值无效");
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) fail("JSON 包含不安全属性");
    validateJsonValue(item, depth + 1);
  }
}

function setValueFromForm(s: WebStepForm): JsonValue {
  // Imported forms from older versions may carry a typed runtime value despite the
  // text-draft field type. Preserve that value for backwards compatibility.
  let draft = s.valueDraft ?? "";
  if (!draft && typeof s.value === "string" && s.value) draft = s.value;
  if (!draft && s.value === null) return null;
  if (!draft && typeof s.value !== "string" && s.value !== null) return s.value;
  switch (s.valueType) {
    case "number": {
      if (!draft.trim() || !Number.isFinite(Number(draft))) fail("数字值必须是有限数值");
      return Number(draft);
    }
    case "boolean":
      if (draft !== "true" && draft !== "false") fail("布尔值必须选择 true 或 false");
      return draft === "true";
    case "json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft);
      } catch {
        fail("JSON 值格式无效");
      }
      validateJsonValue(parsed);
      if (JSON.stringify(parsed).length > 64 * 1024) fail("JSON 值过大");
      return parsed as JsonValue;
    }
    case "text":
    default:
      return draft;
  }
}

export function defaultWebStep(): WebStepForm {
  return {
    type: "web_button",
    selector: "",
    text: "",
    hint: "",
    waitMs: 3000,
    scrollX: 0,
    scrollY: 500,
    read: "text",
    name: "",
    all: false,
    maxItems: 100,
    resultVariable: "",
    attribute: "",
    property: "",
    set: "value",
    valueType: "text",
    value: "",
    valueDraft: "",
    conditionMode: "variable",
    conditionLeft: "",
    conditionOperator: "eq",
    conditionRight: "",
    conditionSelector: "",
    conditionPageOperator: "exists",
    conditionPageValue: "",
    thenSteps: [],
    elseSteps: [],
    count: 2,
    indexVariable: "loop_index",
    steps: [],
    itemVariable: "item",
    maxIterations: 100,
    forEachAttribute: "",
    forEachTextContains: "",
    status: "success",
    message: "",
  };
}

function fail(message: string): never {
  throw new Error(`网页步骤：${message}`);
}

function pageCondition(
  s: WebStepForm,
): Extract<WebStep, { type: "web_if" }>["condition"] {
  const selector = safeSelector(s.conditionSelector, "页面条件 CSS 选择器");
  if (!WEB_PAGE_CONDITION_OPERATORS.includes(s.conditionPageOperator)) {
    fail("页面条件运算符无效");
  }
  if (
    !["exists", "visible"].includes(s.conditionPageOperator) &&
    !s.conditionPageValue.trim()
  ) {
    fail("该页面条件需要比较值");
  }
  return {
    selector,
    operator: s.conditionPageOperator,
    ...(!["exists", "visible"].includes(s.conditionPageOperator)
      ? { value: s.conditionPageValue }
      : {}),
  };
}

function nestedSteps(steps: WebStepForm[], depth: number): WebStep[] {
  if (depth >= MAX_DEPTH) fail(`嵌套不能超过 ${MAX_DEPTH} 层`);
  return steps.map((step) => webStepToConfig(step, depth + 1));
}

/** Convert one form node into the compact backend contract and validate user input. */
export function webStepToConfig(s: WebStepForm, depth = 0): WebStep {
  if (depth > MAX_DEPTH) fail(`嵌套不能超过 ${MAX_DEPTH} 层`);
  const selector = s.selector.trim();
  switch (s.type) {
    case "web_input":
      return {
        type: "web_input",
        selector: safeSelector(selector, "输入步骤 CSS 选择器"),
        text: s.text,
      };
    case "web_button":
      return {
        type: "web_button",
        selector: safeSelector(selector, "点击步骤 CSS 选择器"),
      };
    case "web_delay":
      if (!integerInRange(s.waitMs, 0, 86_400_000)) fail("等待时长必须是 0 到 86400000 的整数毫秒");
      return { type: "web_delay", waitMs: s.waitMs };
    case "web_turnstile":
      return { type: "web_turnstile" };
    case "web_scroll":
      if (!Number.isFinite(s.scrollX) || !Number.isFinite(s.scrollY)) fail("滚动距离必须是有限数字");
      return {
        type: "web_scroll",
        ...(s.scrollX ? { x: s.scrollX } : {}),
        ...(s.scrollY ? { y: s.scrollY } : {}),
      };
    case "web_wait_element":
      safeSelector(selector, "等待元素步骤 CSS 选择器");
      if (!integerInRange(s.waitMs, 0, 86_400_000)) fail("元素等待时长必须是 0 到86400000 的整数毫秒");
      return { type: "web_wait_element", selector, ...(s.waitMs > 0 ? { waitMs: s.waitMs } : {}) };
    case "ai_web_button":
      return { type: "ai_web_button", ...(s.hint.trim() ? { hint: s.hint.trim() } : {}) };
    case "ai_web_click_xy":
      return { type: "ai_web_click_xy", ...(s.hint.trim() ? { hint: s.hint.trim() } : {}) };
    case "ai_web_input":
      return {
        type: "ai_web_input",
        ...(s.hint.trim() ? { hint: s.hint.trim() } : {}),
        ...(s.text ? { text: s.text } : {}),
      };
    case "web_eval": {
      if (!WEB_EVAL_READS.includes(s.read)) fail("读取方式无效");
      const pageLevelRead = ["url", "title", "text", "textContent", "innerText"].includes(s.read);
      if (!pageLevelRead) safeSelector(selector, "读取页面值 CSS 选择器");
      if (s.read === "attribute" || s.read === "property") safeDomName(s.name, s.read);
      if (!validVariableName(s.resultVariable.trim())) fail("结果变量名不合法");
      if (!s.resultVariable.trim()) fail("读取步骤需要结果变量名");
      if (!integerInRange(s.maxItems, 1, 500)) fail("最多元素数必须是 1 到 500 的整数");
      if (!integerInRange(s.waitMs, 0, MAX_PAGE_OPERATION_TIMEOUT)) {
        fail(`页面读取超时必须是 0 到 ${MAX_PAGE_OPERATION_TIMEOUT} 的整数毫秒`);
      }
      return {
        type: "web_eval",
        ...(selector && !["url", "title"].includes(s.read)
          ? { selector: safeSelector(selector, "读取页面值 CSS 选择器") }
          : {}),
        mode: s.read,
        variable: s.resultVariable.trim(),
        ...(s.read === "attribute" || s.read === "property"
          ? { name: safeDomName(s.name, s.read) }
          : {}),
        ...(s.all ? { all: true } : {}),
        ...(s.maxItems !== 100 ? { maxItems: s.maxItems } : {}),
        ...(s.waitMs !== 3000 && s.waitMs > 0 ? { maxWaitMs: s.waitMs } : {}),
      };
    }
    case "web_set": {
      if (!WEB_SET_MODES.includes(s.set)) fail("设置方式无效");
      const setSelector = safeSelector(selector, "页面设置 CSS 选择器");
      if (s.set === "attribute" || s.set === "property") safeDomName(s.name, s.set);
      if (!validVariableName(s.resultVariable.trim())) fail("结果变量名不合法");
      if (!integerInRange(s.waitMs, 0, MAX_PAGE_OPERATION_TIMEOUT)) {
        fail(`页面设置超时必须是 0 到 ${MAX_PAGE_OPERATION_TIMEOUT} 的整数毫秒`);
      }
      return {
        type: "web_set",
        selector: setSelector,
        mode: s.set,
        ...(s.set !== "click" ? { value: setValueFromForm(s) } : {}),
        ...(s.set === "attribute" || s.set === "property"
          ? { name: safeDomName(s.name, s.set) }
          : {}),
        ...(s.resultVariable.trim() ? { resultVariable: s.resultVariable.trim() } : {}),
        ...(s.waitMs !== 3000 && s.waitMs > 0 ? { maxWaitMs: s.waitMs } : {}),
      };
    }
    case "web_if": {
      if (s.conditionMode === "page") {
        return {
          type: "web_if",
          condition: pageCondition(s),
          thenSteps: nestedSteps(s.thenSteps, depth),
          ...(s.elseSteps.length ? { elseSteps: nestedSteps(s.elseSteps, depth) } : {}),
        };
      }
      if (!s.conditionLeft.trim()) fail("条件分支需要左值");
      if (!WEB_CONDITION_OPERATORS.includes(s.conditionOperator)) fail("条件运算符无效");
      if (!["exists", "empty"].includes(s.conditionOperator) && !s.conditionRight.trim()) {
        fail("该条件需要右值");
      }
      return {
        type: "web_if",
        condition: {
          left: s.conditionLeft,
          operator: s.conditionOperator,
          ...(!["exists", "empty"].includes(s.conditionOperator) ? { right: s.conditionRight } : {}),
        },
        thenSteps: nestedSteps(s.thenSteps, depth),
        ...(s.elseSteps.length ? { elseSteps: nestedSteps(s.elseSteps, depth) } : {}),
      };
    }
    case "web_repeat":
      if (!integerInRange(s.count, 0, 500)) fail("重复次数必须是 0 到 500 的整数");
      if (!validVariableName(s.indexVariable.trim())) fail("序号变量名不合法");
      return {
        type: "web_repeat",
        count: s.count,
        ...(s.indexVariable.trim() ? { indexVariable: s.indexVariable.trim() } : {}),
        steps: nestedSteps(s.steps, depth),
      };
    case "web_for_each":
      const eachSelector = safeSelector(selector, "逐元素循环 CSS 选择器");
      if (!validVariableName(s.itemVariable.trim()) || !validVariableName(s.indexVariable.trim())) {
        fail("循环变量名不合法");
      }
      if (s.itemVariable.trim() && s.itemVariable.trim() === s.indexVariable.trim()) {
        fail("数据变量与序号变量不能同名");
      }
      if (!integerInRange(s.maxIterations, 1, 500)) fail("逐元素循环上限必须是 1 到 500 的整数");
      return {
        type: "web_for_each",
        selector: eachSelector,
        ...(s.itemVariable.trim() ? { itemVariable: s.itemVariable.trim() } : {}),
        ...(s.indexVariable.trim() ? { indexVariable: s.indexVariable.trim() } : {}),
        ...(s.forEachAttribute.trim()
          ? { attribute: safeDomName(s.forEachAttribute, "attribute") }
          : {}),
        ...(s.forEachTextContains ? { textContains: s.forEachTextContains } : {}),
        ...(s.maxIterations !== 100 ? { maxIterations: s.maxIterations } : {}),
        steps: nestedSteps(s.steps, depth),
      };
    case "web_finish":
      if (s.status !== "success" && s.status !== "failed") fail("结束状态无效");
      return { type: "web_finish", status: s.status, ...(s.message ? { message: s.message } : {}) };
  }
}

export function webStepsToConfig(steps: WebStepForm[]): WebStep[] {
  return steps.map((step) => webStepToConfig(step));
}

/** Fill the editor's flat form shape from a saved page-step tree. */
export function webStepFromConfig(s: WebStep): WebStepForm {
  const base = defaultWebStep();
  switch (s.type) {
    case "web_input":
      return { ...base, type: s.type, selector: s.selector, text: s.text };
    case "web_button":
      return { ...base, type: s.type, selector: s.selector };
    case "web_delay":
      return { ...base, type: s.type, waitMs: s.waitMs };
    case "web_turnstile":
      return { ...base, type: s.type };
    case "web_scroll":
      return { ...base, type: s.type, scrollX: s.x ?? 0, scrollY: s.y ?? 0 };
    case "web_wait_element":
      return { ...base, type: s.type, selector: s.selector, waitMs: s.waitMs ?? 30000 };
    case "ai_web_button":
    case "ai_web_click_xy":
      return { ...base, type: s.type, hint: s.hint ?? "" };
    case "ai_web_input":
      return { ...base, type: s.type, hint: s.hint ?? "", text: s.text ?? "" };
    case "web_eval":
      return {
        ...base,
        type: s.type,
        selector: s.selector ?? "",
        read: s.mode,
        name: s.name ?? "",
        resultVariable: s.variable,
        all: s.all ?? false,
        maxItems: s.maxItems ?? 100,
        waitMs: s.maxWaitMs ?? 0,
      };
    case "web_set":
      {
        const value = s.value === undefined ? "" : s.value;
        const valueType: WebSetValueType =
          value === null
            ? "json"
            : typeof value === "number"
              ? "number"
              : typeof value === "boolean"
                ? "boolean"
                : typeof value === "object"
                  ? "json"
                  : "text";
        const valueDraft =
          valueType === "json" ? JSON.stringify(value) : String(value);
      return {
        ...base,
        type: s.type,
        selector: s.selector ?? "",
        set: s.mode,
        valueType,
        value,
        valueDraft,
        name: s.name ?? "",
        property: "",
        resultVariable: s.resultVariable ?? "",
        waitMs: s.maxWaitMs ?? 0,
      };
      }
    case "web_if":
      if ("selector" in s.condition) {
        return {
          ...base,
          type: s.type,
          conditionMode: "page",
          conditionSelector: s.condition.selector,
          conditionPageOperator: s.condition.operator,
          conditionPageValue: s.condition.value ?? "",
          thenSteps: webStepsFromConfig(s.thenSteps),
          elseSteps: webStepsFromConfig(s.elseSteps),
        };
      }
      return {
        ...base,
        type: s.type,
        conditionMode: "variable",
        conditionLeft: s.condition.left,
        conditionOperator: s.condition.operator,
        conditionRight: s.condition.right ?? "",
        thenSteps: webStepsFromConfig(s.thenSteps),
        elseSteps: webStepsFromConfig(s.elseSteps),
      };
    case "web_repeat":
      return {
        ...base,
        type: s.type,
        count: s.count,
        indexVariable: s.indexVariable ?? "",
        steps: webStepsFromConfig(s.steps),
      };
    case "web_for_each":
      return {
        ...base,
        type: s.type,
        selector: s.selector,
        itemVariable: s.itemVariable ?? "",
        indexVariable: s.indexVariable ?? "",
        maxIterations: s.maxIterations ?? 100,
        forEachAttribute: s.attribute ?? "",
        forEachTextContains: s.textContains ?? "",
        steps: webStepsFromConfig(s.steps),
      };
    case "web_finish":
      return { ...base, type: s.type, status: s.status, message: s.message ?? "" };
  }
}

export function webStepsFromConfig(steps: WebStep[] | undefined): WebStepForm[] {
  return (steps ?? []).map(webStepFromConfig);
}
