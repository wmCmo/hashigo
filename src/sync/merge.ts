import {
  applyLocalArchive,
  exportLocalArchive,
  type ApplyReport,
  type LocalArchive,
} from "../backup/index.js";
import type { SqliteHandle } from "../db/browser.js";
import { retiredHashes, writeRetired } from "../blobs/retire.js";

export const SYNC_VERSION = 3;

export const OLDEST_SYNC_VERSION = 1;

export interface CardFlags {
  readonly cardId: string;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly updatedAt: string;
  readonly voice?: string;
  readonly templateId?: string;
}

export interface DeckFlags {
  readonly deckId: string;
  readonly archived: boolean;
  readonly updatedAt: string;
  readonly voice?: string;
}

export interface SyncPayload {
  readonly syncVersion: number;
  readonly archive: LocalArchive;
  readonly cardFlags: readonly CardFlags[];
  readonly deckFlags?: readonly DeckFlags[];
  readonly voicesCarried?: true;
  readonly templatesCarried?: true;
  readonly retiredClips?: readonly string[];
}

export interface MergeReport {
  readonly applied: ApplyReport;
  readonly trackStateTaken: number;
  readonly trackStateKept: number;
  readonly flagsTaken: number;
  readonly flagsKept: number;
  readonly templatesTaken: number;
  readonly templatesKept: number;
  readonly fieldsTaken: number;
  readonly fieldsKept: number;
  readonly valuesKept: number;
  readonly flagsOrphaned: number;
  readonly deckFlagsTaken: number;
  readonly clipsRetired: number;
  readonly cardTemplatesTaken: number;
}

const SELECT_CARD_FLAGS = `
SELECT id AS card_id, archived, pinned, updated_at, voice, template_id
  FROM cards
 ORDER BY id`;

const SET_CARD_TEMPLATE = `UPDATE cards SET template_id = ? WHERE id = ?`;
const TEMPLATE_EXISTS = `SELECT 1 FROM templates WHERE id = ?`;

const SELECT_TEMPLATE_CLOCKS = `
SELECT id, name, content, updated_at
  FROM templates
 ORDER BY id`;

const RESTORE_TEMPLATE = `
UPDATE templates
   SET name = ?, content = ?, updated_at = ?
 WHERE id = ?`;

const SELECT_FIELD_ROWS = `
SELECT template_id, id, name, type, source_field_id, options, pos, local, updated_at
  FROM template_fields`;

const RESTORE_FIELD = `
UPDATE template_fields
   SET name = ?, type = ?, source_field_id = ?, options = ?, pos = ?, local = ?,
       updated_at = ?
 WHERE template_id = ? AND id = ?`;

const SET_FIELD_CLOCK = `
UPDATE template_fields SET updated_at = ? WHERE template_id = ? AND id = ?`;

interface LocalField {
  readonly name: string;
  readonly type: string;
  readonly sourceFieldId: string | null;
  readonly options: string;
  readonly pos: string;
  readonly local: number;
  readonly updatedAt: string | null;
}

const fieldKey = (templateId: string, id: string): string => `${templateId}\u0000${id}`;

const SELECT_TRACK_CLOCKS = `
SELECT t.card_id AS card_id, t.kind AS kind, t.last_reviewed_at AS last_reviewed_at,
       t.due_at, t.scheduled_days, t.reps, t.lapses, t.scheduler, t.scheduler_state
  FROM card_tracks t`;

const RESTORE_TRACK_STATE = `
UPDATE card_tracks
   SET due_at = ?, scheduled_days = ?, reps = ?, lapses = ?, last_reviewed_at = ?,
       scheduler = ?, scheduler_state = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE card_id = ? AND kind = ?`;

const SET_CARD_FLAGS = `
UPDATE cards
   SET archived = ?, pinned = ?, updated_at = ?
 WHERE id = ?`;

const SET_CARD_FLAGS_AND_VOICE = `
UPDATE cards
   SET archived = ?, pinned = ?, voice = ?, updated_at = ?
 WHERE id = ?`;

const CARD_EXISTS = `SELECT 1 FROM cards WHERE id = ? LIMIT 1`;

const SELECT_DECK_FLAGS = `
SELECT id AS deck_id, archived, updated_at, voice FROM decks ORDER BY id`;

const SET_DECK_FLAGS = `
UPDATE decks SET archived = ?, updated_at = ? WHERE id = ?`;

const SET_DECK_FLAGS_AND_VOICE = `
UPDATE decks SET archived = ?, voice = ?, updated_at = ? WHERE id = ?`;

function voiceOf(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

interface LocalTrack {
  readonly lastReviewedAt: string | null;
  readonly dueAt: string | null;
  readonly scheduledDays: number | null;
  readonly reps: number;
  readonly lapses: number;
  readonly scheduler: string | null;
  readonly schedulerState: string | null;
}

const trackKey = (cardId: string, kind: string): string => `${cardId}\u0000${kind}`;

function isNewer(a: string | null, b: string | null): boolean {
  if (a === null) return false;
  if (b === null) return true;
  return a > b;
}

function remoteClock(clocks: ReadonlyMap<string, string>, cardId: string): string | null {
  return clocks.get(cardId) ?? null;
}

const SELECT_VALUE = `
SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?`;

const RESTORE_VALUE = `
UPDATE card_field_values SET value = ? WHERE card_id = ? AND field_id = ?`;

export function exportSync(db: SqliteHandle, createdAt: string): SyncPayload {
  const cardFlags = (db.prepare(SELECT_CARD_FLAGS).all() as Record<string, unknown>[]).map(
    (r): CardFlags => ({
      cardId: String(r["card_id"]),
      archived: Number(r["archived"]) === 1,
      pinned: Number(r["pinned"]) === 1,
      updatedAt: String(r["updated_at"]),
      ...(voiceOf(r["voice"]) === undefined ? {} : { voice: voiceOf(r["voice"]) as string }),
      ...(r["template_id"] === null || r["template_id"] === undefined
        ? {}
        : { templateId: String(r["template_id"]) }),
    }),
  );
  const deckFlags = (db.prepare(SELECT_DECK_FLAGS).all() as Record<string, unknown>[]).map(
    (r): DeckFlags => ({
      deckId: String(r['deck_id']),
      archived: Number(r['archived']) === 1,
      updatedAt: String(r['updated_at']),
      ...(voiceOf(r["voice"]) === undefined ? {} : { voice: voiceOf(r["voice"]) as string }),
    }),
  );
  return {
    syncVersion: SYNC_VERSION,
    archive: exportLocalArchive(db, createdAt),
    cardFlags,
    deckFlags,
    voicesCarried: true,
    templatesCarried: true,
    retiredClips: retiredHashes(db),
  };
}

export function mergeSync(db: SqliteHandle, remote: SyncPayload): MergeReport {
  if (
    typeof remote.syncVersion !== "number" ||
    remote.syncVersion > SYNC_VERSION ||
    remote.syncVersion < OLDEST_SYNC_VERSION
  ) {
    throw new Error(
      `sync payload is version ${remote.syncVersion}; this device speaks ${SYNC_VERSION}. ` +
        `Update both devices rather than merging across versions.`,
    );
  }

  const localTracks = new Map<string, LocalTrack>();
  for (const r of db.prepare(SELECT_TRACK_CLOCKS).all() as Record<string, unknown>[]) {
    localTracks.set(trackKey(String(r["card_id"]), String(r["kind"])), {
      lastReviewedAt: r["last_reviewed_at"] === null ? null : String(r["last_reviewed_at"]),
      dueAt: r["due_at"] === null ? null : String(r["due_at"]),
      scheduledDays: r["scheduled_days"] === null ? null : Number(r["scheduled_days"]),
      reps: Number(r["reps"]),
      lapses: Number(r["lapses"]),
      scheduler: r["scheduler"] === null ? null : String(r["scheduler"]),
      schedulerState: r["scheduler_state"] === null ? null : String(r["scheduler_state"]),
    });
  }
  const localTemplates = new Map<
    string,
    { name: string; content: string; updatedAt: string | null }
  >();
  for (const r of db.prepare(SELECT_TEMPLATE_CLOCKS).all() as Record<string, unknown>[]) {
    localTemplates.set(String(r["id"]), {
      name: String(r["name"]),
      content: String(r["content"]),
      updatedAt: r["updated_at"] === null ? null : String(r["updated_at"]),
    });
  }

  const localFields = new Map<string, LocalField>();
  for (const r of db.prepare(SELECT_FIELD_ROWS).all() as Record<string, unknown>[]) {
    localFields.set(fieldKey(String(r["template_id"]), String(r["id"])), {
      name: String(r["name"]),
      type: String(r["type"]),
      sourceFieldId: r["source_field_id"] === null ? null : String(r["source_field_id"]),
      options: r["options"] === null ? "{}" : String(r["options"]),
      pos: String(r["pos"]),
      local: Number(r["local"]),
      updatedAt: r["updated_at"] === null ? null : String(r["updated_at"]),
    });
  }

  const localRetired = retiredHashes(db);

  const localFlags = new Map<string, string>();
  const localTemplate = new Map<string, string | null>();
  const localCardState = new Map<string, { archived: number; pinned: number; updatedAt: string }>();
  for (const r of db.prepare(SELECT_CARD_FLAGS).all() as Record<string, unknown>[]) {
    localFlags.set(String(r["card_id"]), String(r["updated_at"]));
    localTemplate.set(String(r["card_id"]), r["template_id"] === null ? null : String(r["template_id"]));
    localCardState.set(String(r["card_id"]), {
      archived: Number(r["archived"]),
      pinned: Number(r["pinned"]),
      updatedAt: String(r["updated_at"]),
    });
  }

  const remoteCardClock = new Map(remote.cardFlags.map((f) => [f.cardId, f.updatedAt]));
  const heldValue = db.prepare(SELECT_VALUE);
  const keptValues: { cardId: string; fieldId: string; value: string }[] = [];
  for (const incoming of remote.archive.fieldValues) {
    const localClock = localFlags.get(incoming.cardId);
    if (localClock === undefined) continue;
    if (isNewer(remoteClock(remoteCardClock, incoming.cardId), localClock)) continue;
    const held = heldValue.get(incoming.cardId, incoming.fieldId) as { value: string } | undefined;
    if (held === undefined || held.value === incoming.value) continue;
    keptValues.push({ cardId: incoming.cardId, fieldId: incoming.fieldId, value: held.value });
  }

  const applied = applyLocalArchive(db, remote.archive);

  const restoreValue = db.prepare(RESTORE_VALUE);
  for (const kept of keptValues) restoreValue.run(kept.value, kept.cardId, kept.fieldId);
  const valuesKept = keptValues.length;

  let templatesTaken = 0;
  let templatesKept = 0;
  const restoreTemplate = db.prepare(RESTORE_TEMPLATE);
  for (const incoming of remote.archive.templates ?? []) {
    const local = localTemplates.get(incoming.id);
    if (local === undefined) continue;
    if (incoming.updatedAt !== undefined && isNewer(incoming.updatedAt, local.updatedAt)) {
      restoreTemplate.run(incoming.name, incoming.content, incoming.updatedAt, incoming.id);
      templatesTaken += 1;
      continue;
    }
    restoreTemplate.run(local.name, local.content, local.updatedAt, incoming.id);
    templatesKept += 1;
  }

  let fieldsTaken = 0;
  let fieldsKept = 0;
  const restoreField = db.prepare(RESTORE_FIELD);
  const setFieldClock = db.prepare(SET_FIELD_CLOCK);
  for (const incoming of remote.archive.localFields) {
    const local = localFields.get(fieldKey(incoming.templateId, incoming.id));
    if (local === undefined) continue;
    if (incoming.updatedAt !== undefined && isNewer(incoming.updatedAt, local.updatedAt)) {
      setFieldClock.run(incoming.updatedAt, incoming.templateId, incoming.id);
      fieldsTaken += 1;
      continue;
    }
    restoreField.run(
      local.name,
      local.type,
      local.sourceFieldId,
      local.options,
      local.pos,
      local.local,
      local.updatedAt,
      incoming.templateId,
      incoming.id,
    );
    fieldsKept += 1;
  }

  let trackStateTaken = 0;
  let trackStateKept = 0;
  const restore = db.prepare(RESTORE_TRACK_STATE);
  for (const incoming of remote.archive.trackState) {
    const local = localTracks.get(trackKey(incoming.cardId, incoming.kind));
    if (local === undefined) continue;
    if (isNewer(incoming.lastReviewedAt, local.lastReviewedAt)) {
      trackStateTaken += 1;
      continue;
    }
    restore.run(
      local.dueAt,
      local.scheduledDays,
      local.reps,
      local.lapses,
      local.lastReviewedAt,
      local.scheduler,
      local.schedulerState,
      incoming.cardId,
      incoming.kind,
    );
    trackStateKept += 1;
  }

  let flagsTaken = 0;
  let flagsKept = 0;
  let flagsOrphaned = 0;
  const exists = db.prepare(CARD_EXISTS);
  const setFlags = db.prepare(SET_CARD_FLAGS);
  const setFlagsAndVoice = db.prepare(SET_CARD_FLAGS_AND_VOICE);
  const restoreCardState = db.prepare(SET_CARD_FLAGS);
  for (const incoming of remote.cardFlags) {
    const localClock = localFlags.get(incoming.cardId);
    if (localClock === undefined) {
      if (exists.get(incoming.cardId) === undefined) {
        flagsOrphaned += 1;
        continue;
      }
    }
    if (localClock !== undefined && !isNewer(incoming.updatedAt, localClock)) {
      const local = localCardState.get(incoming.cardId);
      if (local !== undefined) restoreCardState.run(local.archived, local.pinned, local.updatedAt, incoming.cardId);
      flagsKept += 1;
      continue;
    }
    if (remote.voicesCarried === true) {
      setFlagsAndVoice.run(
        incoming.archived ? 1 : 0,
        incoming.pinned ? 1 : 0,
        incoming.voice ?? null,
        incoming.updatedAt,
        incoming.cardId,
      );
    } else {
      setFlags.run(
        incoming.archived ? 1 : 0,
        incoming.pinned ? 1 : 0,
        incoming.updatedAt,
        incoming.cardId,
      );
    }
    flagsTaken += 1;
  }

  let deckFlagsTaken = 0;
  const localDecks = new Map<string, string>();
  for (const r of db.prepare(SELECT_DECK_FLAGS).all() as Record<string, unknown>[]) {
    localDecks.set(String(r["deck_id"]), String(r["updated_at"]));
  }
  const setDeck = db.prepare(SET_DECK_FLAGS);
  const setDeckAndVoice = db.prepare(SET_DECK_FLAGS_AND_VOICE);
  for (const incoming of remote.deckFlags ?? []) {
    const localClock = localDecks.get(incoming.deckId);
    if (localClock === undefined) continue;
    if (!isNewer(incoming.updatedAt, localClock)) continue;
    if (remote.voicesCarried === true) {
      setDeckAndVoice.run(
        incoming.archived ? 1 : 0,
        incoming.voice ?? null,
        incoming.updatedAt,
        incoming.deckId,
      );
    } else {
      setDeck.run(incoming.archived ? 1 : 0, incoming.updatedAt, incoming.deckId);
    }
    deckFlagsTaken += 1;
  }

  let cardTemplatesTaken = 0;
  if (remote.templatesCarried === true) {
    const templateExists = db.prepare(TEMPLATE_EXISTS);
    const setTemplate = db.prepare(SET_CARD_TEMPLATE);
    for (const incoming of remote.cardFlags) {
      const theirs = incoming.templateId;
      if (theirs === undefined) continue;
      if (!localTemplate.has(incoming.cardId)) continue;
      const ours = localTemplate.get(incoming.cardId) ?? null;
      if (ours === theirs) continue;
      if (templateExists.get(theirs) === undefined) continue;
      const localClock = localFlags.get(incoming.cardId) as string;
      if (ours !== null && !isNewer(incoming.updatedAt, localClock)) continue;
      setTemplate.run(theirs, incoming.cardId);
      cardTemplatesTaken += 1;
    }
  }

  const union = new Set([...localRetired, ...(remote.retiredClips ?? [])]);
  const clipsRetired = [...union].filter((hash) => !localRetired.includes(hash) && /^[0-9a-f]{64}$/.test(hash)).length;
  writeRetired(db, union);

  return {
    applied,
    clipsRetired,
    trackStateTaken,
    trackStateKept,
    flagsTaken,
    flagsKept,
    valuesKept,
    flagsOrphaned,
    deckFlagsTaken,
    templatesTaken,
    templatesKept,
    fieldsTaken,
    fieldsKept,
    cardTemplatesTaken,
  };
}
