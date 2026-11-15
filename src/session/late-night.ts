/**
 * LATE NIGHT — Zach, 2026-11-15: *"I need like an emergency mode that like for any
 * day that I don't have time before midnight, I can turn on that mode and then it
 * won't reset at midnight, so it would be like I can still review it as if it's
 * still during the day. And once I finish reviewing, it just resets just like
 * normal, and then it turned off that mode automatically."*
 *
 * The setting holds the DATE he wants to keep (`2026-11-15`), or `""` for off.
 * Once midnight has passed, a session built while it is set is planned for that
 * date — its due cards, its new cards, its count of what he answered — instead of
 * the new one (`buildSession`). The page clears it when that plan is finished, and
 * the next sitting is an ordinary new day (`app/main.ts`, `endLateNight`).
 *
 * WHAT IT DOES NOT DO: rewrite a grade's time. A card graded at 00:40 is written at
 * 00:40, so its next due date counts from the day it was really seen — decision 6:
 * the review's date is a measurement, not a label. Only the PLAN keeps yesterday.
 *
 * It reaches ONE day back and no further: a setting left on for a week does not
 * pin the app to last week. A page left open over midnight already keeps its day
 * without this (`app/new-day.ts`); the mode is for opening the app, or reloading
 * it, after midnight.
 *
 * Import-free (no db), so `app/` and `test/` can both reach it.
 */

export const LATE_NIGHT_KEY = "session.late-night";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-11-14` for `2026-11-15`. Calendar arithmetic on the date alone. */
export function previousDate(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The date to plan for instead of `today`, or null when the mode changes nothing:
 * off, set for today (midnight has not come yet), or set for longer ago than
 * yesterday.
 */
export function keptDay(stored: string | null | undefined, today: string): string | null {
  if (stored === null || stored === undefined || !DATE.test(stored)) return null;
  return stored === previousDate(today) ? stored : null;
}

/**
 * The last millisecond of `day`, in the same offset as `now` — what a plan "as of
 * that day" is built from. Only its local date selects the queue (`buildSession`).
 */
export function endOfDay(day: string, now: string): string {
  const offset = /([+-]\d{2}:\d{2}|Z)$/.exec(now)?.[1] ?? "Z";
  return `${day}T23:59:59.999${offset}`;
}
