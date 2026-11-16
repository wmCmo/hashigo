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
