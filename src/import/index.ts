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
  readonly dir: string;
  readonly root: MochiRecord;
}

export interface ImportOptions extends MapOptions, PlanOptions {
  readonly blobs?: false | ImportBlobsOptions;
  readonly verify?: boolean;
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
  readonly fieldValuesRemoved: number;
  readonly emptyLeafDecksDropped: readonly string[];
  readonly searchTextWritten: number;
}

export interface ImportReport {
  readonly sources: readonly string[];
  readonly structure: StructureCounts;
  readonly reviews: ImportReviewsResult;
  readonly tags: ImportTagsResult;
  readonly links: ImportLinksResult;
  readonly blobs: BlobImportReport | null;
  readonly notes: MappingNotes;
  readonly integrity: readonly string[];
  readonly elapsedMs: number;
}

export function readSource(dir: string): ImportSource {
  return { dir, root: loadExport(dir) };
}

export function importExportDirs(
  db: Db,
  dirs: readonly string[],
  options: ImportOptions = {},
): ImportReport {
  options.onPhase?.("decode", dirs.map((dir) => basename(dir)).join(", "));
  return importExports(db, dirs.map(readSource), options);
}

export function importExports(
  db: Db,
  sources: readonly ImportSource[],
  options: ImportOptions = {},
): ImportReport {
  const started = Date.now();
  const phase = options.onPhase ?? ((): void => {});

  if (options.reverseDefault !== undefined) {
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

  const cards = sources.flatMap((source) =>
    walkCards(source.root).map((walked) => walked.card),
  );

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
  });
  phase(
    "reviews",
    `${reviews.reviews} reviews across ${reviews.tracks} tracks` +
      (reviews.tracksPreserved > 0
        ? ` · ${reviews.tracksPreserved} locally-graded track(s) LEFT ALONE`
        : ""),
  );

  const tags = importTags(db, cards as unknown as MochiTaggedCard[]);
  phase(
    "tags",
    `${tags.tags} tag paths, ${tags.cardTags} card tags` +
      (tags.cardTagsReplaced > tags.cardTags
        ? ` · ${tags.cardTagsReplaced - tags.cardTags} REMOVED in Mochi since the last import`
        : ""),
  );

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

const UPDATE_SEARCH_TEXT = `
UPDATE cards SET search_text = ? WHERE id = ? AND search_text IS NOT ?`;

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
