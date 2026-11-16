import {
  LIKE_ESCAPE_CLAUSE,
  charCount,
  ftsMatchExpression,
  likeContains,
  likePrefix,
  type SearchQuery,
} from "./query.js";

export interface BuiltStatement {
  readonly sql: string;
  readonly params: readonly (string | number)[];
}

export const FTS_COLUMNS = ["card_id", "name", "body", "tags"] as const;

export const FTS_BM25_WEIGHTS: Readonly<Record<(typeof FTS_COLUMNS)[number], number>> = {
  card_id: 0,
  name: 8,
  body: 1,
  tags: 4,
};

export const SCAN_WEIGHTS = {
  nameExact: 1000,
  namePrefix: 300,
  nameContains: 120,
  tags: 40,
  body: 10,
  bodyOccurrence: 2,
  bodyOccurrenceCap: 8,
  nameLengthCap: 200,
  nameLengthDivisor: 25,
} as const;

export const INVISIBLE_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff] as const;

export function strippedNameSql(expression: string): string {
  let out = expression;
  for (const code of INVISIBLE_CODE_POINTS) out = `replace(${out}, char(${code}), '')`;
  return out;
}

const NAME = strippedNameSql("s.name");

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

function archivedClause(includeArchived: boolean): string {
  return includeArchived ? "" : " AND c.archived = 0";
}

function deckClause(builder: SqlBuilder, deckIds: readonly string[] | null): void {
  if (deckIds === null) return;
  if (deckIds.length === 0) {
    builder.push(" AND 0 = 1");
    return;
  }
  builder.push(` AND c.deck_id IN (${deckIds.map(() => "?").join(", ")})`, ...deckIds);
}

function needsCardsJoin(includeArchived: boolean, deckIds: readonly string[] | null): boolean {
  return !includeArchived || deckIds !== null;
}

export function bm25Expression(): string {
  const weights = FTS_COLUMNS.map((column) => FTS_BM25_WEIGHTS[column].toFixed(1));
  return `bm25(card_fts, ${weights.join(", ")})`;
}

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
    .push(
      ` + min((length(s.body) - length(replace(lower(s.body), lower(?), ''))) / ?,` +
        ` ${w.bodyOccurrenceCap}) * ${w.bodyOccurrence}.0`,
      term,
      charCount(term),
    );
}

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

export const SEARCH_INDEX_STATUS_SQL =
  "SELECT (SELECT count(*) FROM cards) AS cards," +
  " (SELECT count(*) FROM card_fts) AS indexed," +
  " (SELECT count(*) FROM card_search_index WHERE search_text_populated = 0) AS unrendered";
