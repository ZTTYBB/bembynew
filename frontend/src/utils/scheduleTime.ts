export type ScheduleTimeError = "invalidTimezone" | "invalidTime" | "nonexistentTime";

function formatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    throw new Error("invalidTimezone" satisfies ScheduleTimeError);
  }
}

function parts(date: Date, format: Intl.DateTimeFormat): number[] {
  const values = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  return ["year", "month", "day", "hour", "minute", "second"].map((key) => Number(values[key]));
}

function stamp(values: number[]): number {
  const [year, month, day, hour, minute, second] = values;
  return new Date(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`).getTime();
}

export function zonedInput(iso: string, timezone: string): string {
  const value = new Date(iso);
  if (!Number.isFinite(value.getTime())) throw new Error("invalidTime" satisfies ScheduleTimeError);
  const [year, month, day, hour, minute, second] = parts(value, formatter(timezone));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

/**
 * Intl supplies the timezone rules. Candidate offsets on either side of the
 * local date are checked by round-trip, preserving both repeated DST instants.
 */
export function resolveZonedInput(value: string, timezone: string): string[] {
  const format = formatter(timezone);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error("invalidTime" satisfies ScheduleTimeError);
  const wanted = match.slice(1).map((part) => Number(part ?? 0));
  const wallStamp = stamp(wanted);
  if (!Number.isFinite(wallStamp) || zonedInput(new Date(wallStamp).toISOString(), "UTC") !==
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}`) {
    throw new Error("invalidTime" satisfies ScheduleTimeError);
  }
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = wallStamp + hours * 3_600_000;
    offsets.add(stamp(parts(new Date(sample), format)) - sample);
  }
  const candidates = [...offsets].map((offset) => wallStamp - offset)
    .filter((instant) => parts(new Date(instant), format).every((part, index) => part === wanted[index]));
  if (!candidates.length) throw new Error("nonexistentTime" satisfies ScheduleTimeError);
  return [...new Set(candidates)].sort((a, b) => a - b).map((instant) => new Date(instant).toISOString());
}

export function utcOffsetLabel(iso: string, timezone: string): string {
  const value = new Date(iso);
  const minutes = Math.round((stamp(parts(value, formatter(timezone))) - value.getTime()) / 60_000);
  const magnitude = Math.abs(minutes);
  return `UTC${minutes >= 0 ? "+" : "-"}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;
}
