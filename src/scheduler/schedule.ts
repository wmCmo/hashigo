/**
 * Stage 6 — the scheduler, as arithmetic. No database, no clock, no I/O.
 *
 * `BACKTEST.md` chose FSRS-6 and fitted it; `./policy.ts` records what Zach
 * settled; `./algorithms/fsrs6.ts` is the model. This file is the remaining
 * step, and it is smaller than any of them: given a track's memory state, how
 * many whole days ago it was last seen, and whether he remembered it, produce
 * the next memory state and the next interval.
 *
 * WHY IT IS A SEPARATE FILE FROM `./tracks.ts`. Everything here is a pure
 * function of its arguments, so every scheduling claim in the tests is checked
 * without a database, a fixture or a date — and the one thing that is genuinely
 * hard to get right (which unit of elapsed time the model is fed) is visible in
 * a signature rather than buried in a SQL statement.
 *
 * THE THREE THINGS THAT ARE EASY TO GET WRONG HERE, all measured or settled
 * elsewhere and merely obeyed here:
 *
 *   1. THE MODEL IS FED WHOLE LOCAL DAYS. Every observation the shipped
 *      parameters were fitted on was date-only (SPEC "Review timestamps"), so a
 *      fractional gap is a unit the fit has never seen. It is also what makes a
 *      same-day re-review reach FSRS-6's short-term branch at all: 0.125 days
 *      takes the long-term branch with r ≈ 1 and barely moves stability, which
 *      is not what `stabilityShortTerm` is there for. `reviews.elapsed_days`
 *      still stores the exact fractional measurement — see `./day.ts`, and
 *      decision 6 in CLAUDE.md.
 *   2. THE INTERVAL IS ROUNDED, CLAMPED AND FUZZED ONCE, HERE. `intervalDays` is
 *      a whole number and it is what BOTH the due date and
 *      `reviews.next_scheduled_days` are computed from. Rounding at two call
 *      sites is how a planned interval and a due date drift apart, and
 *      `review_interval_audit` would then report a chain break on data that is
 *      merely inconsistently rounded. Fuzz has the same property and a sharper
 *      failure: computed at READ time instead, a due date jitters on every query.
 *   3. GRADES ARE BINARY. `gradeFor` is the only mapping, and it is imported
 *      rather than restated. w[15] and w[16] cannot be reached from here, which
 *      is the point.
 *
 * WHAT THIS DOES NOT DECIDE. A lapse floors at one day and is therefore due
 * tomorrow, not again in this session: `clampInterval` already settled that, on
 * the grounds that the queue is day-grained. Whether a forgotten card should
 * come back before the session ends is a review-UI question about a session
 * buffer, not a scheduling question, and stage 7 owns it. Nothing here needs to
 * change for it.
 */

import { gradeFor, type BinaryGrade } from "../schema/index.js";

import type { ReviewObservation } from "./algorithms/index.js";
import { fsrs6, type Fsrs6Parameters, type Fsrs6State } from "./algorithms/fsrs6.js";
import {
  INTERVAL_FUZZ,
  MAX_INTERVAL_DAYS,
  SCHEDULER_PARAMETERS,
  TARGET_RETENTION,
  clampInterval,
} from "./policy.js";

/**
 * A track's memory state — `card_tracks.scheduler_state`, as an object.
 *
 * Structurally FSRS-6's `Fsrs6State`, and named for the column rather than for
 * the algorithm because the column is what survives an algorithm change.
 */
export interface TrackMemory {
  readonly stability: number;
  readonly difficulty: number;
}

/** What `gradeMemory` needs. Everything optional has a settled default. */
export interface GradeRequest {
  /**
   * The track's state before this review, or null for a track FSRS has never
   * seen — a genuinely new card, or an imported track being graded locally for
   * the first time. `seedMemory` is how the second case avoids arriving here
   * as null and throwing away four years of history.
   */
  readonly memory: TrackMemory | null;
  /**
   * WHOLE local days since the previous review. Ignored when `memory` is null.
   * 0 means "same local date" — the short-term branch — not "no time passed".
   */
  readonly elapsedDays: number;
  readonly remembered: 0 | 1;
  /** Per deck, resolved by the caller. Defaults to the settled 0.90. */
  readonly targetRetention?: number;
  /** Defaults to the settled 365. */
  readonly maxIntervalDays?: number;
  /** Defaults to `SCHEDULER_PARAMETERS`. Tests and a refit pass their own. */
  readonly parameters?: Fsrs6Parameters;
  /**
   * The track id, which is what interval fuzz is keyed on. Omit and NO FUZZ is
   * applied — which is right for the pure arithmetic tests below and wrong for
   * anything that writes a due date, so `gradeTrack` always passes it.
   *
   * It must be the TRACK and nothing coarser. See `fuzzInterval`.
   */
  readonly fuzzKey?: number;
  /** Fuzz width. Defaults to the settled `INTERVAL_FUZZ` (±5%). 0 disables it. */
  readonly fuzzWidth?: number;
}

export interface GradeResult {
  readonly memory: TrackMemory;
  /** 1 (Again) or 3 (Good). There is no third value and never will be. */
  readonly grade: BinaryGrade;
  /**
   * P(recall) the model gave BEFORE it saw the outcome — null on a first
   * review, where there is no prior state to predict from. Worth storing or
   * logging: it is the only per-review number that says whether the scheduler
   * was surprised.
   */
  readonly retrievability: number | null;
  /**
   * WHOLE days, at least 1. What ships — and note that it can exceed
   * `maxIntervalDays` by up to the fuzz width, because fuzz is applied AFTER the
   * cap. That is deliberate and measured: 99.2% of the tracks this scheduler
   * would cap want an interval past 384 days, so fuzzing before the cap moves
   * none of them. `FUZZ_MAY_EXCEED_MAX_INTERVAL` in `./policy.ts` has the
   * numbers and the conservative alternative.
   */
  readonly intervalDays: number;
  /** `intervalDays` before fuzz: rounded, clamped, and the model's own answer. */
  readonly cappedIntervalDays: number;
  /** Before rounding and clamping. Kept so a clip is visible, not implied. */
  readonly rawIntervalDays: number;
  /** True when the 365-day ceiling, not the model, chose `cappedIntervalDays`. */
  readonly clippedByCap: boolean;
  /** True when this review created the memory rather than testing it. */
  readonly firstReview: boolean;
}

const DEFAULT_MODEL = fsrs6(SCHEDULER_PARAMETERS);

function modelFor(parameters: Fsrs6Parameters | undefined) {
  return parameters === undefined ? DEFAULT_MODEL : fsrs6(parameters);
}

/**
 * `Scheduler.intervalFor` is nullable because ONE candidate in the backtest —
 * the constant baseline — has no notion of an interval. FSRS-6 always has one,
 * so a null here is a broken model rather than a case to handle, and it says so
 * instead of quietly becoming a one-day interval.
 */
function intervalOf(
  model: ReturnType<typeof fsrs6>,
  memory: Fsrs6State,
  targetRetention: number,
): number {
  const raw = model.intervalFor(memory, targetRetention);
  if (raw === null) {
    throw new TypeError(`${model.id} returned no interval, which FSRS-6 cannot do`);
  }
  return raw;
}

// ─── interval fuzz ───────────────────────────────────────────────────────────

/**
 * splitmix32's finalizer: two multiply-xorshift rounds over a 32-bit key.
 *
 * DETERMINISTIC ON PURPOSE, and not `Math.random()`. Three things follow from
 * that and each of them is worth more than the randomness would be:
 *
 *   * a track's due date is a pure function of its state, so a schedule can be
 *     recomputed, diffed and tested rather than only observed;
 *   * sync cannot produce two devices that disagree about when a card is due;
 *   * the tests below can assert an exact interval instead of a range, which is
 *     what let the cohort-versus-track keying question be settled by a number.
 */
function hash32(key: number): number {
  let x = (key + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return (x ^ (x >>> 15)) >>> 0;
}

/**
 * Deterministic order key for (local day, track). Same day, same order; a new
 * day reshuffles.
 *
 * `newTracks` needs a random pick over ~3,980 unlearned tracks (decision 15) and
 * `Math.random()` would reshuffle mid-session and on every re-render. Keyed the
 * way `fuzzFactor` is keyed, and for the same reason: reproducibility is what
 * makes the queue an answer rather than a roll.
 *
 * The day is mixed with a large odd constant before the XOR so that adjacent
 * days do not produce correlated orders — track ids are dense small integers, so
 * `day ^ id` alone would leave the low bits of the order almost unchanged from
 * one day to the next.
 */
export function dailyOrderKey(dayNumber: number, trackId: number): number {
  return hash32(Math.imul(dayNumber, 0x9e3779b1) ^ trackId);
}

/** Uniform in [-width, +width), from a 32-bit key. */
export function fuzzFactor(key: number, width: number = INTERVAL_FUZZ): number {
  return (hash32(key) / 0x1_0000_0000) * 2 * width - width;
}

/**
 * Spread an interval by ±`width`, keyed on `key`.
 *
 * `key` MUST identify the track and nothing coarser. Keying it on the interval
 * value, or on the due date, translates a clump instead of spreading it and
 * measures WORSE than no fuzz at all — see `INTERVAL_FUZZ` in `./policy.ts` for
 * the table.
 *
 * One and two days are returned unchanged: ±5% of them rounds to zero anyway,
 * and saying so is cheaper than a reader wondering whether a lapse gets jittered.
 */
export function fuzzInterval(
  intervalDays: number,
  key: number,
  width: number = INTERVAL_FUZZ,
): number {
  if (intervalDays <= 2) return intervalDays;
  return Math.max(1, Math.round(intervalDays * (1 + fuzzFactor(key, width))));
}

function observation(elapsedDays: number, grade: BinaryGrade): ReviewObservation {
  // `ordinal` is a backtest concept — the position within a replayed track —
  // and no FSRS-6 code path reads it. 0 rather than a fabricated count.
  return { ordinal: 0, elapsedDays, remembered: grade === 3 ? 1 : 0, grade };
}

/**
 * P(recall) for a track, `elapsedDays` whole days after its state was set.
 *
 * The number the review UI can show as "how likely was this?", and the number
 * `gradeMemory` feeds back into the stability update rather than recomputing —
 * `fsrs6Step` takes retrievability as an argument for exactly that reason.
 */
export function retrievabilityOf(
  memory: TrackMemory,
  elapsedDays: number,
  parameters?: Fsrs6Parameters,
): number {
  return modelFor(parameters).predict(memory, elapsedDays);
}

/** The interval a track's current state asks for, whole days, clamped. */
export function intervalForMemory(
  memory: TrackMemory,
  targetRetention: number = TARGET_RETENTION,
  maxIntervalDays: number = MAX_INTERVAL_DAYS,
  parameters?: Fsrs6Parameters,
): number {
  const model = modelFor(parameters);
  return Math.round(clampInterval(intervalOf(model, memory, targetRetention), maxIntervalDays));
}

/**
 * Grade one review. The whole of stage 6's scheduling decision, in one call.
 */
export function gradeMemory(request: GradeRequest): GradeResult {
  const model = modelFor(request.parameters);
  const targetRetention = request.targetRetention ?? TARGET_RETENTION;
  const maxIntervalDays = request.maxIntervalDays ?? MAX_INTERVAL_DAYS;
  const grade = gradeFor(request.remembered);
  const firstReview = request.memory === null;

  let memory: Fsrs6State;
  let retrievability: number | null;
  if (request.memory === null) {
    // No prior state, so nothing to predict and nothing to be wrong about.
    // FSRS's `init` is a function of the grade alone.
    memory = model.init(observation(0, grade));
    retrievability = null;
  } else {
    const elapsedDays = Math.max(0, Math.round(request.elapsedDays));
    retrievability = model.predict(request.memory, elapsedDays);
    memory = model.next(request.memory, observation(elapsedDays, grade), retrievability);
  }

  const rawIntervalDays = intervalOf(model, memory, targetRetention);
  const cappedIntervalDays = Math.round(clampInterval(rawIntervalDays, maxIntervalDays));
  // ONCE, HERE, AT GRADE TIME. The other place this could go is the queue, and
  // putting it there makes a due date jitter on every read — see policy.ts.
  const intervalDays =
    request.fuzzKey === undefined
      ? cappedIntervalDays
      : fuzzInterval(cappedIntervalDays, request.fuzzKey, request.fuzzWidth);

  return {
    memory: { stability: memory.stability, difficulty: memory.difficulty },
    grade,
    retrievability,
    intervalDays,
    cappedIntervalDays,
    rawIntervalDays,
    clippedByCap: rawIntervalDays > maxIntervalDays,
    firstReview,
  };
}

/**
 * Rebuild a track's memory state by replaying its history — what turns an
 * imported Mochi track into an FSRS-6 track without losing four years.
 *
 * This is the same replay `loadHistory`/`erase` perform in the backtest, and
 * deliberately the same arithmetic: with a date-only corpus the whole-day
 * elapsed times this is given are identical to the fractional ones the backtest
 * computed, so a track seeded here reaches the state the backtest measured. Only
 * live reviews, which carry a real time of day, can make the two units differ,
 * and by then the track has state and is never seeded again.
 *
 * Returns null for an empty history: a track with no reviews is new, and
 * `gradeMemory` handles new by initialising rather than by seeding.
 */
export function seedMemory(
  observations: readonly ReviewObservation[],
  parameters?: Fsrs6Parameters,
): TrackMemory | null {
  if (observations.length === 0) return null;
  const model = modelFor(parameters);
  let state = model.init(observations[0] as ReviewObservation);
  for (let i = 1; i < observations.length; i += 1) {
    const next = observations[i] as ReviewObservation;
    state = model.next(state, next, model.predict(state, next.elapsedDays));
  }
  return { stability: state.stability, difficulty: state.difficulty };
}

/** `card_tracks.scheduler_state` as it is written. Round-trips `TrackMemory`. */
export function serialiseMemory(memory: TrackMemory): string {
  return JSON.stringify({ stability: memory.stability, difficulty: memory.difficulty });
}

/** Thrown rather than silently resetting a card's memory to new. */
export class SchedulerStateError extends Error {
  constructor(value: string, why: string) {
    super(`card_tracks.scheduler_state is unusable — ${why}: ${value.slice(0, 120)}`);
    this.name = "SchedulerStateError";
  }
}

/**
 * Parse `card_tracks.scheduler_state`.
 *
 * A malformed state THROWS. The tempting alternative — treat it as new — loses
 * a card's whole history to a JSON typo and looks like the scheduler working;
 * the caller in `./tracks.ts` catches this and reseeds from the review log
 * instead, which is recoverable and countable.
 */
export function parseMemory(json: string | null): TrackMemory | null {
  if (json === null || json === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SchedulerStateError(json, "not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SchedulerStateError(json, "not an object");
  }
  const { stability, difficulty } = parsed as Record<string, unknown>;
  if (typeof stability !== "number" || !Number.isFinite(stability) || stability <= 0) {
    throw new SchedulerStateError(json, "stability is not a positive finite number");
  }
  if (typeof difficulty !== "number" || !Number.isFinite(difficulty)) {
    throw new SchedulerStateError(json, "difficulty is not a finite number");
  }
  return { stability, difficulty };
}
