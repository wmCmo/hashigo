/**
 * Stage 1 — the schema, as SQL text plus the handful of TypeScript types and
 * transforms that mirror its CHECK constraints.
 *
 * `schema.sql` and `views.sql` are the authority; this module names their
 * enumerations so the rest of the codebase cannot invent a fourth reverse state
 * or a review track Mochi never had, and owns the two derivations the SQL cannot
 * express — `buildSearchText` and `searchPlan`.
 *
 * THIS FILE HAS NO NODE IMPORTS, AND MUST NOT ACQUIRE ANY. It used to read the
 * DDL off disk with `node:fs` at module scope, which meant every one of the
 * eleven value importers of this module — `src/template/resolve.ts`,
 * `src/scheduler/policy.ts`, `src/scheduler/schedule.ts`, `src/generate/fields.ts`,
 * `src/generate/voice.ts`, `src/dashboard/metrics.ts` among them — threw at module
 * load in a browser worker, for a filesystem read none of them asked for. The DDL
 * text now lives in `./sources.ts`, which is Node-only by design; put anything
 * that touches I/O there. `test/schema.test.ts` pins the absence, so this cannot
 * regress quietly.
 */

import { renderPlainTextParts, stripInvisible } from "../text/index.js";

/**
 * Bumped only by a migration. `PRAGMA user_version` holds this.
 *
 * 9 adds `cards.local`, so a card CREATED in the app can be told apart from the
 * 7,716 imported ones. The backup carries only what `exports/` cannot rebuild and
 * therefore archived no cards at all — correct for every imported card and silent
 * data loss for one he wrote himself, which the app has been able to make since
 * 2026-08-26. Decision 9's rule for fields, applied to the card. The importer does
 * not write the column, so decision 16's final import leaves it alone.
 *
 * 8 adds `cards.pinned`'s partial index and the accent pipeline's last views.
 *
 * 7 adds `template_fields.local`, so a field that exists HERE and not in any
 * Mochi export survives a re-import. `pruneFieldValues` could not tell a field
 * Mochi DELETED from one Mochi NEVER HAD, and threw away all 3,454 materialised
 * `型` labels the first time it met one.
 *
 * 6 excludes adjudicated words from `accent_disagreements`. Without it the queue
 * never empties — OJAD backed our derivation on 11 words and the cross-check
 * still disagrees with all 11, so they reappeared as work forever. A work list
 * that cannot be finished stops being read.
 *
 * 5 makes `accent_resolved` name its analyser priority (manual, then the
 * primary `openjtalk`) instead of ordering by version across analysers — with
 * two analysers loaded, `version DESC` compared 'pyopenjtalk-plus/…' against
 * 'unidic/…' as strings, so the winner depended on where u sorts after p. Adds
 * `accent_disagreements`, the adjudication queue: a cross-check analyser is
 * stored but never resolves, because UniDic is measurably wrong on some of the
 * words it could otherwise answer (it reads 正義 as the name マサヨシ).
 *
 * 4 adds the `accents` table (derived 高低アクセント facts keyed by TEXT, not by
 * card), the `accent_resolved` and `card_voice_resolved` views, and `'accent'`
 * to `template_fields.type` — Zach's `<<型>>` field. Added now rather than
 * retrofitted because SPEC is explicit that retrofitted storage means a
 * migration over 7,716 cards.
 *
 * 3 adds `decks.voice` and `cards.voice` (NULL = inherit, resolving up the deck
 * tree and bottoming out at settings `voice.default`), seeds that setting EMPTY
 * so nothing changes until it is set, and adds `blobs.unreferenced_at` so a
 * sweep can hold a grace period instead of destroying the losing candidate of a
 * voice A/B the instant the winner is pointed at. Between them those three are
 * Mochi pain point #5 — the voice is set on the template, applies to every card,
 * and cannot be changed for one.
 *
 * 2 renames `reviews.interval_days` to the explicit `elapsed_days` /
 * `scheduled_days` pair, renames `next_interval_days` to
 * `next_scheduled_days`, renames `card_tracks.interval_days` to
 * `scheduled_days`, adds `cards.search_text`, and drops `reviews.grade`. There
 * is still no migration path — `applySchema` refuses a database at any other
 * version — which is correct here, because a version-1 file has columns that no
 * longer exist and every database in the project is rebuildable from
 * `exports/` in about fifteen seconds. Re-import rather than migrate.
 */
export const SCHEMA_VERSION = 9;

/**
 * Three-state, on both cards and decks. `inherit` resolves up the deck tree and
 * bottoms out at the workspace default (`off`); a card's explicit value beats
 * its deck. Mochi's two-state boolean cannot express a deliberate exception,
 * which is the whole reason for the third state.
 */
export const REVERSE_MODES = ["inherit", "on", "off"] as const;
export type ReverseMode = (typeof REVERSE_MODES)[number];

/** A node in the inheritance chain — a deck, reduced to what the rule reads. */
export interface ReverseInheritance {
  readonly id: string;
  readonly parentId: string | null;
  readonly reverse: ReverseMode;
}

/**
 * THE ONE DEFINITION of how `inherit` resolves up the deck tree.
 *
 * `views.sql` states the rule in SQL (`deck_reverse_resolved`: nearest ancestor by
 * depth whose `reverse <> 'inherit'`, then `settings`, then `off`) and says beside
 * the neighbouring voice view exactly why that should be the only one — *"so there
 * is one definition of the inheritance rather than a SQL one and a TypeScript one
 * that drift"*.
 *
 * IT HAD THREE, AND ONE OF THEM DISAGREED. `src/import/entities.ts` matched the
 * view. `src/import/reviews.ts` walked PAST an explicit `off` and kept looking for
 * an `on` above it, so a deck deliberately excepted under an enabled parent resolved
 * to `on` there and `off` everywhere else.
 *
 * That divergence is unreachable from a Mochi export today, and only by accident:
 * `mochiDeckReverse` maps a falsy `review-reverse?` to `inherit` rather than to
 * `off`, so an explicit `off` never exists in imported data. `decks.reverse` is a
 * real column with three states, and request 14's deck CRUD is what puts an `off`
 * in it — at which point two importers would have disagreed about which cards have
 * reverse tracks, and a track is what the scheduler schedules.
 *
 * So both callers now adapt their own shape to `ReverseInheritance` and call this.
 * `test/reverse-inheritance.test.ts` pins the result against the SQL view over the
 * real corpus, which is the only check that can catch the two drifting again.
 *
 * Cycle-safe: a deck that is its own ancestor stops rather than looping, and
 * resolves to `fallback`. Malformed exports have produced exactly that.
 */
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
    // The NEAREST explicit value wins, whichever way it points. Taking only `on`
    // here is the bug this function replaced.
    if (node.reverse !== "inherit") return node.reverse;
    id = node.parentId;
  }
  return fallback;
}

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
  // Zach's <<型>>: 平板 / 頭高 / 中高 / 尾高 beside the audio. His idea, and it
  // doubles as the error-detection mechanism for the whole accent pipeline,
  // because a wrong LABEL is visible where a wrong CONTOUR is silently absorbed.
  "accent",
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

/**
 * `template_fields.type` -> `blobs.kind`, for the field types that GENERATE
 * their content rather than store it.
 *
 * One definition, here, because three layers need it and a second copy is how
 * two of them come to disagree: `src/template/resolve.ts` needs it to know that
 * an empty value means "pending" rather than "blank", `src/generate/fields.ts`
 * needs it to build the request, and the importer's cache-bucket mapping is the
 * same table read the other way. `image-search` -> `image` is the only rename,
 * and it is Mochi's: the cache bucket is `image-search`, the blob kind is not.
 *
 * All 19 generator-typed fields in the reference corpus are one of these six.
 */
export const FIELD_TYPE_BLOB_KIND: Readonly<Record<string, BlobKind>> = {
  speech: "speech",
  ai: "ai",
  translate: "translate",
  furigana: "furigana",
  dictionary: "dictionary",
  "image-search": "image",
};

/** The `template_fields.type` values that generate. Keys of the table above. */
export const GENERATOR_FIELD_TYPES: ReadonlySet<string> = new Set(
  Object.keys(FIELD_TYPE_BLOB_KIND),
);

/** Provenance of a review row. Everything imported from Mochi is `mochi`. */
export const REVIEW_SOURCES = ["mochi", "local"] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

/** Keys seeded into `settings` by schema.sql. */
export const SETTING_KEYS = {
  reverseDefault: "reverse.default",
  targetRetentionDefault: "target_retention.default",
  voiceDefault: "voice.default",
  timezoneDefault: "timezone.default",
} as const;

// ---------------------------------------------------------------------------
// Grades are binary.
// ---------------------------------------------------------------------------

/**
 * Hashigo records `remembered` and nothing else. Anki's four-button
 * Again/Hard/Good/Easy was considered and rejected, so there is no `grade`
 * column in `reviews` and never will be — a column that is NULL on all 102,020
 * rows and on every future row advertises support that does not exist.
 *
 * The upside is worth stating rather than treating this as a data limitation:
 * the scheduler is fitted on exactly the signal it receives in production, so
 * there is no train/serve distribution shift.
 */
export const GRADES_ARE_BINARY = true as const;

/**
 * The only two FSRS ratings this application can ever produce. Schedulers take
 * a 1–4 rating; the binary signal maps onto Again and Good.
 */
export const BINARY_GRADE = { forgot: 1, remembered: 3 } as const;
export type BinaryGrade = (typeof BINARY_GRADE)[keyof typeof BINARY_GRADE];

/**
 * FSRS-6 weights that binary grading makes unreachable: `w[15]` is the Hard
 * penalty and `w[16]` the Easy bonus, and neither rating can occur. They must
 * be FROZEN at their defaults rather than fitted — an optimiser handed a
 * parameter no observation touches will wander to a clamp boundary and report a
 * number that means nothing. No published figure may depend on them.
 */
export const FROZEN_FSRS_WEIGHTS = [15, 16] as const;

/** `remembered` (0/1 or boolean) to its FSRS rating. The only mapping there is. */
export function gradeFor(remembered: boolean | 0 | 1): BinaryGrade {
  return remembered ? BINARY_GRADE.remembered : BINARY_GRADE.forgot;
}

// ---------------------------------------------------------------------------
// The two intervals.
// ---------------------------------------------------------------------------

/**
 * How a consumer says which interval it means. There is no third option and no
 * default: `reviews.interval_days` used to be one column that the importer
 * wrote as planned, the backtest read as elapsed and the dashboard bucketed as
 * planned, and every retention-versus-interval figure in the project moved
 * silently as a result.
 *
 *   `elapsed`   — MEASURED. `reviews.elapsed_days`, backfilled from the
 *                 timestamps themselves in `review_log_elapsed` (NOT in
 *                 `review_log`, which deliberately has no `elapsed_days` — the
 *                 window costs 187% and most aggregates never look at an
 *                 interval). Ground truth: what actually happened. Median 15d,
 *                 p75 74d, p90 210d, max 454d.
 *   `scheduled` — PLANNED. `reviews.scheduled_days`, what the scheduler asked
 *                 for that same gap, stored at review time and never
 *                 recomputed. Median 24.7d, p75 123d, p90 358d, max 2,707d.
 *
 * On the real corpus 22,226 reviews were taken more than 1.5 days late and 240
 * early, and the `> 365d` bucket holds 3,009 observations under `elapsed` and
 * zero under `scheduled`. Neither substitutes for the other; anything plotted
 * against an interval must name its basis.
 */
export const INTERVAL_BASES = ["elapsed", "scheduled"] as const;
export type IntervalBasis = (typeof INTERVAL_BASES)[number];

/** The view carrying `retention_by_*` for each basis. */
export const RETENTION_BY_INTERVAL_VIEW: Readonly<Record<IntervalBasis, string>> = {
  elapsed: "retention_by_elapsed_interval",
  scheduled: "retention_by_scheduled_interval",
};

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------

/**
 * FTS5 tokeniser. The default (unicode61) splits on whitespace and cannot index
 * Japanese; trigram indexes every 3-character window and so matches mid-string
 * CJK substrings. The cost is the floor below.
 */
export const FTS_TOKENIZER = "trigram";

/**
 * A trigram index physically cannot serve a query shorter than this, and two
 * characters is the commonest search unit in Japanese — 意味, 勉強, 漢字, 日本.
 * Measured on the corpus: `'意味'` LIKE 3 / MATCH 0, `'する'` LIKE 229 / MATCH 0,
 * `'ない'` LIKE 77 / MATCH 0. Below the floor, `searchPlan` scans instead.
 */
export const FTS_MIN_QUERY_CHARS = 3;

/**
 * The rendered, searchable form of one piece of authored text — `cards.search_text`.
 *
 * A THIN ALIAS FOR `renderPlainTextParts`, AND IT HAS TO STAY ONE. This
 * function used to carry its own copy of the link grammar and the invisible-
 * character list while `src/text/render.ts` carried the other, and the two had
 * already drifted apart on four of eight probed inputs before anyone noticed:
 *
 *   input             src/text (correct)  this copy (wrong)
 *   [[a|]]            [[a|]]              a
 *   [[]]              [[]]                ''
 *   [[|]]             [[|]]               ''
 *   [[display|]]tail  [[display|]]tail    displaytail
 *
 * Nothing in the corpus takes any of those shapes today, which is exactly why
 * the corpus-wide agreement test read green while the two definitions
 * disagreed. The symptom of that drift, once one of those shapes is typed, is a
 * card that renders one way and indexes another: visible but not findable.
 *
 * So the transform lives in ONE place — `src/text/render.ts` — which owns the
 * three link forms, the U+200E adjacency story, and the NFC-not-NFKC decision.
 * The name survives here because the schema's own comments reference it and
 * because `search_text` is a schema-level obligation on every write path, not
 * because there is a second implementation.
 *
 * THE STORED VALUE IS NEVER TOUCHED. `card_field_values.value` and
 * `cards.content` keep the marks and the link syntax verbatim; only
 * `cards.search_text` is cleaned. Rendering is a read-time projection.
 */
export function buildSearchText(...parts: readonly (string | null | undefined)[]): string {
  return renderPlainTextParts(parts);
}

/** Which path `searchPlan` chose. Both return the same columns. */
export type SearchMode = "fts" | "like";

export interface SearchPlan {
  readonly mode: SearchMode;
  readonly sql: string;
  readonly params: readonly (string | number)[];
  /** The query after normalisation, i.e. what was actually searched for. */
  readonly normalised: string;
}

/**
 * FTS path: a trigram phrase match, ranked. `card_search_index` supplies the
 * body so the two paths cannot disagree about what a card's text is.
 */
const SEARCH_FTS_SQL =
  "SELECT card_id, name, bm25(card_fts) AS score FROM card_fts" +
  " WHERE card_fts MATCH ? ORDER BY score LIMIT ?";

/**
 * Scan path, for 1–2 character queries. Over body, name AND tags: a name-only
 * scan misses all three `意味` hits, which are in bodies. 7,716 rows is a scan
 * of no consequence, and a leading wildcard could not use an index anyway.
 */
const SEARCH_LIKE_SQL =
  "SELECT card_id, name, 0.0 AS score FROM card_search_index" +
  " WHERE name LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'" +
  " ORDER BY card_id LIMIT ?";

/** Escape the LIKE metacharacters so a literal `%` or `_` matches itself. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Quote a query as a single FTS5 phrase, so operators in it are literal. */
export function ftsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Pick the search path for `query` and return SQL ready to prepare.
 *
 * This is the two-character path, and it is a schema-level guarantee rather
 * than a UI detail: the trigram index cannot serve a short query at all, so
 * without the scan the commonest search unit in Japanese returns nothing.
 * Callers should not branch on length themselves.
 */
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

// ---------------------------------------------------------------------------
// Object inventory.
// ---------------------------------------------------------------------------

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

export { moveWithin, positionKeys } from "./order.js";
