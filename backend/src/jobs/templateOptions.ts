import type { JsonValue } from "./automation";

/**
 * Custom templates keep their option definitions in the config blob. A
 * linked job stores the selected values next to the copied definition so that
 * editing a job cannot accidentally make its placeholders unresolved.
 */
export const TEMPLATE_OPTIONS_KEY = "jobOptions";
export const TEMPLATE_OPTION_VALUES_KEY = "jobOptionValues";

export const MAX_TEMPLATE_OPTIONS = 50;
export const MAX_TEMPLATE_OPTION_CHOICES = 100;

export type CustomTemplateOption = {
  name: string;
  label: string;
  options: TemplateOptionValue[];
  default: TemplateOptionValue;
};

export type TemplateOptionValue = string | number | boolean;
export type CustomTemplateOptionValues = Record<string, TemplateOptionValue>;

type RecordValue = Record<string, unknown>;

const BLOCKED_NAMES = new Set(["__proto__", "prototype", "constructor", "account_id", "reply_text"]);
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeOptionName(value: unknown): value is string {
  return typeof value === "string" &&
    VARIABLE_NAME.test(value) &&
    !BLOCKED_NAMES.has(value);
}

/**
 * Config blobs historically arrived both as objects and as JSON strings
 * (including a few double-encoded exports). Keep accepting those forms while
 * ensuring route writes always use a plain object.
 */
export function parseTemplateConfig(raw: unknown): RecordValue | null {
  if (raw == null) return null;
  let value: unknown = raw;
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
}

function normaliseChoice(value: unknown): TemplateOptionValue | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (isRecord(value) &&
      (typeof value.value === "string" || typeof value.value === "number" || typeof value.value === "boolean")) {
    return normaliseChoice(value.value);
  }
  return null;
}

function normaliseOption(raw: unknown, index: number): CustomTemplateOption | null {
  if (!isRecord(raw) || !isSafeOptionName(raw.name)) return null;
  const label = raw.label === undefined ? raw.name : raw.label;
  if (typeof label !== "string" || !label.trim() || label.length > 128) return null;
  const rawChoices = Array.isArray(raw.options)
    ? raw.options
    : Array.isArray(raw.choices) ? raw.choices : null;
  if (!rawChoices || rawChoices.length === 0 || rawChoices.length > MAX_TEMPLATE_OPTION_CHOICES) return null;
  const options: TemplateOptionValue[] = [];
  for (const rawChoice of rawChoices) {
    const choice = normaliseChoice(rawChoice);
    if (choice === null || options.some((existing) => Object.is(existing, choice)) ||
        (typeof choice === "string" && choice.length > 128)) return null;
    options.push(choice);
  }
  const fallback = options[0];
  const defaultValue = raw.default === undefined ? fallback : normaliseChoice(raw.default);
  if (defaultValue === null || !options.some((choice) => Object.is(choice, defaultValue))) return null;
  return { name: raw.name, label: label.trim(), options, default: defaultValue };
}

/**
 * Return normalised definitions and a user-facing error for malformed input.
 * `undefined` means the config has no template options, which is valid.
 */
export function readTemplateOptions(config: unknown): {
  options: CustomTemplateOption[];
  error: string | null;
} {
  const parsed = parseTemplateConfig(config);
  if (!parsed || parsed[TEMPLATE_OPTIONS_KEY] === undefined) return { options: [], error: null };
  const rawOptions = parsed[TEMPLATE_OPTIONS_KEY];
  if (!Array.isArray(rawOptions) || rawOptions.length > MAX_TEMPLATE_OPTIONS) {
    return { options: [], error: `jobOptions must contain 1 to ${MAX_TEMPLATE_OPTIONS} options` };
  }
  const options: CustomTemplateOption[] = [];
  const names = new Set<string>();
  for (let index = 0; index < rawOptions.length; index++) {
    const option = normaliseOption(rawOptions[index], index);
    if (!option) {
      return { options: [], error: `jobOptions[${index}] is invalid` };
    }
    if (names.has(option.name)) return { options: [], error: `Duplicate job option name: ${option.name}` };
    names.add(option.name);
    options.push(option);
  }
  return { options, error: null };
}

function readValues(raw: unknown): { values: CustomTemplateOptionValues; error: string | null } {
  if (raw === undefined) return { values: {}, error: null };
  if (!isRecord(raw)) return { values: {}, error: `${TEMPLATE_OPTION_VALUES_KEY} must be an object` };
  const values: CustomTemplateOptionValues = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isSafeOptionName(name) ||
        !(typeof value === "string" || typeof value === "number" || typeof value === "boolean") ||
        (typeof value === "number" && !Number.isFinite(value))) {
      return { values: {}, error: `${TEMPLATE_OPTION_VALUES_KEY} must map option names to primitive values` };
    }
    values[name] = value;
  }
  return { values, error: null };
}

/**
 * Validate and resolve task selections. Missing values use each option's
 * default; supplied values must be one of that option's public choices.
 */
export function resolveTemplateOptionValues(
  options: readonly CustomTemplateOption[],
  rawValues: unknown,
  rejectUnknown = false,
): { values: CustomTemplateOptionValues; error: string | null } {
  const parsed = readValues(rawValues);
  if (parsed.error) return parsed;
  const known = new Set(options.map((option) => option.name));
  if (rejectUnknown) {
    const unknown = Object.keys(parsed.values).find((name) => !known.has(name));
    if (unknown) return { values: {}, error: `Unknown job option: ${unknown}` };
  }
  const values: CustomTemplateOptionValues = {};
  for (const option of options) {
    const selected = parsed.values[option.name];
    if (selected === undefined) {
      values[option.name] = option.default;
    } else if (!option.options.some((choice) => Object.is(choice, selected))) {
      return {
        values: {},
        error: `${option.name} must be one of: ${option.options.join(", ")}`,
      };
    } else {
      values[option.name] = selected;
    }
  }
  return { values, error: null };
}

export function validateTemplateOptions(config: unknown): string | null {
  const { error } = readTemplateOptions(config);
  if (error) return error;
  const parsed = parseTemplateConfig(config);
  if (!parsed) return null;
  const { options } = readTemplateOptions(parsed);
  const values = resolveTemplateOptionValues(
    options,
    parsed[TEMPLATE_OPTION_VALUES_KEY],
    true,
  );
  return values.error;
}

/**
 * Merge a custom template with a linked job's config. Template actions and
 * option definitions remain authoritative; only the job's valid selections
 * survive. Invalid legacy selections fall back to defaults so one corrupt
 * row cannot prevent a template from being edited.
 */
export function mergeCustomTemplateConfig(
  templateRaw: unknown,
  jobRaw: unknown,
): RecordValue | null {
  const template = parseTemplateConfig(templateRaw) ?? {};
  const job = parseTemplateConfig(jobRaw) ?? {};
  const { options } = readTemplateOptions(template);
  if (!options.length) {
    return { ...template, ...(Object.prototype.hasOwnProperty.call(job, TEMPLATE_OPTION_VALUES_KEY)
      ? { [TEMPLATE_OPTION_VALUES_KEY]: job[TEMPLATE_OPTION_VALUES_KEY] }
      : {}) };
  }
  const resolved = resolveTemplateOptionValues(
    options,
    job[TEMPLATE_OPTION_VALUES_KEY] ?? template[TEMPLATE_OPTION_VALUES_KEY],
  );
  const values = resolved.error
    ? resolveTemplateOptionValues(options, undefined).values
    : resolved.values;
  return {
    ...template,
    [TEMPLATE_OPTIONS_KEY]: options,
    [TEMPLATE_OPTION_VALUES_KEY]: values,
  };
}

/**
 * Repair jobs affected by the old template editor, which persisted only
 * `jobOptionValues` and dropped the template's `jobOptions` definitions.
 *
 * The callback is deliberately supplied by the caller so this helper stays
 * independent of the database module and can be used in a transaction. A job
 * that already has a `jobOptions` property is left untouched, even when its
 * definitions are malformed or differ from the current template: operators
 * may have intentionally customised that copy.
 */
export function restoreMissingTemplateOptions(
  rows: ReadonlyArray<{
    id: number;
    jobConfig: unknown;
    templateConfig: unknown;
  }>,
  update: (jobId: number, config: RecordValue) => void,
): number {
  let restored = 0;
  for (const row of rows) {
    const template = parseTemplateConfig(row.templateConfig);
    const templateOptions = readTemplateOptions(template);
    if (!template || templateOptions.error || !templateOptions.options.length) continue;

    const parsedJob = parseTemplateConfig(row.jobConfig);
    // Do not replace an unreadable non-null blob; a later backup restore or
    // manual repair should be able to recover the original bytes.
    if (row.jobConfig != null && !parsedJob) continue;
    const job = parsedJob ?? {};
    if (Object.prototype.hasOwnProperty.call(job, TEMPLATE_OPTIONS_KEY)) continue;

    const merged = mergeCustomTemplateConfig(template, job);
    if (!merged) continue;
    update(row.id, merged);
    restored++;
  }
  return restored;
}

/** Values to seed into the custom-job runtime variable context. */
export function templateOptionVariables(config: unknown): Record<string, JsonValue> {
  const parsed = parseTemplateConfig(config);
  if (!parsed) return {};
  const { options } = readTemplateOptions(parsed);
  const resolved = resolveTemplateOptionValues(options, parsed[TEMPLATE_OPTION_VALUES_KEY]);
  const values = resolved.error
    ? resolveTemplateOptionValues(options, undefined).values
    : resolved.values;
  return { ...values };
}

