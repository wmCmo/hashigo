/**
 * Stage 7 — the review session. What is due, in the order it will be shown.
 *
 *     import { buildSession } from "hashigo/session";
 *
 *     const session = buildSession(db);            // 10 new + everything due
 *     const item = session.current();              // -> SessionItem | null
 *     session.answer(true);                        // grades, advances
 *
 * The last piece between `hashigo/scheduler` (what is due), `hashigo/cards` (a
 * card id in, a renderable card out) and the screen. `src/scheduler`'s own header
 * says it "does NOT hold a session, choose a new-cards-per-day number, interleave
 * new with due, or undo a grade" — this owns the first three and deliberately not
 * the fourth.
 *
 * TWO THINGS TO KNOW BEFORE CALLING IT, both of them decisions rather than
 * implementation:
 *
 *   1. **A re-ask is never graded.** Decision 13: a forgotten card comes back at
 *      the end of the session and writes no review row. `answer()` enforces it —
 *      `AnswerResult.graded` is false and `review` is null. A caller cannot
 *      override that, because it is the half of decision 13 that is easy to lose.
 *   2. **New cards are SPREAD through the first 80 cards by default** — Zach's
 *      choice of policy, and a window that is the implementation half of it.
 *      Spread across the whole 453-card plan he would see two of his ten new
 *      cards before stopping; windowed, he sees all ten. `./session.ts`'s header
 *      has the table. `due-first` remains a defect rather than a preference:
 *      the ten are never reached at all.
 *
 * BROWSER-PORTABLE and pinned as such: typed against `SqliteHandle` through a
 * type-only import, reaching no `node:` import, walked by
 * `test/browser-portable.test.ts`. The review screen runs in an OPFS worker.
 */

export {
  DEFAULT_INTERLEAVE,
  DEFAULT_NEW_LIMIT,
  EXPECTED_SESSION_CARDS,
  ReviewSession,
  SessionCompleteError,
  buildSession,
  interleaveTracks,
  type AnswerResult,
  type InterleavePolicy,
  type SessionItem,
  type SessionOptions,
  type SessionProgress,
} from "./session.js";
