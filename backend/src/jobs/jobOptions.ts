export type JobOptions = {
  runOnce: boolean;
  firstRunMinDays: number;
  firstRunMaxDays: number;
  rerunOnRestart: boolean;
  /** Hours between same-day retries after a failure; 0 turns it off. */
  retrySameDayHours: number;
};

/** Largest same-day retry interval. Longer would never fit in one day. */
export const MAX_RETRY_SAME_DAY_HOURS = 23;

export function normalizeJobOptions(
  input: Record<string, unknown>,
  fallback: Partial<JobOptions> = {},
): JobOptions {
  const runOnce = input.runOnce !== undefined ? input.runOnce : fallback.runOnce ?? false;
  const rerunOnRestart = input.rerunOnRestart !== undefined ? input.rerunOnRestart : fallback.rerunOnRestart ?? false;
  const min = input.firstRunMinDays !== undefined ? input.firstRunMinDays : fallback.firstRunMinDays ?? 0;
  const max = input.firstRunMaxDays !== undefined ? input.firstRunMaxDays : fallback.firstRunMaxDays ?? 0;
  const retryHours = input.retrySameDayHours !== undefined
    ? input.retrySameDayHours
    : fallback.retrySameDayHours ?? 0;
  if (typeof runOnce !== "boolean") throw new Error("runOnce must be boolean");
  if (typeof rerunOnRestart !== "boolean") throw new Error("rerunOnRestart must be boolean");
  for (const [key, value] of [["firstRunMinDays", min], ["firstRunMaxDays", max]] as const) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 3650) {
      throw new Error(`${key} must be an integer from 0 to 3650`);
    }
  }
  if ((max as number) < (min as number)) {
    throw new Error("firstRunMaxDays must not be less than firstRunMinDays");
  }
  if (
    typeof retryHours !== "number" || !Number.isSafeInteger(retryHours) ||
    retryHours < 0 || retryHours > MAX_RETRY_SAME_DAY_HOURS
  ) {
    throw new Error(`retrySameDayHours must be an integer from 0 to ${MAX_RETRY_SAME_DAY_HOURS}`);
  }
  return {
    runOnce,
    firstRunMinDays: min as number,
    firstRunMaxDays: max as number,
    rerunOnRestart,
    retrySameDayHours: retryHours,
  };
}
