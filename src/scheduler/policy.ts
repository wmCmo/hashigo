import { FROZEN_FSRS_WEIGHTS, GRADES_ARE_BINARY, BINARY_GRADE } from "../schema/index.js";

import { FSRS6_FITTED_PARAMETERS, type Fsrs6Parameters } from "./algorithms/fsrs6.js";

export const SCHEDULER_ALGORITHM = "fsrs6" as const;

export const MAX_INTERVAL_DAYS = 365;

export const TARGET_RETENTION = 0.9;

export const SCHEDULER_PARAMETERS: Fsrs6Parameters = FSRS6_FITTED_PARAMETERS;

export const PARAMETERS_ARE_PROVISIONAL = true as const;

export const INTERVAL_FUZZ = 0.05;

export const FUZZ_MAY_EXCEED_MAX_INTERVAL = true as const;

export const UNREACHABLE_BY_DESIGN: readonly number[] = FROZEN_FSRS_WEIGHTS;

export const UNREACHABLE_REASON =
  "unreachable by design: grades are binary (Again/Good), so ratings 2 and 4 never occur";

export const SCHEDULER_POLICY = {
  algorithm: SCHEDULER_ALGORITHM,
  maxIntervalDays: MAX_INTERVAL_DAYS,
  targetRetention: TARGET_RETENTION,
  intervalFuzz: INTERVAL_FUZZ,
  parameters: SCHEDULER_PARAMETERS,
  parametersAreProvisional: PARAMETERS_ARE_PROVISIONAL,
  gradesAreBinary: GRADES_ARE_BINARY,
  grades: BINARY_GRADE,
  unreachableWeights: UNREACHABLE_BY_DESIGN,
  unreachableReason: UNREACHABLE_REASON,
} as const;

export function clampInterval(days: number, maxIntervalDays = MAX_INTERVAL_DAYS): number {
  if (!Number.isFinite(days)) return maxIntervalDays;
  return Math.min(maxIntervalDays, Math.max(1, days));
}
