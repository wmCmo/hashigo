/**
 * The review session — the thing that stands between `hashigo/scheduler` (what is
 * due) and the screen (what is in front of you now).
 *
 * `src/scheduler`'s own header is explicit that it "does NOT hold a session,
 * choose a new-cards-per-day number, interleave new with due, or undo a grade".
 * This owns the first three. It does NOT own undo — see the end of this comment.
 *
 * NO DOM, NO RENDERING, NO `node:` IMPORT. The session is a state machine over
 * track ids, so it is testable without a browser and portable into the OPFS
 * worker where the review screen will run.
 *
 * ─── THE THREE DECISIONS THIS IMPLEMENTS ─────────────────────────────────────
 *
 * **Decision 13 — a forgotten card is SHOWN again at the end of the session, and
 * NOT GRADED.** That is the whole of the re-ask behaviour and the second half is
 * the load-bearing part: `answer()` on a re-ask writes no review row and moves no
 * due date. Grading it would take FSRS-6's short-term branch and move the next
 * interval by a flat 3.50x on a pass or 0.173x on a second failure — a multiplier
 * fitted to new-card second looks with **zero** post-lapse observations in this
 * corpus. So the re-ask creates the data that would later justify grading it, and
 * until then it changes nothing.
 *
 * **ONE re-ask per track per session, and the session therefore TERMINATES.** If a
 * failed re-ask re-queued itself, a card he cannot recall today would never let the
 * session end. Decision 13 does not address it because it does not have to;
 * termination does.
 *
 * That property comes from ONE line and it is worth naming, because the obvious
 * implementation is a redundant second mechanism. `answer()` returns EARLY for a
 * re-ask — before the re-queue branch — so a re-ask cannot queue anything, and a
 * track appears in the plan exactly once (`dueTracks` and `newTracks` are disjoint
 * by `due_at IS NULL`). A `Set` of already-re-asked track ids was here too, and
 * fault injection proved it dead: deleting it left all 17 tests green. It is gone
 * rather than kept as belt-and-braces, because code that reads as load-bearing and
 * is not is the trap this repo files under "built but NOT WIRED UP".
 *
 * **Decisions 12 and 15 — ten NEW TRACKS a day, at random, forward and reverse
 * not paired.** Both already live in `newTracks`, including the randomness, so
 * this passes `newLimit` and does not re-implement the order. `DEFAULT_NEW_LIMIT`
 * is 10 because that is Mochi's default and what he wants kept.
 *
 * ─── THE ORDER IS `spread`, AND IT IS SPREAD OVER A WINDOW ───────────────────
 *
 * **Zach chose `spread` on 2026-08-23.** Interleaving was the one item
 * `src/scheduler`'s header flagged as his taste, and he took it: new cards mixed
 * through the session rather than stacked at the front, so he warms up on words he
 * already knows instead of on ten he has never seen — which is the right call for
 * a shadowing drill, where a new card has no accent to recall yet.
 *
 * **The WINDOW is the implementation half, and without it his choice does not
 * work.** Spread across the *whole* plan, the new cards are pushed so far apart
 * that he never reaches most of them: the due queue is **443** and his sustained
 * load is ~69-78 reviews a day (`BACKTEST.md` carries both bases), so he does not
 * finish a session. Measured over a 453-card plan, new cards actually seen:
 *
 *     stopping after card             50    80   100   150
 *     spread over the whole plan       1     2     2     3
 *     spread over a window of 80       6    10    10    10
 *
 * So the slots are laid out over `min(total, max(spreadOver, 2 x new))` positions
 * rather than over the whole plan. `EXPECTED_SESSION_CARDS` is 80 because that is
 * just above both measured bases for his sustained load (77.5 per active day,
 * 69.2 on `BACKTEST.md`'s basis) — a derived number, not a round one, and a
 * setting rather than a constant.
 *
 * The `2 x new` floor is what keeps two new cards from ever landing adjacent: it
 * forces the step to at least 2 whenever `due >= new`. Swept over 90,000
 * `(due, new)` pairs, zero violations, and pinned by a test.
 *
 * The first new card lands at `floor(0.5 x window / new)` — card 4 of 80 with ten
 * new — so a few due cards come first and the warm-up he asked for is real rather
 * than nominal.
 *
 * `new-first` and `due-first` remain available. **`due-first` is a defect, not a
 * preference**: the ten new cards are never reached at all, and decision 12's dial
 * becomes inert.
 *
 * ─── DETERMINISM ─────────────────────────────────────────────────────────────
 *
 * No `Math.random()` anywhere. The plan is fixed when the session is built: due
 * order from `dueTracks` (`due_at`, then `t.id`), new order from `newTracks`
 * (`dailyOrderKey`), and re-asks appended in the order they were failed. Building
 * two sessions from the same database at the same instant gives the same plan,
 * which is what makes a session resumable and a test meaningful.
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * **Undo, skip and bury are absent because no decision covers them.** Undo in
 * particular is not a UI affordance over this module: a graded review is a row in
 * an append-only table with a BEFORE UPDATE trigger, so undo is a schema question
 * before it is a session one. Do not add any of the three by inference.
 */

import {
  dueTracks,
  gradeTrack,
  newTracks,
  nowInHostOffset,
  snapshotTrack,
  ungradeTrack,
  type GradedReview,
  type QueuedTrack,
  type TrackSnapshot,
} from "../scheduler/index.js";
// TYPE-ONLY, exactly as `src/cards/load.ts` does it: the import is erased at
// compile time, so nothing here pulls `src/db/browser.ts` (and its sqlite-wasm
// dynamic import) into the runtime graph. That is what keeps this module
// browser-portable, and `test/browser-portable.test.ts` walks it to prove so.
import type { SqliteHandle } from "../db/browser.js";

/** Decision 12: Mochi's default, and what he wants kept. */
export const DEFAULT_NEW_LIMIT = 10;

/**
 * How new tracks are mixed into the due queue.
 *
 * `spread` is the default (Zach's choice, 2026-08-23) and the file header explains
 * both the window it needs and why `due-first` is a defect rather than a preference.
 */
export type InterleavePolicy = "new-first" | "due-first" | "spread";

export const DEFAULT_INTERLEAVE: InterleavePolicy = "spread";

/**
 * How many positions `spread` lays the new cards across, by default.
 *
 * DERIVED, not chosen: just above both measured bases for his sustained load —
 * 77.5 reviews per ACTIVE day, and 69.2 on `BACKTEST.md`'s basis. Name the basis
 * or the number is not a fact (decision 6). It is a default, not a constant: a
 * caller passes `spreadOver` when it knows better.
 */
export const EXPECTED_SESSION_CARDS = 80;

export interface SessionOptions {
  /** RFC 3339 with an offset. Only its LOCAL DATE selects the queue. */
  readonly now?: string;
  /** Decision 12/15. Defaults to `DEFAULT_NEW_LIMIT`; 0 means due cards only. */
  readonly newLimit?: number;
  /** Cap the due half. Absent means every due track, which is the real session. */
  readonly dueLimit?: number;
  readonly interleave?: InterleavePolicy;
  /**
   * `spread` only: how many positions to distribute the new cards across.
   * Defaults to `EXPECTED_SESSION_CARDS`. Floored at `2 x new` so two new cards
   * never land adjacent, and capped at the plan length.
   */
  readonly spreadOver?: number;
  readonly deckId?: string;
  readonly includeSubdecks?: boolean;
  readonly kinds?: readonly string[];
}

export interface SessionItem {
  readonly trackId: number;
  readonly cardId: string;
  readonly kind: string;
  /** Which half of the queue it came from. A re-ask keeps its original origin. */
  readonly origin: "due" | "new";
  /**
   * TRUE means decision 13's re-ask: show it, and **do not grade it**. `answer()`
   * enforces that; a caller cannot grade a re-ask by passing a flag.
   */
  readonly reask: boolean;
  /** The scheduler's row, carried through so the screen needs no second query. */
  readonly track: QueuedTrack;
}

export interface AnswerResult {
  readonly item: SessionItem;
  /** FALSE for a re-ask — no review row was written and no due date moved. */
  readonly graded: boolean;
  /** Null exactly when `graded` is false. */
  readonly review: GradedReview | null;
  /** True when this answer queued the card for a decision-13 re-ask. */
  readonly queuedReask: boolean;
  /**
   * Everything `unanswer` needs to put this back — the track's schedule as it was
   * BEFORE the grade, plus the review row's id.
   *
   * Null on a decision-13 re-ask, which writes nothing and so has nothing to undo
   * beyond the cursor. `scheduler_state` is serialised FSRS memory and cannot be
   * recomputed, which is why this is a snapshot rather than a derivation.
   */
  readonly undo: { readonly reviewId: number; readonly snapshot: TrackSnapshot } | null;
}

export interface SessionProgress {
  /** Fresh items in the plan, fixed when the session was built. */
  readonly planned: number;
  /** Fresh items answered so far. */
  readonly answered: number;
  readonly dueCount: number;
  readonly newCount: number;
  /** Re-asks queued so far this session (decision 13). */
  readonly reasksQueued: number;
  /** Re-asks still to show. */
  readonly reasksRemaining: number;
  /** Fresh items plus pending re-asks. */
  readonly remaining: number;
  readonly done: boolean;
}

export class SessionCompleteError extends Error {
  constructor() {
    super("the session has no current item; check `done` before answering");
    this.name = "SessionCompleteError";
  }
}

/**
 * Mix new into due. Pure and total: every input appears exactly once.
 *
 * `spread` places the new items at evenly spaced positions across a WINDOW of the
 * plan — see the file header for why the window exists and what it is worth. A
 * `spread` over the whole plan is the same policy with the window set to `total`,
 * and it is measurably worse for the only session that matters.
 */
export function interleaveTracks(
  due: readonly SessionItem[],
  fresh: readonly SessionItem[],
  policy: InterleavePolicy,
  spreadOver: number = EXPECTED_SESSION_CARDS,
): SessionItem[] {
  if (fresh.length === 0) return [...due];
  if (due.length === 0) return [...fresh];
  if (policy === "new-first") return [...fresh, ...due];
  if (policy === "due-first") return [...due, ...fresh];

  const total = due.length + fresh.length;
  // Position i of n new items goes at floor((i + 0.5) * total / n): the midpoint
  // of its share, which keeps one at neither end and spaces them evenly.
  // The window: never past the end of the plan, and never tighter than twice the
  // number of new cards — that floor is what forces a step of at least 2, so two
  // new cards cannot land adjacent while `due >= new`.
  const window = Math.min(total, Math.max(spreadOver, 2 * fresh.length));

  // Slot i is the MIDPOINT of new item i's share: floor((i + 0.5) * window / n).
  //
  // NO COLLISION HANDLING, and that is proved rather than hoped. Consecutive
  // slots differ by window/n, which the floor above keeps at >= 1, so the floors
  // strictly increase. A guard walking forward to the next free slot was here;
  // injection proved it unreachable, and a sweep of 90,000 (due, new) pairs over
  // 1..300 — re-run after the window landed — found zero collisions and zero
  // adjacent pairs. Removed rather than kept, like the re-ask Set.
  //
  // A new item CAN land at position 0 or at the window's edge, so do not assert
  // "never at either end" in general; `test/session.test.ts` pins what is true.
  const slots = new Set<number>();
  for (let i = 0; i < fresh.length; i += 1) {
    slots.add(Math.floor(((i + 0.5) * window) / fresh.length));
  }
  const out: SessionItem[] = [];
  let d = 0;
  let f = 0;
  for (let position = 0; position < total; position += 1) {
    if (slots.has(position) && f < fresh.length) out.push(fresh[f++]!);
    else if (d < due.length) out.push(due[d++]!);
    else if (f < fresh.length) out.push(fresh[f++]!);
  }
  return out;
}

function toItem(track: QueuedTrack, origin: "due" | "new"): SessionItem {
  return {
    trackId: track.trackId,
    cardId: track.cardId,
    kind: track.kind,
    origin,
    reask: false,
    track,
  };
}

/**
 * A review session over a fixed plan, with decision 13's re-ask tail.
 *
 * Build it with `buildSession`. The plan does not change after construction —
 * only the re-ask tail grows — so `planned` is a stable denominator for a
 * progress indicator, which a queue that re-read the database would not be.
 */
export class ReviewSession {
  private readonly db: SqliteHandle;
  private readonly plan: readonly SessionItem[];
  private readonly reasks: SessionItem[] = [];
  private cursor = 0;

  constructor(db: SqliteHandle, plan: readonly SessionItem[]) {
    this.db = db;
    this.plan = plan;
  }

  /**
   * The item `offset` places from the one on screen, WITHOUT moving anything.
   *
   * Zach's *"while reviewing card, i would like to use arrows (left and right) to
   * move to next card and move back, without registering any reviewing record,
   * just wanna see what's next"*.
   *
   * **It is a read, and that is the whole point.** Advancing the cursor would
   * either skip a card or demand a grade for it, and both are worse than looking:
   * a skipped card silently leaves the session and a forced grade writes a review
   * he did not mean. So `peek` moves nothing — `cursor` is untouched, no review is
   * written, and the queue he comes back to is the queue he left.
   *
   * Offsets run over the plan and then over the decision-13 re-asks, in the same
   * order `current()` walks them, so `peek(0)` and `current()` are the same item
   * by construction rather than by coincidence.
   */
  peek(offset: number): SessionItem | null {
    const at = this.cursor + offset;
    if (at < 0) return null;
    if (at < this.plan.length) return this.plan[at] ?? null;
    const tail = at - this.plan.length;
    return tail < this.reasks.length ? (this.reasks[tail] ?? null) : null;
  }

  /** The item on screen, or null when the session is finished. */
  current(): SessionItem | null {
    if (this.cursor < this.plan.length) return this.plan[this.cursor] ?? null;
    const tail = this.cursor - this.plan.length;
    return tail < this.reasks.length ? (this.reasks[tail] ?? null) : null;
  }

  get done(): boolean {
    return this.current() === null;
  }

  /**
   * Grade the current item and advance.
   *
   * A re-ask is NOT graded — decision 13 — and that is enforced here rather than
   * left to the caller, because it is the half of the decision that is easy to
   * lose. `graded: false` in the result is how a caller can tell.
   *
   * `gradeTrack` throws `TrackNotFoundError` / `DormantTrackError` if the track
   * has gone away under a long session. Deliberately NOT swallowed: dropping a
   * card silently is worse than surfacing it.
   *
   * **BUT THE CURSOR DOES NOT MOVE, AND THERE IS NO `skip()`**, so a track that
   * goes dormant mid-session HARD-LOCKS it — every `answer()` throws on the same
   * card and the only exit is abandoning the session. An earlier version of this
   * comment said "the caller can skip forward", which is not an API that exists
   * (see the file header: skip is absent because no decision covers it). Whether
   * the fix is a `skip()` or swallowing this one error class is a decision, not an
   * implementation detail — it changes whether a review can be silently lost.
   */
  answer(
    remembered: boolean,
    options: { readonly at?: string; readonly durationMs?: number | null } = {},
  ): AnswerResult {
    const item = this.current();
    if (item === null) throw new SessionCompleteError();

    if (item.reask) {
      this.cursor += 1;
      return { item, graded: false, review: null, queuedReask: false, undo: null };
    }

    // BEFORE the write. `gradeTrack` advances the track in place, so this is the only
    // moment the previous schedule exists to be read.
    const snapshot = snapshotTrack(this.db, item.trackId);
    const review = gradeTrack(this.db, {
      trackId: item.trackId,
      remembered: remembered ? 1 : 0,
      ...(options.at === undefined ? {} : { reviewedAt: options.at }),
      ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    });

    // No "already re-asked?" test is needed, and adding one would be dead code:
    // the re-ask branch above returns before reaching here, and a track is in the
    // plan exactly once. That is the whole termination argument.
    let queuedReask = false;
    if (!remembered) {
      this.reasks.push({ ...item, reask: true });
      queuedReask = true;
    }
    this.cursor += 1;
    return { item, graded: true, review, queuedReask, undo: { reviewId: review.reviewId, snapshot } };
  }

  /**
   * Undo the last `answer()` — his request 13, and the half that was missing.
   *
   * *"when you ctrl+z, it should undo your last action, whether create card, review
   * card, remember card, forget card"*. Card and deck operations had it; grading, the
   * first thing he named, did not. A grade writes a `reviews` row AND advances the
   * FSRS schedule, so it was the one action in the app that could not be taken back.
   *
   * Three things move, and all three must, or the session and the database disagree:
   *
   *   the review row      deleted, by `ungradeTrack`
   *   the track schedule  restored from the snapshot, not recomputed
   *   the cursor          stepped back, and a queued re-ask popped
   *
   * Pass the `undo` handle from the `AnswerResult` this is reversing. Undoing out of
   * order throws rather than corrupting: `ungradeTrack` refuses anything but the
   * latest review on the track, because the schedule was computed from it.
   */
  unanswer(result: AnswerResult): void {
    if (this.cursor === 0) throw new Error("nothing has been answered in this session");

    // The DB first: if it throws, the cursor has not moved and the caller can retry
    // or report. The other order leaves a session that disagrees with its database.
    if (result.undo !== null) ungradeTrack(this.db, result.undo);

    if (result.queuedReask) {
      const popped = this.reasks.pop();
      if (popped === undefined) throw new Error("queuedReask was true but no re-ask is queued");
    }
    this.cursor -= 1;
  }

  progress(): SessionProgress {
    const answeredFresh = Math.min(this.cursor, this.plan.length);
    const reasksShown = Math.max(0, this.cursor - this.plan.length);
    return {
      planned: this.plan.length,
      answered: answeredFresh,
      dueCount: this.plan.filter((i) => i.origin === "due").length,
      newCount: this.plan.filter((i) => i.origin === "new").length,
      reasksQueued: this.reasks.length,
      reasksRemaining: this.reasks.length - reasksShown,
      remaining: this.plan.length - answeredFresh + (this.reasks.length - reasksShown),
      done: this.done,
    };
  }

  /** The plan as built. For a CLI or a test; the screen wants `current()`. */
  planned(): readonly SessionItem[] {
    return this.plan;
  }
}

/**
 * Read the queue and build a session plan.
 *
 * One read of each half, then a pure interleave — so the plan is a snapshot, and
 * a card that becomes due mid-session is tomorrow's problem rather than a queue
 * that grows while it is being worked.
 */
export function buildSession(db: SqliteHandle, options: SessionOptions = {}): ReviewSession {
  const now = options.now ?? nowInHostOffset();
  const newLimit = options.newLimit ?? DEFAULT_NEW_LIMIT;
  const shared = {
    now,
    ...(options.deckId === undefined ? {} : { deckId: options.deckId }),
    ...(options.includeSubdecks === undefined
      ? {}
      : { includeSubdecks: options.includeSubdecks }),
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
  };

  const due = dueTracks(db, {
    ...shared,
    ...(options.dueLimit === undefined ? {} : { limit: options.dueLimit }),
  }).map((t) => toItem(t, "due"));

  const fresh =
    newLimit <= 0 ? [] : newTracks(db, { ...shared, limit: newLimit }).map((t) => toItem(t, "new"));

  const plan = interleaveTracks(
    due,
    fresh,
    options.interleave ?? DEFAULT_INTERLEAVE,
    options.spreadOver ?? EXPECTED_SESSION_CARDS,
  );
  return new ReviewSession(db, plan);
}
