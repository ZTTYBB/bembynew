export type AccountTagValue = string | number | boolean | null;
export type AccountTags = Record<string, AccountTagValue>;
export type TagFilterOp = "has" | "lacks" | "eq" | "ne" | "contains" | "gt" | "gte" | "lt" | "lte";
export type AccountTagFilter = { name: string; op: TagFilterOp; value?: string };
export type TagDraft = {
  id: number;
  name: string;
  hasValue: boolean;
  value: string;
  originalValue?: AccountTagValue;
};

export const TAG_FILTER_OPS: TagFilterOp[] = ["has", "lacks", "eq", "ne", "contains", "gt", "gte", "lt", "lte"];
const RESERVED_NAMES = new Set(["__proto__", "prototype", "constructor"]);
let nextDraftId = 0;

export function newTagDraft(): TagDraft {
  return { id: ++nextDraftId, name: "", hasValue: false, value: "" };
}

export function tagsToDraft(tags: AccountTags = {}): TagDraft[] {
  return Object.entries(tags).map(([name, value]) => ({
    ...newTagDraft(),
    name,
    hasValue: value !== true && value !== null,
    value: value === true || value === null ? "" : String(value),
    originalValue: value,
  }));
}

export function tagsFromDraft(rows: TagDraft[]): AccountTags {
  const result: AccountTags = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && !row.hasValue && !row.value) continue;
    if (!name) throw new Error("tagNameRequired");
    if (name.length > 96 || RESERVED_NAMES.has(name)) throw new Error("tagNameInvalid");
    if (row.value.length > 512) throw new Error("tagValueTooLong");
    if (Object.prototype.hasOwnProperty.call(result, name)) throw new Error("tagDuplicate");
    if (!row.hasValue) {
      result[name] = row.originalValue === null ? null : true;
    } else {
      const original = row.originalValue;
      result[name] = original !== undefined && original !== null && original !== true
        && String(original) === row.value ? original : row.value;
    }
  }
  if (Object.keys(result).length > 128) throw new Error("tagLimit");
  return result;
}

export function normalizeTagFilters(value: unknown): AccountTagFilter[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((row) => {
    if (!row || typeof row !== "object" || typeof row.name !== "string") return [];
    const name = row.name.trim();
    if (!name || name.length > 96 || !TAG_FILTER_OPS.includes(row.op)) return [];
    return [{
      name,
      op: row.op as TagFilterOp,
      ...(!["has", "lacks"].includes(row.op) ? { value: String(row.value ?? "") } : {}),
    }];
  });
}

export function legacyTagFilter(value: string): AccountTagFilter[] {
  const separator = value.indexOf("=");
  const name = (separator < 0 ? value : value.slice(0, separator)).trim();
  if (!name) return [];
  return [{
    name,
    op: separator < 0 ? "has" : "contains",
    ...(separator >= 0 ? { value: value.slice(separator + 1).trim() } : {}),
  }];
}

export function validateTagFilters(rows: AccountTagFilter[]): string | null {
  if (rows.length > 32) return "filterLimit";
  for (const row of rows) {
    if (!row.name.trim()) return "tagNameRequired";
    if (row.name.trim().length > 96) return "tagNameInvalid";
    if (["gt", "gte", "lt", "lte"].includes(row.op)) {
      try {
        const value = JSON.parse(String(row.value ?? "").replace(/,/g, ""));
        if (typeof value !== "number" || !Number.isFinite(value)) return "filterNumberRequired";
      } catch {
        return "filterNumberRequired";
      }
    }
  }
  return null;
}
