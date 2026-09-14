/**
 * Stage 5 — the candidate schedulers, as predictors.
 *
 * SPEC.html "Scheduling": the scheduler is chosen by backtest, not assumed.
 * That means every candidate has to answer one question — given a track's
 * history and the time that has elapsed, what is P(recall)? — because that is
 * the only thing a log of graded reviews can score.
 *
 * WHAT THE CORPUS CAN AND CANNOT TELL A CANDIDATE. Three properties of the
 * imported history shape every algorithm in this directory:
 *
 *   * `reviews.grade` is NULL on all 103,110 rows. Mochi recorded only
 *     `remembered?`, so the 1-4 Again/Hard/Good/Easy scale does not exist here.
 *     Every candidate is fed the documented binary mapping: remembered -> Good
 *     (3), forgotten -> Again (1). Nothing in the corpus can identify a
 *     parameter that only Hard or Easy touches; see FSRS6_UNIDENTIFIABLE.
 *   * Every review timestamp is date-only (SPEC "Review timestamps — the one
 *     that cannot wait"), so elapsed time is an integer number of days and a
 *     same-day review has elapsed 0 — meaning "unknown, somewhere under a day",
 *     not "zero time". backtest.ts excludes those from scoring by default and
 *     says so; they still update state, because they really happened.
 *   * The intervals are the ones Mochi chose. Nothing here observes what would
 *     have happened at an interval Mochi never scheduled.
 *
 * The interface is deliberately narrow — init / predict / next — so a candidate
 * cannot accidentally see the outcome it is predicting. `next` receives the
 * outcome; `predict` receives only the state and the elapsed time.
 */

/** Mochi has no grade scale; the binary mapping is Again or Good. */
export const GRADE_AGAIN = 1;
export const GRADE_HARD = 2;
export const GRADE_GOOD = 3;
export const GRADE_EASY = 4;

export type Grade = 1 | 2 | 3 | 4;

/** One review as a candidate sees it. `elapsedDays` is 0 on a track's first. */
export interface ReviewObservation {
  /** 0-based position within its track, chronological. */
  readonly ordinal: number;
  /** Days since the previous review of the same track. Integral: date-only log. */
  readonly elapsedDays: number;
  readonly remembered: 0 | 1;
  readonly grade: Grade;
}

/**
 * A memory model. `S` is whatever state the algorithm carries; it never leaves
 * the algorithm, because `erase` closes over it.
 */
export interface Scheduler<S> {
  readonly id: string;
  readonly name: string;
  /** One line, printed in the report, naming the parameters actually used. */
  readonly detail: string;
  /** State after a track's FIRST review, which no model can have predicted. */
  init(first: ReviewObservation): S;
  /** P(recall) for a review that comes `elapsedDays` after the state was set. */
  predict(state: S, elapsedDays: number): number;
  /**
   * State after the review. `retrievability` is what `predict` just returned,
   * passed in rather than recomputed so the two can never disagree.
   */
  next(state: S, observation: ReviewObservation, retrievability: number): S;
  /**
   * The interval this model would schedule from `state` to land on
   * `targetRetention`. Null when the model has no notion of one (the constant
   * baseline). Used by the target-retention workload estimate, not by scoring.
   */
  intervalFor(state: S, targetRetention: number): number | null;
  /** Memory stability in days, for models that have it. Reporting only. */
  stabilityOf(state: S): number | null;
}

/** A scheduler with its state type erased, which is what the harness replays. */
export interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  /**
   * Replay one track in order, calling `emit` once per review that has a
   * predecessor — i.e. every review except the first, which is the one that
   * creates the memory rather than testing it.
   */
  replayTrack<R extends ReviewObservation>(
    reviews: readonly R[],
    emit: (review: R, predicted: number) => void,
  ): void;
  /** Interval at `targetRetention` after replaying the whole track. */
  intervalAfter(reviews: readonly ReviewObservation[], targetRetention: number): number | null;
  /** Stability in days after replaying the whole track. */
  stabilityAfter(reviews: readonly ReviewObservation[]): number | null;
}

/**
 * Erase a scheduler's state type. The state is created, threaded and discarded
 * entirely inside these closures, so no caller can hand one model another
 * model's state.
 */
export function erase<S>(spec: Scheduler<S>): Candidate {
  function replay(reviews: readonly ReviewObservation[]): S | null {
    if (reviews.length === 0) return null;
    const first = reviews[0] as ReviewObservation;
    let state = spec.init(first);
    for (let i = 1; i < reviews.length; i += 1) {
      const review = reviews[i] as ReviewObservation;
      const predicted = spec.predict(state, review.elapsedDays);
      state = spec.next(state, review, predicted);
    }
    return state;
  }

  return {
    id: spec.id,
    name: spec.name,
    detail: spec.detail,
    replayTrack<R extends ReviewObservation>(
      reviews: readonly R[],
      emit: (review: R, predicted: number) => void,
    ): void {
      if (reviews.length === 0) return;
      let state = spec.init(reviews[0] as R);
      for (let i = 1; i < reviews.length; i += 1) {
        const review = reviews[i] as R;
        const predicted = spec.predict(state, review.elapsedDays);
        emit(review, predicted);
        state = spec.next(state, review, predicted);
      }
    },
    intervalAfter(reviews: readonly ReviewObservation[], targetRetention: number): number | null {
      const state = replay(reviews);
      return state === null ? null : spec.intervalFor(state, targetRetention);
    },
    stabilityAfter(reviews: readonly ReviewObservation[]): number | null {
      const state = replay(reviews);
      return state === null ? null : spec.stabilityOf(state);
    },
  };
}

/**
 * An exponential forgetting curve pinned so that R = `base` at `intervalDays`.
 *
 * This is how an interval scheduler that has no probability model — SM-2, the
 * fixed multiplier — is turned into one: it believes it is scheduling for `base`
 * retention at the interval it chose, so R(t) = base^(t / interval). Anki's
 * classic default of 0.9 is the base. Stated explicitly because it is a
 * modelling choice made BY THIS HARNESS and not by SM-2: a scheduler that only
 * emits intervals cannot be scored on log loss without one, and the choice of
 * curve shape (exponential here, power for FSRS) affects the score
 * independently of the interval logic. backtest.ts scores SM-2 under both
 * curves for exactly that reason.
 */
export function exponentialRecall(intervalDays: number, elapsedDays: number, base = 0.9): number {
  if (!(intervalDays > 0)) return base;
  return Math.pow(base, elapsedDays / intervalDays);
}

/** Inverse of `exponentialRecall`: the interval that lands on `target`. */
export function exponentialInterval(intervalDays: number, target: number, base = 0.9): number {
  if (!(intervalDays > 0)) return 0;
  return (intervalDays * Math.log(target)) / Math.log(base);
}

// This module deliberately re-exports NOTHING from fsrs6.ts / sm2.ts /
// baseline.ts. Those three import the shared types and curves from here, so a
// barrel export would make the directory circular; callers import each
// algorithm by name instead.
