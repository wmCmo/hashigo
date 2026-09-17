/**
 * HOW LATE THIS TRACK IS, IN WORDS.
 *
 * Zach, 2026-09-17: *"it would actually be perfect if there's a label showing
 * when this card was due in the past — like i didn't have time to review so now
 * im like catching up, but it would be helpful to see that this track was due 5
 * days ago or something"*.
 *
 * ─── THE NUMBER IS THE SCHEDULER'S, NOT A SUBTRACTION DONE HERE ─────────────
 *
 * `QueuedTrack.overdueDays` already exists and is documented "whole days late, 0
 * when due today". It counts in LOCAL DATES (`QueueOptions.now` says *"only its
 * local date is used"*), which is the right basis for this sentence and is not
 * what `Date.now() - due` gives you: a card due at 23:00 yesterday is one day
 * late, not fourteen hours late. Decision 6 — name the basis or the number is
 * not a fact. So the worker passes the scheduler's own figure through and this
 * only chooses words for it.
 *
 * ─── THE BUCKETS ARE MEASURED, AND THE QUEUE IS BIMODAL ─────────────────────
 *
 * His real queue as of 2026-09-17, 1,166 due tracks:
 *
 *     0 days (today)   134      ← NO LABEL. It is not in the past.
 *     1 day            135
 *     2-30 days        827      ← the catch-up he is describing, 80% of the late ones
 *     31-364 days        0
 *     365+ days         70      ← 数字, untouched since 2024-08; the oldest is 757
 *
 * Nothing at all between 31 and 364. So days carries the case he asked about and
 * years carries the tail, and the months arm exists for a future that has not
 * happened yet rather than for anything on screen today.
 *
 * `757 days` is a true number nobody reads as a duration — that arm says "2
 * years ago", and the `title` carries the date itself for anyone who wants it.
 *
 * NO IMPORTS — the same rule as `./review-boundary.ts` and `./sync-climb.ts`:
 * the root `tsconfig.json` excludes `app/`, so an import-free module is reachable
 * from `test/` and one that touches the DOM is not.
 */

/** Average lengths, so 61 days is 2 months rather than 2.03 of something. */
const DAYS_PER_MONTH = 30.44;
const DAYS_PER_YEAR = 365.25;

/**
 * `null` when there is nothing to say — which is every new track and every track
 * due TODAY.
 *
 * Due today is deliberately unlabelled. It is not late, it is the plan working,
 * and a chip on all 134 of them would make the ones that ARE late stop standing
 * out — which is the entire point of asking for this.
 */
export function overdueLabel(days: number): string | null {
  if (!Number.isFinite(days) || days < 1) return null;
  const whole = Math.floor(days);
  if (whole === 1) return "due yesterday";
  if (whole <= 30) return `due ${whole} days ago`;
  if (whole < 365) {
    // Clamped at 11: `Math.round(364 / 30.44)` is 12, and "due 12 months ago"
    // beside a "due 1 year ago" that means fewer days is a worse pair than a
    // slightly conservative 11.
    const months = Math.min(11, Math.max(1, Math.round(whole / DAYS_PER_MONTH)));
    return `due ${months} month${months === 1 ? "" : "s"} ago`;
  }
  const years = Math.max(1, Math.round(whole / DAYS_PER_YEAR));
  return `due ${years} year${years === 1 ? "" : "s"} ago`;
}

/**
 * The date itself, for the `title` — "due 3 weeks ago" is the glance and this is
 * the answer to "yes but WHEN".
 *
 * Sliced, never parsed. `due_at` is RFC 3339 WITH his offset already on it, so
 * the first ten characters are the local date the scheduler meant. Feeding it to
 * `new Date()` and formatting would re-interpret it in the viewer's zone and can
 * land a day off — which on a label whose whole job is a day count would be a
 * defect that only appears when travelling.
 */
export function dueDateOf(dueAt: string | null): string | null {
  if (dueAt === null) return null;
  const date = dueAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/** The whole `title`: the date when there is one, and the plain count otherwise. */
export function overdueTitle(days: number, dueAt: string | null): string {
  const date = dueDateOf(dueAt);
  const whole = Math.max(0, Math.floor(days));
  return date === null ? `${whole} days late` : `due ${date} — ${whole} days late`;
}
