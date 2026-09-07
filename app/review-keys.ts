/**
 * WHICH KEY DOES WHAT, GIVEN WHAT IS ON SCREEN — as one pure function.
 *
 * ─── THIS FILE EXISTS BECAUSE THIS RULE HAS BEEN WRONG TWICE, SILENTLY ──────
 *
 * The keydown handler in `main.ts` is where the app's most expensive bugs have
 * lived, and both were the same shape: a key that was correct in one state doing
 * something destructive in another, with nothing on screen to say so.
 *
 * **1. Typing in the gallery filter box graded cards.** Every single-key review
 * shortcut fired while he typed a deck name into a search box, because
 * `reviewView.hidden` looks like it covers the gallery and does not — the gallery
 * is shown by `data-view` on the body and hidden in CSS, so `hidden` is false the
 * whole time it is up. Typing "japanese" archived the review card behind it and
 * graded it. A grade writes a `reviews` row and advances the FSRS schedule, so this
 * corrupted the study history the app exists to protect, from a search box.
 *
 * **2. Grading while looking ahead grades a different card.** `answer()` acts on
 * the SESSION's current item, not on what is displayed, so `j` pressed during his
 * #9's look-ahead moves a due date on a card he is not reading.
 *
 * Neither is visible when it happens. Both are one boolean in a long `if` chain.
 * So the chain is a table now, in a module with no imports, and `test/app-keys.test.ts`
 * enumerates it — including the two states above, by name.
 *
 * ─── WHY IT RETURNS AN ACTION INSTEAD OF DOING ONE ──────────────────────────
 *
 * The same reason `app/keys.ts` and `app/review-boundary.ts` are shaped this way:
 * the root `tsconfig.json` excludes `app/`, so a module with no imports is reachable
 * from `test/` and one that touches the DOM is not. `main.ts` maps the action to a
 * call; everything decidable is decided here.
 */

// `survivesTyping` lives in `./keys.ts` and is IMPORTED rather than repeated. It is
// one line, which is exactly why a second copy would never be noticed drifting —
// and `test/app-logic.test.ts` already pins that one. `./keys.ts` has no imports of
// its own, so this module stays reachable from `test/`.
import { survivesTyping } from "./keys.js";

/** Everything about the screen that changes what a key means. */
export interface KeyState {
  /** Focus is in a text field. `app/keys.ts` decides this from the event target. */
  readonly typing: boolean;
  /** A modal layer is open — a preview, the editor, a confirm, the palette. */
  readonly layerOpen: boolean;
  /**
   * The top layer accepts the single-key card operations. TRUE for a preview only.
   *
   * Deliberately not derived from "the layer has a card id": the EDITOR carries one
   * too and every one of its fields is an input, so keying off the id alone would
   * archive the card he is editing the moment focus sat on the panel.
   */
  readonly layerActs: boolean;
  readonly sidebarOpen: boolean;
  /** The review view is not on screen at all — boot, or the done screen. */
  readonly reviewHidden: boolean;
  readonly revealed: boolean;
  /**
   * The card ASKED something on entry — decision 29's mode 2, or a widget card.
   *
   * It decides whether `r` works before the reveal, and the distinction is the
   * decision rather than a convenience:
   *
   *   * asked  — the clip is the QUESTION. Replaying it is repeating the question,
   *              so it must work immediately. Zach hit this on a 数字 card:
   *              *"now i can't replay it even if i want to, i would have to click
   *              review first"* — and revealing to hear the question again hands
   *              him the answer, which deletes the exercise.
   *   * not    — the clip is the ANSWER (the 692 `Reading = true` cards). Replay
   *              stays behind the reveal. That is decision 29 working, not a bug:
   *              on those cards the silence IS the exercise.
   */
  readonly asked: boolean;
  /** His #9: the screen is showing a neighbour, and the session cursor has not moved. */
  readonly peeking: boolean;
  /** There is a card to act on. */
  readonly hasCard: boolean;
}

export type ReviewAction =
  | "palette"
  | "undo"
  | "closeLayer"
  | "editLayer"
  | "layerPin"
  | "layerArchive"
  | "layerDelete"
  | "closeSidebar"
  | "openSidebar"
  | "edit"
  | "reveal"
  | "archive"
  | "pin"
  | "delete"
  | "next"
  | "previous"
  | "backToCard"
  | "gradeForgot"
  | "gradeRemembered"
  | "replay"
  /** A grade was pressed while looking ahead. Say so; write nothing. */
  | "gradeBlocked"
  /** Nothing, and the browser keeps the keystroke. */
  | null;

export interface KeyEventShape {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
}

export function reviewAction(event: KeyEventShape, state: KeyState): ReviewAction {
  if (event.repeat === true) return null;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey === true || event.metaKey === true;

  // ── global, and deliberately above the typing guard ──
  // Ctrl+K over a filter box is a reasonable thing to press. Ctrl+Z is not, while
  // he is typing — the browser's own undo is what he means there.
  if (mod && key === "k") return "palette";
  if (mod && key === "z") return state.typing ? null : "undo";
  if (mod) return null;

  // ── THE GUARD THAT WAS MISSING ──
  // Every branch below is a single-key shortcut. Without this they all fired while
  // he typed in the gallery's filter box: `a` archived, `d` opened delete, `j`
  // graded remembered, `f` graded forgot, space revealed — which is what made j
  // and f live. Typing "japanese" was an archive and a grade.
  if (state.typing && !survivesTyping(event.key)) return null;

  // ── a layer owns the keyboard ──
  // Without this, space would grade the card UNDERNEATH the preview he is reading.
  if (state.layerOpen) {
    if (event.key === "Escape") return "closeLayer";
    if (state.typing) return null;
    if (key === "e") return "editLayer";
    if (!state.layerActs) return null;
    if (key === "p" && event.shiftKey === true) return "layerPin";
    if (key === "a") return "layerArchive";
    if (key === "d") return "layerDelete";
    return null;
  }

  // ── the sidebar is navigation, and answers only when nothing is over it ──
  if (state.sidebarOpen) {
    if (event.key === "Escape") return "closeSidebar";
    if (state.typing) return null;
  }
  if (event.key === "/") return "openSidebar";

  if (state.reviewHidden) return null;

  if (key === "e") return "edit";
  if (key === " " || key === "enter") return state.revealed ? null : "reveal";

  // ── operations, which act WITHOUT grading ──
  if (!state.hasCard) return null;
  if (key === "a") return "archive";
  if (key === "p" && event.shiftKey === true) return "pin";
  if (key === "d") return "delete";
  if (event.key === "ArrowRight") return "next";
  if (event.key === "ArrowLeft") return "previous";
  if (event.key === "Escape") return state.peeking ? "backToCard" : null;

  // REPLAY IS ABOVE THE REVEAL GATE WHEN THE CLIP IS THE QUESTION. See
  // `KeyState.asked`: on a mode-2 card, needing to reveal in order to hear the
  // question again hands over the answer.
  if (key === "r" && state.asked) return "replay";

  if (!state.revealed) return null;

  // ── grading ──
  // GRADING IS THE SESSION'S CURSOR, NOT THE SCREEN'S. `answer()` grades whatever
  // the session is on, so a keystroke here while looking ahead moves a due date on
  // a card he is not reading. Blocked and SAID, not silently ignored: the two keys
  // he presses a hundred times a day doing nothing without explanation reads as the
  // app being broken.
  if (key === "f") return state.peeking ? "gradeBlocked" : "gradeForgot";
  if (key === "j") return state.peeking ? "gradeBlocked" : "gradeRemembered";
  if (key === "r") return "replay";
  return null;
}

/** The state a freshly-opened review screen is in. Handy for tests and defaults. */
export const REVIEWING: KeyState = {
  typing: false,
  layerOpen: false,
  layerActs: false,
  sidebarOpen: false,
  reviewHidden: false,
  revealed: false,
  asked: false,
  peeking: false,
  hasCard: true,
};
