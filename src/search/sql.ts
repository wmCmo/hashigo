/**
 * Stage 8 — the SQL. Two statements per path, generated so that text and
 * parameters cannot drift apart.
 *
 * Both paths read `card_search_index`, which is the view that defines what
 * search sees; the FTS path reaches it through `card_fts`, whose triggers are
 * fed from that same view. So the index and the scan physically cannot disagree
 * about what a card's text is, and that is not a claim about discipline — it is
 * one SELECT, in `src/schema/schema.sql`, used twice.
 *
 * ── RANKING ─────────────────────────────────────────────────────────────────
 * FIXES.md §3.5 is the defect this file exists to close: the previous scan
 * ordered by `card_id` and capped at 50, so `する` returned 50 arbitrary cards
 * out of 228. Ordering by an opaque 8-character id is not a ranking, and it
 * must not reach the `@` picker looking like one.
 *
 * FTS path: `bm25()`, which is what FTS5 is for.
 *
 * Scan path: there is no inverted index to ask, so the three things bm25 is
 * made of are computed by hand, and only those three:
 *
 *   FIELD WEIGHT      a hit in the card's title is what the user meant; a hit in
 *                     a curated tag is next; prose is the baseline. The title
 *                     bucket is split three ways — exact, prefix, contains —
 *                     because those are the only position facts available
 *                     without introducing a second definition of equality (see
 *                     below).
 *   TERM FREQUENCY    occurrences of the term in the body, counted with the
 *                     length-of-replace trick and CAPPED, so one card that says
 *                     する forty times cannot outrank a card titled する.
 *                     Deliberately bounded below the gap between field buckets:
 *                     frequency breaks ties inside a bucket, it never crosses one.
 *   LENGTH NORM       shorter titles first. A three-character card named 意味 is
 *                     a better answer for `意味` than a 90-character sentence
 *                     that happens to contain it. This is the `b` in bm25, and
 *                     on this corpus it is the component that does most of the
 *                     visible work.
 *
 * WHY NO `instr()` POSITION SCORE. `instr()` is case-SENSITIVE and `LIKE` is
 * ASCII-case-INSENSITIVE. Scoring with `instr()` while filtering with `LIKE`
 * would mean the ranking and the filter disagreed about whether `Kanji` contains
 * `kanji` — on his English deck, which is half the corpus by template. One
 * definition of equality, so: LIKE for the filter, LIKE for the buckets,
 * `lower()` (also ASCII-only, which is what makes it agree) for the exact test.
 *
 * ── THE NAME COLUMN HAS TO BE STRIPPED HERE, AND THAT COSTS 2.3x ────────────
 * `card_search_index.body` is `cards.search_text` — rendered, zero-width
 * stripped. `card_search_index.name` is `cards.name`, RAW. 48 card names hold an
 * invisible mark (`川‎越‎市`, `素‎晴らしい`, `RSAとは、巨大な数の素因数‎分解が…`),
 * and for 3 of them the stripped name appears nowhere in the body either, so
 * those cards are unfindable by what they visibly say unless this module strips
 * the marks itself. It does, with nested `replace()`.
 *
 * Measured cost of that workaround on the real database, one session of 25 runs
 * per query: the ranked scan goes from 3.62-5.68 ms to 8.14-10.86 ms for `意味`,
 * and from 11.14-17.97 ms to 34.77-45.95 ms for the worst case (`a`, 6,359
 * matching cards). Treat the RATIO — about 2.3-2.9x — as the finding and the
 * absolute numbers as one machine on one afternoon: repeated sessions of the
 * whole-call timing moved by a factor of three under nothing but background
 * load. The fix belongs in the view, not here; see the ORPHAN note in the stage
 * report. Correctness first, and the cost is on the record so the fix has a
 * number attached.
 */

import {
  LIKE_ESCAPE_CLAUSE,
  charCount,
  ftsMatchExpression,
  likeContains,
  likePrefix,
  type SearchQuery,
} from "./query.js";

/** A statement and its positional parameters, in text order. */
export interface BuiltStatement {
  readonly sql: string;
  readonly params: readonly (string | number)[];
}

/**
 * `card_fts`'s columns, in declaration order, because `bm25()` weights are
 * POSITIONAL and include the UNINDEXED one.
 *
 * SQLite does not check the count. Measured: `bm25(card_fts, 10.0, 1.0, 3.0)`
 * on a 4-column table runs without complaint and silently weights `card_id` by
 * 10, `name` by 1, `body` by 3 and `tags` by 1 — a scoring function nobody
 * wrote. `bm25(card_fts, 1.0)` likewise returns the default score. So the
 * weight vector is built from this list rather than typed out, and
 * `test/search.test.ts` asserts the emitted SQL carries exactly this many.
 */
export const FTS_COLUMNS = ["card_id", "name", "body", "tags"] as const;

/**
 * bm25 column weights. `card_id` is UNINDEXED and contributes nothing whatever
 * its weight is (measured: `bm25(card_fts, 100, 0, 0, 0)` scores every row
 * 0.0), so it is 0 to say so out loud.
 *
 * Honest caveat about `name`: Mochi's own primary field carries the field id
 * `name`, and 7,390 of 7,716 cards have one, so the title text is usually
 * present in `body` as well. Weighting `name` up therefore changes scores but
 * only sometimes changes order — measured on `ている` (29 hits) it moved one
 * card three places. The weight is right in principle and weak on this corpus;
 * both halves of that are worth knowing before someone tunes it.
 */
export const FTS_BM25_WEIGHTS: Readonly<Record<(typeof FTS_COLUMNS)[number], number>> = {
  card_id: 0,
  name: 8,
  body: 1,
  tags: 4,
};

/** The scan's hand-built bm25 analogue. Every constant that shapes an order. */
export const SCAN_WEIGHTS = {
  /** The card is titled exactly this. */
  nameExact: 1000,
  /** The title starts with the term. */
  namePrefix: 300,
  /** The title contains the term anywhere. */
  nameContains: 120,
  /** A tag path contains the term. */
  tags: 40,
  /** The rendered body contains the term. */
  body: 10,
  /** Per additional occurrence in the body, up to `bodyOccurrenceCap`. */
  bodyOccurrence: 2,
  bodyOccurrenceCap: 8,
  /** Length normalisation: `- min(len(name), cap) / divisor`. */
  nameLengthCap: 200,
  nameLengthDivisor: 25,
} as const;

/**
 * The zero-width and bidi marks stripped from a name, as code points.
 *
 * The same set as `INVISIBLE_MARKS` in `src/text/render.ts` — U+200B..U+200F
 * and U+FEFF — listed here as numbers because SQL needs `char(8203)` and cannot
 * be handed a JavaScript regex. `test/search.test.ts` pins the two lists equal.
 */
export const INVISIBLE_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff] as const;

/** `replace(replace(...expr..., char(8203), ''), ...)` — the rendered name. */
export function strippedNameSql(expression: string): string {
  let out = expression;
  for (const code of INVISIBLE_CODE_POINTS) out = `replace(${out}, char(${code}), '')`;
  return out;
}

/** `card_search_index.name`, with the marks gone. Used by filter and ranking. */
const NAME = strippedNameSql("s.name");

/**
 * Text and parameters, appended together so they cannot fall out of step.
 *
 * Every fragment must declare exactly as many parameters as it has `?`
 * placeholders; the constructor of a wrong ORDER BY is a wrong answer that
 * looks plausible, and the constructor of a wrong parameter order is a query
 * that searches for the limit. Checked, not trusted.
 */
class SqlBuilder {
  private text = "";
  private readonly values: (string | number)[] = [];

  push(fragment: string, ...params: (string | number)[]): this {
    const holes = fragment.split("?").length - 1;
    if (holes !== params.length) {
      throw new Error(
        `SQL fragment has ${holes} placeholder(s) and ${params.length} parameter(s): ${fragment}`,
      );
    }
    this.text += fragment;
    this.values.push(...params);
    return this;
  }

  build(): BuiltStatement {
    return { sql: this.text, params: [...this.values] };
  }
}

/** `AND c.archived = 0`, or nothing. */
function archivedClause(includeArchived: boolean): string {
  return includeArchived ? "" : " AND c.archived = 0";
}

/**
 * `AND c.deck_id IN (...)`, or nothing — the SUBTREE the caller resolved.
 *
 * SCOPING BELONGS IN THE QUERY, NOT AFTER IT. The app used to take the top `limit`
 * matches across the whole collection and filter them to a deck in the page, which
 * silently under-reports: with `limit: 300` over 7,716 cards, a query matching widely
 * outside the deck returns almost nothing inside it and reports that as "no matches".
 * The count was wrong too, since `total` counted the unfiltered set.
 *
 * Resolving the subtree stays the CALLER's job (`app/deck-scope.ts` walks `parent_id`);
 * this only applies the ids it is given.
 */
function deckClause(builder: SqlBuilder, deckIds: readonly string[] | null): void {
  if (deckIds === null) return;
  if (deckIds.length === 0) {
    // An empty scope matches nothing. Saying so explicitly beats emitting `IN ()`,
    // which is a syntax error in SQLite.
    builder.push(" AND 0 = 1");
    return;
  }
  builder.push(` AND c.deck_id IN (${deckIds.map(() => "?").join(", ")})`, ...deckIds);
}

/** True when a query needs `cards` joined that would otherwise be left out. */
function needsCardsJoin(includeArchived: boolean, deckIds: readonly string[] | null): boolean {
  return !includeArchived || deckIds !== null;
}

// ---------------------------------------------------------------------------
// FTS path.
// ---------------------------------------------------------------------------

/** `bm25(card_fts, 0.0, 8.0, 1.0, 4.0)` — one weight per column, in order. */
export function bm25Expression(): string {
  const weights = FTS_COLUMNS.map((column) => FTS_BM25_WEIGHTS[column].toFixed(1));
  return `bm25(card_fts, ${weights.join(", ")})`;
}

/**
 * The ranked FTS query.
 *
 * `bm25()` returns a NEGATIVE number and better is more negative, so the sort is
 * ascending. Getting that backwards yields the worst 50 matches in confident
 * order, which is why `test/search.test.ts` asserts the top hit rather than only
 * that the order differs from `card_id`.
 *
 * `c.seq` breaks ties, so paging with OFFSET is stable rather than
 * "whatever the sorter did this time".
 */
export function buildFtsSearch(
  query: SearchQuery,
  limit: number,
  offset: number,
  includeArchived: boolean,
  deckIds: readonly string[] | null = null,
): BuiltStatement {
  const builder = new SqlBuilder()
    .push(
      `SELECT c.id AS card_id, c.seq AS seq, ${strippedNameSql("c.name")} AS name,` +
        ` c.deck_id AS deck_id, c.archived AS archived, ${bm25Expression()} AS score` +
        ` FROM card_fts JOIN cards c ON c.seq = card_fts.rowid` +
        ` WHERE card_fts MATCH ?`,
      ftsMatchExpression(query.terms),
    )
    .push(archivedClause(includeArchived));
  deckClause(builder, deckIds);
  return builder.push(" ORDER BY score ASC, c.seq ASC LIMIT ? OFFSET ?", limit, offset).build();
}

/**
 * How many cards match, ignoring the page. The number `truncated` needs.
 *
 * The join to `cards` is present ONLY when the archived filter needs it. It is
 * dead weight otherwise, and this count is a second full pass over the data —
 * measured at roughly the same cost as the ranked query itself on the scan path,
 * so its dead weight is half the price of knowing the denominator.
 */
export function buildFtsCount(
  query: SearchQuery,
  includeArchived: boolean,
  deckIds: readonly string[] | null = null,
): BuiltStatement {
  const from = needsCardsJoin(includeArchived, deckIds)
    ? "card_fts JOIN cards c ON c.seq = card_fts.rowid"
    : "card_fts";
  const builder = new SqlBuilder()
    .push(
      `SELECT count(*) AS n FROM ${from} WHERE card_fts MATCH ?`,
      ftsMatchExpression(query.terms),
    )
    .push(archivedClause(includeArchived));
  deckClause(builder, deckIds);
  return builder.build();
}

// ---------------------------------------------------------------------------
// Scan path.
// ---------------------------------------------------------------------------

/** One term's filter: the term is somewhere in the name, the body or a tag. */
function pushTermFilter(builder: SqlBuilder, term: string): void {
  const contains = likeContains(term);
  builder.push(
    `(${NAME} LIKE ?${LIKE_ESCAPE_CLAUSE}` +
      ` OR s.body LIKE ?${LIKE_ESCAPE_CLAUSE}` +
      ` OR s.tags LIKE ?${LIKE_ESCAPE_CLAUSE})`,
    contains,
    contains,
    contains,
  );
}

/** One term's contribution to the score. See SCAN_WEIGHTS for every constant. */
function pushTermScore(builder: SqlBuilder, term: string): void {
  const w = SCAN_WEIGHTS;
  const contains = likeContains(term);
  builder
    .push(`(CASE WHEN lower(${NAME}) = lower(?) THEN ${w.nameExact}.0 ELSE 0.0 END)`, term)
    .push(
      ` + (CASE WHEN ${NAME} LIKE ?${LIKE_ESCAPE_CLAUSE} THEN ${w.namePrefix}.0 ELSE 0.0 END)`,
      likePrefix(term),
    )
    .push(
      ` + (CASE WHEN ${NAME} LIKE ?${LIKE_ESCAPE_CLAUSE} THEN ${w.nameContains}.0 ELSE 0.0 END)`,
      contains,
    )
    .push(
      ` + (CASE WHEN s.tags LIKE ?${LIKE_ESCAPE_CLAUSE} THEN ${w.tags}.0 ELSE 0.0 END)`,
      contains,
    )
    .push(
      ` + (CASE WHEN s.body LIKE ?${LIKE_ESCAPE_CLAUSE} THEN ${w.body}.0 ELSE 0.0 END)`,
      contains,
    )
    // Occurrences, capped. `length(lower(x))` would equal `length(x)` because
    // SQLite's lower() only folds ASCII, so the outer lower() is left off the
    // measured side rather than paid for on every row.
    .push(
      ` + min((length(s.body) - length(replace(lower(s.body), lower(?), ''))) / ?,` +
        ` ${w.bodyOccurrenceCap}) * ${w.bodyOccurrence}.0`,
      term,
      charCount(term),
    );
}

/**
 * The ranked scan, for any query with a term below the trigram floor.
 *
 * 7,716 rows, no index, and that is fine: a leading `%` could not use one
 * anyway. Measured on the real database, 25 runs each, `--db build/hashigo.db`:
 * 8.14-10.86 ms for `意味` (3 hits), 10.53-15.53 ms for `する` (228 hits),
 * 12.31-16.72 ms for `の` (387), and 33.38-47.62 ms for the pathological
 * single-letter `a` (6,359 hits, i.e. 82% of the corpus). The last one is
 * dominated by sorting 6,359 scored rows to return 50 of them.
 */
export function buildScanSearch(
  query: SearchQuery,
  limit: number,
  offset: number,
  includeArchived: boolean,
  deckIds: readonly string[] | null = null,
): BuiltStatement {
  const builder = new SqlBuilder();
  builder.push(
    `SELECT s.card_id AS card_id, s.seq AS seq, ${NAME} AS name,` +
      ` c.deck_id AS deck_id, c.archived AS archived, `,
  );
  query.terms.forEach((term, index) => {
    if (index > 0) builder.push(" + ");
    pushTermScore(builder, term);
  });
  builder.push(
    ` - min(length(${NAME}), ${SCAN_WEIGHTS.nameLengthCap})` +
      ` / ${SCAN_WEIGHTS.nameLengthDivisor}.0 AS score`,
  );
  builder.push(" FROM card_search_index s JOIN cards c ON c.seq = s.seq WHERE ");
  query.terms.forEach((term, index) => {
    if (index > 0) builder.push(" AND ");
    pushTermFilter(builder, term);
  });
  builder.push(archivedClause(includeArchived));
  deckClause(builder, deckIds);
  builder.push(
    ` ORDER BY score DESC, length(${NAME}) ASC, s.seq ASC LIMIT ? OFFSET ?`,
    limit,
    offset,
  );
  return builder.build();
}

/** The scan's exact match count. Same WHERE, no scoring, no sort, no join. */
export function buildScanCount(
  query: SearchQuery,
  includeArchived: boolean,
  deckIds: readonly string[] | null = null,
): BuiltStatement {
  const builder = new SqlBuilder();
  const from = needsCardsJoin(includeArchived, deckIds)
    ? "card_search_index s JOIN cards c ON c.seq = s.seq"
    : "card_search_index s";
  builder.push(`SELECT count(*) AS n FROM ${from} WHERE `);
  query.terms.forEach((term, index) => {
    if (index > 0) builder.push(" AND ");
    pushTermFilter(builder, term);
  });
  builder.push(archivedClause(includeArchived));
  deckClause(builder, deckIds);
  return builder.build();
}

/**
 * The rendered bodies of the cards on this page, for snippets.
 *
 * Bounded by the page size, never by the match count: the scan may have touched
 * 6,359 rows but only the 50 being shown need their text back.
 */
export function buildBodyFetch(cardIds: readonly string[]): BuiltStatement {
  if (cardIds.length === 0) throw new RangeError("no card ids to fetch bodies for");
  const holes = cardIds.map(() => "?").join(", ");
  return new SqlBuilder()
    .push(
      `SELECT card_id, name, body, tags FROM card_search_index WHERE card_id IN (${holes})`,
      ...cardIds,
    )
    .build();
}

/**
 * Is the index actually maintained? `search_text_populated = 0` means a writer
 * edited a card without recomputing `cards.search_text`, and the schema comment
 * asks for exactly this count to make that condition observable rather than
 * invisible.
 */
export const SEARCH_INDEX_STATUS_SQL =
  "SELECT (SELECT count(*) FROM cards) AS cards," +
  " (SELECT count(*) FROM card_fts) AS indexed," +
  " (SELECT count(*) FROM card_search_index WHERE search_text_populated = 0) AS unrendered";
