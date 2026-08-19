/**
 * Stage 4 — the `<input>` widget: a typed answer box, and the comparison that
 * decides whether what he typed is what the card meant.
 *
 * ONE USE, AND IT CARRIES THE PARSER TRAP. The 数字 template, verbatim:
 *
 *     << Voice >>
 *     <input value=<<NoComma>>>
 *     ---
 *     << Number >>
 *
 * A FIELD REFERENCE INSIDE AN UNQUOTED HTML ATTRIBUTE. It works — and it only
 * works — because interpolation is TEXTUAL and happens before any markup is
 * lexed: `resolveSideTexts` substitutes `<<NoComma>>` into the side's text, and
 * `parseMaskedSide` then lexes `<input value=662928912>`. By the time the tag
 * exists, the attribute is a literal. `test/japanese-render.test.ts` verifies
 * that end to end, on the real card, and also probes what a value containing a
 * space or a `>` would do to the tag — the honest answer is that it would break
 * it, and the reason it never has is that all 90 `NoComma` values in the corpus
 * are ASCII digits (measured, not assumed).
 *
 * THE BOX RENDERS EMPTY. `nodes.ts` puts the authored `value` in `data-expect`
 * instead of in `value`, because on this template the attribute is the ANSWER:
 * side 1 reads a number aloud (`Voice`, a speech field over the same digits) and
 * side 2 shows it formatted with commas. Prefilling it would print the answer
 * into the box he is supposed to type into.
 *
 * WHY NORMALISATION IS NOT OPTIONAL HERE. The answer is `662928912` and the
 * reveal is `662,928,912`, so he will type commas; and a Japanese IME set to 全角
 * produces `６６２９２８９１２`, which is a different string from `662928912` in
 * every byte. Both have to compare equal or the box is unusable on the phone
 * where he actually studies. NFKC does the width fold in one call; the separator
 * strip is ours.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: kana folding is OFF by default. Accepting
 * ミル for みる looks generous until you remember that 漢字's readings are
 * katakana for 音読み and hiragana for 訓読み — the two are different answers, and
 * quietly conflating them would teach him that the distinction does not matter.
 * `foldKana` exists for a caller that knows its field is not that.
 */

import { toHiragana } from "./ruby.js";
import type { WidgetMount } from "./nodes.js";

// ─── the port ────────────────────────────────────────────────────────────────

export interface InputListenerOptions {
  readonly passive?: boolean;
  readonly capture?: boolean;
}

/** A key event, cut down. `KeyboardEvent` satisfies it. */
export interface InputKeyEvent {
  readonly key: string;
  preventDefault(): void;
}

/**
 * The box, cut down to what an answer check needs. `HTMLInputElement` satisfies
 * it, and `test/japanese-render.test.ts` pins that with a type-only assignment.
 * `RenderElement` deliberately has no `value` and no listeners, so the caller
 * narrows: `attachInput(mount, mount.element as HTMLInputElement)`.
 */
export interface InputSurface {
  value: string;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(
    type: string,
    listener: (event: InputKeyEvent) => void,
    options?: InputListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: InputKeyEvent) => void,
    options?: InputListenerOptions,
  ): void;
}

// ─── normalisation ───────────────────────────────────────────────────────────

/** Characters a number can be written with that carry no information. */
const SEPARATORS = /[\s,、・，､_'`]/g;

export interface AnswerOptions {
  /** Fold katakana to hiragana before comparing. Off by default; see the header. */
  readonly foldKana?: boolean;
  /** Compare case-insensitively. On by default: the English decks are prose. */
  readonly foldCase?: boolean;
}

/**
 * The form two answers are compared in.
 *
 * NFKC first, which folds 全角 digits and letters to ASCII, ideographic space to
 * a space, and `，` to `,`. Then separators go: thousands commas either width,
 * `、`, `・`, spaces, underscores, quotes. Nothing else is touched — a digit is
 * never reordered and a kanji is never rewritten.
 */
export function normaliseAnswer(text: string, options: AnswerOptions = {}): string {
  let out = text.normalize("NFKC").replace(SEPARATORS, "");
  if (options.foldKana === true) out = toHiragana(out);
  if (options.foldCase !== false) out = out.toLowerCase();
  return out;
}

export interface AnswerCheck {
  readonly ok: boolean;
  /** As authored, from `data-expect`. */
  readonly expected: string;
  /** As typed. */
  readonly typed: string;
  readonly normalisedExpected: string;
  readonly normalisedTyped: string;
}

/** Compare a typed answer with the authored one. Both are normalised first. */
export function checkAnswer(
  expected: string,
  typed: string,
  options: AnswerOptions = {},
): AnswerCheck {
  const normalisedExpected = normaliseAnswer(expected, options);
  const normalisedTyped = normaliseAnswer(typed, options);
  return {
    // An empty box is not a correct answer, even against an empty expectation.
    ok: normalisedTyped !== "" && normalisedTyped === normalisedExpected,
    expected,
    typed,
    normalisedExpected,
    normalisedTyped,
  };
}

// ─── the widget ──────────────────────────────────────────────────────────────

/** Attributes this module owns. `data-expect` is the core's and is read-only here. */
export const INPUT_DATA = {
  /** `correct` | `incorrect`, set by `check()`, removed on the next keystroke. */
  answer: "data-answer",
} as const;

export interface InputOptions extends AnswerOptions {
  /** Overrides `mount.expected`. */
  readonly expected?: string | null;
  /** Enter was pressed. The verdict is null when the card expects nothing. */
  readonly onSubmit?: (check: AnswerCheck | null) => void;
  /** Every check, whoever asked for it. */
  readonly onCheck?: (check: AnswerCheck) => void;
}

export interface InputHandle {
  /** What the card expects, or null when it expects nothing checkable. */
  readonly expected: string | null;
  readonly value: string;
  /** Check the current value. Null when there is nothing to check against. */
  check(): AnswerCheck | null;
  /** Empty the box and drop any verdict. */
  reset(): void;
  detach(): void;
}

/**
 * Make a rendered `<input>` answer for itself.
 *
 * Grading is NOT here: `onSubmit` hands the verdict up, and what a right or
 * wrong answer means to the scheduler is stage 7's, exactly as the renderer's
 * hooks are. All this owns is the comparison and the `data-answer` mark.
 */
export function attachInput(
  mount: Pick<WidgetMount, "expected"> | null,
  surface: InputSurface,
  options: InputOptions = {},
): InputHandle {
  const expected =
    options.expected !== undefined ? options.expected : (mount?.expected ?? null);

  function verdict(): AnswerCheck | null {
    if (expected === null) return null;
    const result = checkAnswer(expected, surface.value, options);
    surface.setAttribute(INPUT_DATA.answer, result.ok ? "correct" : "incorrect");
    options.onCheck?.(result);
    return result;
  }

  const onKey = (event: InputKeyEvent): void => {
    if (event.key !== "Enter") return;
    // A form submit would navigate; there is no server and no form to post to.
    event.preventDefault();
    options.onSubmit?.(verdict());
  };
  // Any edit invalidates the verdict: a red box that stays red while he fixes a
  // typo is a lie about the current contents.
  const onEdit = (): void => surface.removeAttribute(INPUT_DATA.answer);

  surface.addEventListener("keydown", onKey);
  surface.addEventListener("input", onEdit);

  return {
    expected,
    get value(): string {
      return surface.value;
    },
    check: verdict,
    reset(): void {
      surface.value = "";
      surface.removeAttribute(INPUT_DATA.answer);
    },
    detach(): void {
      surface.removeEventListener("keydown", onKey);
      surface.removeEventListener("input", onEdit);
    },
  };
}
