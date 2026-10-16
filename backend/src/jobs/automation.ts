export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type AutomationCondition = {
  left: string;
  operator: "eq" | "ne" | "contains" | "not_contains" | "gt" | "gte" | "lt" | "lte" | "exists" | "empty";
  right?: string;
};

export type AdvancedAction<Action = unknown> =
  | { type: "set_variables"; variables: { name: string; value: JsonValue; source?: "value" | "reply"; regex?: string }[] }
  | { type: "if_check"; condition: AutomationCondition; thenActions: Action[]; elseActions?: Action[] }
  | { type: "repeat"; count: number; indexVariable?: string; actions: Action[] }
  | {
      type: "for_each";
      source: "variable" | "warehouse";
      variable?: string;
      folderId?: number;
      onlyUnprocessed?: boolean;
      markProcessed?: boolean;
      itemVariable?: string;
      indexVariable?: string;
      maxIterations?: number;
      actions: Action[];
    }
  | { type: "finish"; status: "success" | "failed"; message?: string }
  | { type: "save_message_link"; variable: string }
  | { type: "save_data"; folderId: number; regex: string; key: string; value: string };

const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SYSTEM_VARIABLES = new Set(["account_id", "reply_text"]);
export const ADVANCED_ACTION_TYPES = new Set([
  "set_variables", "if_check", "repeat", "for_each", "finish", "save_message_link", "save_data",
]);
export const MAX_AUTOMATION_STEPS = 2000;
export const MAX_AUTOMATION_DEPTH = 8;
export const MAX_AUTOMATION_ITERATIONS = 500;
export const MAX_VARIABLE_BYTES = 256 * 1024;

export function isVariableName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) && !BLOCKED_KEYS.has(value);
}
export function assertMutableVariableName(name: unknown): asserts name is string {
  if (!isVariableName(name) || SYSTEM_VARIABLES.has(name)) throw new Error("Invalid or reserved variable name");
}

export function boundedReplyText(value: string): { text: string; truncated: boolean } {
  const maxBytes = 64 * 1024;
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maxBytes
    ? { text: value, truncated: false }
    : { text: `${bytes.subarray(0, maxBytes - 4).toString("utf8")}...`, truncated: true };
}

export function assertJson(value: unknown, maxBytes = MAX_VARIABLE_BYTES): asserts value is JsonValue {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 20000 || depth > 16) throw new Error("JSON data is too complex");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object") throw new Error("Only finite JSON values are allowed");
    if (seen.has(item)) throw new Error("Circular JSON data is not allowed");
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("JSON objects must be plain objects");
      for (const [key, child] of Object.entries(item)) {
        if (BLOCKED_KEYS.has(key)) throw new Error(`Unsafe JSON key: ${key}`);
        visit(child, depth + 1);
      }
    }
    seen.delete(item);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) throw new Error("JSON data is too large");
}

export function variableValue(variables: Record<string, JsonValue>, path: string): JsonValue | undefined {
  const segments = path.replace(/^\{|\}$/g, "").split(".");
  if (segments.some((key) => BLOCKED_KEYS.has(key))) throw new Error("Unsafe variable path");
  let value: unknown = variables;
  for (const key of segments) {
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value as JsonValue | undefined;
}

export function valueText(value: JsonValue | undefined): string {
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function expandVariables(template: string, variables: Record<string, JsonValue>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\}/g, (token, path: string) => {
    const value = variableValue(variables, path);
    return value === undefined ? token : valueText(value);
  });
}

export function expandRuntimeCommand(
  template: string,
  variables: Record<string, JsonValue>,
  expandBuiltin: (token: string) => string,
): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)(?::\d+)?\}/g, (token, path: string) => {
    const value = variableValue(variables, path);
    return value === undefined ? expandBuiltin(token) : valueText(value);
  });
}

export function expandActionVariables<T>(value: T, variables: Record<string, JsonValue>, skipRootKeys: readonly string[] = []): T {
  if (typeof value === "string") return expandVariables(value, variables) as T;
  if (Array.isArray(value)) return value.map((item) => expandActionVariables(item, variables)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, key === "type" || skipRootKeys.includes(key) ? item : expandActionVariables(item, variables),
    ])) as T;
  }
  return value;
}

export function evaluateCondition(condition: AutomationCondition, variables: Record<string, JsonValue>): boolean {
  if (!condition || typeof condition.left !== "string") throw new Error("Condition requires a left value");
  const left = expandVariables(condition.left, variables);
  const right = expandVariables(condition.right ?? "", variables);
  switch (condition.operator) {
    case "exists": {
      const value = variableValue(variables, condition.left);
      return value !== undefined && value !== null;
    }
    case "empty": {
      const value = /^\{[^}]+\}$/.test(condition.left)
        ? variableValue(variables, condition.left) : left;
      return value == null || value === "" || (Array.isArray(value) && value.length === 0);
    }
    case "eq": return left === right;
    case "ne": return left !== right;
    case "contains": return left.includes(right);
    case "not_contains": return !left.includes(right);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (!left.trim() || !right.trim() || !Number.isFinite(Number(left)) || !Number.isFinite(Number(right))) {
        throw new Error("Numeric conditions require two finite numbers");
      }
      const a = Number(left);
      const b = Number(right);
      return condition.operator === "gt" ? a > b : condition.operator === "gte" ? a >= b : condition.operator === "lt" ? a < b : a <= b;
    }
    default: throw new Error("Unsupported condition operator");
  }
}

export class AutomationFinish extends Error {
  constructor(public readonly status: "success" | "failed", message: string) {
    super(message || (status === "success" ? "Finished successfully" : "Finished as failed"));
    this.name = "AutomationFinish";
  }
}

export function automationContext(initial: Record<string, JsonValue> = {}, signal?: AbortSignal) {
  assertJson(initial);
  const variables: Record<string, JsonValue> = Object.create(null);
  for (const [name, value] of Object.entries(initial)) {
    assertMutableVariableName(name);
    variables[name] = structuredClone(value);
  }
  let steps = 0;
  return {
    variables,
    consume(depth: number): void {
      if (signal?.aborted) throw new Error("Job cancelled");
      if (depth > MAX_AUTOMATION_DEPTH) throw new Error("Automation nesting limit exceeded");
      if (++steps > MAX_AUTOMATION_STEPS) throw new Error("Automation step budget exceeded");
    },
    set(name: string, value: JsonValue): void {
      if (!isVariableName(name)) throw new Error("Invalid variable name");
      assertJson(value);
      variables[name] = structuredClone(value);
      assertJson(variables);
    },
  };
}

export function iterationCount(value: unknown, fallback?: number): number {
  const count = value == null ? fallback : value;
  if (!Number.isInteger(count) || Number(count) < 0 || Number(count) > MAX_AUTOMATION_ITERATIONS) {
    throw new Error(`Iteration count must be between 0 and ${MAX_AUTOMATION_ITERATIONS}`);
  }
  return Number(count);
}
