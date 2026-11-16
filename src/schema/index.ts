import { renderPlainTextParts, stripInvisible } from "../text/index.js";

export const SCHEMA_VERSION = 9;

export const REVERSE_MODES = ["inherit", "on", "off"] as const;
export type ReverseMode = (typeof REVERSE_MODES)[number];

export interface ReverseInheritance {
  readonly id: string;
  readonly parentId: string | null;
  readonly reverse: ReverseMode;
}

export function resolveReverseInheritance(
  nodes: ReadonlyMap<string, ReverseInheritance>,
  deckId: string | null | undefined,
  fallback: "on" | "off" = "off",
): "on" | "off" {
  const seen = new Set<string>();
  let id = deckId ?? null;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const node = nodes.get(id);
    if (node === undefined) break;
    if (node.reverse !== "inherit") return node.reverse;
    id = node.parentId;
  }
  return fallback;
}

export type TrackKind = "forward" | "reverse" | `cloze:${number}`;

export const FIELD_TYPES = [
  "plain",
  "boolean",
  "number",
  "speech",
  "ai",
  "translate",
  "accent",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const BLOB_KINDS = [
  "speech",
  "ai",
  "translate",
  "furigana",
  "dictionary",
  "image",
  "file",
] as const;
export type BlobKind = (typeof BLOB_KINDS)[number];

export const FIELD_TYPE_BLOB_KIND: Readonly<Record<string, BlobKind>> = {
  speech: "speech",
  ai: "ai",
  translate: "translate",
};

export const GENERATOR_FIELD_TYPES: ReadonlySet<string> = new Set(
  Object.keys(FIELD_TYPE_BLOB_KIND),
);

export const REVIEW_SOURCES = ["mochi", "local"] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

export const SETTING_KEYS = {
  reverseDefault: "reverse.default",
  targetRetentionDefault: "target_retention.default",
  voiceDefault: "voice.default",
  timezoneDefault: "timezone.default",
} as const;

export const GRADES_ARE_BINARY = true as const;

export const BINARY_GRADE = { forgot: 1, remembered: 3 } as const;
export type BinaryGrade = (typeof BINARY_GRADE)[keyof typeof BINARY_GRADE];

export const FROZEN_FSRS_WEIGHTS = [15, 16] as const;

export function gradeFor(remembered: boolean | 0 | 1): BinaryGrade {
  return remembered ? BINARY_GRADE.remembered : BINARY_GRADE.forgot;
}

export const INTERVAL_BASES = ["elapsed", "scheduled"] as const;
export type IntervalBasis = (typeof INTERVAL_BASES)[number];

export const RETENTION_BY_INTERVAL_VIEW: Readonly<Record<IntervalBasis, string>> = {
  elapsed: "retention_by_elapsed_interval",
  scheduled: "retention_by_scheduled_interval",
};

export const FTS_TOKENIZER = "trigram";

export const FTS_MIN_QUERY_CHARS = 3;

export function buildSearchText(...parts: readonly (string | null | undefined)[]): string {
  return renderPlainTextParts(parts);
}

export type SearchMode = "fts" | "like";

export interface SearchPlan {
  readonly mode: SearchMode;
  readonly sql: string;
  readonly params: readonly (string | number)[];
  readonly normalised: string;
}

const SEARCH_FTS_SQL =
  "SELECT card_id, name, bm25(card_fts) AS score FROM card_fts" +
  " WHERE card_fts MATCH ? ORDER BY score LIMIT ?";

const SEARCH_LIKE_SQL =
  "SELECT card_id, name, 0.0 AS score FROM card_search_index" +
  " WHERE name LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'" +
  " ORDER BY card_id LIMIT ?";

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function ftsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function searchPlan(query: string, limit = 50): SearchPlan | null {
  const normalised = stripInvisible(query.normalize("NFC")).trim();
  if (normalised === "") return null;

  if ([...normalised].length >= FTS_MIN_QUERY_CHARS) {
    return {
      mode: "fts",
      sql: SEARCH_FTS_SQL,
      params: [ftsPhrase(normalised), limit],
      normalised,
    };
  }

  const pattern = `%${escapeLike(normalised)}%`;
  return {
    mode: "like",
    sql: SEARCH_LIKE_SQL,
    params: [pattern, pattern, pattern, limit],
    normalised,
  };
}

export const TABLES = [
  "settings",
  "decks",
  "templates",
  "template_fields",
  "cards",
  "card_field_values",
  "card_tracks",
  "reviews",
  "tags",
  "card_tags",
  "card_links",
  "blobs",
  "blob_refs",
  "card_fts",
] as const;

export const VIEWS = [
  "deck_paths",
  "deck_ancestry",
  "deck_reverse_resolved",
  "card_reverse_resolved",
  "deck_target_retention_resolved",
  "card_links_resolved",
  "card_search_index",
  "tag_usage",
  "review_gaps",
  "review_log",
  "review_log_elapsed",
  "review_log_bucketed",
  "review_interval_audit",
  "study_totals",
  "activity_by_day",
  "retention_by_deck",
  "retention_by_elapsed_interval",
  "retention_by_scheduled_interval",
  "retention_by_hour",
  "deck_progress",
  "lapse_distribution",
] as const;

export function clozeTrack(index: number): TrackKind {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`cloze track index must be a non-negative integer, got ${index}`);
  }
  return `cloze:${index}`;
}

export function parseTrackKind(kind: string): TrackKind | null {
  if (kind === "forward" || kind === "reverse") return kind;
  const cloze = /^cloze:(\d+)$/.exec(kind);
  return cloze ? (kind as TrackKind) : null;
}

export function isReverseMode(value: string): value is ReverseMode {
  return (REVERSE_MODES as readonly string[]).includes(value);
}

export function isFieldType(value: string): value is FieldType {
  return (FIELD_TYPES as readonly string[]).includes(value);
}

export function isBlobKind(value: string): value is BlobKind {
  return (BLOB_KINDS as readonly string[]).includes(value);
}

export { moveWithin, positionKeys } from "./order.js";
