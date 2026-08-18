/**
 * Stage 5 — SM-2, the Anki-classic candidate.
 *
 * SM-2 is an INTERVAL scheduler: it emits "see this again in N days" and has no
 * probability model at all. To score it on log loss the harness has to supply
 * one, and the supplied one is the assumption SM-2 itself is built on — that the
 * interval it chose is the interval at which retention is 90%. So
 * R(t) = 0.9 ^ (t / I_sm2), an exponential curve pinned at its own schedule.
 * That choice belongs to this harness, not to SM-2, and BACKTEST.md scores the
 * same interval logic under FSRS's power curve as well so the two effects can be
 * told apart.
 *
 * BINARY GRADES. SM-2's ease update needs a 0-5 quality. Mochi recorded only
 * `remembered?`, so this maps remembered -> q = 4 and forgotten -> q = 2, and
 * runs the published formula
 *
 *     EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
 *
 * which gives exactly 0 for q = 4 and -0.32 for q = 2. The consequence is worth
 * stating because it is visible in the results: with binary grades SM-2's ease
 * factor can only ever fall. Anki's own variant uses -0.20 on Again and 0 on
 * Good, which is the same shape with a gentler slope; `Sm2Options` exposes both
 * so the difference is measurable rather than argued about.
 */

import { exponentialInterval, exponentialRecall, type ReviewObservation, type Scheduler } from "./index.js";

export interface Sm2Options {
  /** Ease factor of a brand-new card. SM-2 and Anki both ship 2.5. */
  readonly initialEase?: number;
  /** Floor on the ease factor. SM-2 and Anki both ship 1.3. */
  readonly minimumEase?: number;
  /** First interval after a successful first review, in days. */
  readonly firstInterval?: number;
  /** Second interval, SM-2's I(2) = 6 days. */
  readonly secondInterval?: number;
  /** Interval a lapse drops to, in days. */
  readonly lapseInterval?: number;
  /**
   * Ease delta on a lapse. Null uses the published SM-2 quality formula at
   * q = 2, which is -0.32. Anki uses -0.20.
   */
  readonly lapseEaseDelta?: number | null;
  /** Retention the scheduler believes its own interval achieves. */
  readonly assumedRetention?: number;
  /** Use FSRS's power curve instead of the exponential one. Sensitivity check. */
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
  /** Consecutive successes; SM-2's `n`, reset to 0 by a lapse. */
  readonly repetition: number;
}

/** The published quality formula, for q in 0..5. */
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

  /** The same curve family FSRS uses, pinned so R = base at t = interval. */
  function powerRecall(intervalDays: number, elapsedDays: number, d: number): number {
    if (!(intervalDays > 0)) return base;
    const factor = Math.exp(Math.log(base) / -d) - 1;
    return Math.pow((elapsedDays / intervalDays) * factor + 1, -d);
  }

  /** Inverse of whichever curve is in use. */
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
      // q = 4 leaves the ease untouched, which is the published formula's own
      // answer and not a shortcut: easeDelta(4) === 0.
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
      // SM-2 has no target-retention knob; this is what its own curve implies,
      // which is the only honest way to put it on the same axis as FSRS.
      return intervalAt(state, targetRetention);
    },

    stabilityOf(state: Sm2State): number {
      // Stability is defined as the interval at 90%, so it is the curve's own
      // answer there — which equals the SM-2 interval exactly when base = 0.9.
      return intervalAt(state, 0.9);
    },
  };
}
