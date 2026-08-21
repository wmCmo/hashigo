/**
 * Stage 1 — the importer. One or more extracted `.mochi` exports into one
 * Hashigo database, in the only order the foreign keys accept, idempotently.
 *
 * The parts each own one slice of the export and are separately tested:
 * `transit.ts` (decode + deduped walk), `entities.ts` (decks, templates,
 * fields, cards, field values), `reviews.ts` (tracks + the review log),
 * `tags.ts`, `links.ts`, `blobs.ts`. This file is the only thing that knows the
 * order they have to run in, and the only thing that writes the structural
 * rows.
 *
 * DEPENDENCY ORDER, and why it is not the obvious one
 *
 *   templates -> template_fields -> decks -> cards -> card_field_values
 *             -> card_tracks/reviews -> tags -> card_tags -> card_links -> blobs
 *
 * Templates come before decks, not after, because `decks.default_template_id`
 * is a foreign key to `templates`. Within a template, fields must be inserted
 * sources-first: `template_fields` carries the self-referential foreign key
 * (template_id, source_field_id) -> (template_id, id), and 単語's `Speech`
 * really does precede its source in the export's field map. `mapExports`
 * already emits them topologically ordered; this file must not re-sort them.
 * Decks are emitted parents-before-children for the same reason.
 *
 * IDEMPOTENCE is not "no crash on the second run", it is "the second run
 * changes nothing". Every structural write is an upsert whose DO UPDATE carries
 * a WHERE that fires only when a column actually differs, so a re-import of an
 * unchanged export reports `unchanged` for every row and writes zero pages —
 * which also means `updated_at` does not drift on rows nobody edited. The
 * downstream modules are idempotent in their own ways: `reviews` keys on
 * `import_key` and does nothing on conflict, `tags` upserts and ORs the manual
 * flag, `links` replaces each card's rows wholesale, `blobs` is
 * content-addressed with a unique index on the reference scope.
 *
 * CONVERGENCE, one step beyond idempotence: re-importing an export in which a
 * field was *deleted* must not leave the old value behind. Field values are
 * therefore pruned to what the export currently holds, per imported card. The
 * links importer does the same thing by deleting each card's rows first.
 *
 * SEARCH TEXT is written here and nowhere else in the importer, in a pass after
 * both cards and field values are in place — it is derived from all of them at
 * once, so it cannot be written row by row. The transform itself is
 * `renderPlainTextParts` in src/text/, which is the single definition of it and
 * the same function the `@` picker and the reviewer will call; this file must
 * not grow its own copy of that logic.
 *
 * LINKS ARE EXTRACTED FROM THE RAW EXPORT, not from the rows just written, and
 * that matters because `entities.ts` discards stale pre-template `content`.
 * 889 of the 8,744 wiki-links live in exactly that discarded text. They are
 * KEPT — dropping them would lose 10% of the graph and leave 25 target cards
 * with no inbound edge at all, which is a bigger loss than the discard itself
 * and is not what was decided.
 *
 * The consequence is honest but needs saying: those 889 rows are no longer
 * derivable from the stored text. Anything that rebuilds `card_links` from
 * `cards.content` + `card_field_values` — the editor at stage 10, or a repair
 * task — will delete them unless it is told not to. If that is not what Zach
 * wants, the fix is to migrate the links (or the text) rather than to let a
 * rebuild quietly prune them. Asserted in test/roundtrip.test.ts so a change
 * here is deliberate.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 *   * Invent timestamps. Decks, templates and fields carry none in the export,
 *     so their `created_at`/`updated_at` come from the column defaults; cards
 *     carry both and keep them.
 *   * Assign review times. Every one of the 102,020 imported reviews is
 *     date-only and lands with `time_unknown = 1`. See `reviews.ts`.
 */

import { basename } from "node:path";

import { checkIntegrity, type Db } from "../db/index.js";
import { SETTING_KEYS } from "../schema/index.js";
import { renderPlainTextParts } from "../text/index.js";
import {
  type BlobImportReport,
  type ImportBlobsOptions,
  type MochiMediaCard,
  importBlobs,
} from "./blobs.js";
import {
  type CardFieldValueRow,
  type MapOptions,
  type MappedExport,
  type MappingNotes,
  mapExports,
} from "./entities.js";
import { type ImportLinksResult, type MochiLinkedCard, importLinks } from "./links.js";
import {
  type ImportReviewsResult,
  type MochiCard,
  type PlanOptions,
  importReviews,
} from "./reviews.js";
import { type ImportTagsResult, type MochiTaggedCard, importTags } from "./tags.js";
import { type MochiRecord, asText, loadExport, walkCards, walkDecks } from "./transit.js";

export interface ImportSource {
  /**
   * The extracted export directory. It is both where `data.json` was read from
   * and where the flat media files live, so `blobs.ts` needs it by name.
   */
  readonly dir: string;
  /** The decoded `data.json`. */
  readonly root: MochiRecord;
}

export interface ImportOptions extends MapOptions, PlanOptions {
  /**
   * Media and cached generations. `false` skips them entirely — useful when
   * only the review history is wanted, and the difference between a 3-second
   * import and hashing 657 MB. Default: import with `store: "path"`.
   */
  readonly blobs?: false | ImportBlobsOptions;
  /**
   * Run `PRAGMA integrity_check` and `foreign_key_check` at the end. Default
   * true: a foreign key violation after an import is a failed import, and it is
   * cheap to find out now rather than at stage 5.
   */
  readonly verify?: boolean;
  /** Called after each phase, for a CLI progress line. */
  readonly onPhase?: (phase: ImportPhase, detail: string) => void;
}

export type ImportPhase =
  | "decode"
  | "map"
  | "structure"
  | "reviews"
  | "tags"
  | "links"
  | "blobs"
  | "verify";

/** Insert / update / no-op counts for one upserted table. */
export interface WriteCounts {
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
}

export interface StructureCounts {
  readonly templates: WriteCounts;
  readonly templateFields: WriteCounts;
  readonly decks: WriteCounts;
  readonly cards: WriteCounts;
  readonly cardFieldValues: WriteCounts;
  /** Stale values pruned because the export no longer carries that field. */
  readonly fieldValuesRemoved: number;
  /**
   * Deck ids the export contains but the database does not — by default the six
   * empty leaf decks, and empty when `dropEmptyLeafDecks: false` asks to keep
   * them. Measured as the difference between the walk and the rows, so it
   * reports what was actually lost rather than what a rule says should have
   * been.
   */
  readonly emptyLeafDecksDropped: readonly string[];
  /**
   * Cards whose `search_text` this import wrote or changed. Zero on a re-import
   * of an unchanged export, like every other count here.
   */
  readonly searchTextWritten: number;
}

export interface ImportReport {
  /** Basenames of the imported export directories, in the order given. */
  readonly sources: readonly string[];
  readonly structure: StructureCounts;
  readonly reviews: ImportReviewsResult;
  readonly tags: ImportTagsResult;
  readonly links: ImportLinksResult;
  /** Null when `blobs: false`. */
  readonly blobs: BlobImportReport | null;
  readonly notes: MappingNotes;
  /** Empty when healthy. Non-empty is a failed import, not a warning. */
  readonly integrity: readonly string[];
  readonly elapsedMs: number;
}

/** Read and decode one extracted export directory. */
export function readSource(dir: string): ImportSource {
  return { dir, root: loadExport(dir) };
}

/**
 * Import every export directory in `dirs`. Convenience over `importExports`;
 * the split exists so the browser build, which has no `node:fs`, can decode
 * with `decodeExport` and call `importExports` directly.
 */
export function importExportDirs(
  db: Db,
  dirs: readonly string[],
  options: ImportOptions = {},
): ImportReport {
  options.onPhase?.("decode", dirs.map((dir) => basename(dir)).join(", "));
  return importExports(db, dirs.map(readSource), options);
}

/**
 * Import decoded exports into `db`. All of them at once rather than one at a
 * time, because cross-export identity is real: `oiaISYb2` (単語) is defined in
 * both 日本語 and 基本情報, and a wiki-link in one export can name a card in
 * another. Importing together is what makes the template a single row and the
 * link resolve.
 */
export function importExports(
  db: Db,
  sources: readonly ImportSource[],
  options: ImportOptions = {},
): ImportReport {
  const started = Date.now();
  const phase = options.onPhase ?? ((): void => {});

  if (options.reverseDefault !== undefined) {
    // views.sql resolves `inherit` against settings['reverse.default'], so the
    // mapper's fallback and the view's must be the same value or the database
    // disagrees with the rows just written into it.
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE settings.value IS NOT excluded.value`,
    ).run(SETTING_KEYS.reverseDefault, options.reverseDefault);
  }

  const roots = sources.map((source) => source.root);
  const mapped = mapExports(roots, options);
  phase(
    "map",
    `${mapped.decks.length} decks, ${mapped.templates.length} templates, ` +
      `${mapped.cards.length} cards, ${mapped.cardFieldValues.length} field values`,
  );

  // One walk, reused by every module below. Each takes the raw decoded card
  // record under a different structural type; they read disjoint keys.
  const cards = sources.flatMap((source) =>
    walkCards(source.root).map((walked) => walked.card),
  );

  // Which decks the mapper dropped, by difference rather than by recomputing
  // the rule: `mapExports` has already filtered its output, so re-running
  // `emptyLeafDeckIds` over the filtered list answers a different question and
  // (measured on 日本語) returns none of the six it actually removed.
  const walkedDeckIds = new Set(
    roots.flatMap((root) => walkDecks(root)).map((walked) => asText(walked.deck["id"])),
  );
  for (const deck of mapped.decks) walkedDeckIds.delete(deck.id);
  walkedDeckIds.delete("");

  const structure = writeStructure(db, mapped, [...walkedDeckIds].sort());
  phase(
    "structure",
    `cards ${describe(structure.cards)}, field values ${describe(structure.cardFieldValues)}`,
  );

  const reviews = importReviews(db, cards as unknown as MochiCard[], {
    ...(options.tzOffsetMinutes === undefined
      ? {}
      : { tzOffsetMinutes: options.tzOffsetMinutes }),
    ...(options.timeKnown === undefined ? {} : { timeKnown: options.timeKnown }),
    // No `decks`/`deckReverse`: the deck rows are already written, so
    // `deck_reverse_resolved` is read out of the database and the importer
    // cannot disagree with the view the app will use.
  });
  phase("reviews", `${reviews.reviews} reviews across ${reviews.tracks} tracks`);

  const tags = importTags(db, cards as unknown as MochiTaggedCard[]);
  phase("tags", `${tags.tags} tag paths, ${tags.cardTags} card tags`);

  const links = importLinks(db, cards as unknown as MochiLinkedCard[]);
  phase("links", `${links.links} wiki-links, ${links.unresolvedRows} unresolved`);

  let blobs: BlobImportReport | null = null;
  if (options.blobs !== false) {
    blobs = importBlobs(
      db,
      sources.map((source) => ({
        mediaDir: source.dir,
        cards: walkCards(source.root).map(
          (walked) => walked.card as unknown as MochiMediaCard,
        ),
      })),
      options.blobs ?? {},
    );
    phase(
      "blobs",
      `${blobs.liveAttachments} live attachments, ${blobs.tombstonesSkipped} tombstones skipped`,
    );
  }

  const integrity = options.verify === false ? [] : checkIntegrity(db);
  if (options.verify !== false) phase("verify", integrity.length === 0 ? "ok" : "PROBLEMS");

  return {
    sources: sources.map((source) => basename(source.dir)),
    structure,
    reviews,
    tags,
    links,
    blobs,
    notes: mapped.notes,
    integrity,
    elapsedMs: Date.now() - started,
  };
}

// ─── the structural half ─────────────────────────────────────────────────────

const UPSERT_TEMPLATE = `
INSERT INTO templates (id, name, content, reverse_permutation, pos)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name,
  content = excluded.content,
  reverse_permutation = excluded.reverse_permutation,
  pos = excluded.pos,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE templates.name                IS NOT excluded.name
    OR templates.content             IS NOT excluded.content
    OR templates.reverse_permutation IS NOT excluded.reverse_permutation
    OR templates.pos                 IS NOT excluded.pos`;

const UPSERT_TEMPLATE_FIELD = `
INSERT INTO template_fields (template_id, id, name, type, source_field_id, options, pos)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (template_id, id) DO UPDATE SET
  name = excluded.name,
  type = excluded.type,
  source_field_id = excluded.source_field_id,
  options = excluded.options,
  pos = excluded.pos,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE template_fields.name            IS NOT excluded.name
    OR template_fields.type            IS NOT excluded.type
    OR template_fields.source_field_id IS NOT excluded.source_field_id
    OR template_fields.options         IS NOT excluded.options
    OR template_fields.pos             IS NOT excluded.pos`;

const UPSERT_DECK = `
INSERT INTO decks (id, parent_id, name, reverse, target_retention,
                   default_template_id, archived, pos)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
  parent_id = excluded.parent_id,
  name = excluded.name,
  reverse = excluded.reverse,
  target_retention = excluded.target_retention,
  default_template_id = excluded.default_template_id,
  archived = excluded.archived,
  pos = excluded.pos,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE decks.parent_id           IS NOT excluded.parent_id
    OR decks.name                IS NOT excluded.name
    OR decks.reverse             IS NOT excluded.reverse
    OR decks.target_retention    IS NOT excluded.target_retention
    OR decks.default_template_id IS NOT excluded.default_template_id
    OR decks.archived            IS NOT excluded.archived
    OR decks.pos                 IS NOT excluded.pos`;

/**
 * `cards.seq` is the FTS docid and must survive a re-import, so the conflict
 * target is the unique `id`, never the primary key. `reverse` is written from
 * the mapper, which applies SPEC's do-not-orphan rule to the same six cards
 * `importReviews` would force — so the two agree and neither flip-flops the
 * column on alternate runs.
 */
const UPSERT_CARD = `
INSERT INTO cards (id, deck_id, template_id, name, content, reverse, pinned,
                   archived, needs_rereview, pos, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
  deck_id = excluded.deck_id,
  template_id = excluded.template_id,
  name = excluded.name,
  content = excluded.content,
  reverse = excluded.reverse,
  pinned = excluded.pinned,
  archived = excluded.archived,
  needs_rereview = excluded.needs_rereview,
  pos = excluded.pos,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at
 WHERE cards.deck_id        IS NOT excluded.deck_id
    OR cards.template_id    IS NOT excluded.template_id
    OR cards.name           IS NOT excluded.name
    OR cards.content        IS NOT excluded.content
    OR cards.reverse        IS NOT excluded.reverse
    OR cards.pinned         IS NOT excluded.pinned
    OR cards.archived       IS NOT excluded.archived
    OR cards.needs_rereview IS NOT excluded.needs_rereview
    OR cards.pos            IS NOT excluded.pos
    OR cards.created_at     IS NOT excluded.created_at
    OR cards.updated_at     IS NOT excluded.updated_at`;

const UPSERT_FIELD_VALUE = `
INSERT INTO card_field_values (card_id, field_id, value)
VALUES (?, ?, ?)
ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value
 WHERE card_field_values.value IS NOT excluded.value`;

/**
 * `search_text` is DERIVED, never authored, so it is written by its own
 * statement rather than as a column of UPSERT_CARD: it depends on the card's
 * field values, which are not written until after every card row exists.
 *
 * The guard is what keeps a re-import writing zero pages. It also matters more
 * here than elsewhere — `search_text` is in the `cards_fts_au` trigger's
 * UPDATE OF list, so an unguarded write would rebuild all 7,716 FTS rows on
 * every run. `IS NOT` rather than `<>` because NULL means "not maintained" and
 * has to compare as a real value.
 */
const UPDATE_SEARCH_TEXT = `
UPDATE cards SET search_text = ? WHERE id = ? AND search_text IS NOT ?`;

/**
 * Write decks, templates, fields, cards and field values in one transaction: a
 * half-written card tree is not a state this function can produce, and the FTS
 * triggers fire per row either way.
 */
function writeStructure(
  db: Db,
  mapped: MappedExport,
  decksDropped: readonly string[],
): StructureCounts {
  const upsertTemplate = db.prepare(UPSERT_TEMPLATE);
  const upsertField = db.prepare(UPSERT_TEMPLATE_FIELD);
  const upsertDeck = db.prepare(UPSERT_DECK);
  const upsertCard = db.prepare(UPSERT_CARD);
  const upsertValue = db.prepare(UPSERT_FIELD_VALUE);

  const templateExists = db.prepare("SELECT 1 FROM templates WHERE id = ?").pluck();
  const fieldExists = db
    .prepare("SELECT 1 FROM template_fields WHERE template_id = ? AND id = ?")
    .pluck();
  const deckExists = db.prepare("SELECT 1 FROM decks WHERE id = ?").pluck();
  const cardExists = db.prepare("SELECT 1 FROM cards WHERE id = ?").pluck();
  const valueExists = db
    .prepare("SELECT 1 FROM card_field_values WHERE card_id = ? AND field_id = ?")
    .pluck();

  const templates = counter();
  const templateFields = counter();
  const decks = counter();
  const cards = counter();
  const cardFieldValues = counter();
  let fieldValuesRemoved = 0;
  let searchTextWritten = 0;

  db.transaction(() => {
    for (const row of mapped.templates) {
      const existed = templateExists.get(row.id) === 1;
      const changes = upsertTemplate.run(
        row.id,
        row.name,
        row.content,
        row.reverse_permutation,
        row.pos,
      ).changes;
      templates.count(existed, changes);
    }

    // Emitted sources-first by `orderTemplateFields`; re-sorting here would
    // reintroduce the FOREIGN KEY failure it exists to prevent.
    for (const row of mapped.templateFields) {
      const existed = fieldExists.get(row.template_id, row.id) === 1;
      const changes = upsertField.run(
        row.template_id,
        row.id,
        row.name,
        row.type,
        row.source_field_id,
        row.options,
        row.pos,
      ).changes;
      templateFields.count(existed, changes);
    }

    // Parents before children, from `orderDecks`.
    for (const row of mapped.decks) {
      const existed = deckExists.get(row.id) === 1;
      const changes = upsertDeck.run(
        row.id,
        row.parent_id,
        row.name,
        row.reverse,
        row.target_retention,
        row.default_template_id,
        row.archived,
        row.pos,
      ).changes;
      decks.count(existed, changes);
    }

    for (const row of mapped.cards) {
      const existed = cardExists.get(row.id) === 1;
      const changes = upsertCard.run(
        row.id,
        row.deck_id,
        row.template_id,
        row.name,
        row.content,
        row.reverse,
        row.pinned,
        row.archived,
        row.needs_rereview,
        row.pos,
        row.created_at,
        row.updated_at,
      ).changes;
      cards.count(existed, changes);
    }

    for (const row of mapped.cardFieldValues) {
      const existed = valueExists.get(row.card_id, row.field_id) === 1;
      const changes = upsertValue.run(row.card_id, row.field_id, row.value).changes;
      cardFieldValues.count(existed, changes);
    }

    fieldValuesRemoved = pruneFieldValues(db, mapped.cardFieldValues);
    searchTextWritten = writeSearchText(db, mapped);
  })();

  return {
    templates: templates.result(),
    templateFields: templateFields.result(),
    decks: decks.result(),
    cards: cards.result(),
    cardFieldValues: cardFieldValues.result(),
    fieldValuesRemoved,
    emptyLeafDecksDropped: decksDropped,
    searchTextWritten,
  };
}

/**
 * Populate `cards.search_text` — the rendered, searchable form of everything
 * authored on a card.
 *
 * Runs last, and inside the same transaction, because it reads the whole card:
 * `content` plus every field value. Both are in `mapped`, so this needs no
 * query — the rows about to be in the database and the rows just written are
 * the same rows.
 *
 * The transform is NOT implemented here. `renderPlainTextParts` in src/text/ is
 * the single definition of it (wiki-link syntax reduced to its display text,
 * zero-width and bidi marks removed, NFC), and the reviewer and the `@` picker
 * call the same function. A second copy of that logic in the importer is how
 * the index and the query box drift apart — the symptom being a card you can
 * read but cannot find.
 *
 * NO `resolveName` IS PASSED, so a bare `[[card-id]]` contributes nothing to
 * the indexed body rather than contributing the target card's name. That is
 * deliberate: resolving would make one card's search text depend on another
 * card's name, so renaming a card would silently stale every search_text
 * pointing at it, and nothing in the schema or the editor owns that
 * invalidation. 54 links corpus-wide are affected and every one of them is on a
 * card with other text. Revisit when the editor exists to maintain it.
 *
 * Field values are concatenated in the export's own order, which is the order
 * `mapExports` emits them in. Order only affects where line breaks fall in the
 * indexed body, never which cards match.
 */
function writeSearchText(db: Db, mapped: MappedExport): number {
  const update = db.prepare(UPDATE_SEARCH_TEXT);

  const valuesByCard = new Map<string, string[]>();
  for (const row of mapped.cardFieldValues) {
    const list = valuesByCard.get(row.card_id);
    if (list === undefined) valuesByCard.set(row.card_id, [row.value]);
    else list.push(row.value);
  }

  let written = 0;
  for (const card of mapped.cards) {
    const text = renderPlainTextParts([card.content, ...(valuesByCard.get(card.id) ?? [])]);
    written += update.run(text, card.id, text).changes;
  }
  return written;
}

/**
 * Delete values for imported cards whose field the export no longer carries.
 *
 * Without this, re-importing an export in which a field was deleted leaves the
 * old value in the database and in the FTS body forever — the card would keep
 * matching text it no longer contains. Scoped to the cards in this import, so
 * it can never touch a card that came from an export not being re-read.
 *
 * LOCALLY DEFINED FIELDS ARE EXEMPT (`template_fields.local = 1`). A field Mochi
 * DELETED and a field Mochi NEVER HAD look identical from here — both are absent
 * from the export — and they want opposite treatment. Conflating them threw away
 * all 3,454 materialised `型` labels on the first re-import after that field
 * existed. Measured, not predicted; the importer printed the count.
 *
 * It matters because re-importing is not a one-off: Zach still reviews ~100
 * cards a day in Mochi, so every fresh export brings history worth having, and
 * anything that needs manual repair afterwards needs it forever.
 */
function pruneFieldValues(db: Db, values: readonly CardFieldValueRow[]): number {
  db.exec(
    `CREATE TEMP TABLE IF NOT EXISTS import_field_keys
       (card_id TEXT NOT NULL, field_id TEXT NOT NULL, PRIMARY KEY (card_id, field_id));
     DELETE FROM import_field_keys`,
  );
  const remember = db.prepare(
    "INSERT OR IGNORE INTO import_field_keys (card_id, field_id) VALUES (?, ?)",
  );
  for (const row of values) remember.run(row.card_id, row.field_id);

  const removed = db
    .prepare(
      `DELETE FROM card_field_values
        WHERE card_id IN (SELECT card_id FROM import_field_keys)
          AND NOT EXISTS (SELECT 1 FROM import_field_keys k
                           WHERE k.card_id = card_field_values.card_id
                             AND k.field_id = card_field_values.field_id)
          AND NOT EXISTS (SELECT 1 FROM template_fields f
                           WHERE f.id = card_field_values.field_id AND f.local = 1)`,
    )
    .run().changes;
  db.exec("DROP TABLE IF EXISTS import_field_keys");
  return removed;
}

interface Counter {
  count(existed: boolean, changes: number): void;
  result(): WriteCounts;
}

function counter(): Counter {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  return {
    count(existed, changes) {
      if (!existed) inserted += 1;
      else if (changes > 0) updated += 1;
      else unchanged += 1;
    },
    result: () => ({ inserted, updated, unchanged }),
  };
}

function describe(counts: WriteCounts): string {
  return `+${counts.inserted} ~${counts.updated} =${counts.unchanged}`;
}

// ─── the module's public surface ──────────────────────────────────────────────

export {
  type CardFieldValueRow,
  type CardRow,
  type DeckRow,
  type MapOptions,
  type MappedExport,
  type MappingNotes,
  type TemplateFieldRow,
  type TemplateRow,
  emptyLeafDeckIds,
  mapExports,
} from "./entities.js";
export { type BlobImportReport, type ImportBlobsOptions, importBlobs } from "./blobs.js";
export { type ImportLinksResult, importLinks, mapCardLinks, wikiLinks } from "./links.js";
export { type ImportReviewsResult, importReviews, planCardTracks } from "./reviews.js";
export { type ImportTagsResult, importTags, mapCardTags, normaliseTagPath } from "./tags.js";
export {
  type MochiRecord,
  cardText,
  decodeExport,
  loadExport,
  reviewTracks,
  walkCards,
  walkDecks,
} from "./transit.js";
