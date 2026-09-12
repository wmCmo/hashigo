/**
 * Stage 11 — merging two devices' databases.
 *
 *     import { exportSync, mergeSync } from "hashigo/sync";
 *
 *     const mine = exportSync(db);              // send this
 *     const report = mergeSync(db, theirs);     // apply what came back
 *
 * ─── THIS IS NOT A NEW PAYLOAD, AND THAT IS THE POINT ───────────────────────
 *
 * Decision 17's backup already solved the two hard problems sync has, because it
 * had to solve them for a different reason:
 *
 *   1. **Device-stable identity.** `reviews.id` and `card_tracks.id` are local
 *      INTEGER PRIMARY KEYs — two devices both hand out 102,021 to different
 *      rows, so neither can be a merge key. `src/backup/archive.ts` keys every
 *      row on `(card_id, kind)`, which is UNIQUE and is the same on both devices
 *      because `cards.id` is Mochi's id or a locally-created TEXT one.
 *   2. **Idempotent apply.** `reviews` is append-only with a BEFORE UPDATE
 *      trigger, so `applyLocalArchive` inserts what is missing and skips what is
 *      there, matched on `(track, reviewed_at, source)`.
 *
 * So a merge is a backup archive applied in the other direction, plus the rules
 * below — the places where BACKUP semantics and MERGE semantics genuinely differ.
 * Everything else is reused rather than rewritten, because a second copy of that
 * SQL is a second place for the identity rules to drift.
 *
 * ─── THE FOUR RULES, AND WHY EACH IS NOT LAST-WRITE-WINS ────────────────────
 *
 * SPEC's locked decision is "bidirectional, field-level last-write-wins". That is
 * right for most of the database and WRONG for the two things that matter most,
 * so the rules are stated per kind of data rather than applied uniformly:
 *
 * `reviews`          UNION, deduped on (track, reviewed_at, source).
 *                    Append-only per track, so it can never conflict — SPEC's own
 *                    reasoning, and the reason a grade can never be lost by a
 *                    merge no matter how long the two devices were apart.
 *
 * `card_tracks`      LAST REVIEW WINS — not last write.
 * scheduler state    This is the rule SPEC's flat LWW would get wrong. The state
 *                    (`due_at`, `reps`, `lapses`, `scheduled_days`,
 *                    `scheduler_state`) is a FUNCTION of the last grade. If both
 *                    devices graded the same track, both reviews survive the
 *                    union above — but LWW on a row clock would pick whichever
 *                    device wrote last, which is not necessarily the device that
 *                    graded last. The log and the state would then disagree, and
 *                    the schedule would be one the history does not explain.
 *                    `last_reviewed_at` is the honest clock, and picking the
 *                    newer one reproduces exactly what would have happened had
 *                    the two grades been made in sequence on one device.
 *
 *                    RECOMPUTING from the merged log was considered and is
 *                    WRONG: decision 11 applies interval fuzz ONCE at grade time,
 *                    so replaying would re-fuzz and move due dates that decision
 *                    14 says are not to be respread.
 *
 * `cards.archived`   LWW on `cards.updated_at`, and the payload carries EVERY
 * `cards.pinned`     card's flags rather than only the raised ones. The backup
 *                    export selects `WHERE archived = 1 OR pinned = 1` and
 *                    applies with `max(archived, ?)` — deliberately additive,
 *                    because a backup must never clear a flag it does not know
 *                    about. A merge must: Zach archiving 数字 on his phone and a
 *                    merge that can only ever SET flags means he can never
 *                    unarchive anything again. An unarchive is invisible as an
 *                    absence, so the row has to be present with its clock.
 *                    ~7,716 rows is ~300 KB, against the 224 MB of audio the
 *                    device already holds. Not worth a delta watermark yet.
 *
 * everything else    Upsert, which is what `applyLocalArchive` already does:
 *                    templates and their fields (they move together — a rename
 *                    rewrites the body's markers), settings, locally-created
 *                    cards with their values and tracks.
 *
 * ─── ONE KNOWN GAP, MEASURED AND NOT PAPERED OVER ───────────────────────────
 *
 * `schema.sql` says "sync is field-level last-write-wins, so the writer owns the
 * clock" — but `card_field_values` is `(card_id, field_id, value)` and carries NO
 * clock at all. The finest timestamp in the database is `cards.updated_at`, which
 * is CARD level. So editing `意味` on the laptop and `例文` on the phone, on the
 * same card, before a sync, is a card-level conflict and one of them loses.
 *
 * That is a schema change, and a schema bump here means a full re-import
 * (`SCHEMA_VERSION` is refused, never migrated). It is deliberately NOT done in
 * the same step as this: decision 16's ONE final import is already a scheduled
 * rebuild, and doing it then costs nothing extra instead of forcing a destructive
 * re-seed now. Until then this merge is card-level for field values and says so.
 *
 * BROWSER-PORTABLE: `SqliteHandle`, no `node:` import — this runs in the OPFS
 * worker on both devices.
 */

import {
  applyLocalArchive,
  exportLocalArchive,
  type ApplyReport,
  type LocalArchive,
} from "../backup/index.js";
import type { SqliteHandle } from "../db/browser.js";

/** Bumped only for a change a peer could not otherwise survive. */
export const SYNC_VERSION = 1;

/**
 * One card's collection flags, with the clock that resolves a conflict.
 *
 * Carried for EVERY card, not only the raised ones — see the header. `updatedAt`
 * is `cards.updated_at`, which the schema says is written by the caller rather
 * than a trigger precisely so it can mean "when this was last decided".
 */
export interface CardFlags {
  readonly cardId: string;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly updatedAt: string;
}

/** What one device sends the other. */
export interface SyncPayload {
  readonly syncVersion: number;
  /** Everything decision 17's backup already carries. */
  readonly archive: LocalArchive;
  /** Every card's flags plus its clock. See the header for why every. */
  readonly cardFlags: readonly CardFlags[];
}

export interface MergeReport {
  /** The backup apply's own counts — reviews inserted, fields upserted, … */
  readonly applied: ApplyReport;
  /** Tracks whose scheduler state the REMOTE won, by last review. */
  readonly trackStateTaken: number;
  /** Tracks where the local grade was newer, so local state was kept. */
  readonly trackStateKept: number;
  /** Cards whose flags the remote won, by clock. */
  readonly flagsTaken: number;
  /** Cards where local was newer or equal, so nothing moved. */
  readonly flagsKept: number;
  /** Cards in the payload that this device does not have. */
  readonly flagsOrphaned: number;
}

const SELECT_CARD_FLAGS = `
SELECT id AS card_id, archived, pinned, updated_at
  FROM cards
 ORDER BY id`;

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

const CARD_EXISTS = `SELECT 1 FROM cards WHERE id = ? LIMIT 1`;

interface LocalTrack {
  readonly lastReviewedAt: string | null;
  readonly dueAt: string | null;
  readonly scheduledDays: number | null;
  readonly reps: number;
  readonly lapses: number;
  readonly scheduler: string | null;
  readonly schedulerState: string | null;
}

const trackKey = (cardId: string, kind: string): string => `${cardId} ${kind}`;

/**
 * Later of two nullable instants, as strings.
 *
 * RFC 3339 UTC sorts correctly as text, which is why the schema stores instants
 * that way. A null means "never reviewed", which loses to any real instant.
 */
function isNewer(a: string | null, b: string | null): boolean {
  if (a === null) return false;
  if (b === null) return true;
  return a > b;
}

/** What this device would send a peer. */
export function exportSync(db: SqliteHandle, createdAt: string): SyncPayload {
  const cardFlags = (db.prepare(SELECT_CARD_FLAGS).all() as Record<string, unknown>[]).map(
    (r): CardFlags => ({
      cardId: String(r["card_id"]),
      archived: Number(r["archived"]) === 1,
      pinned: Number(r["pinned"]) === 1,
      updatedAt: String(r["updated_at"]),
    }),
  );
  return {
    syncVersion: SYNC_VERSION,
    archive: exportLocalArchive(db, createdAt),
    cardFlags,
  };
}

/**
 * Merge a peer's payload into this database.
 *
 * Order matters and is not arbitrary: `applyLocalArchive` upserts track state
 * WHOLESALE (correct for a restore, where the archive is the only truth), so the
 * local clocks are read BEFORE it runs and the newer ones are put back after.
 * Doing it the other way round would need the apply to know about merge rules,
 * which is how a backup path grows a sync bug.
 */
export function mergeSync(db: SqliteHandle, remote: SyncPayload): MergeReport {
  if (remote.syncVersion !== SYNC_VERSION) {
    throw new Error(
      `sync payload is version ${remote.syncVersion}; this device speaks ${SYNC_VERSION}. ` +
        `Update both devices rather than merging across versions.`,
    );
  }

  // ── before the apply: the local clocks the merge rules need ───────────────
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
  const localFlags = new Map<string, string>();
  for (const r of db.prepare(SELECT_CARD_FLAGS).all() as Record<string, unknown>[]) {
    localFlags.set(String(r["card_id"]), String(r["updated_at"]));
  }

  // ── the union and the upserts, reused wholesale ───────────────────────────
  const applied = applyLocalArchive(db, remote.archive);

  // ── rule: scheduler state follows the LAST REVIEW, not the last write ─────
  let trackStateTaken = 0;
  let trackStateKept = 0;
  const restore = db.prepare(RESTORE_TRACK_STATE);
  for (const incoming of remote.archive.trackState) {
    const local = localTracks.get(trackKey(incoming.cardId, incoming.kind));
    if (local === undefined) continue; // the apply reported it orphaned
    if (isNewer(incoming.lastReviewedAt, local.lastReviewedAt)) {
      // The apply already wrote the remote's state. Nothing to do.
      trackStateTaken += 1;
      continue;
    }
    // Local graded later (or the two are equal): put the local state back.
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

  // ── rule: collection flags are LWW on the card clock, and CAN clear ───────
  let flagsTaken = 0;
  let flagsKept = 0;
  let flagsOrphaned = 0;
  const exists = db.prepare(CARD_EXISTS);
  const setFlags = db.prepare(SET_CARD_FLAGS);
  for (const incoming of remote.cardFlags) {
    const localClock = localFlags.get(incoming.cardId);
    if (localClock === undefined) {
      // A card this device has never seen. `applyLocalArchive` restores
      // locally-CREATED cards; anything else is a card the peer has and this
      // device does not, which a Mochi re-import would bring.
      if (exists.get(incoming.cardId) === undefined) {
        flagsOrphaned += 1;
        continue;
      }
    }
    if (localClock !== undefined && !isNewer(incoming.updatedAt, localClock)) {
      flagsKept += 1;
      continue;
    }
    setFlags.run(
      incoming.archived ? 1 : 0,
      incoming.pinned ? 1 : 0,
      incoming.updatedAt,
      incoming.cardId,
    );
    flagsTaken += 1;
  }

  return { applied, trackStateTaken, trackStateKept, flagsTaken, flagsKept, flagsOrphaned };
}
