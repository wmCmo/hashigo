import {
  ARCHIVE_VERSION,
  archivedReview,
  archivedTrackState,
  type ArchivedReview,
  type ArchivedTrackState,
} from "../backup/archive.js";
import type { SqliteHandle } from "../db/browser.js";
import { exportSync, SYNC_VERSION, type SyncPayload } from "./merge.js";
import { editsSince, noEdits, type SentIndex, type SyncEdits } from "./sent.js";

export interface SyncDelta {
  readonly syncVersion: number;
  readonly delta: 1;
  readonly mark: number;
  readonly reviews: readonly ArchivedReview[];
  readonly trackState: readonly ArchivedTrackState[];
  readonly edits?: SyncEdits;
}

const SELECT_NEW_REVIEWS = `
SELECT r.id AS id, t.card_id AS card_id, t.kind AS kind, r.reviewed_at, r.tz_offset_minutes,
       r.time_unknown, r.remembered, r.elapsed_days, r.scheduled_days,
       r.next_scheduled_days, r.due_at, r.duration_ms, r.rereview, r.source,
       r.import_key
  FROM reviews r JOIN card_tracks t ON t.id = r.track_id
 WHERE r.source = 'local' AND r.id > ?
 ORDER BY r.id`;

const SELECT_TRACK = `
SELECT t.card_id AS card_id, t.kind AS kind, t.due_at, t.scheduled_days, t.reps,
       t.lapses, t.last_reviewed_at, t.scheduler, t.scheduler_state
  FROM card_tracks t
 WHERE t.card_id = ? AND t.kind = ?`;

export function maxLocalReviewId(db: SqliteHandle): number {
  const row = db.prepare("SELECT max(id) AS m FROM reviews WHERE source = 'local'").get() as
    | { m: number | null }
    | undefined;
  return Number(row?.m ?? 0);
}

export function exportDelta(db: SqliteHandle, after: number): SyncDelta {
  const rows = db.prepare(SELECT_NEW_REVIEWS).all(after) as Record<string, unknown>[];
  const reviews = rows.map(archivedReview);
  const mark = rows.reduce((max, row) => Math.max(max, Number(row["id"])), after);
  const seen = new Set<string>();
  const trackState: ArchivedTrackState[] = [];
  const track = db.prepare(SELECT_TRACK);
  for (const review of reviews) {
    const key = `${review.cardId}\u0000${review.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = track.get(review.cardId, review.kind) as Record<string, unknown> | undefined;
    if (row !== undefined) trackState.push(archivedTrackState(row));
  }
  return { syncVersion: SYNC_VERSION, delta: 1, mark, reviews, trackState };
}

export function exportEditDelta(
  db: SqliteHandle,
  after: number,
  sent: SentIndex,
  createdAt: string,
): { readonly delta: SyncDelta; readonly index: Record<string, string>; readonly rows: number } {
  const grades = exportDelta(db, after);
  const { edits, rows, index } = editsSince(exportSync(db, createdAt), sent);
  return { delta: rows === 0 ? grades : { ...grades, edits }, index, rows };
}

export function isDelta(value: unknown): value is SyncDelta {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { delta?: unknown }).delta === 1 &&
    Array.isArray((value as { reviews?: unknown }).reviews)
  );
}

export function deltaPayload(delta: SyncDelta, createdAt: string): SyncPayload {
  if (!noEdits(delta.edits)) return editPayload(delta, delta.edits as SyncEdits, createdAt);
  return {
    syncVersion: delta.syncVersion,
    archive: {
      archiveVersion: ARCHIVE_VERSION,
      schemaVersion: 0,
      createdAt,
      reviews: delta.reviews,
      trackState: delta.trackState,
      localFields: [],
      templates: [],
      localCards: [],
      fieldValues: [],
      settings: [],
      cardState: [],
      counts: {
        reviews: delta.reviews.length,
        trackState: delta.trackState.length,
        localFields: 0,
        localCards: 0,
        templates: 0,
        fieldValues: 0,
        settings: 0,
        cardState: 0,
      },
    },
    cardFlags: [],
    deckFlags: [],
  };
}

function editPayload(delta: SyncDelta, edits: SyncEdits, createdAt: string): SyncPayload {
  return {
    syncVersion: delta.syncVersion,
    archive: {
      archiveVersion: ARCHIVE_VERSION,
      schemaVersion: 0,
      createdAt,
      reviews: delta.reviews,
      trackState: delta.trackState,
      localFields: edits.localFields,
      templates: edits.templates,
      localCards: edits.localCards,
      fieldValues: edits.fieldValues,
      settings: edits.settings,
      cardState: edits.cardState,
      counts: {
        reviews: delta.reviews.length,
        trackState: delta.trackState.length,
        localFields: edits.localFields.length,
        localCards: edits.localCards.length,
        templates: edits.templates.length,
        fieldValues: edits.fieldValues.length,
        settings: edits.settings.length,
        cardState: edits.cardState.length,
      },
    },
    cardFlags: edits.cardFlags,
    deckFlags: edits.deckFlags,
    voicesCarried: true,
    templatesCarried: true,
    retiredClips: edits.retiredClips,
  };
}
