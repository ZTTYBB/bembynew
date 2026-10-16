import type { EmbywatchConfig } from "../types";

/**
 * Linked Emby jobs keep credentials and any deliberate per-job playback
 * overrides in their own config. The template remains the source of defaults.
 *
 * The marker is intentionally namespaced: configs are user-editable JSON and
 * unknown fields have historically been tolerated, so a short generic key
 * could collide with an Emby setting.
 */
export const EMBY_TEMPLATE_META_KEY = "__bembyTemplate";
export const EMBY_TEMPLATE_OVERRIDE_KEYS = [
  "playDuration",
  "playDurationMax",
] as const;
export const DEFAULT_PLAY_DURATION_SECONDS = 300;

export type EmbyTemplateMeta = {
  overrides?: Partial<Pick<EmbywatchConfig, (typeof EMBY_TEMPLATE_OVERRIDE_KEYS)[number]>>;
};

export type EmbyTemplateJobConfig = Partial<EmbywatchConfig> & {
  [EMBY_TEMPLATE_META_KEY]?: EmbyTemplateMeta;
};

export function parseEmbyConfig(raw: string | null | undefined): EmbyTemplateJobConfig {
  if (!raw) return {};
  try {
    let parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as EmbyTemplateJobConfig
      : {};
  } catch {
    return {};
  }
}

export function hasEmbyDuration(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function isValidEmbyDuration(value: unknown): boolean {
  return (
    (typeof value === "number" || typeof value === "string") &&
    (typeof value !== "string" || /^\d+$/.test(value.trim())) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= 30
  );
}

/** Old malformed settings must not turn an inherited duration into zero or NaN. */
export function resolveEmbyDefaultPlayDuration(value: unknown): number {
  return isValidEmbyDuration(value) ? Number(value) : DEFAULT_PLAY_DURATION_SECONDS;
}

/** Resolves optional default max play duration. Returns undefined if not set. */
export function resolveEmbyDefaultPlayDurationMax(value: unknown): number | undefined {
  return isValidEmbyDuration(value) ? Number(value) : undefined;
}

/** Reject invalid new values while leaving absent fields on their defaults. */
export function validateEmbyDurations(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const validatePair = (values: Record<string, unknown>): string | null => {
    for (const key of EMBY_TEMPLATE_OVERRIDE_KEYS) {
      const value = values[key];
      if (!hasEmbyDuration(value)) continue;
      if (!isValidEmbyDuration(value)) {
        return `${key} must be a whole number of at least 30 seconds`;
      }
    }
    if (
      hasEmbyDuration(values.playDuration) &&
      hasEmbyDuration(values.playDurationMax) &&
      Number(values.playDurationMax) < Number(values.playDuration)
    ) {
      return "playDurationMax must not be less than playDuration";
    }
    return null;
  };
  const values = config as Record<string, unknown>;
  const error = validatePair(values);
  if (error) return error;
  const marker = values[EMBY_TEMPLATE_META_KEY];
  if (marker && typeof marker === "object" && !Array.isArray(marker)) {
    const overrides = (marker as EmbyTemplateMeta).overrides;
    if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
      return validatePair(overrides as Record<string, unknown>);
    }
  }
  return null;
}

/**
 * Validate the actual playback range, after merging any linked template.
 * An upper-only override inherits its lower bound from the template or setting.
 */
export function validateEffectiveEmbyDurations(
  effectiveConfig: unknown,
  defaultPlayDuration?: unknown,
): string | null {
  const error = validateEmbyDurations(effectiveConfig);
  if (error) return error;
  if (!effectiveConfig || typeof effectiveConfig !== "object" || Array.isArray(effectiveConfig)) {
    return null;
  }
  const values = effectiveConfig as Record<string, unknown>;
  if (!hasEmbyDuration(values.playDurationMax)) return null;
  const minimum = hasEmbyDuration(values.playDuration)
    ? Number(values.playDuration)
    : resolveEmbyDefaultPlayDuration(defaultPlayDuration);
  return Number(values.playDurationMax) < minimum
    ? "playDurationMax must not be less than the effective playDuration"
    : null;
}

function isOwnValue(value: unknown): value is string | number {
  return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Extract explicit task overrides from a config. New records use the marker;
 * legacy merged records are treated as template defaults until the first
 * template update, which prevents an old merged copy from becoming a
 * permanent override by accident.
 */
export function embyTemplateOverrides(
  config: EmbyTemplateJobConfig,
): Partial<Pick<EmbywatchConfig, (typeof EMBY_TEMPLATE_OVERRIDE_KEYS)[number]>> {
  const marked = config[EMBY_TEMPLATE_META_KEY]?.overrides;
  if (!marked || typeof marked !== "object") return {};
  const overrides: Partial<Pick<EmbywatchConfig, (typeof EMBY_TEMPLATE_OVERRIDE_KEYS)[number]>> = {};
  for (const key of EMBY_TEMPLATE_OVERRIDE_KEYS) {
    if (isOwnValue(marked[key])) overrides[key] = marked[key] as never;
  }
  return overrides;
}

export function withEmbyTemplateMeta(
  config: Record<string, unknown>,
  overrides: Partial<Pick<EmbywatchConfig, (typeof EMBY_TEMPLATE_OVERRIDE_KEYS)[number]>>,
): EmbyTemplateJobConfig {
  const cleanOverrides: Record<string, number | string> = {};
  for (const key of EMBY_TEMPLATE_OVERRIDE_KEYS) {
    if (isOwnValue(overrides[key])) cleanOverrides[key] = overrides[key] as number | string;
  }
  return {
    ...config,
    [EMBY_TEMPLATE_META_KEY]: { overrides: cleanOverrides },
  } as EmbyTemplateJobConfig;
}

/**
 * Build the runtime config from a template and a linked job. Legacy linked
 * configs without the marker retain their old merged behaviour; new records
 * overlay only explicitly selected duration fields.
 */
export function mergeEmbyTemplateConfig(
  templateRaw: string | null | undefined,
  jobConfig: EmbyTemplateJobConfig,
): EmbywatchConfig {
  const template = parseEmbyConfig(templateRaw);
  const marked = jobConfig[EMBY_TEMPLATE_META_KEY]?.overrides;
  const overlay = marked && typeof marked === "object"
    ? Object.fromEntries(
        EMBY_TEMPLATE_OVERRIDE_KEYS
          .filter(key => hasEmbyDuration(marked[key]))
          .map(key => [key, marked[key]]),
      )
    : Object.fromEntries(
        Object.entries(jobConfig).filter(([key]) =>
          key !== "username" && key !== "password" && key !== EMBY_TEMPLATE_META_KEY),
      );
  const merged = { ...template, ...overlay };
  // A job's single duration means a fixed duration, even when its template has
  // a range. Only an upper bound explicitly set on the job extends that range.
  if (
    marked &&
    Object.prototype.hasOwnProperty.call(overlay, "playDuration") &&
    !Object.prototype.hasOwnProperty.call(overlay, "playDurationMax")
  ) {
    delete merged.playDurationMax;
  }
  if (typeof jobConfig.username === "string") merged.username = jobConfig.username;
  if (typeof jobConfig.password === "string") merged.password = jobConfig.password;
  return merged as EmbywatchConfig;
}

