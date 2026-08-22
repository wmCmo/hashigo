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
 *   * NAME THE BASIS, OR THE BOUNDARY IS WRONG (decision 6, applied to itself).
 *     454 days is where the ELAPSED support ends. The PLANNED support ends at
 *     365, and that is the one a cap constrains: measured 2026-08-22 by
 *     `scripts/cap-derive.ts`, all 3,009 of those gaps came from a plan of
 *     <= 365 days, and NOT ONE came from a longer plan. So 454 is not evidence
 *     about memory at 454 days -- it is Mochi's cap plus how late Zach runs.
 *     An earlier version of this comment said "a schedule beyond ~454 days is
 *     extrapolation", which mixed the two bases. A SCHEDULE beyond 365 is
 *     extrapolation, because no schedule beyond 365 was ever issued.
 *
 * The cap's real justification is therefore not the 454, and not the calendar.
 * It is that the fit's opinion about long intervals is MANUFACTURED by the
 * scheduler that produced its training data: observed retention RISES through
 * the tail (94.35% at 181-365d, 96.40% at 366-400d, 98.16% at 401-454d), which
 * memory does not do, and the fitted decay ran to its floor (0.1542 -> 0.100)
 * asking for a flatter tail still. Only cards that keep being remembered are
 * ever granted a long interval. A cap bounds how far that bias is allowed to
 * run; it is not a claim about how long a memory lasts.
 *
 * Anything longer needs new observations, and the way to get them is to raise
 * this number deliberately later, not to let a model fitted on censored data
 * choose 1,000 days on its own. What that costs is priced: 365 spends +33.3%
 * more reviews a year than no cap at all (17,314 against 12,986, ~11.9/day),
 * and 365 -> 454 buys back 3.5/day for 89 days of extrapolation. See
 * `notes/max-interval-and-relearning.md` for the full table.
 *
 * RE-RATIFIED 2026-08-22, by Zach, after he reopened it. He kept 365 on the
 * reasoning above rather than buying reviews back with extrapolation.
 *
 * THIS IS A CENTRE, NOT A CEILING. Interval fuzz is applied AFTER the cap, so an
 * issued interval can reach 383 days -- 18 days, 4.9%, past where the planned
 * support ends. That is a deliberate small extrapolation and he ratified it
 * knowing so; see `FUZZ_MAY_EXCEED_MAX_INTERVAL` below for the two ways of
 * "fixing" it that are measurably worse.
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
 * Uncapped, 0.90 wants a median interval of 988 days. Capped at 365 the median is
 * 365d. The two constants are not independent and should not be changed
 * independently.
 *
 * (This comment used to say 988 was "twice beyond anything ever observed, since
 * no review follows an elapsed gap longer than 454 days". Same basis error as the
 * one corrected under MAX_INTERVAL_DAYS: 454 is the ELAPSED edge and is itself
 * Mochi's cap plus lateness. On the PLANNED basis the edge is 365, so 988 is
 * 2.7x beyond it, not 2.2x. The conclusion does not change and the arithmetic
 * does.)
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
 * Interval fuzz, as a fraction. SETTLED: ±5%, applied ONCE at grade time, keyed
 * PER TRACK. Zach raised it; it was missing entirely.
 *
 * WHY IT MATTERS MORE HERE THAN IN GENERAL. Fuzz is usually cosmetic. In this
 * collection it is not, because the schedule is already piled onto single days:
 * 3,650 of the 8,518 live scheduled tracks — 42.9% — sit at exactly 365 days,
 * the cap, so every heavy study day reappears as a spike one year later.
 * Re-measured 2026-08-22 by `scripts/fuzz-load.ts`, section 1, which shifts each
 * live scheduled track's due date by
 * ±5% of its OWN planned interval, i.e. "if fuzz had been applied when this plan
 * was made", grouped by local due date over 8,518 tracks and 1,194 days:
 *
 *     keying                    worst day    CV
 *     none (today)                    188   2.48
 *     per TRACK                        71   1.94
 *     downward only at the cap        104   2.05
 *     per COHORT, by due date         295   2.84      <- WORSE than none
 *     per COHORT, by interval         180   2.49      <- no better than none
 *
 * THE WIDTH WAS DERIVED, NOT COPIED FROM ANKI. The smallest width whose worst
 * day fits inside his realised sustained load is 4% on a per-active-day basis
 * (77.5/day) and 6% on BACKTEST.md's 69.2/day basis, so 5% sits between two
 * defensible bases. The table above shows the return flattening past it: ±4%
 * gives 78, ±5% gives 71, ±6% gives 73.
 *
 * TWO WAYS TO BUILD IT WRONG, both of which have been built.
 *
 *   * Keying the shift per COHORT rather than per track TRANSLATES the clump
 *     instead of spreading it, and two translated clumps can land on one day —
 *     that is the 295 above, against a baseline of 188.
 *   * Computing it when READING the queue rather than at grade time makes the
 *     due date jitter on every query. It is applied in `gradeMemory` and stored;
 *     nothing in `queue.ts` knows fuzz exists.
 *
 * IT DOES NOT INVALIDATE `BACKTEST.md`. That measured which scheduler ranks
 * best. The fuzzed value is what was PLANNED, so it is what lands in
 * `reviews.scheduled_days`, and `review_interval_audit` still passes.
 */
export const INTERVAL_FUZZ = 0.05;

/**
 * THE FUZZ IS APPLIED AFTER THE CAP, WHICH MEANS `MAX_INTERVAL_DAYS` IS NOW A
 * CENTRE AND NOT A CEILING: an issued interval can reach 383 days.
 *
 * This is the one place where decision 11 (fuzz) and decision 1 (cap at 365)
 * collide, and it is settled by measurement rather than by taste. Seeding every
 * live track from its history and asking the fitted model what it wants at 0.90
 * (`scripts/fuzz-load.ts`, section 2): the median raw interval is **988 days**, 6,669
 * of 8,961 tracks (74.4%) exceed the cap, and **6,617 of those — 99.2% — exceed
 * 384 days**, which is 365/0.95. A −5% fuzz applied BEFORE the cap therefore
 * cannot bring any of them under 365; they clamp straight back onto exactly 365
 * and the spike survives untouched. Fuzz before the cap is not a more
 * conservative choice, it is an inert one.
 *
 * THE "383 < 454" ARGUMENT THIS COMMENT USED TO MAKE IS WITHDRAWN (2026-08-22).
 * It said the overshoot stays inside the observed support because the longest
 * observed gap is 454 days. That mixes the two interval bases: 454 is the
 * ELAPSED edge, and every one of those gaps came from a plan of <= 365 days
 * (`scripts/cap-derive.ts`). On the PLANNED basis — the one a cap constrains —
 * 383 is 18 days past anything ever issued. It is a small extrapolation, but it
 * is an extrapolation, and calling it "inside observed support" was wrong.
 *
 * THE DICHOTOMY THIS COMMENT USED TO OFFER WAS ALSO FALSE. It presented "383
 * days, or accept a worst day of 104", having tested downward-only fuzz at one
 * width — the same ±5%, which is half the window and so naturally spreads
 * worse. Swept properly:
 *
 *     two-sided ±5%                worst  71   CV 1.94   cap becomes 383d
 *     downward-only, 5% width      worst 104   CV 2.05   cap stays 365d
 *     downward-only, 10% width     worst  73   CV 1.91   cap stays 365d
 *
 * Downward-only at 10% is the same 36-day window and the same spread, with a
 * slightly better CV, while leaving 365 an absolute ceiling. It costs ~2% more
 * reviews. So the load smoothing does NOT require amending the cap.
 *
 * Zach's `Math.min(fuzzed, 365)` variant is measured too and is the weakest of
 * the three: it shoves every upward-fuzzed track back onto exactly the cap, so
 * 1,892 of the 3,650 at-cap tracks — 52% — land on one day again, worst day 113.
 *
 * RATIFIED 2026-08-22: two-sided, after the cap, issued maximum 383 days. Zach
 * was shown downward-only-at-10% -- same 36-day window, worst day 73 against 71,
 * cap stays an absolute ceiling, ~2% more reviews -- and chose this instead.
 */
export const FUZZ_MAY_EXCEED_MAX_INTERVAL = true as const;

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
  intervalFuzz: INTERVAL_FUZZ,
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
 *
 * THIS IS NOT THE LAST STEP ANY MORE. `gradeMemory` applies interval fuzz after
 * this function returns, so the value that reaches `due_at` can be up to
 * `INTERVAL_FUZZ` above `maxIntervalDays`. `GradeResult.cappedIntervalDays` is
 * this function's answer; `GradeResult.intervalDays` is what ships.
 */
export function clampInterval(days: number, maxIntervalDays = MAX_INTERVAL_DAYS): number {
  if (!Number.isFinite(days)) return maxIntervalDays;
  return Math.min(maxIntervalDays, Math.max(1, days));
}
