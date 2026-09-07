/**
 * WIKI-LINKS IN A TEXTAREA — finding one, and completing one.
 *
 * Zach, 2026-09-07: *"for hyperlink when i edit the card, right now it's just text,
 * i want the auto complete when you type just like when you're in obsidian, and
 * ctrl+clicking it should open a new card on top … also `@` and `[[` should both
 * start the trigger"*.
 *
 * ─── EVERYTHING HERE IS DERIVED FROM HIS CORPUS, NOT FROM OBSIDIAN ──────────
 *
 * Measured over 8,744 links across 4,335 cards:
 *
 * ```
 * form                       [[display|card-id]]   the target is ALWAYS an id
 * display = the target NAME  8,210  (94%)
 * display = something else     534  (6%)
 * display = the bare id            0
 * in a FIELD / in card content   7,725 / 1,019
 * dead targets (card deleted)       18
 * ```
 *
 * **The 6% is the reason completion inserts a DEFAULT and not a fixed value.** Those
 * are inflections pointing at a dictionary form: `[[越|4nKAg2kH]]` targets 越す,
 * `[[引き|10PQotxm]]` targets 引く, `[[換え|C1p9g1mL]]` targets 換える. He links the
 * conjugated text he wrote to the card that holds the word. So the display text is
 * seeded with the target's name and stays editable; a completion that hard-wired the
 * name would make his own commonest deliberate edit impossible.
 *
 * ─── WHY `@` TRIGGERS ONLY AFTER WHITESPACE ─────────────────────────────────
 *
 * `@` is Mochi's own card-reference trigger (`schema.sql`: "@ card reference ->
 * card_links"), so both belong. But `@` also occurs as literal text. Measured over
 * all 22,319 field values: **four contain `@` at all**, and three of them are
 * markdown image paths — `![OIG (1).jpeg](@media/mxkKeDnY.jpeg)`. Requiring
 * start-of-text or whitespace before it excludes exactly those three. The fourth is
 * `; @austere` in a synonym list, which would open a suggestion list he can dismiss
 * with Escape — a trigger is not a transformation, and nothing is written until he
 * picks something.
 *
 * ─── WHY THIS FILE HAS NO IMPORTS ───────────────────────────────────────────
 *
 * The root `tsconfig.json` excludes `app/`, so an import-free module here is
 * reachable from `test/` and one that touches the DOM is not — the same seam as
 * `app/keys.ts`, `app/review-keys.ts` and `app/review-boundary.ts`. Offsets and
 * strings are decidable; `main.ts` owns the textarea.
 */

/** A complete `[[display|target]]` occurrence, by offset. */
export interface LinkSpan {
  /** Offset of the first `[`. */
  readonly start: number;
  /** Offset one past the last `]`. */
  readonly end: number;
  readonly display: string;
  /** The card id. `[[id]]` with no pipe carries the id here and `null` display. */
  readonly target: string;
  readonly raw: string;
}

/**
 * `[[…]]`, non-greedy, no newline inside.
 *
 * A link never spans a line in this corpus and allowing it to would make an
 * unclosed `[[` swallow the rest of the field.
 */
const LINK = /\[\[([^\]\n]*)\]\]/g;

/** Split a link body on its LAST pipe: a display text may itself contain one. */
function parseBody(body: string): { display: string; target: string } {
  const pipe = body.lastIndexOf("|");
  if (pipe === -1) return { display: body, target: body };
  return { display: body.slice(0, pipe), target: body.slice(pipe + 1) };
}

/** Every complete link in `text`, in order. */
export function linksIn(text: string): LinkSpan[] {
  const out: LinkSpan[] = [];
  for (const match of text.matchAll(new RegExp(LINK.source, "g"))) {
    const at = match.index;
    if (at === undefined) continue;
    const { display, target } = parseBody(match[1] ?? "");
    out.push({ start: at, end: at + match[0].length, display, target, raw: match[0] });
  }
  return out;
}

/**
 * The link containing `offset`, or null.
 *
 * Inclusive of the brackets at both ends, because a ctrl+click lands wherever the
 * pointer was and the brackets are part of what he sees. `offset === end` counts:
 * a caret placed just after `]]` is still "on" that link for this purpose, and the
 * alternative is a click at the right-hand edge doing nothing.
 */
export function linkAt(text: string, offset: number): LinkSpan | null {
  for (const span of linksIn(text)) {
    if (offset >= span.start && offset <= span.end) return span;
  }
  return null;
}

export type TriggerKind = "[[" | "@";

/** An in-progress reference at the caret: the opener, and what has been typed. */
export interface Trigger {
  readonly kind: TriggerKind;
  /** Offset of the first character of the opener. */
  readonly start: number;
  /** Offset one past the query, i.e. the caret. */
  readonly end: number;
  readonly query: string;
}

/**
 * How far a query may run before the trigger is abandoned.
 *
 * Card names in this corpus reach 24 characters (`a ball is in one's court`), so
 * spaces have to be allowed and a length bound is what stops a stray `@` turning
 * the rest of a paragraph into a search.
 */
const MAX_QUERY = 40;

/**
 * The reference being typed at `caret`, or null.
 *
 * Returns null when the caret sits inside a COMPLETE link — otherwise editing
 * `[[越|4nKAg2kH]]` would reopen the menu over a link he already finished.
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  if (caret < 0 || caret > text.length) return null;
  if (linkAt(text, caret) !== null) return null;

  const from = Math.max(0, caret - MAX_QUERY - 2);
  const window = text.slice(from, caret);

  const openBrackets = window.lastIndexOf("[[");
  if (openBrackets !== -1) {
    const query = window.slice(openBrackets + 2);
    // An unclosed `[[` only counts while nothing has closed it and no line ended.
    if (!query.includes("]]") && !query.includes("\n") && query.length <= MAX_QUERY) {
      return { kind: "[[", start: from + openBrackets, end: caret, query };
    }
  }

  const at = window.lastIndexOf("@");
  if (at !== -1) {
    const before = from + at === 0 ? "" : text[from + at - 1] ?? "";
    // START OF TEXT OR WHITESPACE ONLY — see the header: this is what excludes
    // `](@media/…)`, which is three of the four literal `@`s in the whole corpus.
    if (before === "" || /\s/.test(before)) {
      const query = window.slice(at + 1);
      if (!query.includes("\n") && !query.includes("@") && query.length <= MAX_QUERY) {
        return { kind: "@", start: from + at, end: caret, query };
      }
    }
  }
  return null;
}

/**
 * Replace a trigger with a finished link.
 *
 * `display` is seeded by the caller from the target's name and is the part he edits
 * afterwards — see the header for why that 6% matters. The caret lands just before
 * the closing `]]`, on the display text, because that is the only part worth
 * changing and putting it there saves the one keystroke that makes an inflection
 * link cheap to write.
 */
export function completeLink(
  text: string,
  trigger: Trigger,
  display: string,
  target: string,
): { text: string; caret: number } {
  const link = `[[${display}|${target}]]`;
  const next = text.slice(0, trigger.start) + link + text.slice(trigger.end);
  return { text: next, caret: trigger.start + 2 + display.length };
}
