import type { CustomAction as LegacyAction, CustomConfig as LegacyConfig } from "./client";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type VariableAssignment = { name: string; value: JsonValue; source?: "value" | "reply"; regex?: string; valueMode?: "text" | "number" | "boolean" | "json"; valueDraft?: string };
export type TemplateOptionValue = string | number | boolean;
export type TemplateOptionDefinition = {
  name: string;
  label: string;
  options: TemplateOptionValue[];
  default: TemplateOptionValue;
};
export type Condition = { left: string; operator: "eq" | "ne" | "contains" | "not_contains" | "gt" | "gte" | "lt" | "lte" | "exists" | "empty"; right?: string };
export type CustomAction =
  | LegacyAction
  | { type: "set_variables"; variables: VariableAssignment[] }
  | { type: "if_check"; condition: Condition; thenActions: CustomAction[]; elseActions?: CustomAction[] }
  | { type: "repeat"; count: number; indexVariable?: string; actions: CustomAction[] }
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
      /** Delay between item executions, in milliseconds. */
      delayMs?: number;
      /** Stop at the first failed item, or continue with later items. */
      onError?: "stop" | "continue";
      actions: CustomAction[];
    }
  | { type: "finish"; status: "success" | "failed"; message?: string }
  | { type: "save_message_link"; variable: string }
  | { type: "save_data"; folderId: number | undefined; regex: string; key: string; value: string };
export type CustomConfig = Omit<LegacyConfig, "actions"> & {
  actions: CustomAction[];
  variables?: Record<string, JsonValue>;
  jobOptions?: TemplateOptionDefinition[];
  jobOptionValues?: Record<string, TemplateOptionValue>;
};
export type AdvancedActionType = "set_variables" | "if_check" | "repeat" | "for_each" | "finish" | "save_message_link" | "save_data";
export const advancedActionOptions: { type: AdvancedActionType; label: string }[] = [
  { type: "set_variables", label: "设置变量" }, { type: "if_check", label: "条件分支" },
  { type: "repeat", label: "重复执行" }, { type: "for_each", label: "数据循环" },
  { type: "finish", label: "结束流程" }, { type: "save_message_link", label: "保存消息链接" },
  { type: "save_data", label: "保存数据" },
];
export function isAdvancedAction(type: string): type is AdvancedActionType { return advancedActionOptions.some((option) => option.type === type); }
export function defaultWorkflowAction(type: CustomAction["type"] = "send_command"): CustomAction {
  switch (type) {
    case "set_variables": return { type, variables: [{ name: "", value: "" }] };
    case "if_check": return { type, condition: { left: "", operator: "eq", right: "" }, thenActions: [], elseActions: [] };
    case "repeat": return { type, count: 2, indexVariable: "loop_index", actions: [] };
    case "for_each": return { type, source: "variable", variable: "", itemVariable: "item", indexVariable: "loop_index", maxIterations: 100, onlyUnprocessed: true, markProcessed: false, actions: [] };
    case "finish": return { type, status: "success", message: "" };
    case "save_message_link": return { type, variable: "message_link" };
    case "save_data": return { type, folderId: undefined, regex: "", key: "{match}", value: "{match}" };
    case "send_contact_message": return { type, contact: "", content: "" };
    case "wait_reply": return { type, maxWaitMs: 30000 };
    case "delay": return { type, waitMs: 2000 };
    case "save_tag": return { type, name: "", value: "" };
    case "click_button": return { type, button: "", maxRetries: 0, maxWaitMs: 30000 };
    case "click_message_button": return { type, contact: "", button: "", maxRetries: 0, maxWaitMs: 30000 };
    case "join_group": return { type, groupId: "" };
    case "subscribe_channel": return { type, channelId: "" };
    case "leave_group": return { type, groupId: "" };
    case "unsubscribe_channel": return { type, channelId: "" };
    case "enter_captcha": return { type, maxWaitMs: 30000 };
    case "open_url": return { type, url: "", steps: [] };
    case "open_mini_app": return { type, appButtons: [] };
    case "open_mini_app_url": return { type, url: "", appButtons: [] };
    case "open_bot_menu_app": return { type, appButtons: [] };
    case "mini_app_http": return { type, url: "", method: "GET", body: "", contentType: "application/json", responseVariable: "", statusVariable: "", maxWaitMs: 30000, sendInitData: false };
    case "ai_multiple_btn": return { type, gapMs: 1000, maxRetries: 0, maxWaitMs: 30000 };
    case "watch_buttons": return { type, groupId: "", button: "", alsoWatchButtons: [], maxWaitMs: 15 * 60 * 60 * 1000, minShare: 0, thankYou: [], thankDelayMinMs: 0, thankDelayMaxMs: 0, thankAsReply: false };
    case "watch_codes": return { type, groupId: "", regex: "", command: "/start {code}", maxWaitMs: 15 * 60 * 60 * 1000, maxCodeAgeMs: 10 * 60 * 1000, replyWaitMs: 40000 };
    default: return { type: "send_command", content: "/start" };
  }
}
const invalidNames = new Set(["__proto__", "constructor", "prototype", "account_id", "reply_text"]);
const unsafeJsonKeys = new Set(["__proto__", "constructor", "prototype"]);
function requireName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || invalidNames.has(name)) throw new Error("变量名不合法或为系统保留名");
}
function requireCount(value: unknown, fallback: number) {
  const count = value == null ? fallback : value;
  if (!Number.isInteger(count) || Number(count) < 0 || Number(count) > 500) throw new Error("循环次数必须是 0 到 500 的整数");
}
function safeJson(value: unknown, depth = 0): void {
  if (depth > 16) throw new Error("JSON 数据层级过深");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach((item) => safeJson(item, depth + 1)); return; }
  if (!value || typeof value !== "object") throw new Error("无效 JSON 值");
  for (const [key, child] of Object.entries(value)) { if (unsafeJsonKeys.has(key)) throw new Error("JSON 包含不安全属性"); safeJson(child, depth + 1); }
}
export function workflowToConfig(action: CustomAction, depth = 0): CustomAction {
  if (depth > 8) throw new Error("流程嵌套不能超过 8 层");
  const result = JSON.parse(JSON.stringify(action)) as CustomAction;
  switch (result.type) {
    case "set_variables":
      if (!result.variables.length) throw new Error("请至少添加一个变量");
      result.variables = result.variables.map(({ name, value, source, regex, valueMode, valueDraft }) => {
        requireName(name);
        if (source !== "reply") {
          if (valueMode === "json") { try { value = JSON.parse(valueDraft ?? JSON.stringify(value)); } catch { throw new Error(`变量 ${name} 的 JSON 无效`); } }
          else if (valueMode === "number") { if (value === "" || !Number.isFinite(Number(value))) throw new Error(`变量 ${name} 需要有限数值`); value = Number(value); }
          else if (valueMode === "boolean") value = value === true;
          safeJson(value);
        }
        return { name, value, ...(source ? { source } : {}), ...(regex ? { regex } : {}) };
      });
      break;
    case "if_check": result.thenActions = result.thenActions.map((item) => workflowToConfig(item, depth + 1)); result.elseActions = (result.elseActions ?? []).map((item) => workflowToConfig(item, depth + 1)); break;
    case "repeat": requireCount(result.count, 0); requireName(result.indexVariable || "loop_index"); result.actions = result.actions.map((item) => workflowToConfig(item, depth + 1)); break;
    case "for_each":
      requireCount(result.maxIterations, 100); requireName(result.itemVariable || "item"); requireName(result.indexVariable || "loop_index");
      if ((result.itemVariable || "item") === (result.indexVariable || "loop_index")) throw new Error("数据变量与序号变量不能同名");
      if (result.source === "warehouse" && (!Number.isSafeInteger(result.folderId) || Number(result.folderId) < 1)) throw new Error("请选择数据仓库文件夹");
      if (result.source === "variable" && !result.variable?.trim()) throw new Error("请填写数组变量名");
      if (result.delayMs != null && (!Number.isInteger(result.delayMs) || result.delayMs < 0 || result.delayMs > 3_600_000)) {
        throw new Error("数据循环间隔必须是 0 到 3600000 的整数毫秒");
      }
      if (result.onError != null && result.onError !== "stop" && result.onError !== "continue") {
        throw new Error("数据循环失败策略无效");
      }
      result.actions = result.actions.map((item) => workflowToConfig(item, depth + 1)); break;
    case "save_message_link": requireName(result.variable); break;
    case "save_data":
      if (!Number.isSafeInteger(result.folderId) || Number(result.folderId) < 1) throw new Error("请选择数据仓库文件夹");
      if (!result.regex.trim() || result.regex.length > 500) throw new Error("保存数据需要 1 到 500 个字符的正则表达式");
      if (!result.key.trim() || result.key.length > 256 || result.value.length > 32768) throw new Error("保存数据的键和值模板长度无效");
      try { new RegExp(result.regex); } catch { throw new Error("保存数据的正则表达式无效"); }
      break;
    case "mini_app_http":
      if (!result.url.trim() || result.url.length > 2048) throw new Error("Mini App HTTP URL is required and must be at most 2048 characters");
      if (result.method !== "GET" && result.method !== "POST") throw new Error("Mini App HTTP method is invalid");
      if (result.body && new TextEncoder().encode(result.body).length > 64 * 1024) throw new Error("Mini App HTTP body is too large");
      if (result.method === "GET" && result.body) throw new Error("GET Mini App HTTP requests cannot have a body");
      if (result.contentType && !["application/json", "application/x-www-form-urlencoded", "text/plain"].includes(result.contentType)) throw new Error("Mini App HTTP content type is invalid");
      if (result.responseVariable) requireName(result.responseVariable);
      if (result.statusVariable) requireName(result.statusVariable);
      if (result.maxWaitMs != null && (!Number.isFinite(Number(result.maxWaitMs)) || Number(result.maxWaitMs) < 100 || Number(result.maxWaitMs) > 300000)) throw new Error("Mini App HTTP timeout is out of range");
      if (result.successContains && result.successContains.length > 4096) throw new Error("Success marker is too long");
      if (result.failContains && result.failContains.length > 4096) throw new Error("Failure marker is too long");
      break;
    case "watch_codes": {
      if (!result.groupId.trim()) throw new Error("抢码需要填写监听群组");
      if (!result.regex.trim() || result.regex.length > 500) throw new Error("抢码需要 1 到 500 个字符的正则表达式");
      const slash = result.regex.trim().match(/^\/([\s\S]*)\/([dgimsuvy]*)$/);
      try { new RegExp(slash ? slash[1] : result.regex.trim(), slash ? slash[2] : ""); }
      catch { throw new Error("抢码正则表达式无效"); }
      if (result.command && result.command.length > 1024) throw new Error("抢码发送命令过长");
      for (const [name, value, min, max] of [
        ["maxWaitMs", result.maxWaitMs, 1000, 86_400_000],
        ["maxCodeAgeMs", result.maxCodeAgeMs, 0, 86_400_000],
        ["replyWaitMs", result.replyWaitMs, 100, 600_000],
      ] as const) {
        if (value != null && (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max)) {
          throw new Error(`${name} 超出允许范围`);
        }
      }
      break;
    }
  }
  return result;
}
