/**
 * Stage 5/6 — the scheduler decisions Zach has SETTLED, in one place, so that
 * no later stage re-derives them from a backtest table and quietly picks
 * something else.
 *
 * BACKTEST.md measures; this file decides. The backtest deliberately declined
 * to name a default (5 of 17 free parameters land on clamp boundaries and
 * wildly different vectors score within 0.0006 of each other), and that refusal
 * was correct as a measurement result and useless as a shipping configuration.
 * These are the answers, chosen by the user, with the measurement each one has
 * to live with recorded next to it.
 */

import { FROZEN_FSRS_WEIGHTS, GRADES_ARE_BINARY, BINARY_GRADE } from "../schema/index.js";

import { FSRS6_FITTED_PARAMETERS, type Fsrs6Parameters } from "./algorithms/fsrs6.js";

/**
 * FSRS-6, fitted to this user, binary-graded.
 *
 * The margin over the alternatives is real but small, and the honest size of it
 * is in BACKTEST.md rather than here: fitted FSRS-6 scores 0.1905 held-out log
 * loss against a constant-base-rate model's 0.2111. That is roughly a 10%
 * improvement over a model with NO INPUTS AT ALL — not the factor of four the
 * raw SM-2 row (0.8802) suggests, because 91% of SM-2's gap is its exponential
 * forgetting curve rather than its interval logic.
 */
export const SCHEDULER_ALGORITHM = "fsrs6" as const;

/**
 * Maximum interval, in days. SETTLED: one year.
 *
 * This is a policy ceiling, not a data limit, and it happens to sit exactly
 * where the evidence stops being evidence:
 *
 *   * Mochi enforced a 365-day cap from 2022-06-28 until 2026-02-22, when it
 *     was lifted (measured: the first plan beyond a year appears on that local
 *     date, and 1,356 reviews have planned beyond a year since, up to 2,707d).
 *   * The longest gap ever actually OBSERVED in the corpus is 454 days. Every
 *     one of the 3,009 reviews past a year is a late review of a card capped at
 *     365, spanning 366-454 days.
 *   * So a schedule beyond ~454 days is extrapolation off the end of the
 *     observed support, for every track. Capping at 365 keeps every interval
 *     the app issues inside the range the fit was measured on.
 *
 * Anything longer needs new observations, and the way to get them is to raise
 * this number deliberately later, not to let a model fitted on censored data
 * choose 1,000 days on its own.
 */
export const MAX_INTERVAL_DAYS = 365;

/**
 * Target retention. SETTLED: 0.90, revised down from 0.95 on 2026-08-19.
 *
 * The earlier 0.95 rested on a false inference: that because the user's realised
 * retention is 96.24% all-time and 95.10% in 2026, a 0.95 target reproduces the
 * schedule he already runs. It does not. Mochi reaches 96.24% using intervals
 * FSRS considers too long for 95%, so adopting FSRS at 0.95 means SHORTENING
 * intervals. Measured under this file's own 365-day cap (scripts/capped-load.ts,
 * against a realised 69.2 reviews/day over the last 90 active days):
 *
 *   target   median interval   reviews/day   vs realised   clipped by the cap
 *   0.95     355-365d          130-204       1.9-3.0x      49-55%
 *   0.90     365d               62-97        0.9-1.4x      71-74%
 *   0.85     365d               44-64        0.6-0.9x      81-87%
 *
 * 0.90 reproduces the load he has actually sustained for four years. 0.95 asks
 * him to roughly double it for retention he already has.
 *
 * MAX_INTERVAL_DAYS is what makes 0.90 the safe choice rather than the risky one.
 * Uncapped, 0.90 wants a median interval near 1,000 days — twice beyond anything
 * ever observed, since no review in the corpus follows an elapsed gap longer than
 * 454 days. Capped at 365 the median is 365d, inside measured territory. The two
 * constants are not independent and should not be changed independently.
 *
 * Below 0.90 the cap does the work rather than the target (81-87% of tracks
 * clipped at 0.85), so going lower means raising the cap too — and then the
 * schedule is extrapolating again.
 */
export const TARGET_RETENTION = 0.9;

/**
 * The 21 FSRS-6 weights the app schedules with. SETTLED: the fitted vector,
 * marked PROVISIONAL — BACKTEST.md's recommendation 2, verbatim: "Ship it with
 * the fitted parameters, marked provisional, and refit automatically once there
 * is a year of reviews carrying real timestamps".
 *
 * The margin is 6.5% of held-out log loss over the stock vector (0.2038 ->
 * 0.1905), which is worth having and is not worth reading: refitting with a
 * different sweep budget lands within 0.0006 of the same training loss on a
 * COMPLETELY DIFFERENT vector, so no individual weight here means anything. The
 * fit's real content is the decay — w[20] 0.1542 -> 0.100, a flatter forgetting
 * curve — and the stability update.
 *
 * So: do not tune these by hand, do not read them as facts about him, and do
 * not replace them with anything other than the fitter's output on his own
 * history. `PARAMETERS_ARE_PROVISIONAL` is exported so anything that prints the
 * configuration says so.
 */
export const SCHEDULER_PARAMETERS: Fsrs6Parameters = FSRS6_FITTED_PARAMETERS;

/** True until a refit on reviews carrying real timestamps replaces the above. */
export const PARAMETERS_ARE_PROVISIONAL = true as const;

/**
 * FSRS-6 weights that are UNREACHABLE BY DESIGN.
 *
 * READ THIS BEFORE "IMPROVING" IT. These are not unfitted for lack of data, and
 * collecting more history will never reach them. Hashigo records `remembered`
 * and nothing else: Anki's four-button Again/Hard/Good/Easy was considered and
 * REJECTED, so ratings 2 (Hard) and 4 (Easy) cannot occur, in this corpus or in
 * any future one. w[15] is the Hard penalty and applies only at rating 2;
 * w[16] is the Easy bonus and applies only at rating 4. They are frozen at
 * their published defaults, permanently, and no number in BACKTEST.md depends
 * on them.
 *
 * The upside is worth stating rather than treating this as a limitation: the
 * scheduler is fitted on exactly the signal it receives in production, so there
 * is no train/serve distribution shift. A four-button model fitted on
 * four-button history and then fed binary grades would have one.
 *
 * (w[1] and w[3], the initial stabilities for Hard and Easy, are unreachable
 * for the same reason and are frozen alongside them — see
 * FSRS6_UNIDENTIFIABLE in algorithms/fsrs6.ts, which is the full list the
 * fitter freezes. FROZEN_FSRS_WEIGHTS names the two the schema calls out.)
 */
export const UNREACHABLE_BY_DESIGN: readonly number[] = FROZEN_FSRS_WEIGHTS;

/** Why, in one string, for anything that prints the frozen set. */
export const UNREACHABLE_REASON =
  "unreachable by design: grades are binary (Again/Good), so ratings 2 and 4 never occur";

/**
 * The whole settled configuration, as one object, for callers that want to log
 * or persist it.
 */
export const SCHEDULER_POLICY = {
  algorithm: SCHEDULER_ALGORITHM,
  maxIntervalDays: MAX_INTERVAL_DAYS,
  targetRetention: TARGET_RETENTION,
  parameters: SCHEDULER_PARAMETERS,
  parametersAreProvisional: PARAMETERS_ARE_PROVISIONAL,
  gradesAreBinary: GRADES_ARE_BINARY,
  grades: BINARY_GRADE,
  unreachableWeights: UNREACHABLE_BY_DESIGN,
  unreachableReason: UNREACHABLE_REASON,
} as const;

/**
 * Apply the ceiling. Every interval the app issues goes through here, so that
 * "capped at 365" is one function rather than a convention six call sites are
 * each expected to remember.
 *
 * Also floors at one day: a scheduler that returns 0.4 days means "again
 * today", and the review queue is a day-grained thing.
 */
export function clampInterval(days: number, maxIntervalDays = MAX_INTERVAL_DAYS): number {
  if (!Number.isFinite(days)) return maxIntervalDays;
  return Math.min(maxIntervalDays, Math.max(1, days));
}
