import { describe, expect, it } from "vitest";
import {
  assertJson, automationContext, boundedReplyText, evaluateCondition, expandActionVariables,
  expandRuntimeCommand, expandVariables, iterationCount, variableValue,
} from "../jobs/automation";

describe("automation values and guards", () => {
  it("expands own nested fields while preserving existing random placeholders", () => {
    const variables = { person: { name: "Alice" }, ids: [5, 8] };
    expect(expandVariables("{person.name} {ids.1} {uuid} {missing}", variables)).toBe("Alice 8 {uuid} {missing}");
    expect(expandActionVariables({ type: "send_command", content: "{person.name}" }, variables)).toEqual({ type: "send_command", content: "Alice" });
    expect(expandActionVariables({ type: "watch_codes", groupId: "group-{person.name}", channelId: "{ids.0}" }, variables))
      .toEqual({ type: "watch_codes", groupId: "group-Alice", channelId: "5" });
    expect(variableValue(variables, "{ids.0}")).toBe(5);
  });

  it("rejects unsafe keys at any depth and inherited variable properties", () => {
    expect(() => assertJson(JSON.parse('{"safe":{"__proto__":{"polluted":true}}}'))).toThrow("Unsafe");
    expect(() => expandVariables("{constructor.name}", {})).toThrow("Unsafe");
    expect(variableValue({}, "toString")).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
  });

  it("does not recursively reinterpret variable values as built-in or variable placeholders", () => {
    const builtin = (token: string) => token === "{uuid}" ? "generated-id" : token === "{num:3}" ? "123" : token;
    expect(expandRuntimeCommand("{person.name} {literal} {uuid} {num:3} {missing}", {
      person: { name: "{literal}" }, literal: "{uuid}",
    }, builtin)).toBe("{literal} {uuid} generated-id 123 {missing}");
    expect(expandActionVariables({ type: "send_command", content: "{literal}", other: "{literal}" }, { literal: "{uuid}" }, ["content"]))
      .toEqual({ type: "send_command", content: "{literal}", other: "{uuid}" });
  });

  it("bounds steps, depth, values, and loop counts", () => {
    const context = automationContext();
    expect(() => context.consume(9)).toThrow("nesting");
    const budget = automationContext();
    for (let i = 0; i < 2000; i++) budget.consume(0);
    expect(() => budget.consume(0)).toThrow("budget");
    expect(() => iterationCount(501)).toThrow("Iteration");
    expect(() => iterationCount(-1)).toThrow("Iteration");
    expect(() => assertJson({ large: "x".repeat(300000) })).toThrow("large");
    expect(() => assertJson({ value: Infinity })).toThrow("finite");
    expect(() => context.set("__proto__", "bad")).toThrow("Invalid variable");
  });

  it("honors cancellation before executing an action", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => automationContext({}, controller.signal).consume(0)).toThrow("Job cancelled");
  });

  it("bounds the reply_text helper separately from user variables", () => {
    const reply = boundedReplyText("长".repeat(100000));
    expect(reply.truncated).toBe(true);
    expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(64 * 1024);
    expect(() => automationContext({ account_id: 1 })).toThrow("reserved");
  });

  it("evaluates explicit text/numeric conditions without executing expressions", () => {
    const variables = { points: 12, status: "ready", empty: [], no: null };
    expect(evaluateCondition({ left: "{points}", operator: "gte", right: "10" }, variables)).toBe(true);
    expect(evaluateCondition({ left: "{status}", operator: "contains", right: "ead" }, variables)).toBe(true);
    expect(evaluateCondition({ left: "{missing}", operator: "exists" }, variables)).toBe(false);
    expect(evaluateCondition({ left: "{empty}", operator: "empty" }, variables)).toBe(true);
    expect(evaluateCondition({ left: "{no}", operator: "exists" }, variables)).toBe(false);
    expect(() => evaluateCondition({ left: "abc", operator: "gt", right: "1" }, variables)).toThrow("finite");
  });
});
