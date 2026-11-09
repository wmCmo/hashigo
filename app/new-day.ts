/**
 * A NEW DAY REACHES A PAGE THAT STAYED OPEN. Zach, 2026-11-09, a screenshot of
 * the laptop window three days after he last cleared a plan on it:
 * *"it's a new day, but i still see this"* — "congrats, one rung up, 66 answered".
 *
 * The plan is built ONCE, when the database opens (`db.worker.ts`), for the
 * local date of that moment (`Session.today`). Nothing rebuilt it after that,
 * so a window left open over the weekend kept the last day's done screen —
 * and its counts — for as long as it stayed open.
 *
 * ─── WHAT THIS DOES, AND WHY A RELOAD ───────────────────────────────────────
 *
 * When the page comes back into view (or the window takes focus — a desktop
 * window behind others is not always reported hidden), a FINISHED plan from an
 * earlier date reloads the page. The reload is the boot: it pulls from the
 * other devices before the first card (decision 50) and builds today's plan,
 * which is exactly the sitting he is starting. Rebuilding in place was tried on
 * paper and refused by the worker: `replan` will not touch a session that has
 * been graded, and on the done screen it always has.
 *
 * ONLY ON THE DONE SCREEN. A session carried past midnight keeps the day it was
 * planned for, on purpose (`Session.answeredToday`); reloading under a card
 * would throw away the walk. And not while something is half-typed — a layer
 * (the editor) or a text field with something in it — the same restraint as
 * `update-check.ts`. No timer, no polling: SPEC problem #1.
 *
 * Import-free, so `test/` can reach the decision.
 */

/** `2026-11-09` — the local calendar date, the same day `Session.today` uses. */
export function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface NewDayState {
  /** The local date the plan on screen was built for. */
  readonly plannedOn: string;
  /** The local date now. */
  readonly today: string;
  /** The done screen is showing — the plan is finished. */
  readonly onDone: boolean;
  /** A layer (editor, preview) is open. */
  readonly layered: boolean;
  /** A text field has focus or holds text. */
  readonly typing: boolean;
}

/** True when the page should reload to start today's plan. */
export function shouldStartNewDay(state: NewDayState): boolean {
  return state.today !== state.plannedOn && state.onDone && !state.layered && !state.typing;
}
