import type { ReviewObservation, Scheduler } from "./index.js";

export const FSRS6_PARAMETER_COUNT = 21;

export type Fsrs6Parameters = readonly number[];

export const FSRS6_DEFAULT_PARAMETERS: Fsrs6Parameters = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
  0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

export const FSRS6_UNIDENTIFIABLE: readonly number[] = [1, 3, 15, 16];

export const FSRS6_UNREACHABLE_BY_DESIGN: readonly number[] = [15, 16];

export function respectsFrozenWeights(
  w: Fsrs6Parameters,
  frozen: readonly number[] = FSRS6_UNIDENTIFIABLE,
): boolean {
  return frozen.every((i) => w[i] === FSRS6_DEFAULT_PARAMETERS[i]);
}

const S_MIN = 0.001;
const S_MAX = 36_500;
const D_MIN = 1;
const D_MAX = 10;
const INIT_S_MAX = 100;

export const FSRS6_CLAMPS: readonly (readonly [number, number])[] = [
  [S_MIN, INIT_S_MAX],
  [S_MIN, INIT_S_MAX],
  [S_MIN, INIT_S_MAX],
  [S_MIN, INIT_S_MAX],
  [D_MIN, D_MAX],
  [0.001, 4],
  [0.001, 4],
  [0.001, 0.75],
  [0, 4.5],
  [0, 0.8],
  [0.001, 3.5],
  [0.001, 5],
  [0.001, 0.25],
  [0.001, 0.9],
  [0, 4],
  [0, 1],
  [1, 6],
  [0, 2],
  [0, 2],
  [0, 0.8],
  [0.1, 0.8],
];

export interface Fsrs6State {
  readonly stability: number;
  readonly difficulty: number;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export function clampFsrs6Parameters(w: Fsrs6Parameters): number[] {
  if (w.length !== FSRS6_PARAMETER_COUNT) {
    throw new RangeError(`FSRS-6 takes ${FSRS6_PARAMETER_COUNT} parameters, got ${w.length}`);
  }
  return w.map((value, index) => {
    const range = FSRS6_CLAMPS[index] as readonly [number, number];
    return clamp(value, range[0], range[1]);
  });
}

export function powerForgettingCurve(w: Fsrs6Parameters, elapsedDays: number, stability: number): number {
  const decay = -(w[20] as number);
  const factor = Math.exp(Math.log(0.9) / decay) - 1;
  return Math.pow((elapsedDays / stability) * factor + 1, decay);
}

export function fsrs6NextInterval(
  w: Fsrs6Parameters,
  stability: number,
  targetRetention: number,
): number {
  const decay = -(w[20] as number);
  const factor = Math.exp(Math.log(0.9) / decay) - 1;
  return (stability / factor) * (Math.pow(targetRetention, 1 / decay) - 1);
}

function initStability(w: Fsrs6Parameters, grade: number): number {
  return w[Math.min(Math.max(grade - 1, 0), 3)] as number;
}

function initDifficulty(w: Fsrs6Parameters, grade: number): number {
  return (w[4] as number) - Math.exp((w[5] as number) * (grade - 1)) + 1;
}

function nextDifficulty(w: Fsrs6Parameters, difficulty: number, grade: number): number {
  const deltaD = -(w[6] as number) * (grade - 3);
  const damped = difficulty + ((10 - difficulty) * deltaD) / 9;
  return (w[7] as number) * (initDifficulty(w, 4) - damped) + damped;
}

function stabilityAfterSuccess(
  w: Fsrs6Parameters,
  lastS: number,
  lastD: number,
  r: number,
  grade: number,
): number {
  const hardPenalty = grade === 2 ? (w[15] as number) : 1;
  const easyBonus = grade === 4 ? (w[16] as number) : 1;
  return (
    lastS *
    (Math.exp(w[8] as number) *
      (11 - lastD) *
      Math.pow(lastS, -(w[9] as number)) *
      (Math.exp((1 - r) * (w[10] as number)) - 1) *
      hardPenalty *
      easyBonus +
      1)
  );
}

function stabilityAfterFailure(
  w: Fsrs6Parameters,
  lastS: number,
  lastD: number,
  r: number,
): number {
  const candidate =
    (w[11] as number) *
    Math.pow(lastD, -(w[12] as number)) *
    (Math.pow(lastS + 1, w[13] as number) - 1) *
    Math.exp((1 - r) * (w[14] as number));
  const ceiling = lastS / Math.exp((w[17] as number) * (w[18] as number));
  return Math.min(candidate, ceiling);
}

function stabilityShortTerm(w: Fsrs6Parameters, lastS: number, grade: number): number {
  const sinc =
    Math.exp((w[17] as number) * (grade - 3 + (w[18] as number))) *
    Math.pow(lastS, -(w[19] as number));
  return lastS * (grade >= 2 ? Math.max(sinc, 1) : sinc);
}

export function fsrs6Step(
  w: Fsrs6Parameters,
  state: Fsrs6State,
  elapsedDays: number,
  grade: number,
  retrievability: number,
): Fsrs6State {
  const lastS = clamp(state.stability, S_MIN, S_MAX);
  const lastD = clamp(state.difficulty, D_MIN, D_MAX);
  const stability =
    elapsedDays === 0
      ? stabilityShortTerm(w, lastS, grade)
      : grade === 1
        ? stabilityAfterFailure(w, lastS, lastD, retrievability)
        : stabilityAfterSuccess(w, lastS, lastD, retrievability, grade);
  return {
    stability: clamp(stability, S_MIN, S_MAX),
    difficulty: clamp(nextDifficulty(w, lastD, grade), D_MIN, D_MAX),
  };
}

export function fsrs6(
  parameters: Fsrs6Parameters = FSRS6_DEFAULT_PARAMETERS,
  labels: { readonly id?: string; readonly name?: string; readonly detail?: string } = {},
): Scheduler<Fsrs6State> {
  const w = clampFsrs6Parameters(parameters);
  return {
    id: labels.id ?? "fsrs6",
    name: labels.name ?? "FSRS-6",
    detail: labels.detail ?? `w = [${w.map((v) => v.toFixed(4)).join(", ")}]`,
    init(first: ReviewObservation): Fsrs6State {
      return {
        stability: clamp(initStability(w, first.grade), S_MIN, S_MAX),
        difficulty: clamp(initDifficulty(w, first.grade), D_MIN, D_MAX),
      };
    },
    predict(state: Fsrs6State, elapsedDays: number): number {
      return powerForgettingCurve(w, elapsedDays, state.stability);
    },
    next(state: Fsrs6State, observation: ReviewObservation, retrievability: number): Fsrs6State {
      return fsrs6Step(w, state, observation.elapsedDays, observation.grade, retrievability);
    },
    intervalFor(state: Fsrs6State, targetRetention: number): number {
      return fsrs6NextInterval(w, state.stability, targetRetention);
    },
    stabilityOf(state: Fsrs6State): number {
      return state.stability;
    },
  };
}

export interface Fsrs6TrainingSet {
  readonly trackOffsets: Int32Array;
  readonly elapsedDays: Float64Array;
  readonly remembered: Uint8Array;
  readonly scored: Uint8Array;
}

const PROB_EPSILON = 1e-6;

export function fsrs6Loss(
  w: Fsrs6Parameters,
  set: Fsrs6TrainingSet,
): { readonly loss: number; readonly scored: number } {
  const w0 = w[0] as number;
  const w2 = w[2] as number;
  const w4 = w[4] as number;
  const w5 = w[5] as number;
  const w6 = w[6] as number;
  const w7 = w[7] as number;
  const w8 = w[8] as number;
  const w9 = w[9] as number;
  const w10 = w[10] as number;
  const w11 = w[11] as number;
  const w12 = w[12] as number;
  const w13 = w[13] as number;
  const w14 = w[14] as number;
  const w17 = w[17] as number;
  const w18 = w[18] as number;
  const w19 = w[19] as number;
  const decay = -(w[20] as number);
  const factor = Math.exp(Math.log(0.9) / decay) - 1;
  const expW8 = Math.exp(w8);
  const initEasyD = w4 - Math.exp(w5 * 3) + 1;
  const failureCeilingDivisor = Math.exp(w17 * w18);
  const initSGood = clamp(w2, S_MIN, S_MAX);
  const initSAgain = clamp(w0, S_MIN, S_MAX);
  const initDGood = clamp(w4 - Math.exp(w5 * 2) + 1, D_MIN, D_MAX);
  const initDAgain = clamp(w4 - 1 + 1, D_MIN, D_MAX);

  const { trackOffsets, elapsedDays, remembered, scored } = set;
  const tracks = trackOffsets.length - 1;
  let total = 0;
  let count = 0;

  for (let track = 0; track < tracks; track += 1) {
    const from = trackOffsets[track] as number;
    const to = trackOffsets[track + 1] as number;
    if (to <= from) continue;
    const firstPassed = remembered[from] === 1;
    let s = firstPassed ? initSGood : initSAgain;
    let d = firstPassed ? initDGood : initDAgain;

    for (let i = from + 1; i < to; i += 1) {
      const t = elapsedDays[i] as number;
      const passed = remembered[i] === 1;
      const grade = passed ? 3 : 1;

      const r = Math.pow((t / s) * factor + 1, decay);
      if (scored[i] === 1) {
        const p = r < PROB_EPSILON ? PROB_EPSILON : r > 1 - PROB_EPSILON ? 1 - PROB_EPSILON : r;
        total += passed ? -Math.log(p) : -Math.log(1 - p);
        count += 1;
      }

      let newS: number;
      if (t === 0) {
        const sinc = Math.exp(w17 * (grade - 3 + w18)) * Math.pow(s, -w19);
        newS = s * (grade >= 2 ? (sinc > 1 ? sinc : 1) : sinc);
      } else if (passed) {
        newS = s * (expW8 * (11 - d) * Math.pow(s, -w9) * (Math.exp((1 - r) * w10) - 1) + 1);
      } else {
        const candidate =
          w11 * Math.pow(d, -w12) * (Math.pow(s + 1, w13) - 1) * Math.exp((1 - r) * w14);
        const ceiling = s / failureCeilingDivisor;
        newS = candidate < ceiling ? candidate : ceiling;
      }

      const deltaD = -w6 * (grade - 3);
      const damped = d + ((10 - d) * deltaD) / 9;
      const reverted = w7 * (initEasyD - damped) + damped;

      s = newS < S_MIN ? S_MIN : newS > S_MAX ? S_MAX : newS;
      d = reverted < D_MIN ? D_MIN : reverted > D_MAX ? D_MAX : reverted;
    }
  }

  return { loss: count === 0 ? Number.NaN : total / count, scored: count };
}

export interface Fsrs6FitOptions {
  readonly sweeps?: number;
  readonly evaluationsPerParameter?: number;
  readonly frozen?: readonly number[];
  readonly initial?: Fsrs6Parameters;
  readonly tolerance?: number;
  readonly onSweep?: (sweep: number, loss: number, w: readonly number[]) => void;
}

export interface Fsrs6FitResult {
  readonly parameters: readonly number[];
  readonly initialLoss: number;
  readonly loss: number;
  readonly sweeps: number;
  readonly evaluations: number;
  readonly scored: number;
  readonly frozen: readonly number[];
  readonly elapsedMs: number;
}

const PHI = (Math.sqrt(5) - 1) / 2;

function goldenSection(
  f: (x: number) => number,
  low: number,
  high: number,
  evaluations: number,
): { readonly x: number; readonly y: number } {
  let a = low;
  let b = high;
  let c = b - (b - a) * PHI;
  let d = a + (b - a) * PHI;
  let fc = f(c);
  let fd = f(d);
  let best = fc < fd ? { x: c, y: fc } : { x: d, y: fd };
  for (let i = 2; i < evaluations; i += 1) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - (b - a) * PHI;
      fc = f(c);
      if (fc < best.y) best = { x: c, y: fc };
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + (b - a) * PHI;
      fd = f(d);
      if (fd < best.y) best = { x: d, y: fd };
    }
  }
  return best;
}

export function fitFsrs6(set: Fsrs6TrainingSet, options: Fsrs6FitOptions = {}): Fsrs6FitResult {
  const started = Date.now();
  const sweeps = options.sweeps ?? 8;
  const perParameter = options.evaluationsPerParameter ?? 20;
  const tolerance = options.tolerance ?? 1e-6;
  const frozen = new Set(options.frozen ?? FSRS6_UNIDENTIFIABLE);
  const w = clampFsrs6Parameters(options.initial ?? FSRS6_DEFAULT_PARAMETERS);

  let evaluations = 0;
  const evaluate = (candidate: readonly number[]): number => {
    evaluations += 1;
    return fsrs6Loss(candidate, set).loss;
  };

  const initialLoss = evaluate(w);
  let loss = initialLoss;
  let sweep = 0;

  for (; sweep < sweeps; sweep += 1) {
    const before = loss;
    for (let index = 0; index < FSRS6_PARAMETER_COUNT; index += 1) {
      if (frozen.has(index)) continue;
      const [low, high] = FSRS6_CLAMPS[index] as readonly [number, number];
      const original = w[index] as number;
      const probe = goldenSection(
        (x) => {
          w[index] = x;
          const value = evaluate(w);
          w[index] = original;
          return value;
        },
        low,
        high,
        perParameter,
      );
      if (probe.y < loss) {
        w[index] = probe.x;
        loss = probe.y;
      }
    }
    options.onSweep?.(sweep + 1, loss, [...w]);
    if (before - loss < tolerance) {
      sweep += 1;
      break;
    }
  }

  return {
    parameters: [...w],
    initialLoss,
    loss,
    sweeps: sweep,
    evaluations,
    scored: fsrs6Loss(w, set).scored,
    frozen: [...frozen].sort((a, b) => a - b),
    elapsedMs: Date.now() - started,
  };
}

export const FSRS6_FITTED_PARAMETERS: Fsrs6Parameters = [
  0.212, 1.2931, 3.28122, 8.2956, 1.00059, 1.32572, 3.1824, 0.001, 2.13985, 0.44334, 2.25277,
  2.29425, 0.00101646, 0.188816, 2.02002, 0.6014, 1.8729, 1.50345, 0.834068, 0.0000528856, 0.100046,
];
