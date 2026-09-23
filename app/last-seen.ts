/**
 * WHEN HE LAST SAW THIS TRACK, as a plain date.
 *
 * Zach, 2026-09-23: *"it would be great if we can see when we reviewed this track
 * last time, so we can see like oh wow it's been 8 months since i last reviewed
 * this track, but i think just a plain date would be better, like `Jul 2, 2025`
 * or something"*.
 *
 * ─── HIS INSTINCT FOR A DATE IS ALSO THE ONLY HONEST OPTION ─────────────────
 *
 * He asked for a date over an elapsed count as a preference. It happens to be
 * forced: **all 103,110 imported reviews carry `time_unknown = 1`, and the whole
 * corpus holds exactly ONE distinct time-of-day** (measured 2026-09-23). Mochi
 * truncated to the date and the importer writes local midnight, so `2025-07-02`
 * is a real fact and `2025-07-02 00:00` is a fabricated one. This formats the
 * date and drops the rest of the string on the floor.
 *
 * ─── AND IT IS NOT `overdueDays` ────────────────────────────────────────────
 *
 * Decision 46 already puts "due 17 days ago" on this line, and the two are
 * different quantities that are both worth having: a track on a one-year interval
 * that fell due three days ago reads `due 3 days ago` and was last seen a year
 * back. His "oh wow it's been 8 months" is the second number, which nothing on
 * the screen could say.
 *
 * **His queue is mostly that case**, which is why the chip earns its place —
 * measured over the live tracks: 513 under a month, 2,371 at one to three months,
 * **5,414 at three to twelve**, 712 over a year.
 *
 * ─── PARSED BY SUBSTRING, NOT BY `Date` ─────────────────────────────────────
 *
 * `last_reviewed_at` is RFC 3339 carrying its own offset (`2025-07-02T00:00:00+09:00`)
 * and the first ten characters ARE its local date — the same property
 * `src/scheduler/predicates.ts` relies on and documents at length. `new Date(s)`
 * would convert to the VIEWER's zone, so the same review would read `Jul 1` on a
 * laptop set to UTC. Decision 6: name the basis. The basis is the local date the
 * review was taken in.
 *
 * NO IMPORTS — the same rule as `./overdue.ts` and `./progress.ts`: the root
 * `tsconfig.json` excludes `app/`, so an import-free module is reachable from
 * `test/` and one that touches the DOM is not.
 */

/** `Jan`…`Dec`. Spelled out rather than `toLocaleString`, so the output cannot
 *  move with the device's locale — `7/2/2025` and `2/7/2025` are the same string
 *  to two different readers, and he reads this on two machines. */
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * `2025-07-02T00:00:00+09:00` -> `Jul 2, 2025`. His own example format.
 *
 * Returns `null` for a new track (no last review), and for anything that is not
 * a date this can read — a malformed value renders NOTHING rather than
 * `NaN undefined` or, worse, a plausible wrong date.
 */
export function lastSeenLabel(lastReviewedAt: string | null | undefined): string | null {
  if (typeof lastReviewedAt !== "string") return null;
  // The local date is the first ten characters. See the header.
  const date = lastReviewedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/**
 * The hover/accessible sentence. Says what the date MEANS, because a bare
 * `Jul 2, 2025` beside `due 17 days ago` could be read as another due date.
 *
 * It deliberately does NOT compute "8 months ago". That number changes every day
 * while the session is open, and decision 46 already settled that this line is
 * fixed at PLAN time — two figures on one chip ageing at different rates is the
 * kind of thing that gets noticed as a bug.
 */
export function lastSeenTitle(lastReviewedAt: string | null | undefined): string | null {
  const label = lastSeenLabel(lastReviewedAt);
  return label === null ? null : `last reviewed ${label}`;
}
