import { describe, expect, it, vi } from "vitest";

vi.mock("../db/database", () => ({
  db: {
    prepare: () => ({
      get: () => ({ value: JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0, readyPollMs: 0 }) }),
      run: () => undefined,
      all: () => [],
    }),
  },
}));

import { runWebSteps } from "../jobs/cloudflare";
import type { WebStep } from "../types";

type FakeElement = {
  textContent: string;
  innerText: string;
  value?: string;
  attrs: Record<string, string>;
  hidden?: boolean;
  clicked: number;
  style: { display: string; visibility: string; opacity: string };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  dispatchEvent(event: Event): boolean;
  click(): void;
  matches(selector: string): boolean;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
  getBoundingClientRect(): { width: number; height: number; x: number; y: number };
  scrollIntoView(): void;
};

function element(text: string, value?: string): FakeElement {
  const attrs: Record<string, string> = {};
  const el: FakeElement = {
    textContent: text,
    innerText: text,
    value,
    attrs,
    clicked: 0,
    style: { display: "block", visibility: "visible", opacity: "1" },
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute: (name, next) => { attrs[name] = next; },
    removeAttribute: (name) => { delete attrs[name]; },
    dispatchEvent: () => true,
    click: () => { el.clicked++; },
    matches: (selector) => selector === ":scope",
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 20, height: 20, x: 0, y: 0 }),
    scrollIntoView: () => undefined,
  };
  return el;
}

function pageFixture(elements: Record<string, FakeElement | FakeElement[]>, bodyText = "") {
  const body = element(bodyText);
  const allElements = () => Object.values(elements).flatMap((value) => Array.isArray(value) ? value : [value]);
  const document = {
    body,
    title: "Fixture",
    querySelector(selector: string): FakeElement | null {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector: string): FakeElement[] {
      if (selector === "body") return [body];
      if (elements[selector]) {
        const value = elements[selector];
        return Array.isArray(value) ? value : [value];
      }
      const marker = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (marker) {
        return allElements().filter((item) =>
          marker[2] === undefined ? marker[1] in item.attrs : item.attrs[marker[1]] === marker[2]);
      }
      return [];
    },
  };
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const page: any = {
    on(event: string, cb: (...args: any[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    },
    off(event: string, cb: (...args: any[]) => void) {
      listeners.get(event)?.delete(cb);
    },
    title: async () => "",
    screenshot: async () => Buffer.from("fixture"),
    mouse: {
      move: async () => undefined,
      click: async () => undefined,
    },
    evaluate: async (fn: Function, arg?: unknown) => {
      const previousDocument = (globalThis as any).document;
      const previousLocation = (globalThis as any).location;
      const previousEvent = (globalThis as any).Event;
      (globalThis as any).document = document;
      (globalThis as any).location = { href: "https://fixture.test/checkin" };
      (globalThis as any).Event = class {
        constructor(public type: string, public init?: unknown) {}
      };
      try {
        return fn(arg);
      } finally {
        (globalThis as any).document = previousDocument;
        (globalThis as any).location = previousLocation;
        (globalThis as any).Event = previousEvent;
      }
    },
  };
  return { page, elements };
}

const deadline = () => Date.now() + 10_000;

describe("web action tree", () => {
  it("reads and writes page values and returns them through variable hooks", async () => {
    const input = element("old", "old");
    const { page } = pageFixture({ "#input": input });
    const variables: Record<string, any> = { target: "input" };
    const run = await runWebSteps(page, [
      { type: "web_set", selector: "#input", mode: "value", value: "new", resultVariable: "written" },
      { type: "web_eval", selector: "#{target}", mode: "value", variable: "current" },
      { type: "web_eval", selector: "#input", mode: "attribute", name: "data-state", variable: "attr" } as any,
    ], deadline(), { variables, setVariable: (name, value) => { variables[name] = value; } });
    if (!run.ok) throw new Error(`${run.failure} ${JSON.stringify(run.logs)}`);
    expect(run.ok).toBe(true);
    expect(input.value).toBe("new");
    expect(variables).toMatchObject({ written: "new", current: "new", attr: null });
    expect(run.logs.map((log) => log.path)).toEqual(["1", "2", "3"]);
    expect(run.logs[0].value).toBe("new");
  });

  it("branches on page state, repeats with an index, and iterates elements", async () => {
    const marker = element("ready");
    const { page } = pageFixture({ "#marker": marker, ".row": element("row") });
    const variables: Record<string, any> = {};
    const run = await runWebSteps(page, [
      {
        type: "web_if",
        condition: { selector: "#marker", operator: "text_contains", value: "ready" },
        thenSteps: [{ type: "web_set", selector: "#marker", mode: "text", value: "then" }],
        elseSteps: [{ type: "web_set", selector: "#marker", mode: "text", value: "else" }],
      },
      {
        type: "web_repeat",
        count: 3,
        indexVariable: "iteration",
        steps: [{ type: "web_eval", selector: "#marker", mode: "text", variable: "seen" }],
      },
      {
        type: "web_for_each",
        selector: ".row",
        itemVariable: "item",
        indexVariable: "rowIndex",
        steps: [{ type: "web_eval", selector: "#marker", mode: "text", variable: "last" }],
      },
    ], deadline(), { variables, setVariable: (name, value) => { variables[name] = value; } });
    if (!run.ok) throw new Error(`${run.failure} ${JSON.stringify(run.logs)}`);
    expect(run.ok).toBe(true);
    expect(marker.textContent).toBe("then");
    expect(variables.iteration).toBe(2);
    expect(variables.rowIndex).toBe(0);
    expect(variables.item).toMatchObject({ text: "row", index: 0 });
    expect(run.logs.some((log) => log.path === "2[2].1")).toBe(true);
  });

  it("scopes nested reads, writes, and conditions to each current element", async () => {
    const first = element("first");
    const second = element("second");
    const { page } = pageFixture({ ".row": [first, second] });
    const variables: Record<string, any> = {};
    const run = await runWebSteps(page, [{
      type: "web_for_each",
      selector: ".row",
      itemVariable: "row",
      indexVariable: "rowIndex",
      steps: [
        { type: "web_eval", selector: "{row}", mode: "text", variable: "current" },
        {
          type: "web_if",
          condition: { selector: "{row}", operator: "text_contains", value: "first" },
          thenSteps: [{
            type: "web_set",
            selector: "{row}",
            mode: "attribute",
            name: "data-branch",
            value: "yes",
          }],
        },
        {
          type: "web_set",
          selector: "{row}",
          mode: "attribute",
          name: "data-index",
          value: "{rowIndex}",
        },
      ],
    }], deadline(), { variables, setVariable: (name, value) => { variables[name] = value; } });
    if (!run.ok) throw new Error(`${run.failure} ${JSON.stringify(run.logs)}`);
    expect(first.attrs).toMatchObject({ "data-branch": "yes", "data-index": "0" });
    expect(second.attrs).toMatchObject({ "data-index": "1" });
    expect(second.attrs["data-branch"]).toBeUndefined();
    expect(variables.current).toBe("second");
    expect(Object.keys(first.attrs).some((key) => key.startsWith("data-bemby-web-scope-"))).toBe(false);
    expect(Object.keys(second.attrs).some((key) => key.startsWith("data-bemby-web-scope-"))).toBe(false);
  });

  it("stops on web_finish without executing later actions", async () => {
    const marker = element("before");
    const { page } = pageFixture({ "#marker": marker });
    const run = await runWebSteps(page, [
      { type: "web_finish", status: "success", message: "done" },
      { type: "web_set", selector: "#marker", mode: "text", value: "after" },
    ], deadline(), {});
    expect(run.ok).toBe(true);
    expect(marker.textContent).toBe("before");
    expect(run.logs).toHaveLength(1);
    expect(run.logs[0].outcome).toContain("done");
  });

  it("rejects oversized trees, unsafe property names, and arbitrary script-like modes", async () => {
    const { page } = pageFixture({ "#marker": element("x") });
    const tooMany = await runWebSteps(page, [{
      type: "web_repeat", count: 501, steps: [],
    }], deadline(), {});
    expect(tooMany.ok).toBe(false);
    expect(tooMany.failure).toMatch(/between 0 and 500/);

    const unsafe = await runWebSteps(page, [{
      type: "web_eval", selector: "#marker", mode: "property", name: "__proto__", variable: "x",
    } as WebStep], deadline(), {});
    expect(unsafe.ok).toBe(false);
    expect(unsafe.failure).toMatch(/safe name/);

    const injected = await runWebSteps(page, [{
      type: "web_eval", selector: "#marker", mode: "script", variable: "x",
    } as any], deadline(), {});
    expect(injected.ok).toBe(false);
    expect(injected.failure).toMatch(/Unsupported web_eval mode/);
  });

  it("honors cancellation during a page operation", async () => {
    const { page } = pageFixture({ "#marker": element("x") });
    const controller = new AbortController();
    controller.abort();
    const run = await runWebSteps(page, [
      { type: "web_eval", selector: "#marker", mode: "text", variable: "x" },
    ], deadline(), { signal: controller.signal });
    expect(run.ok).toBe(false);
    expect(run.failure).toMatch(/cancel/i);
  });
});
