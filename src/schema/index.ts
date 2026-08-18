/**
 * Stage 1 — the schema, as SQL text plus the handful of TypeScript types that
 * mirror its CHECK constraints.
 *
 * `schema.sql` and `views.sql` are the authority; this module only loads them
 * and names their enumerations so the rest of the codebase cannot invent a
 * fourth reverse state or a review track Mochi never had. See SPEC.html and the
 * header comments in the two .sql files for the reasoning behind each decision.
 *
 * The SQL is read from disk relative to this module. That works under Node and
 * vitest (import, backtest, tests). The browser/OPFS build has no filesystem,
 * so whatever bundles the PWA must inline these two files — either a text
 * loader or a copy step into `dist/schema/`; `tsc` alone does not copy .sql.
 */

import { readFileSync } from "node:fs";

/** Bumped only by a migration. `PRAGMA user_version` holds this. */
export const SCHEMA_VERSION = 1;

/**
 * Three-state, on both cards and decks. `inherit` resolves up the deck tree and
 * bottoms out at the workspace default (`off`); a card's explicit value beats
 * its deck. Mochi's two-state boolean cannot express a deliberate exception,
 * which is the whole reason for the third state.
 */
export const REVERSE_MODES = ["inherit", "on", "off"] as const;
export type ReverseMode = (typeof REVERSE_MODES)[number];

/**
 * A card has N independent review tracks, each separately scheduled. Mochi's
 * three parallel arrays — reviews, reverse-reviews, cloze/reviews — all map onto
 * this one concept.
 */
export type TrackKind = "forward" | "reverse" | `cloze:${number}`;

/** Field types the template engine and generation DAG must support. */
export const FIELD_TYPES = [
  "plain",
  "text",
  "boolean",
  "number",
  "speech",
  "ai",
  "translate",
  "furigana",
  "dictionary",
  "image-search",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** What a content-addressed blob holds. There is no `deleted` kind, by design. */
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

/** Provenance of a review row. Everything imported from Mochi is `mochi`. */
export const REVIEW_SOURCES = ["mochi", "local"] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

/** Keys seeded into `settings` by schema.sql. */
export const SETTING_KEYS = {
  reverseDefault: "reverse.default",
  targetRetentionDefault: "target_retention.default",
  timezoneDefault: "timezone.default",
} as const;

/**
 * FTS5 tokeniser. The default (unicode61) splits on whitespace and cannot index
 * Japanese; trigram indexes every 3-character window and so matches mid-string
 * CJK substrings. The cost is the floor below: a 1- or 2-character query cannot
 * use the index and the UI must fall back to a LIKE scan.
 */
export const FTS_TOKENIZER = "trigram";
export const FTS_MIN_QUERY_CHARS = 3;

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
  "tag_usage",
  "review_log",
  "review_log_bucketed",
  "study_totals",
  "activity_by_day",
  "retention_by_deck",
  "retention_by_interval",
  "retention_by_hour",
  "deck_progress",
  "lapse_distribution",
] as const;

function readSql(fileName: string): string {
  const url = new URL(fileName, import.meta.url);
  try {
    return readFileSync(url, "utf8");
  } catch (cause) {
    // Loud on purpose. `tsc` does not copy .sql files, so `dist/schema/` has the
    // compiled index.js and no SQL beside it. Whatever builds for distribution
    // must copy src/schema/*.sql next to the emitted module (or inline them with
    // a text loader for the browser/OPFS build, which has no filesystem at all).
    throw new Error(
      `schema source ${fileName} not found next to this module (${url.pathname}). ` +
        `The build must copy src/schema/*.sql alongside the emitted JS, or inline it.`,
      { cause },
    );
  }
}

export const SCHEMA_SQL = readSql("schema.sql");
export const VIEWS_SQL = readSql("views.sql");

/** In application order: tables and triggers first, then the views over them. */
export const SCHEMA_SOURCES: readonly { readonly name: string; readonly sql: string }[] = [
  { name: "schema.sql", sql: SCHEMA_SQL },
  { name: "views.sql", sql: VIEWS_SQL },
];

/** The whole schema as one script, for tooling that wants a single string. */
export function schemaSql(): string {
  return SCHEMA_SOURCES.map((source) => source.sql).join("\n");
}

/** `cloze:3`. Indexed clozes are unused in the corpus but the tracks exist. */
export function clozeTrack(index: number): TrackKind {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`cloze track index must be a non-negative integer, got ${index}`);
  }
  return `cloze:${index}`;
}

/** Narrow a stored `card_tracks.kind` string, or null if the CHECK would reject it. */
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
