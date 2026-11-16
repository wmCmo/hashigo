import { formatInstant } from "../scheduler/day.js";

export const LATE_NIGHT_KEY = "session.late-night";
export const LATE_NIGHT_ENDED_KEY = "session.late-night-ended";

export function stampNow(at: Date = new Date()): string {
  return formatInstant(at.getTime(), -at.getTimezoneOffset());
}

export function sinceForToday(ended: string | null | undefined, today: string): string | null {
  if (ended === null || ended === undefined || ended.length < 10) return null;
  return ended.slice(0, 10) === today ? ended : null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function previousDate(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function keptDay(stored: string | null | undefined, today: string): string | null {
  if (stored === null || stored === undefined || !DATE.test(stored)) return null;
  return stored === previousDate(today) ? stored : null;
}

export function endOfDay(day: string, now: string): string {
  const offset = /([+-]\d{2}:\d{2}|Z)$/.exec(now)?.[1] ?? "Z";
  return `${day}T23:59:59.999${offset}`;
}
