/**
 * Stage 5 — the two floors. SPEC.html asks for "a naive fixed-multiplier as a
 * sanity floor. If a candidate cannot beat this, something is wrong with your
 * harness." There are two different floors worth having, and they fail in
 * different directions:
 *
 *   * fixedMultiplier — an interval scheduler with no memory model beyond
 *     "×2.5 when you pass, back to 1 day when you fail". It has the same shape
 *     as SM-2 with the ease frozen, so beating it means the ease adjustment is
 *     doing work.
 *   * constantRate — predicts one number for every review, forever: the base
 *     rate. It uses no history, no interval and no state, so it is the floor
 *     that says whether a candidate has learned anything at all. This is the
 *     harder floor, and it is the one a log-loss comparison most often fails to
 *     clear on a corpus this skewed — 96.24% of reviews are passes, so
 *     "always say 96%" is already a good prediction. Any candidate that cannot
 *     beat it is not a scheduler, it is noise with extra steps.
 */

import { exponentialInterval, exponentialRecall, type ReviewObservation, type Scheduler } from "./index.js";

export const FIXED_MULTIPLIER_DEFAULTS = {
  multiplier: 2.5,
  firstInterval: 1,
  lapseInterval: 1,
  assumedRetention: 0.9,
} as const;

export interface FixedMultiplierOptions {
  readonly multiplier?: number;
  readonly firstInterval?: number;
  readonly lapseInterval?: number;
  readonly assumedRetention?: number;
}

export interface FixedMultiplierState {
  readonly intervalDays: number;
}

export function fixedMultiplier(options: FixedMultiplierOptions = {}): Scheduler<FixedMultiplierState> {
  const multiplier = options.multiplier ?? FIXED_MULTIPLIER_DEFAULTS.multiplier;
  const firstInterval = options.firstInterval ?? FIXED_MULTIPLIER_DEFAULTS.firstInterval;
  const lapseInterval = options.lapseInterval ?? FIXED_MULTIPLIER_DEFAULTS.lapseInterval;
  const base = options.assumedRetention ?? FIXED_MULTIPLIER_DEFAULTS.assumedRetention;

  return {
    id: "fixed",
    name: `Fixed ×${multiplier}`,
    detail: `I <- I × ${multiplier} on pass, ${lapseInterval}d on lapse, R(t) = ${base}^(t/I)`,
    init(first: ReviewObservation): FixedMultiplierState {
      return { intervalDays: first.remembered === 1 ? firstInterval : lapseInterval };
    },
    predict(state: FixedMultiplierState, elapsedDays: number): number {
      return exponentialRecall(state.intervalDays, elapsedDays, base);
    },
    next(state: FixedMultiplierState, observation: ReviewObservation): FixedMultiplierState {
      return {
        intervalDays:
          observation.remembered === 1 ? state.intervalDays * multiplier : lapseInterval,
      };
    },
    intervalFor(state: FixedMultiplierState, targetRetention: number): number {
      return exponentialInterval(state.intervalDays, targetRetention, base);
    },
    stabilityOf(state: FixedMultiplierState): number {
      return exponentialInterval(state.intervalDays, 0.9, base);
    },
  };
}

/**
 * Predict `rate` for every review. The rate MUST come from the training window
 * only — using the whole corpus's base rate would leak the answer into the
 * held-out score, which is the exact mistake this baseline exists to expose in
 * others.
 */
export function constantRate(rate: number, label = "Constant base rate"): Scheduler<null> {
  return {
    id: "constant",
    name: label,
    detail: `P(recall) = ${(100 * rate).toFixed(2)}% for every review, from the training window`,
    init(): null {
      return null;
    },
    predict(): number {
      return rate;
    },
    next(): null {
      return null;
    },
    intervalFor(): null {
      return null;
    },
    stabilityOf(): null {
      return null;
    },
  };
}
