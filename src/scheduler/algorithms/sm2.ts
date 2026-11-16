import { exponentialInterval, exponentialRecall, type ReviewObservation, type Scheduler } from "./index.js";

export interface Sm2Options {
  readonly initialEase?: number;
  readonly minimumEase?: number;
  readonly firstInterval?: number;
  readonly secondInterval?: number;
  readonly lapseInterval?: number;
  readonly lapseEaseDelta?: number | null;
  readonly assumedRetention?: number;
  readonly powerCurveDecay?: number | null;
}

export const SM2_DEFAULTS = {
  initialEase: 2.5,
  minimumEase: 1.3,
  firstInterval: 1,
  secondInterval: 6,
  lapseInterval: 1,
  lapseEaseDelta: null,
  assumedRetention: 0.9,
  powerCurveDecay: null,
} as const satisfies Required<Sm2Options>;

export interface Sm2State {
  readonly intervalDays: number;
  readonly ease: number;
  readonly repetition: number;
}

function easeDelta(quality: number): number {
  return 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
}

export function sm2(options: Sm2Options = {}): Scheduler<Sm2State> {
  const initialEase = options.initialEase ?? SM2_DEFAULTS.initialEase;
  const minimumEase = options.minimumEase ?? SM2_DEFAULTS.minimumEase;
  const firstInterval = options.firstInterval ?? SM2_DEFAULTS.firstInterval;
  const secondInterval = options.secondInterval ?? SM2_DEFAULTS.secondInterval;
  const lapseInterval = options.lapseInterval ?? SM2_DEFAULTS.lapseInterval;
  const lapseDelta = options.lapseEaseDelta ?? easeDelta(2);
  const base = options.assumedRetention ?? SM2_DEFAULTS.assumedRetention;
  const decay = options.powerCurveDecay ?? null;

  function powerRecall(intervalDays: number, elapsedDays: number, d: number): number {
    if (!(intervalDays > 0)) return base;
    const factor = Math.exp(Math.log(base) / -d) - 1;
    return Math.pow((elapsedDays / intervalDays) * factor + 1, -d);
  }

  function intervalAt(state: Sm2State, target: number): number {
    if (decay === null) return exponentialInterval(state.intervalDays, target, base);
    const factor = Math.exp(Math.log(base) / -decay) - 1;
    return (state.intervalDays / factor) * (Math.pow(target, -1 / decay) - 1);
  }

  return {
    id: decay === null ? "sm2" : "sm2-power",
    name: decay === null ? "SM-2" : "SM-2 (power curve)",
    detail:
      `ease ${initialEase} floor ${minimumEase}, I(1) ${firstInterval}d I(2) ${secondInterval}d, ` +
      `lapse -> ${lapseInterval}d and ease ${lapseDelta.toFixed(2)}, ` +
      (decay === null
        ? `R(t) = ${base}^(t/I)`
        : `R(t) = (1 + f·t/I)^-${decay} pinned at R(I) = ${base}`),

    init(first: ReviewObservation): Sm2State {
      if (first.remembered === 1) {
        return { intervalDays: firstInterval, ease: initialEase, repetition: 1 };
      }
      return {
        intervalDays: lapseInterval,
        ease: Math.max(minimumEase, initialEase + lapseDelta),
        repetition: 0,
      };
    },

    predict(state: Sm2State, elapsedDays: number): number {
      return decay === null
        ? exponentialRecall(state.intervalDays, elapsedDays, base)
        : powerRecall(state.intervalDays, elapsedDays, decay);
    },

    next(state: Sm2State, observation: ReviewObservation): Sm2State {
      if (observation.remembered === 0) {
        return {
          intervalDays: lapseInterval,
          ease: Math.max(minimumEase, state.ease + lapseDelta),
          repetition: 0,
        };
      }
      const repetition = state.repetition + 1;
      const ease = Math.max(minimumEase, state.ease + easeDelta(4));
      const intervalDays =
        repetition === 1
          ? firstInterval
          : repetition === 2
            ? secondInterval
            : state.intervalDays * ease;
      return { intervalDays, ease, repetition };
    },

    intervalFor(state: Sm2State, targetRetention: number): number {
      return intervalAt(state, targetRetention);
    },

    stabilityOf(state: Sm2State): number {
      return intervalAt(state, 0.9);
    },
  };
}
