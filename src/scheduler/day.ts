export const MS_PER_DAY = 86_400_000;

export interface Instant {
  readonly ms: number;
  readonly offsetMinutes: number;
}

export class InstantFormatError extends Error {
  constructor(value: string, why: string) {
    super(`not a usable instant: ${JSON.stringify(value)} — ${why}`);
    this.name = "InstantFormatError";
  }
}

const OFFSET = /(?:(Z)|([+-])(\d{2}):?(\d{2}))$/;

export function parseInstant(value: string): Instant {
  const match = OFFSET.exec(value);
  if (match === null) {
    throw new InstantFormatError(value, "no UTC offset, and one is not assumable");
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new InstantFormatError(value, "not RFC 3339");
  if (match[1] === "Z") return { ms, offsetMinutes: 0 };
  const sign = match[2] === "-" ? -1 : 1;
  const hours = Number(match[3]);
  const minutes = Number(match[4]);
  return { ms, offsetMinutes: sign * (hours * 60 + minutes) };
}

function pad(n: number, width = 2): string {
  return String(Math.abs(n)).padStart(width, "0");
}

export function formatInstant(ms: number, offsetMinutes: number): string {
  const local = new Date(ms + offsetMinutes * 60_000);
  const millis = local.getUTCMilliseconds();
  const sign = offsetMinutes < 0 ? "-" : "+";
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    (millis === 0 ? "" : `.${pad(millis, 3)}`) +
    `${sign}${pad(Math.trunc(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`
  );
}

export function localDate(value: string | Instant): string {
  const instant = typeof value === "string" ? parseInstant(value) : value;
  return new Date(instant.ms + instant.offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function localDayNumber(value: string | Instant): number {
  const instant = typeof value === "string" ? parseInstant(value) : value;
  return Math.floor((instant.ms + instant.offsetMinutes * 60_000) / MS_PER_DAY);
}

export function startOfLocalDayMs(value: string | Instant): number {
  const instant = typeof value === "string" ? parseInstant(value) : value;
  return localDayNumber(instant) * MS_PER_DAY - instant.offsetMinutes * 60_000;
}

export function wholeDaysBetween(from: string | Instant, to: string | Instant): number {
  return localDayNumber(to) - localDayNumber(from);
}

export function exactDaysBetween(from: string | Instant, to: string | Instant): number {
  const a = typeof from === "string" ? parseInstant(from) : from;
  const b = typeof to === "string" ? parseInstant(to) : to;
  return (b.ms - a.ms) / MS_PER_DAY;
}

export function dueInstant(reviewedAt: string | Instant, intervalDays: number): string {
  if (!Number.isInteger(intervalDays)) {
    throw new RangeError(`dueInstant needs whole days, got ${intervalDays}`);
  }
  const instant = typeof reviewedAt === "string" ? parseInstant(reviewedAt) : reviewedAt;
  return formatInstant(
    startOfLocalDayMs(instant) + intervalDays * MS_PER_DAY,
    instant.offsetMinutes,
  );
}
