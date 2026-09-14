/**
 * The local archive — everything in this database that `exports/` cannot rebuild.
 *
 * DECISION 17 is why this exists, and decision 16 is why it is urgent. Today every
 * review is reconstructible from `exports/`, so losing the database costs fifteen
 * seconds. After decision 16's ONE final import, `exports/` stops receiving his
 * history: from the first local grade onward the app's own database is the ONLY
 * copy, and OPFS is browser-owned storage that a "clear site data" takes with it.
 *
 * ─── WHAT IT BACKS UP, AND WHY NOT THE WHOLE FILE ────────────────────────────
 *
 * Not the database file. The archive is exactly the rows that exist nowhere else:
 *
 *   * `reviews` where `source = 'local'` — grades made in Hashigo. THE thing.
 *   * the scheduling state of any track that has one — `due_at`, `scheduled_days`,
 *     `reps`, `lapses`, `last_reviewed_at`, `scheduler`, `scheduler_state`.
 *   * `template_fields` — ALL of them, and their `card_field_values` for the
 *     `local = 1` ones. Decision 9's locally-authored fields (`読み`, `かな主流`,
 *     `型`) were always in here because Mochi never had them; the Mochi-owned ones
 *     joined when the app grew a template editor, for the reason under
 *     "TEMPLATES" below — a renamed field and an edited body have to come back
 *     together or the body's markers name a field that no longer exists.
 *   * `settings`.
 *   * **`cards.archived` and `cards.pinned`, wherever either is 1** — see below.
 *   * **`templates.name` and `templates.content`** — see "TEMPLATES", below.
 *   * **Cards where `local = 1`**, with their field values and their tracks — see
 *     "LOCALLY-CREATED CARDS", below.
 *
 * ─── WHY COLLECTION STATE IS IN HERE, AND WAS NOT ───────────────────────────
 *
 * It looks like something `exports/` rebuilds, and for `archived` it half does:
 * the importer writes `archived = excluded.archived` from the export. That is
 * precisely the problem. **Mochi has no deck-level archive at all**
 * (`src/import/entities.ts`), so the deck Zach archived in Hashigo — his #8, the
 * 数字 deck — arrives back UNARCHIVED after decision 16's one final import, and
 * `pinned` comes back 0 on every card because his export carries none.
 *
 * So these two columns are the one kind of state that is authored HERE, looks
 * imported, and is silently overwritten by the import. Everything else in this
 * file is either obviously local (a grade) or obviously Mochi's (a card).
 *
 * Only the non-default rows are stored — 234 archived and 0 pinned today — so this
 * costs the archive a few kilobytes rather than a row per card. Restoring is
 * therefore additive: it sets the flags it holds and never clears one it does not,
 * which is the right direction for a backup (see `applyLocalArchive`).
 *
 * ─── TEMPLATES, FOR THE SAME REASON AND WITH A SHARPER EDGE ─────────────────
 *
 * `templates.content` is a Mochi column and `UPSERT_TEMPLATE` writes it from the
 * export, so an edited body does not survive decision 16's final import. That was
 * true before the app could edit one and it was already costing something:
 * `scripts/accent-field-apply.ts` writes decision 20's `型` gating INTO the body,
 * which is why re-running it is a documented step of the rebuild chore. Now that
 * the app has a template editor (his #11) it is a hole he can fall into by typing.
 *
 * **The field rows come with it, all of them, and that is not optional.** Renaming
 * a field rewrites the body's `<<Field>>` markers in the same transaction, because
 * the resolver binds by name. Archiving the body without the field NAMES would
 * restore a body whose markers point at names the fields no longer carry — every
 * one of them resolving to an empty string, silently. The two halves are one fact.
 *
 * `local` is carried per row rather than assumed, because it decides whether
 * `pruneFieldValues` deletes a field's values on the next import. An archive
 * written before this change has no `local` on its rows and every row in it was
 * `local = 1` by construction, so absent reads as `true` — the old file restores
 * exactly as it always did.
 *
 * 10 templates and 49 fields: the whole addition is a few kilobytes.
 *
 * ─── LOCALLY-CREATED CARDS ──────────────────────────────────────────────────
 *
 * "Cards rebuild from `exports/`" is true of 7,716 cards and false of any card he
 * writes in the app — and the app has been able to write them since 2026-08-26.
 * Until schema v9 there was no way to tell the two apart, because a created card is
 * otherwise an ordinary row, so this file archived NO cards and a card he made was
 * protected by nothing at all. `cards.local` is decision 9's rule for fields
 * applied to the card itself.
 *
 * Its `card_field_values` come too, all of them — the `local = 1` restriction on
 * values is about a MOCHI card's Mochi-owned fields, which the export holds. A
 * created card's values are in no export at all.
 *
 * Its tracks come as `trackState` like any other, but the SELECT there wants
 * scheduler state or a local review, and a card created five minutes ago has
 * neither. So a fresh track is archived explicitly: without it a restored card
 * comes back with no track and is never scheduled — present, and permanently
 * invisible, which is the worst of the three possible outcomes.
 *
 * Decks are NOT archived with it. A card whose deck is gone is reported as an
 * orphan and skipped, exactly as one whose template is gone; inventing a deck on
 * restore would put his cards somewhere he did not choose.
 *
 * Everything else — decks, templates, tags, links and the 103,110 IMPORTED reviews
 * — rebuilds from `exports/` in about fifteen seconds, and the blobs are content-addressed and
 * re-fetchable. Backing them up would turn a ~330 KB archive into 690 MB and make
 * the one-tap export something he would not tap.
 *
 * **READ "IMPORTED" STRICTLY — decision 41 narrowed what that word covers.** The
 * 2026-09-08 import was the last one, so `exports/` regenerates the history up to
 * that date and NOTHING after it. Every review Hashigo has graded since exists in
 * this archive, in decision 33's sync payloads, and in the device's OPFS, and
 * nowhere else. The scope above is unchanged and still correct — local reviews were
 * always archived — but the sentence used to read as "reviews are regenerable", and
 * that is now true only of the imported ones.
 *
 * A file-level copy was the other option and is worse for the case that matters: a
 * binary SQLite file is only restorable into the schema version it came from, and
 * `applySchema` refuses any version but its own, so a schema bump would strand
 * every backup taken before it. This archive is rows plus stable keys, so it
 * survives a bump — which is the whole point of a backup.
 *
 * ─── THE KEY IS `(card_id, kind)`, NEVER `track_id` ──────────────────────────
 *
 * The single thing that would make this silently useless. `card_tracks.id` is
 * `INTEGER PRIMARY KEY` — a rowid alias assigned at insert time — so it is a
 * property of one build of one database, not an identity. A rebuild is
 * `rm build/hashigo.db` and a re-import, and the ids it hands out are whatever the
 * insert order gives. They would very probably come out identical, which is worse
 * than if they obviously did not: an archive keyed on them would restore cleanly
 * and attach a review to the wrong card the first time anything changed.
 *
 * So every row here carries `cardId` and `kind`, and `applyLocalArchive` resolves
 * them against `card_tracks` at apply time. `(card_id, kind)` is UNIQUE — it is the
 * conflict target `src/import/reviews.ts` already upserts on.
 *
 * ─── APPLYING IS IDEMPOTENT ──────────────────────────────────────────────────
 *
 * `reviews` is append-only with a BEFORE UPDATE trigger, so a re-apply cannot
 * update; it inserts what is missing and skips what is there, matched on
 * `(track, reviewed_at, source)`. Everything else upserts. Run it twice and the
 * second run reports every row as skipped — the same shape as
 * `scripts/reading-apply.ts`, which says "ALREADY APPLIED".
 *
 * BROWSER-PORTABLE: `SqliteHandle`, no `node:` import, so the one-tap export runs
 * in the OPFS worker. Turning the archive into a downloadable file is the shell's
 * job — this module returns data, not a Blob.
 */

import type { SqliteHandle } from "../db/browser.js";

/** Bumped only for a change no reader could otherwise survive. */
export const ARCHIVE_VERSION = 1;

/** The stable identity of a track: its card, and which direction. */
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
  /**
   * A FRACTIONAL INDEX, and therefore TEXT — `'ab'`, `'ac'`. Mochi orders fields
   * with sortable strings so an insert between two neighbours needs no renumber.
   * `Number(pos)` gives NaN, which would restore every field with a null order;
   * this was caught by reading the real rows rather than the column list.
   */
  readonly pos: string;
  /**
   * OPTIONAL, and absent means `true`.
   *
   * Every row in an archive written before templates were carried was `local = 1`
   * by construction (the SELECT had `WHERE local = 1`), so defaulting to true makes
   * an old file restore exactly as it used to. It matters because `local` is what
   * stops `pruneFieldValues` deleting the field's values on the next import.
   */
  readonly local?: boolean;
}

/**
 * One template's editable surface.
 *
 * `reverse_permutation` and `pos` are deliberately absent: neither is reachable
 * from the editor, so archiving them would claim a scope the backup does not have.
 */
/**
 * One card that exists only here. The columns a create or a duplicate can set;
 * `search_text` is derived and `pos` is ordering the app does not expose.
 */
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
  /** `kind` for each of its tracks, so a restored card is scheduled. */
  readonly tracks: readonly string[];
}

export interface ArchivedTemplate {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  /**
   * `templates.updated_at`, so a MERGE can tell whose body is newer.
   *
   * OPTIONAL, and it has to be: archives written before this existed are still
   * good archives, and `ARCHIVE_VERSION` is bumped "only for a change no reader
   * could otherwise survive". A reader survives this one — see `mergeSync`,
   * which reads absent as "unknown clock" and then declines to overwrite a local
   * body rather than clobbering it.
   *
   * A RESTORE ignores this. There the archive is the only truth and wholesale is
   * correct; it is only when two live devices disagree that a clock is needed.
   */
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

/**
 * One card's collection state. Only rows where at least one flag is 1 are stored.
 *
 * Keyed on `cards.id`, which is the Mochi card id and therefore stable across a
 * rebuild — the same property that makes `(card_id, kind)` safe for tracks, and
 * for the same reason: it is an identity, not a rowid.
 */
export interface ArchivedCardState {
  readonly cardId: string;
  readonly archived: boolean;
  readonly pinned: boolean;
}

export interface LocalArchive {
  readonly archiveVersion: number;
  /** `PRAGMA user_version` of the database it came from. Read, not imported. */
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly reviews: readonly ArchivedReview[];
  readonly trackState: readonly ArchivedTrackState[];
  readonly localFields: readonly ArchivedField[];
  /** OPTIONAL for the same reason `cardState` is — an older archive predates it. */
  readonly templates?: readonly ArchivedTemplate[];
  /** Cards created in the app. Optional; absent means "none recorded". */
  readonly localCards?: readonly ArchivedCard[];
  readonly fieldValues: readonly ArchivedFieldValue[];
  readonly settings: readonly ArchivedSetting[];
  /**
   * OPTIONAL, and it stays optional. An archive written before this field existed
   * is still a good archive — absent means "no collection state recorded", which
   * is a complete and correct reading. `ARCHIVE_VERSION` says it is bumped "only
   * for a change no reader could otherwise survive", and a reader survives this
   * one by defaulting to `[]`. Bumping would have rejected every backup he has
   * already taken, at the moment those files are the only copy.
   */
  readonly cardState?: readonly ArchivedCardState[];
  /**
   * Self-describing counts, so a truncated or hand-edited file is detectable
   * before it is applied. `verifyLocalArchive` checks them.
   */
  readonly counts: Readonly<Record<string, number>>;
}

export interface ApplyReport {
  readonly reviewsInserted: number;
  readonly reviewsSkipped: number;
  /** Rows whose `(card_id, kind)` is not in this database at all. */
  readonly reviewsOrphaned: number;
  readonly trackStateApplied: number;
  readonly trackStateOrphaned: number;
  readonly fieldsUpserted: number;
  /** Fields whose TEMPLATE no longer exists here. */
  readonly fieldsOrphaned: number;
  readonly fieldValuesUpserted: number;
  /**
   * Values whose CARD no longer exists here.
   *
   * This one is why the orphan checks are not decoration. `card_field_values` has
   * a foreign key to `cards`, so before this existed a restore into a database
   * rebuilt from a newer export threw `FOREIGN KEY constraint failed` and aborted
   * the WHOLE archive — at the one moment the backup is the only copy. Found by
   * the orphan test, not by reasoning.
   */
  readonly fieldValuesOrphaned: number;
  readonly settingsUpserted: number;
  readonly localCardsInserted: number;
  readonly localCardsSkipped: number;
  /** Cards whose DECK is not in this database. Restoring would invent one. */
  readonly localCardsOrphaned: number;
  readonly templatesApplied: number;
  /** Templates the archive holds that this database no longer has. */
  readonly templatesOrphaned: number;
  readonly cardStateApplied: number;
  /** Cards the archive marks that this database no longer has. */
  readonly cardStateOrphaned: number;
  /** True when nothing needed doing — the "ALREADY APPLIED" shape. */
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

/**
 * Tracks worth restoring: any with scheduler state, or any the app has graded.
 *
 * A track whose state is entirely Mochi's is left out on purpose — the importer
 * writes it back from the export, so archiving it would be storing a copy of
 * something `exports/` already holds.
 */
const SELECT_TRACK_STATE = `
SELECT t.card_id AS card_id, t.kind AS kind, t.due_at, t.scheduled_days, t.reps,
       t.lapses, t.last_reviewed_at, t.scheduler, t.scheduler_state
  FROM card_tracks t
 WHERE t.scheduler_state IS NOT NULL
    OR EXISTS (SELECT 1 FROM reviews r WHERE r.track_id = t.id AND r.source = 'local')
 ORDER BY t.card_id, t.kind`;

/**
 * ALL fields, not only `local = 1`.
 *
 * The `WHERE local = 1` this replaces was right while the only fields authored here
 * were ones Mochi never had. Once a template's body and its field names can both be
 * edited in the app, they have to be archived as one thing — see "TEMPLATES" above.
 */
const SELECT_FIELDS = `
SELECT template_id, id, name, type, source_field_id, options, pos, local
  FROM template_fields ORDER BY template_id, pos, id`;

const SELECT_TEMPLATES = `SELECT id, name, content, updated_at FROM templates ORDER BY id`;

const SELECT_LOCAL_CARDS = `
SELECT id, deck_id, template_id, name, content, reverse, voice, archived, pinned
  FROM cards WHERE local = 1 ORDER BY id`;

const SELECT_LOCAL_TRACKS = `
SELECT t.card_id, t.kind
  FROM card_tracks t JOIN cards c ON c.id = t.card_id
 WHERE c.local = 1 ORDER BY t.card_id, t.kind`;

/** Every value on a locally-created card, not only the locally-authored fields. */
const SELECT_LOCAL_CARD_VALUES = `
SELECT v.card_id, v.field_id, v.value
  FROM card_field_values v JOIN cards c ON c.id = v.card_id
 WHERE c.local = 1 ORDER BY v.card_id, v.field_id`;

/** Values of locally-authored fields only. A Mochi field's values are in the export. */
const SELECT_FIELD_VALUES = `
SELECT v.card_id, v.field_id, v.value
  FROM card_field_values v
 WHERE v.field_id IN (SELECT id FROM template_fields WHERE local = 1)
 ORDER BY v.card_id, v.field_id`;

const SELECT_SETTINGS = `SELECT key, value FROM settings ORDER BY key`;

/**
 * Non-default rows only. `cards_pinned` is a partial index and `archived` is 234
 * of 7,716, so this reads the exceptions rather than the collection.
 */
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

/**
 * Read everything `exports/` cannot rebuild.
 *
 * `now` is a parameter because this module has no clock of its own: the browser
 * and a CLI disagree about how to spell one, and a test wants a fixed value.
 */
export function exportLocalArchive(db: SqliteHandle, now: string): LocalArchive {
  const reviews = (db.prepare(SELECT_REVIEWS).all() as Record<string, unknown>[]).map(
    (r): ArchivedReview => ({
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
    }),
  );

  const trackState = (db.prepare(SELECT_TRACK_STATE).all() as Record<string, unknown>[]).map(
    (r): ArchivedTrackState => ({
      cardId: String(r["card_id"]),
      kind: String(r["kind"]),
      dueAt: r["due_at"] === null ? null : String(r["due_at"]),
      scheduledDays: r["scheduled_days"] === null ? null : Number(r["scheduled_days"]),
      reps: Number(r["reps"]),
      lapses: Number(r["lapses"]),
      lastReviewedAt: r["last_reviewed_at"] === null ? null : String(r["last_reviewed_at"]),
      scheduler: r["scheduler"] === null ? null : String(r["scheduler"]),
      schedulerState: r["scheduler_state"] === null ? null : String(r["scheduler_state"]),
    }),
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

  // TWO SOURCES, ONE LIST, DEDUPLICATED. A value can qualify twice — decision 9's
  // 読み on a card he created here matches both "the field is local" and "the card
  // is local" — and a duplicate would break the self-describing count check in
  // `verifyLocalArchive` on a file that is perfectly good.
  const valueRows = new Map<string, ArchivedFieldValue>();
  for (const sql of [SELECT_FIELD_VALUES, SELECT_LOCAL_CARD_VALUES]) {
    for (const r of db.prepare(sql).all() as Record<string, unknown>[]) {
      const cardId = String(r["card_id"]);
      const fieldId = String(r["field_id"]);
      valueRows.set(`${cardId}\u0000${fieldId}`, {
        cardId,
        fieldId,
        value: String(r["value"]),
      });
    }
  }
  const fieldValues = [...valueRows.values()].sort((a, b) =>
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

/**
 * Check an archive before applying it.
 *
 * Cheap, and it is the difference between "this file is truncated" and a partial
 * restore that looks like it worked. Throws rather than returning a boolean: there
 * is nothing a caller can usefully do with a broken archive but stop.
 */
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
    // `?? []` and not `?.length ?? 0`: an OLD archive has no `cardState` key in
    // `counts` either, so the loop below never asks about it. A NEW one has both.
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

/**
 * Existence probes for the two foreign keys an archive can outlive.
 *
 * Mochi deletes cards — 8,958 tombstones in this corpus — and a template can go
 * too, so an archive taken before a re-import can legitimately reference rows that
 * are no longer here. Reported, never fatal.
 */
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

/**
 * `local` is a PARAMETER now, not the literal 1.
 *
 * It used to be hard-coded because the SELECT only ever produced local rows. With
 * every field archived, writing 1 for all of them would mark Mochi's fields as
 * locally-authored and stop `pruneFieldValues` ever cleaning up a field Mochi
 * genuinely deleted — turning a backup into a slow leak.
 */
const UPSERT_FIELD = `
INSERT INTO template_fields
  (template_id, id, name, type, source_field_id, options, pos, local)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (template_id, id) DO UPDATE SET
  name = excluded.name, type = excluded.type,
  source_field_id = excluded.source_field_id, options = excluded.options,
  pos = excluded.pos, local = excluded.local,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

const DECK_EXISTS = `SELECT 1 FROM decks WHERE id = ? LIMIT 1`;

/**
 * `INSERT OR IGNORE`, deliberately, and it is the difference between a backup and
 * an overwrite.
 *
 * A card id is unique, so a card that is already here is the SAME card — restoring
 * over it would replace whatever he has done to it since the backup with the older
 * copy. Skipped and counted instead. The archive is a floor, not a snapshot to
 * revert to; every other write in this file has the same shape for the same reason.
 */
const INSERT_LOCAL_CARD = `
INSERT OR IGNORE INTO cards
  (id, deck_id, template_id, name, content, reverse, voice, archived, pinned, local)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`;

/**
 * A track per kind the archive recorded.
 *
 * Unscheduled — `due_at` NULL is a NEW card, which is what a restored card should
 * be if its schedule was never backed up. When the archive DOES carry state for it,
 * `trackState` runs after this and is the last word.
 */
const INSERT_LOCAL_TRACK = `
INSERT OR IGNORE INTO card_tracks
  (card_id, kind, dormant, needs_rereview, due_at, scheduled_days, reps, lapses,
   last_reviewed_at, scheduler, scheduler_state)
VALUES (?, ?, 0, 0, NULL, NULL, 0, 0, NULL, NULL, NULL)`;

/**
 * The archived CLOCK is preserved when the archive carries one.
 *
 * It used to stamp `now` unconditionally, which broke two things at once. A
 * restore stopped round-tripping — export, apply, export again was no longer
 * byte-identical, and `test/backup.test.ts` says that property out loud. And it
 * made the template clock meaningless the moment it was used: after any merge
 * every device would believe its own body was the newest, whoever had actually
 * written it, so the LWW rule in `src/sync/merge.ts` would decide by accident.
 *
 * `COALESCE` keeps the old behaviour for an archive written before the clock
 * existed, where `now` is the only answer available.
 */
const UPDATE_TEMPLATE = `
UPDATE templates
   SET name = ?, content = ?,
       updated_at = COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
 WHERE id = ?`;

const UPSERT_VALUE = `
INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?)
ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value`;

const UPSERT_SETTING = `
INSERT INTO settings (key, value) VALUES (?, ?)
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * ADDITIVE, on purpose: it sets the flags the archive holds and clears nothing.
 *
 * The archive stores only non-default rows, so "absent" means "was 0 when the
 * backup was taken" — and clearing on that basis would make a restore UNDO an
 * archive he made after the backup. A backup that removes work is worse than one
 * that misses some, so the omission is the safe direction and the only one.
 */
const UPDATE_CARD_STATE = `
UPDATE cards
   SET archived = max(archived, ?), pinned = max(pinned, ?),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = ?`;

/**
 * Restore an archive into a database, idempotently.
 *
 * ORDER MATTERS: fields before their values (a value with no field is pruned by
 * `pruneFieldValues`), and reviews before track state (so the state is the last
 * word rather than something a review insert could be thought to have moved).
 *
 * **A MISSING ROW NEVER ABORTS THE RESTORE.** Anything whose card, track or
 * template is no longer here is counted into the report and skipped: restoring into
 * a database rebuilt from a newer export can legitimately meet a card Mochi has
 * since deleted, and this corpus carries 8,958 tombstones, so it will happen. A
 * non-zero `*Orphaned` is the signal to look, not a failure.
 *
 * This is not theoretical tidiness. `card_field_values` has a foreign key to
 * `cards`, so before the guard existed a single deleted card made the whole apply
 * throw `FOREIGN KEY constraint failed` — losing the rest of the archive at exactly
 * the moment it is the only copy. The orphan test found it; reasoning had not.
 *
 * The caller owns the transaction.
 */
export function applyLocalArchive(db: SqliteHandle, archive: LocalArchive): ApplyReport {
  verifyLocalArchive(archive);

  const trackId = db.prepare(TRACK_ID);
  const resolve = (key: TrackKey): number | null => {
    const row = trackId.get(key.cardId, key.kind) as { id?: number } | undefined;
    return row?.id ?? null;
  };

  const cardExists = db.prepare(CARD_EXISTS);
  const templateExists = db.prepare(TEMPLATE_EXISTS);

  let fieldsUpserted = 0;
  let fieldsOrphaned = 0;
  const upsertField = db.prepare(UPSERT_FIELD);
  for (const f of archive.localFields) {
    if (templateExists.get(f.templateId) === undefined) {
      fieldsOrphaned += 1;
      continue;
    }
    // `?? true` is the old-archive default — see `ArchivedField.local`.
    upsertField.run(
      f.templateId,
      f.id,
      f.name,
      f.type,
      f.sourceFieldId,
      f.options,
      f.pos,
      (f.local ?? true) ? 1 : 0,
    );
    fieldsUpserted += 1;
  }

  // AFTER the fields, and that order is load-bearing: a restored body's `<<Field>>`
  // markers name fields by NAME, so the names have to be back before the body that
  // uses them. Both are in the caller's one transaction either way, but the order
  // is what makes an interrupted restore leave the readable half rather than a body
  // whose markers resolve to nothing.
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

  // BEFORE the field values and before the reviews: both have foreign keys to
  // `cards`, so a restored card has to exist before anything can point at it.
  // Without this ordering every value and every review on a created card would be
  // counted as an orphan and skipped — a restore that reports success and drops the
  // card's entire contents.
  let localCardsInserted = 0;
  let localCardsSkipped = 0;
  let localCardsOrphaned = 0;
  const deckExists = db.prepare(DECK_EXISTS);
  const insertCard = db.prepare(INSERT_LOCAL_CARD);
  const insertTrack = db.prepare(INSERT_LOCAL_TRACK);
  for (const card of archive.localCards ?? []) {
    // The deck is NOT restored with the card — inventing one would put his cards
    // somewhere he did not choose. Reported, never fatal.
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
  for (const v of archive.fieldValues) {
    if (cardExists.get(v.cardId) === undefined) {
      fieldValuesOrphaned += 1;
      continue;
    }
    upsertValue.run(v.cardId, v.fieldId, v.value);
    fieldValuesUpserted += 1;
  }

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
    templatesOrphaned,
    cardStateApplied,
    cardStateOrphaned,
    // The honest reading of "nothing to do": no review was added. Upserts always
    // run, so counting them would make `noop` permanently false.
    noop: reviewsInserted === 0,
  };
}
