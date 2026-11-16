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

export interface TrackMemory {
  readonly stability: number;
  readonly difficulty: number;
}

export interface GradeRequest {
  readonly memory: TrackMemory | null;
  readonly elapsedDays: number;
  readonly remembered: 0 | 1;
  readonly targetRetention?: number;
  readonly maxIntervalDays?: number;
  readonly parameters?: Fsrs6Parameters;
  readonly fuzzKey?: number;
  readonly fuzzWidth?: number;
}

export interface GradeResult {
  readonly memory: TrackMemory;
  readonly grade: BinaryGrade;
  readonly retrievability: number | null;
  readonly intervalDays: number;
  readonly cappedIntervalDays: number;
  readonly rawIntervalDays: number;
  readonly clippedByCap: boolean;
  readonly firstReview: boolean;
}

const DEFAULT_MODEL = fsrs6(SCHEDULER_PARAMETERS);

function modelFor(parameters: Fsrs6Parameters | undefined) {
  return parameters === undefined ? DEFAULT_MODEL : fsrs6(parameters);
}

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

function hash32(key: number): number {
  let x = (key + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return (x ^ (x >>> 15)) >>> 0;
}

export function dailyOrderKey(dayNumber: number, trackId: number): number {
  return hash32(Math.imul(dayNumber, 0x9e3779b1) ^ trackId);
}

export function fuzzFactor(key: number, width: number = INTERVAL_FUZZ): number {
  return (hash32(key) / 0x1_0000_0000) * 2 * width - width;
}

export function fuzzInterval(
  intervalDays: number,
  key: number,
  width: number = INTERVAL_FUZZ,
): number {
  if (intervalDays <= 2) return intervalDays;
  return Math.max(1, Math.round(intervalDays * (1 + fuzzFactor(key, width))));
}

function observation(elapsedDays: number, grade: BinaryGrade): ReviewObservation {
  return { ordinal: 0, elapsedDays, remembered: grade === 3 ? 1 : 0, grade };
}

export function retrievabilityOf(
  memory: TrackMemory,
  elapsedDays: number,
  parameters?: Fsrs6Parameters,
): number {
  return modelFor(parameters).predict(memory, elapsedDays);
}

export function intervalForMemory(
  memory: TrackMemory,
  targetRetention: number = TARGET_RETENTION,
  maxIntervalDays: number = MAX_INTERVAL_DAYS,
  parameters?: Fsrs6Parameters,
): number {
  const model = modelFor(parameters);
  return Math.round(clampInterval(intervalOf(model, memory, targetRetention), maxIntervalDays));
}

export function gradeMemory(request: GradeRequest): GradeResult {
  const model = modelFor(request.parameters);
  const targetRetention = request.targetRetention ?? TARGET_RETENTION;
  const maxIntervalDays = request.maxIntervalDays ?? MAX_INTERVAL_DAYS;
  const grade = gradeFor(request.remembered);
  const firstReview = request.memory === null;

  let memory: Fsrs6State;
  let retrievability: number | null;
  if (request.memory === null) {
    memory = model.init(observation(0, grade));
    retrievability = null;
  } else {
    const elapsedDays = Math.max(0, Math.round(request.elapsedDays));
    retrievability = model.predict(request.memory, elapsedDays);
    memory = model.next(request.memory, observation(elapsedDays, grade), retrievability);
  }

  const rawIntervalDays = intervalOf(model, memory, targetRetention);
  const cappedIntervalDays = Math.round(clampInterval(rawIntervalDays, maxIntervalDays));
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

export function serialiseMemory(memory: TrackMemory): string {
  return JSON.stringify({ stability: memory.stability, difficulty: memory.difficulty });
}

export class SchedulerStateError extends Error {
  constructor(value: string, why: string) {
    super(`card_tracks.scheduler_state is unusable — ${why}: ${value.slice(0, 120)}`);
    this.name = "SchedulerStateError";
  }
}

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
