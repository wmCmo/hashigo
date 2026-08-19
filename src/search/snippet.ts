/**
 * Stage 8 — the bit of text a hit shows, and where in it the match is.
 *
 * ONE implementation for both paths. FTS5 ships `snippet()` and `highlight()`,
 * and using them would have meant the 1-2 character scan path either had no
 * snippet at all or had a second, differently-behaved one. A hit list where the
 * excerpt rules change depending on how long your query was is worse than a
 * plain one, so the excerpt is computed in TypeScript from the same rendered
 * text both paths index: `card_search_index.body`, i.e. `cards.search_text`.
 *
 * Case folding is `asciiLower` from `./query.js`, which is the module's single
 * definition and the one that agrees with SQLite's `LIKE`. Using
 * `String.prototype.toLowerCase()` here would fold more of Unicode than the
 * query did, and the highlight would sometimes land on text that is not the
 * reason the card matched.
 *
 * Two length-preserving tricks make the offsets trustworthy: `asciiLower` maps
 * code unit to code unit, and newlines and tabs are replaced by single spaces
 * rather than collapsed. So an index found in the folded text is valid in the
 * original, and `matchStart` is an index a UI can slice on directly.
 */

import { asciiLower } from "./query.js";

/** Which column the excerpt came from. */
export type SnippetField = "body" | "name" | "tags";

export interface SearchSnippet {
  /** The excerpt, with `…` where text was cut. Newlines flattened to spaces. */
  readonly text: string;
  readonly field: SnippetField;
  /** UTF-16 offset of the matched term within `text`. */
  readonly matchStart: number;
  /** Length of the matched term in `text`, in UTF-16 units. */
  readonly matchLength: number;
}

/** Characters of context either side of the match. */
export const SNIPPET_RADIUS = 40;

const ELLIPSIS = "…";

/** Line breaks and tabs to spaces. Length-preserving, so offsets survive. */
function flatten(text: string): string {
  return text.replace(/[\r\n\t\v\f]/g, " ");
}

/** True when `index` sits on the low half of a surrogate pair. */
function splitsSurrogate(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const previous = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}

/**
 * Earliest occurrence of any term in `text`, folded ASCII-case-insensitively.
 *
 * Returns the term's own length too, because the shortest term is not
 * necessarily the one that matched first.
 */
function firstMatch(text: string, terms: readonly string[]): { start: number; length: number } | null {
  const folded = asciiLower(text);
  let best: { start: number; length: number } | null = null;
  for (const term of terms) {
    if (term === "") continue;
    const start = folded.indexOf(asciiLower(term));
    if (start < 0) continue;
    if (best === null || start < best.start) best = { start, length: term.length };
  }
  return best;
}

export interface SnippetSource {
  readonly name: string;
  readonly body: string;
  readonly tags: string;
}

/**
 * An excerpt around the first matching term, or `null` when no term is in any
 * of the three fields.
 *
 * `null` is a real answer, not a failure: a card can match on a field the
 * caller did not ask for a snippet of, and an empty card (16 of them in the
 * corpus are untitled and textless) has nothing to excerpt. Inventing a
 * zero-length snippet would make a UI render an empty highlight.
 *
 * Fields are tried body, name, tags — body first because the name is already on
 * screen next to the excerpt, so repeating it there says nothing.
 */
export function makeSnippet(
  source: SnippetSource,
  terms: readonly string[],
  radius: number = SNIPPET_RADIUS,
): SearchSnippet | null {
  if (!Number.isInteger(radius) || radius < 0) {
    throw new RangeError(`snippet radius must be a non-negative integer, got ${radius}`);
  }
  const fields: readonly (readonly [SnippetField, string])[] = [
    ["body", source.body],
    ["name", source.name],
    ["tags", source.tags],
  ];

  for (const [field, raw] of fields) {
    const text = flatten(raw);
    const match = firstMatch(text, terms);
    if (match === null) continue;

    let start = Math.max(0, match.start - radius);
    let end = Math.min(text.length, match.start + match.length + radius);
    if (splitsSurrogate(text, start)) start -= 1;
    if (splitsSurrogate(text, end)) end += 1;

    const head = start > 0 ? ELLIPSIS : "";
    const tail = end < text.length ? ELLIPSIS : "";
    return {
      text: head + text.slice(start, end) + tail,
      field,
      matchStart: head.length + (match.start - start),
      matchLength: match.length,
    };
  }
  return null;
}
