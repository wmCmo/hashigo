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
