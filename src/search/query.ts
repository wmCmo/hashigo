/**
 * Stage 8 — the query side of search: normalise, split, ROUTE, and escape.
 *
 * This file holds every decision about the text the user typed, and no SQL. The
 * router is the point of the stage: `card_fts` uses FTS5's trigram tokeniser, a
 * trigram index physically cannot serve a query shorter than three characters,
 * and two characters is the commonest search unit in Japanese — 意味, 勉強,
 * 漢字, 日本. Measured on the real database (7,716 cards):
 *
 *   意味   trigram MATCH 0   scan 3
 *   する   trigram MATCH 0   scan 228
 *   ない   trigram MATCH 0   scan 74
 *   勉強   trigram MATCH 0   scan 1
 *
 * So the short query is not a degraded case to apologise for; it is the case,
 * and `mode` is how it gets served.
 *
 * ── WHAT NORMALISATION IS APPLIED, AND WHY NOT MORE ─────────────────────────
 * Exactly the transform the index already had applied to it, and not one step
 * further: NFC, then the zero-width / bidi marks stripped, then whitespace
 * collapsed. `cards.search_text` is the output of `renderPlainTextParts()`, so
 * matching it means normalising the query the same way and no other way.
 *
 * NFKC is deliberately NOT applied. `src/text/render.ts` left that decision to
 * "whoever owns the query box"; this file owns it, and the answer is no.
 * Folding is only correct when BOTH sides are folded identically, and the index
 * is NFC. Folding the query alone would take the 464 cards written with `～`
 * (U+FF5E) and make them unfindable by the character actually on the card. The
 * day someone wants `~` to find `～`, the index has to move first.
 *
 * ── WHY WHITESPACE SPLITS INTO TERMS ────────────────────────────────────────
 * Under the trigram tokeniser a space is an ordinary indexed character, so the
 * phrase `"勉強 する"` requires a literal space between the two words and finds
 * nothing else. That is never what a search box means. So a query splits on
 * whitespace and every term must match (AND), which is also the only sane
 * reading of a two-word query in the scan path.
 *
 * Routing then keys off the SHORTEST term, because one short term is enough to
 * make the whole FTS query wrong: FTS5 silently drops a phrase that produces no
 * tokens when the phrases are juxtaposed, and returns nothing at all for it
 * under an explicit AND. Measured: `"気持ち" AND "意味"` -> 0 rows even though
 * 気持ち alone matches 1. A router that sent `気持ち 意味` to FTS5 would
 * therefore report "no results" for a query with a real answer.
 */

import { stripInvisible } from "../text/index.js";

/**
 * The trigram floor. Three, not because FTS5 says so in a config, but because
 * a 3-character window is the smallest thing the index contains.
 *
 * `src/schema/index.ts` declares the same constant for the SQL it owns. That
 * duplication is forced, not chosen: `src/schema/index.ts` reads its .sql files
 * with `node:fs` at module load, so importing it from here would make Ctrl+K
 * Node-only — see the comment in `src/db/browser.ts` saying exactly that. The
 * two copies are pinned equal by `test/search.test.ts`, which imports both.
 */
export const FTS_MIN_QUERY_CHARS = 3;

/**
 * Terms beyond this are dropped, and the drop is REPORTED on the result rather
 * than being silent. A search box does not produce seventeen words; a paste
 * does, and the honest answer to a paste is "I used the first sixteen".
 */
export const MAX_TERMS = 16;

/**
 * Which path served the query. Same two names as `SearchMode` in
 * `src/schema/index.ts`, deliberately — a second vocabulary for the same two
 * facts is how documentation and code stop agreeing.
 */
export type SearchMode = "fts" | "like";

export interface SearchQuery {
  /** Exactly what was typed. Kept so a UI can echo it back. */
  readonly raw: string;
  /** After NFC, mark-stripping and whitespace collapse. What was searched for. */
  readonly normalised: string;
  /** `normalised` split on whitespace. Every one of them must match. */
  readonly terms: readonly string[];
  readonly mode: SearchMode;
  /** Code points in the shortest term — the number the router decides on. */
  readonly shortestTermChars: number;
  /** Terms past `MAX_TERMS`, not searched. Zero for any realistic query. */
  readonly termsDropped: number;
}

/** Code points in `text`, not UTF-16 units. `[...s].length`, spelled out. */
export function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/**
 * The query, normalised to the same shape as the indexed text.
 *
 * Whitespace is collapsed rather than merely trimmed, so `勉強   する` and
 * `勉強 する` are one query, and so a term can never be the empty string.
 */
export function normaliseQuery(raw: string): string {
  return stripInvisible(raw.normalize("NFC")).replace(/\s+/gu, " ").trim();
}

/**
 * Parse and route, or `null` when there is nothing to search for.
 *
 * `null` rather than an empty-term query on purpose: a blank Ctrl+K box must
 * show nothing, and "match everything" is a different feature with a different
 * name.
 */
export function parseSearchQuery(raw: string): SearchQuery | null {
  const normalised = normaliseQuery(raw);
  if (normalised === "") return null;

  const all = normalised.split(" ");
  const terms = all.slice(0, MAX_TERMS);
  let shortest = Number.POSITIVE_INFINITY;
  for (const term of terms) shortest = Math.min(shortest, charCount(term));

  return {
    raw,
    normalised,
    terms,
    mode: shortest >= FTS_MIN_QUERY_CHARS ? "fts" : "like",
    shortestTermChars: shortest,
    termsDropped: all.length - terms.length,
  };
}

// ---------------------------------------------------------------------------
// Escaping. Both halves, because both halves have an injection story.
// ---------------------------------------------------------------------------

/**
 * The LIKE escape character: one backslash.
 *
 * Spelled `String.fromCharCode(92)` rather than as a literal, and the escaper
 * below is a loop rather than a regex, for a reason that has already cost this
 * project time: a backslash inside a string literal inside a SQL string inside
 * a shell heredoc has four layers to be mangled by, and it was — the first draft
 * of the measurement script for this file emitted `ESCAPE ''` and SQLite
 * answered "ESCAPE expression must be a single character". There is no
 * backslash literal anywhere in this module.
 */
export const LIKE_ESCAPE = String.fromCharCode(92);

/** ` ESCAPE '\'`, ready to append to any LIKE. */
export const LIKE_ESCAPE_CLAUSE = ` ESCAPE '${LIKE_ESCAPE}'`;

/**
 * Escape the three characters LIKE treats as syntax, so a query containing them
 * matches them literally.
 *
 * `%` and `_` are the wildcards; the escape character has to escape itself or
 * `%\%` would consume the pattern's own `%`. His cards contain jisho-style `\*`
 * wildcards, so a query of `\*` reaches this function in normal use, and it must
 * come out as a literal backslash followed by a literal star.
 *
 * Iterated by code point, so a surrogate pair cannot be split.
 */
export function escapeLike(value: string): string {
  let out = "";
  for (const character of value) {
    if (character === LIKE_ESCAPE || character === "%" || character === "_") out += LIKE_ESCAPE;
    out += character;
  }
  return out;
}

/** `%term%` — a substring match. A leading wildcard cannot use an index anyway. */
export function likeContains(value: string): string {
  return `%${escapeLike(value)}%`;
}

/** `term%` — a prefix match, used by the ranking rather than by the filter. */
export function likePrefix(value: string): string {
  return `${escapeLike(value)}%`;
}

/**
 * Quote one term as an FTS5 phrase, so every FTS5 operator in it is literal.
 *
 * This is the whole injection defence for the MATCH path and it was verified
 * against the real index rather than reasoned about. Unquoted, each of these is
 * an error or a different query than the user asked for:
 *
 *   `**`     -> unknown special query: *          quoted: 0 rows
 *   `"`      -> unterminated string                quoted: 0 rows
 *   `AND`    -> fts5: syntax error near "AND"      quoted: 786 rows (literal "and")
 *   `NOT`    -> fts5: syntax error near "NOT"      quoted: 220 rows
 *   `col:`   -> no such column: col                quoted: 0 rows
 *   `{a}`    -> no such column: a                  quoted: 0 rows
 *   `-abc`   -> no such column: abc                quoted: 0 rows
 *   `%_`     -> fts5: syntax error near "%"        quoted: 0 rows
 *   `\*`     -> fts5: syntax error near "\"        quoted: 0 rows
 *   `abc*`   -> a PREFIX query (1 row)             quoted: 0 rows, as asked
 *
 * Note the last one: unquoted `abc*` does not fail, it silently answers a
 * different question. That is the case a "does it throw" test would miss.
 */
export function ftsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The MATCH expression for a whole query: every term as a phrase, ANDed.
 *
 * `AND` is written out. FTS5's juxtaposition — `"a" "b"` — is phrase
 * CONCATENATION, not a boolean: measured on the real index, `"気持ち" "ください"`
 * is 0 (no card says those adjacently) while `"気持ち" OR "ください"` is 1. Two
 * plausible readings of the same syntax, so the operator is explicit.
 *
 * Throws on a term the index cannot serve. That is the difference between a
 * loud bug and a silent one: FTS5 answers a zero-token phrase under AND with
 * zero rows, so a 2-character term leaking into this path would report "no
 * results" for a query with 228 answers.
 */
export function ftsMatchExpression(terms: readonly string[]): string {
  if (terms.length === 0) throw new RangeError("no terms to match");
  for (const term of terms) {
    const chars = charCount(term);
    if (chars < FTS_MIN_QUERY_CHARS) {
      throw new RangeError(
        `term ${JSON.stringify(term)} is ${chars} character(s); the trigram index ` +
          `cannot serve fewer than ${FTS_MIN_QUERY_CHARS} and would silently return ` +
          `nothing. Route this query to the scan path instead.`,
      );
    }
  }
  return terms.map(ftsPhrase).join(" AND ");
}

/**
 * ASCII-only lower-casing — the ONE definition of case folding in this module.
 *
 * It has to be ASCII-only because SQLite's `LIKE` and `lower()` are ASCII-only
 * by default, and the scan's ranking compares against the same columns its
 * filter does. `String.prototype.toLowerCase()` folds far more of Unicode, so
 * using it here would give the snippet a different idea of "matches" than the
 * query had, and a highlight would land on text that is not why the card came
 * back.
 */
export function asciiLower(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    out += code >= 0x41 && code <= 0x5a ? String.fromCodePoint(code + 0x20) : character;
  }
  return out;
}
