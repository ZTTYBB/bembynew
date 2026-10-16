export const TEMPLATE_CATEGORIES = [
  "checkin", "watch", "draw", "join", "signup", "miniapp", "web", "other",
] as const;

type TemplateCategoryInput = {
  name: string;
  jobType: string;
  config?: unknown;
  category?: string | null;
};

function actionTypes(config: unknown): Set<string> {
  let value = config;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try { value = JSON.parse(value); } catch { return new Set(); }
  }
  const types = new Set<string>();
  const visit = (actions: unknown, depth = 0) => {
    if (!Array.isArray(actions) || depth > 20) return;
    for (const action of actions) {
      if (!action || typeof action !== "object") continue;
      const step = action as Record<string, unknown>;
      if (typeof step.type === "string") types.add(step.type);
      visit(step.actions, depth + 1);
      visit(step.thenActions, depth + 1);
      visit(step.elseActions, depth + 1);
    }
  };
  visit((value as Record<string, unknown> | null)?.actions);
  return types;
}

/** Public release notes describe inference, but do not specify its exact rules. */
export function inferTemplateCategory(template: TemplateCategoryInput): string {
  if (template.jobType === "checkin") return "checkin";
  if (template.jobType === "embywatch") return "watch";
  if (template.jobType === "autoreg") return "signup";
  const name = template.name.toLowerCase();
  if (/\b(draw|lottery|raffle)\b|抽奖|抽獎/.test(name)) return "draw";
  if (/check[\s-]?in|签到|簽到/.test(name)) return "checkin";
  if (/\b(sign[\s-]?up|register|registration)\b|注册|註冊|抢注|搶註/.test(name)) return "signup";
  const types = actionTypes(template.config);
  if ([...types].some((type) => ["join_group", "subscribe_channel", "join_via_bot_app"].includes(type))
    || /\bjoin\b|入群|加群/.test(name)) return "join";
  if ([...types].some((type) => type.includes("mini_app") || type === "open_bot_menu_app")
    || /mini[\s-]?app|小程序/.test(name)) return "miniapp";
  if (types.has("open_url") || /\bweb\b|网页|網頁/.test(name)) return "web";
  return "other";
}

export function effectiveTemplateCategory(template: TemplateCategoryInput): string {
  return template.category?.trim() || inferTemplateCategory(template);
}
