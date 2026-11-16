import type { SqliteHandle } from "../db/browser.js";

import type { Grade, ReviewObservation } from "./algorithms/index.js";
import { GRADE_AGAIN, GRADE_GOOD } from "./algorithms/index.js";
import type { Fsrs6Parameters } from "./algorithms/fsrs6.js";
import {
  dueInstant,
  exactDaysBetween,
  formatInstant,
  parseInstant,
  wholeDaysBetween,
} from "./day.js";
import { MAX_INTERVAL_DAYS, SCHEDULER_ALGORITHM, TARGET_RETENTION } from "./policy.js";
import {
  SchedulerStateError,
  gradeMemory,
  parseMemory,
  seedMemory,
  serialiseMemory,
  type GradeResult,
  type TrackMemory,
} from "./schedule.js";

export interface TrackRow {
  readonly id: number;
  readonly cardId: string;
  readonly kind: string;
  readonly dormant: 0 | 1;
  readonly dueAt: string | null;
  readonly scheduledDays: number | null;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReviewedAt: string | null;
  readonly scheduler: string | null;
  readonly schedulerState: string | null;
}

const SELECT_TRACK = `
SELECT t.id, t.card_id, t.kind, t.dormant, t.due_at, t.scheduled_days, t.reps,
       t.lapses, t.last_reviewed_at, t.scheduler, t.scheduler_state
  FROM card_tracks t
 WHERE t.id = ?`;

interface RawTrack {
  id: number;
  card_id: string;
  kind: string;
  dormant: number;
  due_at: string | null;
  scheduled_days: number | null;
  reps: number;
  lapses: number;
  last_reviewed_at: string | null;
  scheduler: string | null;
  scheduler_state: string | null;
}

function toTrack(row: RawTrack): TrackRow {
  return {
    id: row.id,
    cardId: row.card_id,
    kind: row.kind,
    dormant: row.dormant === 1 ? 1 : 0,
    dueAt: row.due_at,
    scheduledDays: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    lastReviewedAt: row.last_reviewed_at,
    scheduler: row.scheduler,
    schedulerState: row.scheduler_state,
  };
}

export function readTrack(db: SqliteHandle, trackId: number): TrackRow | null {
  const row = db.prepare(SELECT_TRACK).get(trackId) as RawTrack | undefined;
  return row === undefined ? null : toTrack(row);
}

const SELECT_HISTORY = `
SELECT r.reviewed_at, r.remembered
  FROM reviews r
 WHERE r.track_id = ?
 ORDER BY r.reviewed_at, r.id`;

export function trackObservations(db: SqliteHandle, trackId: number): ReviewObservation[] {
  const rows = db.prepare(SELECT_HISTORY).all(trackId) as {
    reviewed_at: string;
    remembered: number;
  }[];
  const observations: ReviewObservation[] = [];
  let previous: string | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as { reviewed_at: string; remembered: number };
    const remembered: 0 | 1 = row.remembered === 1 ? 1 : 0;
    observations.push({
      ordinal: i,
      elapsedDays: previous === null ? 0 : wholeDaysBetween(previous, row.reviewed_at),
      remembered,
      grade: (remembered === 1 ? GRADE_GOOD : GRADE_AGAIN) as Grade,
    });
    previous = row.reviewed_at;
  }
  return observations;
}

export interface TrackMemoryResult {
  readonly memory: TrackMemory | null;
  readonly source: "stored" | "seeded" | "reseeded" | "new";
  readonly problem?: string;
}

export function trackMemory(
  db: SqliteHandle,
  track: TrackRow,
  parameters?: Fsrs6Parameters,
): TrackMemoryResult {
  if (track.scheduler === SCHEDULER_ALGORITHM && track.schedulerState !== null) {
    try {
      const memory = parseMemory(track.schedulerState);
      if (memory !== null) return { memory, source: "stored" };
    } catch (cause) {
      const memory = seedMemory(trackObservations(db, track.id), parameters);
      return {
        memory,
        source: "reseeded",
        problem: cause instanceof SchedulerStateError ? cause.message : String(cause),
      };
    }
  }
  const memory = seedMemory(trackObservations(db, track.id), parameters);
  return { memory, source: memory === null ? "new" : "seeded" };
}

const SELECT_TARGET_RETENTION = `
SELECT r.target_retention AS target_retention
  FROM cards c
  JOIN deck_target_retention_resolved r ON r.deck_id = c.deck_id
 WHERE c.id = ?`;

export function targetRetentionForCard(db: SqliteHandle, cardId: string): number {
  const row = db.prepare(SELECT_TARGET_RETENTION).get(cardId) as
    | { target_retention: number | null }
    | undefined;
  const value = row?.target_retention;
  return typeof value === "number" && value > 0 && value < 1 ? value : TARGET_RETENTION;
}

export interface GradeTrackInput {
  readonly trackId: number;
  readonly remembered: 0 | 1;
  readonly reviewedAt?: string;
  readonly durationMs?: number | null;
  readonly targetRetention?: number;
  readonly maxIntervalDays?: number;
  readonly parameters?: Fsrs6Parameters;
  readonly fuzzWidth?: number;
  readonly rereview?: 0 | 1;
}

export interface GradedReview extends GradeResult {
  readonly reviewId: number;
  readonly trackId: number;
  readonly cardId: string;
  readonly reviewedAt: string;
  readonly dueAt: string;
  readonly elapsedDaysExact: number | null;
  readonly elapsedDaysWhole: number | null;
  readonly scheduledDays: number | null;
  readonly targetRetention: number;
  readonly memorySource: TrackMemoryResult["source"];
}

export class TrackNotFoundError extends Error {
  constructor(trackId: number) {
    super(`no card_tracks row with id ${trackId}`);
    this.name = "TrackNotFoundError";
  }
}

export class DormantTrackError extends Error {
  constructor(trackId: number) {
    super(
      `track ${trackId} is dormant — retained but not scheduled. ` +
        `A grade arriving for it means the queue offered a card it should not have.`,
    );
    this.name = "DormantTrackError";
  }
}

const SELECT_PREVIOUS_REVIEW = `
SELECT r.reviewed_at, r.next_scheduled_days
  FROM reviews r
 WHERE r.track_id = ?
 ORDER BY r.reviewed_at DESC, r.id DESC
 LIMIT 1`;

const INSERT_REVIEW = `
INSERT INTO reviews
  (track_id, reviewed_at, tz_offset_minutes, time_unknown, remembered,
   elapsed_days, scheduled_days, next_scheduled_days, due_at, duration_ms,
   rereview, source)
VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'local')
RETURNING id`;

const UPDATE_TRACK = `
UPDATE card_tracks
   SET due_at           = ?,
       scheduled_days   = ?,
       reps             = reps + 1,
       lapses           = lapses + ?,
       last_reviewed_at = ?,
       scheduler        = ?,
       scheduler_state  = ?,
       updated_at       = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = ?`;

export function nowInHostOffset(at: Date = new Date()): string {
  return formatInstant(at.getTime(), -at.getTimezoneOffset());
}

export function gradeTrack(db: SqliteHandle, input: GradeTrackInput): GradedReview {
  const run = db.transaction((): GradedReview => {
    const track = readTrack(db, input.trackId);
    if (track === null) throw new TrackNotFoundError(input.trackId);
    if (track.dormant === 1) throw new DormantTrackError(input.trackId);

    const reviewedAt = input.reviewedAt ?? nowInHostOffset();
    const previous = db.prepare(SELECT_PREVIOUS_REVIEW).get(input.trackId) as
      | { reviewed_at: string; next_scheduled_days: number | null }
      | undefined;

    const elapsedDaysExact =
      previous === undefined ? null : exactDaysBetween(previous.reviewed_at, reviewedAt);
    const elapsedDaysWhole =
      previous === undefined ? null : wholeDaysBetween(previous.reviewed_at, reviewedAt);

    const state = trackMemory(db, track, input.parameters);
    const targetRetention =
      input.targetRetention ?? targetRetentionForCard(db, track.cardId);

    const graded = gradeMemory({
      memory: state.memory,
      elapsedDays: elapsedDaysWhole ?? 0,
      remembered: input.remembered,
      targetRetention,
      maxIntervalDays: input.maxIntervalDays ?? MAX_INTERVAL_DAYS,
      fuzzKey: input.trackId,
      ...(input.fuzzWidth === undefined ? {} : { fuzzWidth: input.fuzzWidth }),
      ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
    });

    const dueAt = dueInstant(reviewedAt, graded.intervalDays);
    const { offsetMinutes: tzOffsetMinutes } = parseInstant(reviewedAt);

    const inserted = db
      .prepare(INSERT_REVIEW)
      .get(
        input.trackId,
        reviewedAt,
        tzOffsetMinutes,
        input.remembered,
        elapsedDaysExact,
        previous?.next_scheduled_days ?? null,
        graded.intervalDays,
        dueAt,
        input.durationMs ?? null,
        input.rereview ?? 0,
      ) as { id: number } | undefined;
    if (inserted === undefined) {
      throw new Error(`reviews insert returned no id for track ${input.trackId}`);
    }

    db.prepare(UPDATE_TRACK).run(
      dueAt,
      graded.intervalDays,
      input.remembered === 1 ? 0 : 1,
      reviewedAt,
      SCHEDULER_ALGORITHM,
      serialiseMemory(graded.memory),
      input.trackId,
    );

    return {
      ...graded,
      reviewId: inserted.id,
      trackId: input.trackId,
      cardId: track.cardId,
      reviewedAt,
      dueAt,
      elapsedDaysExact,
      elapsedDaysWhole,
      scheduledDays: previous?.next_scheduled_days ?? null,
      targetRetention,
      memorySource: state.source,
    };
  });
  return run();
}

export interface TrackSnapshot {
  readonly trackId: number;
  readonly dueAt: string | null;
  readonly scheduledDays: number | null;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReviewedAt: string | null;
  readonly scheduler: string | null;
  readonly schedulerState: string | null;
}

const SELECT_SNAPSHOT = `
SELECT id, due_at, scheduled_days, reps, lapses, last_reviewed_at, scheduler, scheduler_state
  FROM card_tracks WHERE id = ?`;

export function snapshotTrack(db: SqliteHandle, trackId: number): TrackSnapshot {
  const row = db.prepare(SELECT_SNAPSHOT).get(trackId) as
    | {
        id: number;
        due_at: string | null;
        scheduled_days: number | null;
        reps: number;
        lapses: number;
        last_reviewed_at: string | null;
        scheduler: string | null;
        scheduler_state: string | null;
      }
    | undefined;
  if (row === undefined) throw new Error(`no card_track ${trackId}`);
  return {
    trackId: row.id,
    dueAt: row.due_at,
    scheduledDays: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    lastReviewedAt: row.last_reviewed_at,
    scheduler: row.scheduler,
    schedulerState: row.scheduler_state,
  };
}

const RESTORE_TRACK = `
UPDATE card_tracks
   SET due_at           = ?,
       scheduled_days   = ?,
       reps             = ?,
       lapses           = ?,
       last_reviewed_at = ?,
       scheduler        = ?,
       scheduler_state  = ?,
       updated_at       = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = ?`;

export function ungradeTrack(
  db: SqliteHandle,
  input: { readonly reviewId: number; readonly snapshot: TrackSnapshot },
): void {
  const run = db.transaction(() => {
    const review = db
      .prepare("SELECT id, track_id FROM reviews WHERE id = ?")
      .get(input.reviewId) as { id: number; track_id: number } | undefined;
    if (review === undefined) throw new Error(`no review ${input.reviewId} to undo`);
    if (review.track_id !== input.snapshot.trackId) {
      throw new Error(
        `review ${input.reviewId} is on track ${review.track_id}, ` +
          `but the snapshot is of track ${input.snapshot.trackId}`,
      );
    }

    const newest = db
      .prepare("SELECT max(id) AS id FROM reviews WHERE track_id = ?")
      .get(review.track_id) as { id: number | null };
    if (newest.id !== input.reviewId) {
      throw new Error(
        `review ${input.reviewId} is not the latest on track ${review.track_id} ` +
          `(that is ${newest.id}). Undo newest-first — the track's schedule was ` +
          `computed from the newest review, and removing an older one leaves it ` +
          `derived from something that is gone.`,
      );
    }

    db.prepare("DELETE FROM reviews WHERE id = ?").run(input.reviewId);
    db.prepare(RESTORE_TRACK).run(
      input.snapshot.dueAt,
      input.snapshot.scheduledDays,
      input.snapshot.reps,
      input.snapshot.lapses,
      input.snapshot.lastReviewedAt,
      input.snapshot.scheduler,
      input.snapshot.schedulerState,
      input.snapshot.trackId,
    );
  });
  run();
}

export interface SeedReport {
  readonly tracks: number;
  readonly seeded: number;
  readonly alreadyStored: number;
  readonly withoutHistory: number;
  readonly dormant: number;
}

const SELECT_SEEDABLE = `
SELECT id FROM card_tracks
 WHERE dormant = 0
   AND (scheduler IS NULL OR scheduler <> ? OR scheduler_state IS NULL)
 ORDER BY id`;

const UPDATE_SEED = `
UPDATE card_tracks
   SET scheduler       = ?,
       scheduler_state = ?,
       updated_at      = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = ?`;

export function seedTrackMemory(
  db: SqliteHandle,
  parameters?: Fsrs6Parameters,
): SeedReport {
  const run = db.transaction((): SeedReport => {
    const ids = db.prepare(SELECT_SEEDABLE).all(SCHEDULER_ALGORITHM) as { id: number }[];
    const update = db.prepare(UPDATE_SEED);
    let seeded = 0;
    let withoutHistory = 0;
    for (const { id } of ids) {
      const memory = seedMemory(trackObservations(db, id), parameters);
      if (memory === null) {
        withoutHistory += 1;
        continue;
      }
      update.run(SCHEDULER_ALGORITHM, serialiseMemory(memory), id);
      seeded += 1;
    }
    const total = db.prepare(`SELECT count(*) AS n FROM card_tracks`).get() as { n: number };
    const dormant = db
      .prepare(`SELECT count(*) AS n FROM card_tracks WHERE dormant <> 0`)
      .get() as { n: number };
    return {
      tracks: total.n,
      seeded,
      alreadyStored: total.n - dormant.n - ids.length,
      withoutHistory,
      dormant: dormant.n,
    };
  });
  return run();
}
