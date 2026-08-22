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
 * ─── THE ORDER IS `new-first` BY DEFAULT, AND THAT IS AN ARGUMENT NOT A TASTE ──
 *
 * Interleaving is the one item `src/scheduler`'s header flags as "still his
 * taste", so it is a named, swappable policy. But the default is not arbitrary,
 * and the reason is a measurement rather than a preference:
 *
 *   * The due queue is **443** and his sustained load is ~69-78 reviews a day
 *     (`BACKTEST.md` gives both bases). **He does not clear the due queue in one
 *     session.**
 *   * So under `due-first`, the ten new cards are never reached — not "reached
 *     late", never — and decision 12's dial becomes inert. That is a defect.
 *   * Under `spread` across the whole due queue, he sees roughly
 *     `10 x (done / 443)` new cards, so stopping at 100 yields two. Same defect,
 *     smaller.
 *   * Under `new-first` the ten happen, so the 3,980-track backlog actually
 *     moves at the rate the setting says it does.
 *
 * The honest counter-argument, and the reason this is still HIS call: ten
 * unfamiliar words first means ten cards where there is no accent to recall yet,
 * which is a poor warm-up for a shadowing exercise. `spread` is one word away if
 * he prefers it. What is NOT defensible is `due-first`.
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
  type GradedReview,
  type QueuedTrack,
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
 * `new-first` is the default and the header explains why `due-first` is a defect
 * rather than a preference given a 443-card due queue.
 */
export type InterleavePolicy = "new-first" | "due-first" | "spread";

export const DEFAULT_INTERLEAVE: InterleavePolicy = "new-first";

export interface SessionOptions {
  /** RFC 3339 with an offset. Only its LOCAL DATE selects the queue. */
  readonly now?: string;
  /** Decision 12/15. Defaults to `DEFAULT_NEW_LIMIT`; 0 means due cards only. */
  readonly newLimit?: number;
  /** Cap the due half. Absent means every due track, which is the real session. */
  readonly dueLimit?: number;
  readonly interleave?: InterleavePolicy;
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
 * `spread` places the new items at evenly spaced positions across the combined
 * length rather than "every Nth due card", so a 3-new/400-due session and a
 * 10-new/10-due session both come out evenly distributed instead of the second
 * degenerating into new-first.
 */
export function interleaveTracks(
  due: readonly SessionItem[],
  fresh: readonly SessionItem[],
  policy: InterleavePolicy,
): SessionItem[] {
  if (fresh.length === 0) return [...due];
  if (due.length === 0) return [...fresh];
  if (policy === "new-first") return [...fresh, ...due];
  if (policy === "due-first") return [...due, ...fresh];

  const total = due.length + fresh.length;
  // Position i of n new items goes at floor((i + 0.5) * total / n): the midpoint
  // of its share, which keeps one at neither end and spaces them evenly.
  // Slot i is the MIDPOINT of new item i's share: floor((i + 0.5) * total / n).
  //
  // NO COLLISION HANDLING, and that is proved rather than hoped. Consecutive
  // slots differ by total/n = 1 + due/n, which is >= 1 whenever `due >= 1` — and
  // `due === 0` took the early return above — so the floors strictly increase.
  // A guard walking forward to the next free slot was here; injection proved it
  // unreachable, and a sweep of 90,000 (due, new) pairs over 1..300 found zero
  // collisions. Removed rather than kept, for the same reason as the re-ask Set.
  //
  // The property a caller cares about is pinned in `test/session.test.ts`: for
  // `due >= new`, no two new items are ever adjacent (minimum gap 2, swept). A
  // new item CAN land at either end, so do not assert otherwise in general.
  const slots = new Set<number>();
  for (let i = 0; i < fresh.length; i += 1) {
    slots.add(Math.floor(((i + 0.5) * total) / fresh.length));
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
   * card silently is worse than surfacing it, and the caller can skip forward.
   */
  answer(
    remembered: boolean,
    options: { readonly at?: string; readonly durationMs?: number | null } = {},
  ): AnswerResult {
    const item = this.current();
    if (item === null) throw new SessionCompleteError();

    if (item.reask) {
      this.cursor += 1;
      return { item, graded: false, review: null, queuedReask: false };
    }

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
    return { item, graded: true, review, queuedReask };
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

  const plan = interleaveTracks(due, fresh, options.interleave ?? DEFAULT_INTERLEAVE);
  return new ReviewSession(db, plan);
}
