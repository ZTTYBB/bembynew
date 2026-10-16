import type { AvailableAccount, JobTemplate, TemplateCreationEligibility } from "../api/client";

export const templateCategories = [
  "checkin", "watch", "draw", "join", "signup", "miniapp", "web", "other",
] as const;

export function templateCategory(template: JobTemplate): string {
  return template.category || template.inferredCategory
    || ({ checkin: "checkin", embywatch: "watch", autoreg: "signup" } as Record<string, string>)[template.jobType]
    || "other";
}

export function templateCreationAccountIds(
  template: Pick<JobTemplate, "id" | "jobType">,
  eligibility: TemplateCreationEligibility,
): number[] {
  const preview = eligibility.templates.find((item) => item.templateId === template.id);
  if (!preview) return [];
  const linked = new Set(preview.linkedAccountIds);
  return (template.jobType === "embywatch" ? eligibility.accountIds : eligibility.telegramAccountIds)
    .filter((id) => !linked.has(id));
}

export function canCreateTemplateJob(account: AvailableAccount, jobType?: JobTemplate["jobType"]): boolean {
  return !account.linked && (account.canCreate ?? (jobType === "embywatch" || account.authStatus === "authenticated"));
}

export type CandidateFilters = {
  excludeLinked: boolean;
  excludeRestricted: boolean;
  includeKeywords: string;
  excludeKeywords: string;
  succeededTemplateId: number | "";
};

export function defaultCandidateFilters(): CandidateFilters {
  return { excludeLinked: true, excludeRestricted: false, includeKeywords: "", excludeKeywords: "", succeededTemplateId: "" };
}

function keywords(value: string): string[] {
  return value.split(/[,，]/).map((part) => part.trim().toLocaleLowerCase()).filter(Boolean);
}

export function isRestrictedAccount(account: AvailableAccount): boolean {
  return ["limited", "restricted", "blocked", "frozen", "banned"].includes(account.restriction ?? "");
}

export function matchesCandidateFilters(account: AvailableAccount, filters: CandidateFilters): boolean {
  if (filters.excludeLinked && account.linked) return false;
  if (filters.excludeRestricted && isRestrictedAccount(account)) return false;
  const name = `${account.name} ${account.tgDisplayName ?? ""}`.toLocaleLowerCase();
  const include = keywords(filters.includeKeywords);
  if (include.length && !include.some((word) => name.includes(word))) return false;
  if (keywords(filters.excludeKeywords).some((word) => name.includes(word))) return false;
  return filters.succeededTemplateId === ""
    || Boolean(account.successfulTemplateIds?.includes(Number(filters.succeededTemplateId)));
}
