/**
 * Stage 8 — the public search call. One function, two paths, and a result that
 * says which one ran.
 *
 *     import { searchCards } from "hashigo/search";
 *
 *     const result = searchCards(db, "意味");
 *     result.mode      // "like"  — below the trigram floor, so it scanned
 *     result.total     // 3       — the real number of matching cards
 *     result.hits[0]   // ranked, not card_id order
 *
 * WHAT THIS IS FOR. Ctrl+K, and the `@` card picker, which SPEC says must reuse
 * this index rather than build a second one. Which is exactly why `total` and
 * `truncated` exist: FIXES.md §3.5 flagged that the old scan returned 50 cards
 * out of 228 with no indication that 178 were missing, and a picker cannot be
 * honest about "no other matches" if the search will not tell it.
 *
 * TYPED AGAINST `SqliteHandle`, NOT `Database`. That is the portable contract in
 * `src/db/browser.ts`, satisfied structurally by better-sqlite3 in Node and by
 * the sqlite-wasm/opfs-sahpool handle in the Worker, so one function body serves
 * both. The import is `import type`, so nothing from `@sqlite.org/sqlite-wasm`
 * survives compilation. Nothing in `src/search/` imports `node:*` or
 * `src/schema/index.ts` (which reads its .sql with `node:fs` at module load), so
 * this module bundles for the browser — Ctrl+K is a browser feature and would
 * otherwise be Node-only.
 */

import type { SqliteHandle } from "../db/browser.js";
import { parseSearchQuery, type SearchMode, type SearchQuery } from "./query.js";
import { makeSnippet, type SearchSnippet } from "./snippet.js";
import {
  SEARCH_INDEX_STATUS_SQL,
  buildBodyFetch,
  buildFtsCount,
  buildFtsSearch,
  buildScanCount,
  buildScanSearch,
} from "./sql.js";

/** The page size a search box uses when it does not say. */
export const DEFAULT_SEARCH_LIMIT = 50;

/**
 * The largest page this will return. Not a performance limit — the scan sorts
 * every match regardless of `limit` — but a limit on how much body text one call
 * pulls back for snippets.
 */
export const MAX_SEARCH_LIMIT = 500;

export interface SearchOptions {
  readonly limit?: number;
  readonly offset?: number;
  /**
   * Archived cards are INCLUDED by default (234 of them in the corpus).
   * Archiving means "stop reviewing", not "stop existing", and a search that
   * silently hides a card you archived is a search you cannot trust. `archived`
   * is on every hit so a UI can grey them instead.
   */
  readonly includeArchived?: boolean;
  /**
   * Restrict to these deck ids, or omit for the whole collection.
   *
   * The caller resolves the subtree — `app/deck-scope.ts` walks `parent_id` — because
   * "this deck" means different things to a sidebar and to a query, and only the
   * caller knows which. An EMPTY array matches nothing, which is different from
   * omitting the option.
   *
   * Scoping has to happen in the QUERY. Filtering the page afterwards under-reports:
   * the top `limit` matches across 7,716 cards can contain almost none from the deck
   * being browsed, and `total` would count the unfiltered set.
   */
  readonly deckIds?: readonly string[];
  /** Compute excerpts. On by default; one extra query bounded by the page. */
  readonly snippets?: boolean;
  readonly snippetRadius?: number;
}

export interface SearchHit {
  readonly cardId: string;
  readonly seq: number;
  /** The card's title with the invisible marks removed — what it visibly says. */
  readonly name: string;
  readonly deckId: string;
  readonly archived: boolean;
  /**
   * HIGHER IS BETTER, always, on both paths. `bm25()` returns a negative number
   * where more negative is better, so the FTS path's value is negated here; the
   * alternative was a field whose sort direction depended on `mode`, which is a
   * trap a caller finds by shipping the worst 50 matches in confident order.
   *
   * Magnitudes are path-specific and mean nothing across modes.
   */
  readonly score: number;
  /** 0-based position in the whole result, `offset` included. */
  readonly rank: number;
  readonly snippet: SearchSnippet | null;
}

export interface SearchResult {
  /** Exactly what was typed. */
  readonly query: string;
  /** What was actually searched for, after NFC and mark-stripping. */
  readonly normalised: string;
  readonly terms: readonly string[];
  /** `null` when the query was empty and nothing ran. */
  readonly mode: SearchMode | null;
  readonly hits: readonly SearchHit[];
  /** Every matching card, not just this page. Exact, not estimated. */
  readonly total: number;
  /** `true` when `total` exceeds what this page could show. */
  readonly truncated: boolean;
  readonly limit: number;
  readonly offset: number;
  /** Terms past `MAX_TERMS`, not searched. */
  readonly termsDropped: number;
  /** Wall clock for the whole call, including the snippet query. */
  readonly elapsedMs: number;
}

interface RankedRow {
  readonly card_id: string;
  readonly seq: number;
  readonly name: string;
  readonly deck_id: string;
  readonly archived: number;
  readonly score: number;
}

interface BodyRow {
  readonly card_id: string;
  readonly name: string;
  readonly body: string;
  readonly tags: string;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  }
  return value;
}

/**
 * Search every card, ranked, through whichever path the query length demands.
 *
 * An empty or whitespace-only query returns an empty result with `mode: null`
 * and runs no SQL. It is not an error and it is not "everything": a blank
 * Ctrl+K box shows nothing.
 */
export function searchCards(
  db: SqliteHandle,
  query: string,
  options: SearchOptions = {},
): SearchResult {
  const started = performance.now();
  const limit = Math.min(
    Math.max(1, positiveInteger(options.limit ?? DEFAULT_SEARCH_LIMIT, "limit")),
    MAX_SEARCH_LIMIT,
  );
  const offset = positiveInteger(options.offset ?? 0, "offset");
  const includeArchived = options.includeArchived !== false;
  const deckIds = options.deckIds ?? null;
  const wantSnippets = options.snippets !== false;

  const parsed = parseSearchQuery(query);
  if (parsed === null) {
    return {
      query,
      normalised: "",
      terms: [],
      mode: null,
      hits: [],
      total: 0,
      truncated: false,
      limit,
      offset,
      termsDropped: 0,
      elapsedMs: performance.now() - started,
    };
  }

  const search =
    parsed.mode === "fts"
      ? buildFtsSearch(parsed, limit, offset, includeArchived, deckIds)
      : buildScanSearch(parsed, limit, offset, includeArchived, deckIds);
  const count =
    parsed.mode === "fts"
      ? buildFtsCount(parsed, includeArchived, deckIds)
      : buildScanCount(parsed, includeArchived, deckIds);

  const total = (db.prepare(count.sql).get(...count.params) as { n: number }).n;
  const rows = db.prepare(search.sql).all(...search.params) as RankedRow[];
  const bodies = wantSnippets && rows.length > 0 ? fetchBodies(db, rows) : new Map<string, BodyRow>();

  const hits: SearchHit[] = rows.map((row, index) => {
    const source = bodies.get(row.card_id);
    return {
      cardId: row.card_id,
      seq: row.seq,
      name: row.name,
      deckId: row.deck_id,
      archived: row.archived === 1,
      // bm25 is negative-better; every consumer gets higher-is-better.
      score: parsed.mode === "fts" ? -row.score : row.score,
      rank: offset + index,
      snippet:
        source === undefined
          ? null
          : makeSnippet(
              { name: row.name, body: source.body, tags: source.tags },
              parsed.terms,
              options.snippetRadius,
            ),
    };
  });

  return {
    query,
    normalised: parsed.normalised,
    terms: parsed.terms,
    mode: parsed.mode,
    hits,
    total,
    truncated: total > offset + hits.length,
    limit,
    offset,
    termsDropped: parsed.termsDropped,
    elapsedMs: performance.now() - started,
  };
}

function fetchBodies(db: SqliteHandle, rows: readonly RankedRow[]): Map<string, BodyRow> {
  const fetch = buildBodyFetch(rows.map((row) => row.card_id));
  const out = new Map<string, BodyRow>();
  for (const row of db.prepare(fetch.sql).all(...fetch.params) as BodyRow[]) {
    out.set(row.card_id, row);
  }
  return out;
}

export interface SearchIndexStatus {
  readonly cards: number;
  /** Rows in `card_fts`. Should equal `cards`; the triggers maintain it. */
  readonly indexed: number;
  /**
   * Cards whose `search_text` is NULL, so `card_search_index` fell back to the
   * raw concatenation for them — link ids in, rendered compounds out. The
   * schema comment asks for this to be countable rather than invisible; this is
   * where it is counted.
   */
  readonly unrendered: number;
}

/** Is search looking at a maintained index? Answer, rather than assume. */
export function searchIndexStatus(db: SqliteHandle): SearchIndexStatus {
  const row = db.prepare(SEARCH_INDEX_STATUS_SQL).get() as {
    cards: number;
    indexed: number;
    unrendered: number;
  };
  return { cards: row.cards, indexed: row.indexed, unrendered: row.unrendered };
}

/** Re-exported so a caller can route or explain without importing two modules. */
export type { SearchQuery };
