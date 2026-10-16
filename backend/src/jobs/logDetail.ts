/**
 * Keeps browser/media screenshots in a run detail small enough for SQLite.
 *
 * The current log API still returns data URIs, so this is deliberately a
 * storage-side compactor rather than the future run-shots file store. It
 * treats every data:image URI as a screenshot candidate, including nested
 * web-step arrays and Telegram response images.
 */

export const DEFAULT_LOG_SCREENSHOT_MAX_BYTES = 1_500_000;

export type LogScreenshotBudget = {
  /** Maximum decoded image bytes kept in one run. */
  maxBytes?: number;
  /** Maximum number of distinct image data URIs kept in one run. */
  maxCount?: number;
};

type Parent = Record<string, unknown> | unknown[];

type Candidate = {
  value: string;
  bytes: number;
  parent: Parent;
  key: string | number;
  order: number;
  failed: boolean;
  duplicate: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDataImage(value: string): boolean {
  return /^data:image\//i.test(value);
}

function imageBytes(value: string): number {
  const comma = value.indexOf(",");
  if (comma < 0) return Buffer.byteLength(value, "utf8");
  const header = value.slice(0, comma);
  const payload = value.slice(comma + 1);
  if (!/;base64(?:;|$)/i.test(header)) return Buffer.byteLength(payload, "utf8");
  const compact = payload.replace(/\s/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(compact.length * 3 / 4) - padding);
}

function hasFailure(value: Record<string, unknown>): boolean {
  const error = value.error;
  if (typeof error === "string" && error.trim()) return true;
  if (value.failed === true || value.success === false || value.ok === false) return true;
  const status = value.status;
  return typeof status === "string" && /^(?:failed|failure|error|timeout|cancelled)$/i.test(status);
}

function normaliseLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

/**
 * Copies a run detail and drops image data URIs until the configured budget is
 * met. Failed steps are considered first, then the newest screenshots, so a
 * useful failure image survives a long successful loop. Repeated identical
 * images are stored only once. The input object is never mutated.
 */
export function compactLogDetail<T>(
  detail: T,
  budget: LogScreenshotBudget = {},
): T {
  const maxBytes = normaliseLimit(budget.maxBytes ?? DEFAULT_LOG_SCREENSHOT_MAX_BYTES);
  const maxCount = normaliseLimit(budget.maxCount);
  const candidates: Candidate[] = [];
  let order = 0;

  const clone = (
    value: unknown,
    parent: Parent | undefined,
    key: string | number | undefined,
    inheritedFailure: boolean,
  ): unknown => {
    if (typeof value === "string") {
      if (parent !== undefined && key !== undefined && isDataImage(value)) {
        candidates.push({
          value,
          bytes: imageBytes(value),
          parent,
          key,
          order: order++,
          failed: inheritedFailure,
          duplicate: false,
        });
      }
      return value;
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        copy.push(clone(value[i], copy, i, inheritedFailure));
      }
      return copy;
    }
    if (isRecord(value)) {
      const copy: Record<string, unknown> = {};
      const ownFailure = inheritedFailure || hasFailure(value);
      for (const [childKey, child] of Object.entries(value)) {
        copy[childKey] = clone(child, copy, childKey, ownFailure);
      }
      return copy;
    }
    return value;
  };

  const copied = clone(detail, undefined, undefined, false) as T;
  if (!candidates.length) return copied;

  // Choose one representative for an identical image. Prefer a failed step
  // when the same image appears in both a successful and failed step.
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.value);
    if (group) group.push(candidate);
    else groups.set(candidate.value, [candidate]);
  }
  const unique: Candidate[] = [];
  for (const group of groups.values()) {
    // Keep the newest occurrence: intermediate steps often repeat the same
    // page image, while the final occurrence is the useful one in the log.
    // A failed step still wins because its screenshot is the strongest
    // diagnostic evidence; among equally classified entries, prefer newest.
    const failed = group.filter((candidate) => candidate.failed);
    const candidatesToChoose = failed.length > 0 ? failed : group;
    const canonical = candidatesToChoose.reduce((latest, candidate) =>
      candidate.order > latest.order ? candidate : latest,
    );
    unique.push(canonical);
    for (const candidate of group) {
      if (candidate !== canonical) candidate.duplicate = true;
    }
  }
  unique.sort((a, b) => a.order - b.order);

  const selected = new Set<Candidate>();
  let usedBytes = 0;
  const add = (candidate: Candidate): void => {
    if (selected.has(candidate) || maxCount === 0 || maxBytes === 0) return;
    if (maxCount !== undefined && selected.size >= maxCount) return;
    if (maxBytes !== undefined && usedBytes + candidate.bytes > maxBytes) return;
    selected.add(candidate);
    usedBytes += candidate.bytes;
  };

  // Error evidence is more useful than intermediate success screenshots.
  for (const candidate of unique) {
    if (candidate.failed) add(candidate);
  }
  // Keep the tail of a long run, which is usually the final page state.
  for (let i = unique.length - 1; i >= 0; i--) add(unique[i]);

  // Remove from arrays backwards so deleting one array element does not move
  // the index of another candidate that is still waiting to be removed.
  const dropped = candidates
    .filter((candidate) => candidate.duplicate || !selected.has(candidate))
    .sort((a, b) => b.order - a.order);
  for (const candidate of dropped) {
    if (Array.isArray(candidate.parent)) {
      const index = Number(candidate.key);
      if (Number.isInteger(index) && candidate.parent[index] === candidate.value) {
        candidate.parent.splice(index, 1);
      }
    } else if (candidate.parent[candidate.key as string] === candidate.value) {
      delete candidate.parent[candidate.key as string];
    }
  }

  return copied;
}

