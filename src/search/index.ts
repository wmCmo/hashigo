/**
 * Stage 8 — search. Ctrl+K, and the index the `@` picker reuses.
 *
 *     import { searchCards } from "hashigo/search";
 *     const result = searchCards(db, "意味");   // mode "like", total 3, ranked
 *
 * THE ROUTER IS THE STAGE. The index was built at stage 1 and works; nothing
 * routed to it. `card_fts` uses FTS5's trigram tokeniser, which cannot serve a
 * query shorter than three characters, and two characters is the commonest
 * search unit in Japanese. Measured on the real database:
 *
 *   意味   trigram MATCH 0   ranked scan 3
 *   する   trigram MATCH 0   ranked scan 228
 *   ない   trigram MATCH 0   ranked scan 74
 *   勉強   trigram MATCH 0   ranked scan 1
 *
 * WHERE THIS STOPS. It answers queries. It does not render a palette, debounce
 * keystrokes, remember history, or create a card on no match — the `@` picker's
 * create-if-missing is stage 10's, and it needs `total` and `truncated` from here
 * to know that "no other matches" is true.
 *
 * FOUR THINGS THAT ARE OBSERVABLE FROM OUTSIDE:
 *
 *   1. A 1-2 CHARACTER QUERY IS ANSWERED, not apologised for. `mode` says which
 *      path ran, both paths return the same columns, and no caller branches on
 *      length itself.
 *   2. RESULTS ARE RANKED, on both paths, and `score` is higher-is-better on
 *      both. `bm25()` for FTS; for the scan, bm25's own three ingredients
 *      computed by hand (field weight, capped term frequency, length
 *      normalisation) because there is no inverted index to ask. Nothing
 *      anywhere orders by `card_id`.
 *   3. `total` IS EXACT AND SEPARATE FROM THE PAGE. 50 of 228 is a sentence a
 *      picker can say; 50 with no denominator is the defect FIXES.md §3.5 named.
 *   4. NEITHER PATH CAN BE BROKEN OR STEERED BY WHAT YOU TYPE. `%`, `_`, `"`,
 *      `*`, `AND`, `col:` and the `\*` jisho wildcards in his own cards were
 *      each run against the real index in both raw and escaped form; the raw
 *      forms throw or silently answer a different question, and the escaped
 *      forms are literal. See `ftsPhrase` and `escapeLike` in `./query.ts`.
 *
 * SEARCH SEES THE RENDERED TEXT, which is the reason `cards.search_text` exists.
 * `～に[[引き|10PQotxm]]‎[[換え|C1p9g1mL]]` is findable as 引き換え, and the
 * opaque link ids are not findable at all: a trigram index built over the raw
 * concatenation matches 2,870 of the 2,895 distinct link target ids across 7,801
 * card hits, and `card_fts` matches 0 of them.
 */

export {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  searchCards,
  searchIndexStatus,
  type SearchHit,
  type SearchIndexStatus,
  type SearchOptions,
  type SearchResult,
} from "./search.js";

export {
  FTS_MIN_QUERY_CHARS,
  LIKE_ESCAPE,
  LIKE_ESCAPE_CLAUSE,
  MAX_TERMS,
  asciiLower,
  charCount,
  escapeLike,
  ftsMatchExpression,
  ftsPhrase,
  likeContains,
  likePrefix,
  normaliseQuery,
  parseSearchQuery,
  type SearchMode,
  type SearchQuery,
} from "./query.js";

export {
  FTS_BM25_WEIGHTS,
  FTS_COLUMNS,
  INVISIBLE_CODE_POINTS,
  SCAN_WEIGHTS,
  SEARCH_INDEX_STATUS_SQL,
  bm25Expression,
  buildBodyFetch,
  buildFtsCount,
  buildFtsSearch,
  buildScanCount,
  buildScanSearch,
  strippedNameSql,
  type BuiltStatement,
} from "./sql.js";

export {
  SNIPPET_RADIUS,
  makeSnippet,
  type SearchSnippet,
  type SnippetField,
  type SnippetSource,
} from "./snippet.js";
