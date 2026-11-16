import type { SqliteHandle } from "../db/browser.js";
import { refreshSearchText } from "../generate/search-text.js";
import { refreshCardTags } from "../cards/tags.js";

export const ARCHIVE_VERSION = 1;

export interface TrackKey {
  readonly cardId: string;
  readonly kind: string;
}

export interface ArchivedReview extends TrackKey {
  readonly reviewedAt: string;
  readonly tzOffsetMinutes: number;
  readonly timeUnknown: 0 | 1;
  readonly remembered: 0 | 1;
  readonly elapsedDays: number | null;
  readonly scheduledDays: number | null;
  readonly nextScheduledDays: number | null;
  readonly dueAt: string | null;
  readonly durationMs: number | null;
  readonly rereview: 0 | 1;
  readonly source: string;
  readonly importKey: string | null;
}

export interface ArchivedTrackState extends TrackKey {
  readonly dueAt: string | null;
  readonly scheduledDays: number | null;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReviewedAt: string | null;
  readonly scheduler: string | null;
  readonly schedulerState: string | null;
}

export interface ArchivedField {
  readonly templateId: string;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly sourceFieldId: string | null;
  readonly options: string | null;
  readonly pos: string;
  readonly local?: boolean;
  readonly updatedAt?: string;
}

export interface ArchivedCard {
  readonly id: string;
  readonly deckId: string;
  readonly templateId: string | null;
  readonly name: string;
  readonly content: string;
  readonly reverse: string;
  readonly voice: string | null;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly tracks: readonly string[];
}

export interface ArchivedTemplate {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly updatedAt?: string;
}

export interface ArchivedFieldValue {
  readonly cardId: string;
  readonly fieldId: string;
  readonly value: string;
}

export interface ArchivedSetting {
  readonly key: string;
  readonly value: string;
}

export interface ArchivedCardState {
  readonly cardId: string;
  readonly archived: boolean;
  readonly pinned: boolean;
}

export interface LocalArchive {
  readonly archiveVersion: number;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly reviews: readonly ArchivedReview[];
  readonly trackState: readonly ArchivedTrackState[];
  readonly localFields: readonly ArchivedField[];
  readonly templates?: readonly ArchivedTemplate[];
  readonly localCards?: readonly ArchivedCard[];
  readonly fieldValues: readonly ArchivedFieldValue[];
  readonly settings: readonly ArchivedSetting[];
  readonly cardState?: readonly ArchivedCardState[];
  readonly counts: Readonly<Record<string, number>>;
}

export interface ApplyReport {
  readonly reviewsInserted: number;
  readonly reviewsSkipped: number;
  readonly reviewsOrphaned: number;
  readonly trackStateApplied: number;
  readonly trackStateOrphaned: number;
  readonly fieldsUpserted: number;
  readonly fieldsOrphaned: number;
  readonly fieldValuesUpserted: number;
  readonly fieldValuesOrphaned: number;
  readonly settingsUpserted: number;
  readonly localCardsInserted: number;
  readonly localCardsSkipped: number;
  readonly localCardsOrphaned: number;
  readonly templatesApplied: number;
  readonly templatesInserted: number;
  readonly templatesOrphaned: number;
  readonly cardStateApplied: number;
  readonly cardStateOrphaned: number;
  readonly noop: boolean;
}

const SELECT_REVIEWS = `
SELECT t.card_id AS card_id, t.kind AS kind, r.reviewed_at, r.tz_offset_minutes,
       r.time_unknown, r.remembered, r.elapsed_days, r.scheduled_days,
       r.next_scheduled_days, r.due_at, r.duration_ms, r.rereview, r.source,
       r.import_key
  FROM reviews r JOIN card_tracks t ON t.id = r.track_id
 WHERE r.source = 'local'
 ORDER BY t.card_id, t.kind, r.reviewed_at`;

const SELECT_TRACK_STATE = `
SELECT t.card_id AS card_id, t.kind AS kind, t.due_at, t.scheduled_days, t.reps,
       t.lapses, t.last_reviewed_at, t.scheduler, t.scheduler_state
  FROM card_tracks t
 WHERE t.scheduler_state IS NOT NULL
    OR EXISTS (SELECT 1 FROM reviews r WHERE r.track_id = t.id AND r.source = 'local')
 ORDER BY t.card_id, t.kind`;

const SELECT_FIELDS = `
SELECT template_id, id, name, type, source_field_id, options, pos, local, updated_at
  FROM template_fields ORDER BY template_id, pos, id`;

const SELECT_TEMPLATES = `SELECT id, name, content, updated_at FROM templates ORDER BY id`;

const SELECT_LOCAL_CARDS = `
SELECT id, deck_id, template_id, name, content, reverse, voice, archived, pinned
  FROM cards WHERE local = 1 ORDER BY id`;

const SELECT_LOCAL_TRACKS = `
SELECT t.card_id, t.kind
  FROM card_tracks t JOIN cards c ON c.id = t.card_id
 WHERE c.local = 1 ORDER BY t.card_id, t.kind`;

const SELECT_ALL_VALUES = `
SELECT v.card_id, v.field_id, v.value
  FROM card_field_values v
 ORDER BY v.card_id, v.field_id`;

const SELECT_SETTINGS = `SELECT key, value FROM settings ORDER BY key`;

const SELECT_CARD_STATE = `
SELECT id AS card_id, archived, pinned
  FROM cards WHERE archived = 1 OR pinned = 1
 ORDER BY id`;

function userVersion(db: SqliteHandle): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  return row?.user_version ?? 0;
}

export function archivedReview(r: Record<string, unknown>): ArchivedReview {
  return {
    cardId: String(r["card_id"]),
    kind: String(r["kind"]),
    reviewedAt: String(r["reviewed_at"]),
    tzOffsetMinutes: Number(r["tz_offset_minutes"]),
    timeUnknown: r["time_unknown"] === 1 ? 1 : 0,
    remembered: r["remembered"] === 1 ? 1 : 0,
    elapsedDays: r["elapsed_days"] === null ? null : Number(r["elapsed_days"]),
    scheduledDays: r["scheduled_days"] === null ? null : Number(r["scheduled_days"]),
    nextScheduledDays:
      r["next_scheduled_days"] === null ? null : Number(r["next_scheduled_days"]),
    dueAt: r["due_at"] === null ? null : String(r["due_at"]),
    durationMs: r["duration_ms"] === null ? null : Number(r["duration_ms"]),
    rereview: r["rereview"] === 1 ? 1 : 0,
    source: String(r["source"]),
    importKey: r["import_key"] === null ? null : String(r["import_key"]),
  };
}

export function archivedTrackState(r: Record<string, unknown>): ArchivedTrackState {
  return {
    cardId: String(r["card_id"]),
    kind: String(r["kind"]),
    dueAt: r["due_at"] === null ? null : String(r["due_at"]),
    scheduledDays: r["scheduled_days"] === null ? null : Number(r["scheduled_days"]),
    reps: Number(r["reps"]),
    lapses: Number(r["lapses"]),
    lastReviewedAt: r["last_reviewed_at"] === null ? null : String(r["last_reviewed_at"]),
    scheduler: r["scheduler"] === null ? null : String(r["scheduler"]),
    schedulerState: r["scheduler_state"] === null ? null : String(r["scheduler_state"]),
  };
}

export function exportLocalArchive(db: SqliteHandle, now: string): LocalArchive {
  const reviews = (db.prepare(SELECT_REVIEWS).all() as Record<string, unknown>[]).map(
    archivedReview,
  );

  const trackState = (db.prepare(SELECT_TRACK_STATE).all() as Record<string, unknown>[]).map(
    archivedTrackState,
  );

  const localFields = (db.prepare(SELECT_FIELDS).all() as Record<string, unknown>[]).map(
    (r): ArchivedField => ({
      templateId: String(r["template_id"]),
      id: String(r["id"]),
      name: String(r["name"]),
      type: String(r["type"]),
      sourceFieldId: r["source_field_id"] === null ? null : String(r["source_field_id"]),
      options: r["options"] === null ? null : String(r["options"]),
      pos: String(r["pos"]),
      local: Number(r["local"]) === 1,
      ...(r["updated_at"] === null || r["updated_at"] === undefined
        ? {}
        : { updatedAt: String(r["updated_at"]) }),
    }),
  );

  const tracksByCard = new Map<string, string[]>();
  for (const row of db.prepare(SELECT_LOCAL_TRACKS).all() as Record<string, unknown>[]) {
    const id = String(row["card_id"]);
    const list = tracksByCard.get(id) ?? [];
    list.push(String(row["kind"]));
    tracksByCard.set(id, list);
  }
  const localCards = (db.prepare(SELECT_LOCAL_CARDS).all() as Record<string, unknown>[]).map(
    (r): ArchivedCard => ({
      id: String(r["id"]),
      deckId: String(r["deck_id"]),
      templateId: r["template_id"] === null ? null : String(r["template_id"]),
      name: String(r["name"]),
      content: String(r["content"]),
      reverse: String(r["reverse"]),
      voice: r["voice"] === null ? null : String(r["voice"]),
      archived: Number(r["archived"]) === 1,
      pinned: Number(r["pinned"]) === 1,
      tracks: tracksByCard.get(String(r["id"])) ?? [],
    }),
  );

  const templates = (db.prepare(SELECT_TEMPLATES).all() as Record<string, unknown>[]).map(
    (r): ArchivedTemplate => ({
      id: String(r["id"]),
      name: String(r["name"]),
      content: String(r["content"]),
      ...(r["updated_at"] === null || r["updated_at"] === undefined
        ? {}
        : { updatedAt: String(r["updated_at"]) }),
    }),
  );

  const fieldValues = (db.prepare(SELECT_ALL_VALUES).all() as Record<string, unknown>[])
    .map(
      (r): ArchivedFieldValue => ({
        cardId: String(r["card_id"]),
        fieldId: String(r["field_id"]),
        value: String(r["value"]),
      }),
    )
    .sort((a, b) =>
      a.cardId === b.cardId ? a.fieldId.localeCompare(b.fieldId) : a.cardId.localeCompare(b.cardId),
    );

  const settings = (db.prepare(SELECT_SETTINGS).all() as Record<string, unknown>[]).map(
    (r): ArchivedSetting => ({ key: String(r["key"]), value: String(r["value"]) }),
  );

  const cardState = (db.prepare(SELECT_CARD_STATE).all() as Record<string, unknown>[]).map(
    (r): ArchivedCardState => ({
      cardId: String(r["card_id"]),
      archived: Number(r["archived"]) === 1,
      pinned: Number(r["pinned"]) === 1,
    }),
  );

  return {
    archiveVersion: ARCHIVE_VERSION,
    schemaVersion: userVersion(db),
    createdAt: now,
    reviews,
    trackState,
    localFields,
    localCards,
    templates,
    fieldValues,
    settings,
    cardState,
    counts: {
      reviews: reviews.length,
      trackState: trackState.length,
      localFields: localFields.length,
      localCards: localCards.length,
      templates: templates.length,
      fieldValues: fieldValues.length,
      settings: settings.length,
      cardState: cardState.length,
    },
  };
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

export function verifyLocalArchive(archive: LocalArchive): void {
  if (archive.archiveVersion !== ARCHIVE_VERSION) {
    throw new ArchiveError(
      `archive version ${archive.archiveVersion}, this build reads ${ARCHIVE_VERSION}`,
    );
  }
  const actual: Record<string, number> = {
    reviews: archive.reviews.length,
    trackState: archive.trackState.length,
    localFields: archive.localFields.length,
    localCards: (archive.localCards ?? []).length,
    templates: (archive.templates ?? []).length,
    fieldValues: archive.fieldValues.length,
    settings: archive.settings.length,
    cardState: (archive.cardState ?? []).length,
  };
  for (const [name, expected] of Object.entries(archive.counts)) {
    if (actual[name] !== expected) {
      throw new ArchiveError(
        `archive says ${expected} ${name} but carries ${actual[name] ?? 0} — truncated or edited`,
      );
    }
  }
}

const TRACK_ID = `SELECT id FROM card_tracks WHERE card_id = ? AND kind = ?`;

const CARD_EXISTS = `SELECT 1 FROM cards WHERE id = ? LIMIT 1`;
const TEMPLATE_EXISTS = `SELECT 1 FROM templates WHERE id = ? LIMIT 1`;

const HAS_REVIEW = `
SELECT 1 FROM reviews WHERE track_id = ? AND reviewed_at = ? AND source = ? LIMIT 1`;

const INSERT_REVIEW = `
INSERT INTO reviews
  (track_id, reviewed_at, tz_offset_minutes, time_unknown, remembered, elapsed_days,
   scheduled_days, next_scheduled_days, due_at, duration_ms, rereview, source, import_key)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPDATE_TRACK = `
UPDATE card_tracks
   SET due_at = ?, scheduled_days = ?, reps = ?, lapses = ?, last_reviewed_at = ?,
       scheduler = ?, scheduler_state = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = ?`;

const UPSERT_FIELD = `
INSERT INTO template_fields
  (template_id, id, name, type, source_field_id, options, pos, local, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
ON CONFLICT (template_id, id) DO UPDATE SET
  name = excluded.name, type = excluded.type,
  source_field_id = excluded.source_field_id, options = excluded.options,
  pos = excluded.pos, local = excluded.local,
  updated_at = excluded.updated_at`;

const DECK_EXISTS = `SELECT 1 FROM decks WHERE id = ? LIMIT 1`;

const INSERT_LOCAL_CARD = `
INSERT OR IGNORE INTO cards
  (id, deck_id, template_id, name, content, reverse, voice, archived, pinned, local)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`;

const INSERT_LOCAL_TRACK = `
INSERT OR IGNORE INTO card_tracks
  (card_id, kind, dormant, needs_rereview, due_at, scheduled_days, reps, lapses,
   last_reviewed_at, scheduler, scheduler_state)
VALUES (?, ?, 0, 0, NULL, NULL, 0, 0, NULL, NULL, NULL)`;

const UPDATE_TEMPLATE = `
UPDATE templates
   SET name = ?, content = ?,
       updated_at = COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
 WHERE id = ?`;

const INSERT_TEMPLATE = `
INSERT INTO templates (id, name, content, updated_at)
VALUES (?, ?, '', COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`;

const UPSERT_VALUE = `
INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?)
ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value
  WHERE card_field_values.value IS NOT excluded.value`;

const UPSERT_SETTING = `
INSERT INTO settings (key, value) VALUES (?, ?)
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

const UPDATE_CARD_STATE = `
UPDATE cards
   SET archived = max(archived, ?), pinned = max(pinned, ?),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = ?`;

export function applyLocalArchive(db: SqliteHandle, archive: LocalArchive): ApplyReport {
  verifyLocalArchive(archive);

  const trackId = db.prepare(TRACK_ID);
  const resolve = (key: TrackKey): number | null => {
    const row = trackId.get(key.cardId, key.kind) as { id?: number } | undefined;
    return row?.id ?? null;
  };

  const cardExists = db.prepare(CARD_EXISTS);
  const templateExists = db.prepare(TEMPLATE_EXISTS);

  let templatesInserted = 0;
  const insertTemplate = db.prepare(INSERT_TEMPLATE);
  for (const t of archive.templates ?? []) {
    if (templateExists.get(t.id) !== undefined) continue;
    insertTemplate.run(t.id, t.name, t.updatedAt ?? null);
    templatesInserted += 1;
  }

  let fieldsUpserted = 0;
  let fieldsOrphaned = 0;
  const upsertField = db.prepare(UPSERT_FIELD);
  for (const f of archive.localFields) {
    if (templateExists.get(f.templateId) === undefined) {
      fieldsOrphaned += 1;
      continue;
    }
    upsertField.run(
      f.templateId,
      f.id,
      f.name,
      f.type,
      f.sourceFieldId,
      f.options,
      f.pos,
      (f.local ?? true) ? 1 : 0,
      f.updatedAt ?? null,
    );
    fieldsUpserted += 1;
  }

  let templatesApplied = 0;
  let templatesOrphaned = 0;
  const updateTemplate = db.prepare(UPDATE_TEMPLATE);
  for (const t of archive.templates ?? []) {
    if (templateExists.get(t.id) === undefined) {
      templatesOrphaned += 1;
      continue;
    }
    updateTemplate.run(t.name, t.content, t.updatedAt ?? null, t.id);
    templatesApplied += 1;
  }

  let localCardsInserted = 0;
  let localCardsSkipped = 0;
  let localCardsOrphaned = 0;
  const deckExists = db.prepare(DECK_EXISTS);
  const insertCard = db.prepare(INSERT_LOCAL_CARD);
  const insertTrack = db.prepare(INSERT_LOCAL_TRACK);
  for (const card of archive.localCards ?? []) {
    if (deckExists.get(card.deckId) === undefined) {
      localCardsOrphaned += 1;
      continue;
    }
    const existed = cardExists.get(card.id) !== undefined;
    insertCard.run(
      card.id,
      card.deckId,
      card.templateId,
      card.name,
      card.content,
      card.reverse,
      card.voice,
      card.archived ? 1 : 0,
      card.pinned ? 1 : 0,
    );
    if (existed) localCardsSkipped += 1;
    else localCardsInserted += 1;
    for (const kind of card.tracks) insertTrack.run(card.id, kind);
  }

  let fieldValuesUpserted = 0;
  let fieldValuesOrphaned = 0;
  const upsertValue = db.prepare(UPSERT_VALUE);
  const retextCards = new Set<string>();
  for (const v of archive.fieldValues) {
    if (cardExists.get(v.cardId) === undefined) {
      fieldValuesOrphaned += 1;
      continue;
    }
    const result = upsertValue.run(v.cardId, v.fieldId, v.value) as { changes?: number };
    fieldValuesUpserted += 1;
    if (Number(result.changes ?? 0) > 0) retextCards.add(v.cardId);
  }
  refreshSearchText(db, retextCards);
  refreshCardTags(db, retextCards);

  let reviewsInserted = 0;
  let reviewsSkipped = 0;
  let reviewsOrphaned = 0;
  const hasReview = db.prepare(HAS_REVIEW);
  const insertReview = db.prepare(INSERT_REVIEW);
  for (const r of archive.reviews) {
    const id = resolve(r);
    if (id === null) {
      reviewsOrphaned += 1;
      continue;
    }
    if (hasReview.get(id, r.reviewedAt, r.source) !== undefined) {
      reviewsSkipped += 1;
      continue;
    }
    insertReview.run(
      id,
      r.reviewedAt,
      r.tzOffsetMinutes,
      r.timeUnknown,
      r.remembered,
      r.elapsedDays,
      r.scheduledDays,
      r.nextScheduledDays,
      r.dueAt,
      r.durationMs,
      r.rereview,
      r.source,
      r.importKey,
    );
    reviewsInserted += 1;
  }

  let trackStateApplied = 0;
  let trackStateOrphaned = 0;
  const updateTrack = db.prepare(UPDATE_TRACK);
  for (const t of archive.trackState) {
    const id = resolve(t);
    if (id === null) {
      trackStateOrphaned += 1;
      continue;
    }
    updateTrack.run(
      t.dueAt,
      t.scheduledDays,
      t.reps,
      t.lapses,
      t.lastReviewedAt,
      t.scheduler,
      t.schedulerState,
      id,
    );
    trackStateApplied += 1;
  }

  let settingsUpserted = 0;
  const upsertSetting = db.prepare(UPSERT_SETTING);
  for (const s of archive.settings) {
    upsertSetting.run(s.key, s.value);
    settingsUpserted += 1;
  }

  let cardStateApplied = 0;
  let cardStateOrphaned = 0;
  const updateCardState = db.prepare(UPDATE_CARD_STATE);
  for (const c of archive.cardState ?? []) {
    if (cardExists.get(c.cardId) === undefined) {
      cardStateOrphaned += 1;
      continue;
    }
    updateCardState.run(c.archived ? 1 : 0, c.pinned ? 1 : 0, c.cardId);
    cardStateApplied += 1;
  }

  return {
    reviewsInserted,
    reviewsSkipped,
    reviewsOrphaned,
    trackStateApplied,
    trackStateOrphaned,
    fieldsUpserted,
    fieldsOrphaned,
    fieldValuesUpserted,
    fieldValuesOrphaned,
    settingsUpserted,
    localCardsInserted,
    localCardsSkipped,
    localCardsOrphaned,
    templatesApplied,
    templatesInserted,
    templatesOrphaned,
    cardStateApplied,
    cardStateOrphaned,
    noop: reviewsInserted === 0,
  };
}
