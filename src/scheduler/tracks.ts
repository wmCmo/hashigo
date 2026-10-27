/**
 * Stage 6 — grading a track, against the database.
 *
 * `./schedule.ts` decides; this file is the only thing that writes a review. It
 * is typed against `SqliteHandle` rather than better-sqlite3's `Database`
 * because the review UI runs in the browser over OPFS — see the contract note in
 * `src/db/browser.ts`. That is a TYPE-LEVEL claim, checked by tsc and by
 * `test/db-contract.types.ts`, and it is the honest limit of it: every test here
 * runs on better-sqlite3, and nothing in this file has yet executed against
 * sqlite-wasm. What the contract buys is that it will not need rewriting to;
 * what it does not buy is a measurement.
 *
 * FOUR THINGS IT DOES THAT ARE NOT OBVIOUS FROM THE CALL SITE.
 *
 * 1. IT SEEDS FROM HISTORY, LAZILY, AND ONLY ONCE PER TRACK. 9,085 of the
 *    13,393 imported tracks carry `scheduler = 'mochi'` and
 *    `scheduler_state = NULL` — Mochi never exported stability or difficulty,
 *    and there is nothing to convert. So the first local grade of a track
 *    replays its whole review log through FSRS-6 first (`seedMemory`), and only
 *    then applies the grade. The alternative — treat an imported track as a new
 *    card — would throw away four years of history one card at a time, and it
 *    would look exactly like the scheduler working.
 *
 *    Lazily, rather than in one migration pass, for a reason that is Zach's
 *    situation and not a preference: he is still reviewing ~100 cards/day in
 *    Mochi and will re-export repeatedly, and the importer overwrites `due_at`.
 *    A track that has not been graded here keeps the due date Mochi gave it, so
 *    on day one the queue is the queue he already knows, and it converts one
 *    card at a time as he works. `seedTrackMemory` is exported for anyone who
 *    wants the eager pass anyway.
 *
 * 2. IT READS THE PREVIOUS REVIEW, NOT THE TRACK COLUMNS, for the two numbers
 *    the interval invariant is built on. `reviews[n].scheduled_days` must equal
 *    `reviews[n-1].next_scheduled_days` — `review_interval_audit` returns rows
 *    when it does not, and it returns none on the corpus today. Taking the
 *    planned interval from `card_tracks.scheduled_days` would satisfy the audit
 *    only as long as that column never drifted; taking it from the row that
 *    defines the invariant satisfies it by construction. `elapsed_days` comes
 *    from the same row's timestamp for the same reason.
 *
 * 3. IT REFUSES TO GRADE A DORMANT TRACK. Dormant is "retained, not scheduled";
 *    a grade arriving for one means the queue offered a card it should not have,
 *    and inserting the review would hide that. Zero tracks are dormant in the
 *    corpus today, which makes this a guard against a future bug rather than a
 *    live case.
 *
 * 4. `time_unknown = 0`, and it matters. Every imported review carries 1,
 *    because Mochi truncated to the date and the time of day is unrecoverable.
 *    Every review written here has a real instant, and the day the
 *    time-of-day charts have something to say is the day the first local review
 *    lands. SPEC calls this "the one that cannot wait"; this is where the
 *    waiting stops.
 */

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

/** A track, as the scheduler needs it. */
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

// ─── history ─────────────────────────────────────────────────────────────────

const SELECT_HISTORY = `
SELECT r.reviewed_at, r.remembered
  FROM reviews r
 WHERE r.track_id = ?
 ORDER BY r.reviewed_at, r.id`;

/**
 * A track's whole review log, as the model reads it.
 *
 * Ordered by `reviewed_at` then `id` for the reason `loadHistory` gives: the
 * imported dates are date-only, two reviews of one track routinely share a
 * timestamp exactly, and `reviews.id` ascends in the export's own array order —
 * the only remaining evidence of which came first.
 *
 * `elapsedDays` is WHOLE LOCAL DAYS, which on this date-only corpus is the same
 * number the backtest computed fractionally. See `./schedule.ts` note 1.
 */
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

/**
 * The memory state a track should be scheduled from, and where it came from.
 *
 * `source` is the honest label: `stored` read the column, `seeded` replayed the
 * review log, `reseeded` replayed it because the column was unusable (which is
 * countable rather than silent — see `parseMemory`), and `new` means the track
 * has no history at all.
 */
export interface TrackMemoryResult {
  readonly memory: TrackMemory | null;
  readonly source: "stored" | "seeded" | "reseeded" | "new";
  /** Set when `source` is `reseeded`: what was wrong with the stored state. */
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

// ─── target retention, per deck ──────────────────────────────────────────────

const SELECT_TARGET_RETENTION = `
SELECT r.target_retention AS target_retention
  FROM cards c
  JOIN deck_target_retention_resolved r ON r.deck_id = c.deck_id
 WHERE c.id = ?`;

/**
 * The target retention for a card, resolved up the deck tree.
 *
 * SPEC: "Target retention stays a setting — per deck, since 漢字 and 基本情報
 * have different stakes." The view does the inheritance and bottoms out in
 * `settings.target_retention.default`, which the schema seeds at 0.90 — the same
 * number `TARGET_RETENTION` holds, so the two cannot disagree on a fresh
 * database. `TARGET_RETENTION` is the fallback if the row is missing entirely,
 * which would mean a card in no deck.
 */
export function targetRetentionForCard(db: SqliteHandle, cardId: string): number {
  const row = db.prepare(SELECT_TARGET_RETENTION).get(cardId) as
    | { target_retention: number | null }
    | undefined;
  const value = row?.target_retention;
  return typeof value === "number" && value > 0 && value < 1 ? value : TARGET_RETENTION;
}

// ─── grading ─────────────────────────────────────────────────────────────────

export interface GradeTrackInput {
  readonly trackId: number;
  readonly remembered: 0 | 1;
  /**
   * RFC 3339 WITH an offset. Defaults to now in the host's offset, which is the
   * honest fact rather than `settings.timezone.default`: a 23:00 review in Tokyo
   * and a 23:00 review abroad are different facts about the day, and the host
   * offset is the one that records travel instead of erasing it.
   */
  readonly reviewedAt?: string;
  /** Time on the card, milliseconds. Mochi's `duration` was seconds; this is not. */
  readonly durationMs?: number | null;
  /** Overrides the per-deck resolution. Tests and a "grade at 0.95" pass it. */
  readonly targetRetention?: number;
  readonly maxIntervalDays?: number;
  readonly parameters?: Fsrs6Parameters;
  /**
   * Interval fuzz width, defaulting to the settled ±5%. The KEY is not settable:
   * it is the track id, always, because that is the whole content of the
   * decision. Pass 0 to switch fuzz off, which only a measurement should do.
   */
  readonly fuzzWidth?: number;
  /** 1 when this is a leech re-review rather than a scheduled one. */
  readonly rereview?: 0 | 1;
}

export interface GradedReview extends GradeResult {
  readonly reviewId: number;
  readonly trackId: number;
  readonly cardId: string;
  readonly reviewedAt: string;
  readonly dueAt: string;
  /** MEASURED, fractional — the `reviews.elapsed_days` that was written. */
  readonly elapsedDaysExact: number | null;
  /** What the model was fed: whole local days. Null on a first review. */
  readonly elapsedDaysWhole: number | null;
  /** The planned interval this review was answering, from the previous row. */
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

/** Now, in the host's own offset — the default `reviewedAt`. */
export function nowInHostOffset(at: Date = new Date()): string {
  return formatInstant(at.getTime(), -at.getTimezoneOffset());
}

/**
 * Grade one review: write the row, advance the track, return what happened.
 *
 * Atomic. The review row and the track update are one transaction because a
 * review with no state advance would be re-offered forever, and a state advance
 * with no review row would be unauditable — `review_interval_audit` reads the
 * rows, not the columns.
 */
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
      // KEYED PER TRACK. Not per cohort — keying the shift on the interval or on
      // the due date translates a clump rather than spreading it, and measures
      // worse than no fuzz at all (policy.ts, `INTERVAL_FUZZ`). Not optional
      // either: every write path goes through here, so a due date this function
      // produces is always fuzzed.
      fuzzKey: input.trackId,
      ...(input.fuzzWidth === undefined ? {} : { fuzzWidth: input.fuzzWidth }),
      ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
    });

    const dueAt = dueInstant(reviewedAt, graded.intervalDays);
    // Offset in minutes east of UTC, read back out of the string that was
    // written rather than taken on the side, so the column and the timestamp
    // cannot disagree — views.sql derives local_date by shifting one by the
    // other, and a mismatch there moves every time-of-day figure silently.
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

// ─── undoing one grade ───────────────────────────────────────────────────────

/**
 * THE SEVEN COLUMNS A GRADE MOVES, AS THEY WERE BEFORE IT MOVED THEM.
 *
 * `gradeTrack` writes a `reviews` row and then advances the track. Undoing it means
 * putting both back, and the track half CANNOT BE RECOMPUTED: `scheduler_state` is
 * the serialised FSRS memory, and deriving the previous value from the previous
 * review would re-run the model rather than restore what was there. So the caller
 * snapshots first and hands the snapshot back.
 *
 * That is the same shape as `app/deck-scope.ts`'s archive undo, for the same reason:
 * an undo that recomputes is a second write, not a reversal.
 */
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

/** Read the track's schedule state. Call this BEFORE `gradeTrack`. */
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

/**
 * Delete one review and put its track back exactly as `snapshot` found it.
 *
 * **ONLY THE LATEST REVIEW ON A TRACK CAN BE UNDONE, and this refuses otherwise.**
 * The track's current schedule was computed FROM the newest review; removing an older
 * one would leave a state derived from a review that no longer exists, and the
 * arithmetic would never be right again. A reviewer undoing two grades has to undo
 * them newest-first, which is what a stack does anyway.
 *
 * Both writes are one transaction: a deleted review beside an unrestored track is a
 * card whose history and whose schedule disagree, which is worse than either alone.
 */
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

// ─── the eager seed, for anyone who wants it ─────────────────────────────────

export interface SeedReport {
  /** Every row of `card_tracks`, dormant included. */
  readonly tracks: number;
  readonly seeded: number;
  /**
   * LIVE tracks that already carried usable state, so seeding skipped them.
   *
   * BASIS FIXED 2026-08-22. This was `tracks - ids.length`, which subtracts a
   * `dormant = 0` count from an all-rows count — so every DORMANT track was
   * reported as "already had state" when seeding had never considered it. Exactly
   * right on this corpus, where dormant is 0, and wrong the first time a track
   * goes dormant. That is the defect decision 6 exists for, in a report line.
   */
  readonly alreadyStored: number;
  readonly withoutHistory: number;
  /**
   * Rows seeding never looked at, because `SELECT_SEEDABLE` filters
   * `dormant = 0`. Broken out so the four numbers reconcile against `tracks`
   * rather than being three numbers and a remainder.
   */
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

/**
 * Replay every track's history into `scheduler_state`, without rescheduling
 * anything.
 *
 * DELIBERATELY DOES NOT TOUCH `due_at`. Seeding is a statement about what FSRS
 * believes; rescheduling is a statement about when he should see the card, and
 * doing both at once would move 9,085 due dates in one commit with no way to
 * tell which change caused what. The lazy path in `gradeTrack` makes this
 * optional — it exists for measuring the seeded state in bulk (what the fitted
 * model thinks his collection's stability distribution is) rather than as a
 * migration anything depends on.
 */
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
      // Same basis as `ids`: live tracks only, minus the ones seeding handled.
      alreadyStored: total.n - dormant.n - ids.length,
      withoutHistory,
      dormant: dormant.n,
    };
  });
  return run();
}
