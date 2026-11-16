import type { SqliteHandle } from "../db/browser.js";
import { okuriganaStem, parseSearchQuery, type SearchMode, type SearchQuery } from "./query.js";
import { makeSnippet, type SearchSnippet } from "./snippet.js";
import {
  SEARCH_INDEX_STATUS_SQL,
  buildBodyFetch,
  buildFtsCount,
  buildFtsSearch,
  buildScanCount,
  buildScanSearch,
} from "./sql.js";

export const DEFAULT_SEARCH_LIMIT = 50;

export const MAX_SEARCH_LIMIT = 500;

export interface SearchOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly includeArchived?: boolean;
  readonly deckIds?: readonly string[];
  readonly snippets?: boolean;
  readonly snippetRadius?: number;
}

export interface SearchHit {
  readonly cardId: string;
  readonly seq: number;
  readonly name: string;
  readonly deckId: string;
  readonly archived: boolean;
  readonly score: number;
  readonly rank: number;
  readonly snippet: SearchSnippet | null;
}

export interface SearchResult {
  readonly query: string;
  readonly normalised: string;
  readonly terms: readonly string[];
  readonly mode: SearchMode | null;
  readonly hits: readonly SearchHit[];
  readonly total: number;
  readonly truncated: boolean;
  readonly limit: number;
  readonly offset: number;
  readonly termsDropped: number;
  readonly stemmedFrom: string | null;
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

export function searchCards(
  db: SqliteHandle,
  query: string,
  options: SearchOptions = {},
): SearchResult {
  const direct = runSearch(db, query, options, null);
  if (direct.hits.length > 0 || direct.mode === null) return direct;
  const stem = okuriganaStem(query);
  if (stem === null) return direct;
  const broadened = runSearch(db, stem, options, query);
  return broadened.hits.length === 0 ? direct : broadened;
}

function runSearch(
  db: SqliteHandle,
  query: string,
  options: SearchOptions,
  stemmedFrom: string | null,
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
      stemmedFrom,
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
    stemmedFrom,
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
  readonly indexed: number;
  readonly unrendered: number;
}

export function searchIndexStatus(db: SqliteHandle): SearchIndexStatus {
  const row = db.prepare(SEARCH_INDEX_STATUS_SQL).get() as {
    cards: number;
    indexed: number;
    unrendered: number;
  };
  return { cards: row.cards, indexed: row.indexed, unrendered: row.unrendered };
}

export type { SearchQuery };
