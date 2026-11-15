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
 * GRADES COUNT FOR THE KEPT DAY. A card graded at 00:40 with the mode on is written
 * at 23:59:59.999 of the kept day (`ReviewSession.lateNightStamp`), so its history
 * and its next interval read as that day — his "as if it's still during the day".
 * (v0.10.10 wrote the real time; he asked for the 15th the same night.)
 *
 * It reaches ONE day back and no further: a setting left on for a week does not
 * pin the app to last week. A page left open over midnight already keeps its day
 * without this (`app/new-day.ts`); the mode is for opening the app, or reloading
 * it, after midnight.
 *
 * THE DAY AFTER STARTS WHEN THE MODE ENDS. Grades made after midnight are dated
 * the new day, so without a marker the new day would count them as its own: the
 * kept day's new cards learned at 00:30 used up the new day's ten, and its bar
 * started part-full. So when the mode switches itself off past midnight, the page
 * stores the moment (`LATE_NIGHT_ENDED_KEY`), and that day counts only grades made
 * after it (`sinceForToday`). Zach, 2026-11-16, on finding it: *"you know what i
 * wanted but you didn't do it?"* — "resets just like normal" meant this too.
 *
 * Imports only `../scheduler/day.ts` (itself import-free), so `app/` and `test/`
 * can both reach it.
 */
import { formatInstant } from "../scheduler/day.js";

export const LATE_NIGHT_KEY = "session.late-night";
/** When the mode switched itself off past midnight — the new day counts from here. */
export const LATE_NIGHT_ENDED_KEY = "session.late-night-ended";

/** Now, in the device's offset and in the exact form grades are written in. */
export function stampNow(at: Date = new Date()): string {
  return formatInstant(at.getTime(), -at.getTimezoneOffset());
}

/**
 * The moment today's counts start from, or null for the whole day: set only on the
 * day a late night ended, and only past midnight (an end before midnight is just a
 * finished day).
 */
export function sinceForToday(ended: string | null | undefined, today: string): string | null {
  if (ended === null || ended === undefined || ended.length < 10) return null;
  return ended.slice(0, 10) === today ? ended : null;
}

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
