import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultWebStep,
  webStepFromConfig,
  webStepToConfig,
  webStepsFromConfig,
  webStepsToConfig,
} from "../src/composables/webSteps.ts";

function form(type, patch = {}) {
  return { ...defaultWebStep(), type, ...patch };
}

test("serializes the primitive page actions with only their contract fields", () => {
  assert.deepEqual(webStepsToConfig([
    form("web_input", { selector: " #email ", text: "alice@example.test" }),
    form("web_button", { selector: "#submit" }),
    form("web_delay", { waitMs: 250 }),
    form("web_scroll", { scrollX: 4, scrollY: 120 }),
    form("web_wait_element", { selector: ".ready", waitMs: 5000 }),
    form("web_turnstile"),
    form("ai_web_button", { hint: "Continue" }),
    form("ai_web_click_xy", { hint: "the green checkmark" }),
    form("ai_web_input", { hint: "Email field", text: "a@b.test" }),
  ]), [
    { type: "web_input", selector: "#email", text: "alice@example.test" },
    { type: "web_button", selector: "#submit" },
    { type: "web_delay", waitMs: 250 },
    { type: "web_scroll", x: 4, y: 120 },
    { type: "web_wait_element", selector: ".ready", waitMs: 5000 },
    { type: "web_turnstile" },
    { type: "ai_web_button", hint: "Continue" },
    { type: "ai_web_click_xy", hint: "the green checkmark" },
    { type: "ai_web_input", hint: "Email field", text: "a@b.test" },
  ]);
});

test("serializes web_eval reads and omits selector for page metadata", () => {
  assert.deepEqual(webStepToConfig(form("web_eval", {
    selector: " .status ",
    read: "text",
    resultVariable: "status",
    all: true,
    maxItems: 12,
    waitMs: 1400,
  })), {
    type: "web_eval",
    selector: ".status",
    mode: "text",
    variable: "status",
    all: true,
    maxItems: 12,
    maxWaitMs: 1400,
  });
  assert.deepEqual(webStepToConfig(form("web_eval", {
    read: "url",
    resultVariable: "page_url",
    selector: "ignored",
  })), {
    type: "web_eval",
    mode: "url",
    variable: "page_url",
  });
  assert.deepEqual(webStepToConfig(form("web_eval", {
    read: "attribute",
    selector: "[data-state]",
    name: " data-state ",
    resultVariable: "state",
  })), {
    type: "web_eval",
    selector: "[data-state]",
    mode: "attribute",
    name: "data-state",
    variable: "state",
  });
  assert.deepEqual(webStepToConfig(form("web_eval", {
    read: "text",
    resultVariable: "page_text",
  })), {
    type: "web_eval",
    mode: "text",
    variable: "page_text",
  });
});

test("serializes web_set modes, including typed JSON values", () => {
  assert.deepEqual(webStepsToConfig([
    form("web_set", {
      selector: "#count",
      set: "value",
      value: "42",
      resultVariable: "set_result",
      waitMs: 300,
    }),
    form("web_set", {
      selector: "#enabled",
      set: "property",
      name: "checked",
      value: true,
    }),
    form("web_set", {
      selector: "#submit",
      set: "click",
      value: "must-be-omitted",
    }),
    form("web_set", {
      selector: "#payload",
      set: "property",
      name: "data",
      valueType: "json",
      valueDraft: '{"ok":true,"count":2}',
    }),
  ]), [
    {
      type: "web_set",
      selector: "#count",
      mode: "value",
      value: "42",
      resultVariable: "set_result",
      maxWaitMs: 300,
    },
    {
      type: "web_set",
      selector: "#enabled",
      mode: "property",
      name: "checked",
      value: true,
    },
    { type: "web_set", selector: "#submit", mode: "click" },
    {
      type: "web_set",
      selector: "#payload",
      mode: "property",
      name: "data",
      value: { ok: true, count: 2 },
    },
  ]);
});

test("round-trips a complete nested action tree without losing branches", () => {
  const config = [{
    type: "web_if",
    condition: {
      left: "{status}",
      operator: "contains",
      right: "success",
    },
    thenSteps: [{
      type: "web_repeat",
      count: 2,
      indexVariable: "attempt",
      steps: [{
        type: "web_for_each",
        selector: ".claim",
        itemVariable: "claim",
        indexVariable: "claim_index",
        maxIterations: 7,
        steps: [{
          type: "web_set",
          selector: "{item}",
          mode: "click",
          resultVariable: "clicked",
        }],
      }],
    }],
    elseSteps: [{
      type: "web_finish",
      status: "failed",
      message: "claim button was not found",
    }],
  }];
  const forms = webStepsFromConfig(config);
  assert.equal(forms.length, 1);
  assert.equal(forms[0].thenSteps[0].steps[0].steps[0].type, "web_set");
  assert.deepEqual(webStepsToConfig(forms), config);
});

test("fromConfig creates independent form trees and accepts missing optional branches", () => {
  const config = [{
    type: "web_if",
    condition: { left: "ready", operator: "exists" },
    thenSteps: [{ type: "web_finish", status: "success" }],
  }];
  const forms = webStepsFromConfig(config);
  assert.deepEqual(forms[0].elseSteps, []);
  forms[0].thenSteps.push(form("web_delay", { waitMs: 10 }));
  assert.equal(config[0].thenSteps.length, 1);
  assert.equal(webStepsFromConfig(undefined).length, 0);
});

test("round-trips selector-based page conditions supported by the backend", () => {
  const config = [{
    type: "web_if",
    condition: { selector: "#status", operator: "text_contains", value: "ready" },
    thenSteps: [{ type: "web_finish", status: "success" }],
    elseSteps: [{ type: "web_finish", status: "failed" }],
  }];
  const forms = webStepsFromConfig(config);
  assert.deepEqual(webStepsToConfig(forms), config);
});

test("round-trips for-each filters and exposes whole-page text reads", () => {
  const config = [
    {
      type: "web_for_each",
      selector: ".claim",
      itemVariable: "claim",
      indexVariable: "index",
      attribute: "data-id",
      textContains: "签到",
      maxIterations: 4,
      steps: [],
    },
  ];
  const forms = webStepsFromConfig(config);
  assert.equal(forms[0].forEachAttribute, "data-id");
  assert.equal(forms[0].forEachTextContains, "签到");
  assert.deepEqual(webStepsToConfig(forms), config);
});

test("rejects unsafe or incomplete page-step input before saving", () => {
  const invalid = [
    [form("web_input"), /CSS 选择器/],
    [form("web_eval", { resultVariable: "", selector: ".x" }), /结果变量名/],
    [form("web_eval", { resultVariable: "constructor", selector: ".x" }), /结果变量名/],
    [form("web_eval", { resultVariable: "x", read: "attribute", selector: ".x", name: "" }), /属性名/],
    [form("web_eval", { resultVariable: "x", read: "property", selector: ".x", name: "__proto__" }), /属性名/],
    [form("web_set", { selector: ".x", set: "property", name: "constructor" }), /属性名/],
    [form("web_if", { conditionLeft: "", thenSteps: [] }), /左值/],
    [form("web_repeat", { count: 501 }), /重复次数/],
    [form("web_for_each", { selector: ".x", itemVariable: "same", indexVariable: "same" }), /不能同名/],
    [form("web_for_each", { selector: ".x", maxIterations: 0 }), /循环上限/],
    [form("web_set", { selector: ".x", set: "attribute", name: "onerror" }), /属性名/],
    [form("web_set", { selector: ".x", valueType: "json", valueDraft: "{" }), /JSON 值格式无效/],
    [form("web_eval", { selector: ".x", resultVariable: "x", waitMs: 300001 }), /超时/],
    [form("web_button", { selector: `.${"x".repeat(2049)}` }), /过长/],
  ];
  for (const [step, error] of invalid) assert.throws(() => webStepToConfig(step), error);
});

test("enforces a finite nesting depth", () => {
  let step = form("web_delay", { waitMs: 1 });
  for (let depth = 0; depth < 9; depth++) {
    step = form("web_if", {
      conditionLeft: "ready",
      conditionOperator: "exists",
      thenSteps: [step],
    });
  }
  assert.throws(() => webStepToConfig(step), /嵌套不能超过/);
});

test("preserves typed web_set values through config and form conversion", () => {
  const config = [
    { type: "web_set", selector: "#enabled", mode: "property", name: "checked", value: true },
    { type: "web_set", selector: "#attempts", mode: "property", name: "value", value: 3 },
    { type: "web_set", selector: "#payload", mode: "property", name: "data", value: { ok: true, count: 2 } },
    { type: "web_set", selector: "#empty", mode: "property", name: "data", value: null },
  ];
  const forms = webStepsFromConfig(config);
  assert.deepEqual(webStepsToConfig(forms), config);
});

