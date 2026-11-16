export const GRADE_AGAIN = 1;
export const GRADE_HARD = 2;
export const GRADE_GOOD = 3;
export const GRADE_EASY = 4;

export type Grade = 1 | 2 | 3 | 4;

export interface ReviewObservation {
  readonly ordinal: number;
  readonly elapsedDays: number;
  readonly remembered: 0 | 1;
  readonly grade: Grade;
}

export interface Scheduler<S> {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  init(first: ReviewObservation): S;
  predict(state: S, elapsedDays: number): number;
  next(state: S, observation: ReviewObservation, retrievability: number): S;
  intervalFor(state: S, targetRetention: number): number | null;
  stabilityOf(state: S): number | null;
}

export interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  replayTrack<R extends ReviewObservation>(
    reviews: readonly R[],
    emit: (review: R, predicted: number) => void,
  ): void;
  intervalAfter(reviews: readonly ReviewObservation[], targetRetention: number): number | null;
  stabilityAfter(reviews: readonly ReviewObservation[]): number | null;
}

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

export function exponentialRecall(intervalDays: number, elapsedDays: number, base = 0.9): number {
  if (!(intervalDays > 0)) return base;
  return Math.pow(base, elapsedDays / intervalDays);
}

export function exponentialInterval(intervalDays: number, target: number, base = 0.9): number {
  if (!(intervalDays > 0)) return 0;
  return (intervalDays * Math.log(target)) / Math.log(base);
}

