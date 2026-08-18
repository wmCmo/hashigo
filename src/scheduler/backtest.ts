/**
 * Stage 5 — the scheduler backtest.
 *
 * SPEC.html "Scheduling": "Replay the real history and score how well each
 * candidate predicted what actually happened, using log loss and RMSE of
 * predicted recall probability against your true grades." That is all this file
 * does. It reads the imported review log, replays every track in order through
 * each candidate, and scores the predictions. It never writes to the database.
 *
 * FIVE DECISIONS THIS HARNESS MAKES, all of them visible in the numbers and all
 * of them argued in BACKTEST.md rather than buried here:
 *
 * 1. ELAPSED TIME, NOT MOCHI'S PLANNED INTERVAL. `reviews.interval_days` is the
 *    interval Mochi PLANNED before this review; the interval that actually
 *    elapsed is the gap between consecutive review dates, and the two differ.
 *    Measured over this corpus: of 84,060 reviews where both are known, 49,050
 *    agree to within half a day, 22,226 were taken MORE than 1.5 days late and
 *    240 early. Forgetting depends on the time that passed, not on the time that
 *    was intended, so elapsed is the independent variable. It also covers 8,934
 *    reviews whose planned interval is NULL, and it is the definition under
 *    which the corpus contains 3,009 observations at intervals over a year —
 *    where the planned-interval definition contains none. `intervalSource:
 *    "planned"` reproduces the other choice for comparison.
 *
 * 2. A TRACK'S FIRST REVIEW IS NOT SCORED. It is the review that creates the
 *    memory, not one that tests it; there is no prior state and no elapsed time.
 *    9,026 of 102,020 reviews are firsts, leaving 92,994 with a predecessor.
 *
 * 3. SAME-DAY REVIEWS ARE NOT SCORED BY DEFAULT. Every timestamp in the corpus
 *    is date-only (SPEC "Review timestamps — the one that cannot wait"), so a
 *    review on the same day as its predecessor has an elapsed time of "somewhere
 *    between a minute and 23 hours", recorded as 0. Scoring a forgetting curve
 *    against an unknown elapsed time measures the harness, not the algorithm —
 *    and it does so unfairly, because an exponential curve predicts exactly 1.0
 *    at t = 0 and is then punished by the log-loss clamp for each of the 256
 *    same-day failures. Those 6,996 reviews still update state, because they
 *    really happened; they are scored in their own separate table.
 *
 * 4. GRADES ARE BINARY. `reviews.grade` is NULL on all 102,020 rows; remembered
 *    maps to Good and forgotten to Again. Four of FSRS-6's 21 parameters are
 *    unreachable as a result and the fitter freezes them.
 *
 * 5. THE FIT NEVER SEES THE EVALUATION WINDOW. Parameters are fitted on reviews
 *    before a cutoff date and scored on reviews on or after it. State for an
 *    evaluation-window review is still produced by replaying that track's
 *    earlier history — which is causal, not leakage: at the moment of the review
 *    that history had already happened.
 */

import type { Db } from "../db/index.js";
import { constantRate, fixedMultiplier } from "./algorithms/baseline.js";
import {
  FSRS6_DEFAULT_PARAMETERS,
  FSRS6_FITTED_PARAMETERS,
  fsrs6,
  type Fsrs6Parameters,
  type Fsrs6TrainingSet,
} from "./algorithms/fsrs6.js";
import {
  GRADE_AGAIN,
  GRADE_GOOD,
  erase,
  type Candidate,
  type Grade,
  type ReviewObservation,
} from "./algorithms/index.js";
import { sm2 } from "./algorithms/sm2.js";

// ─── the history, as the candidates see it ───────────────────────────────────

export interface HistoryReview extends ReviewObservation {
  readonly reviewId: number;
  readonly reviewedAt: string;
  /** `YYYY-MM-DD` in the authoring timezone; `reviewed_at` already carries it. */
  readonly localDate: string;
  /** Days actually elapsed since the previous review of this track. */
  readonly measuredElapsedDays: number | null;
  /** Mochi's planned interval for this review — the previous record's own. */
  readonly plannedIntervalDays: number | null;
  /** False when `elapsedDays` is a fallback rather than the chosen source. */
  readonly intervalKnown: boolean;
  readonly durationMs: number | null;
}

export interface TrackHistory {
  readonly trackId: number;
  readonly cardId: string;
  readonly kind: string;
  readonly deckId: string;
  readonly deckPath: string;
  readonly rootDeckId: string;
  readonly dormant: 0 | 1;
  readonly archived: 0 | 1;
  readonly reviews: readonly HistoryReview[];
}

export type IntervalSource = "elapsed" | "planned";

export interface LoadOptions {
  /**
   * Which interval the candidates are shown. `"elapsed"` (default) is the gap
   * between review dates; `"planned"` is Mochi's own `interval_days`, with the
   * measured gap as a fallback where it is NULL and `intervalKnown` false on
   * those rows so they can be excluded from scoring.
   */
  readonly intervalSource?: IntervalSource;
}

const HISTORY_SQL = `
SELECT r.id                 AS review_id,
       t.id                 AS track_id,
       t.kind               AS kind,
       t.dormant            AS dormant,
       c.id                 AS card_id,
       c.archived           AS archived,
       c.deck_id            AS deck_id,
       coalesce(dp.path, '(unknown)')     AS deck_path,
       coalesce(dp.root_id, c.deck_id)    AS root_deck_id,
       r.reviewed_at        AS reviewed_at,
       r.remembered         AS remembered,
       r.interval_days      AS planned_interval_days,
       r.duration_ms        AS duration_ms
  FROM reviews r
  JOIN card_tracks t ON t.id = r.track_id
  JOIN cards c       ON c.id = t.card_id
  LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id
 ORDER BY t.id, r.reviewed_at, r.id`;

interface HistoryRow {
  readonly review_id: number;
  readonly track_id: number;
  readonly kind: string;
  readonly dormant: number;
  readonly card_id: string;
  readonly archived: number;
  readonly deck_id: string;
  readonly deck_path: string;
  readonly root_deck_id: string;
  readonly reviewed_at: string;
  readonly remembered: number;
  readonly planned_interval_days: number | null;
  readonly duration_ms: number | null;
}

const MS_PER_DAY = 86_400_000;

/**
 * Every track that has at least one review, chronological within the track.
 *
 * Ordered by `reviewed_at` then `id`: the dates are date-only, so two reviews of
 * one track routinely share a timestamp exactly, and `reviews.id` ascends in the
 * export's own array order (see `insertPlannedTracks`), which is the only
 * remaining evidence of which came first.
 */
export function loadHistory(db: Db, options: LoadOptions = {}): readonly TrackHistory[] {
  const source = options.intervalSource ?? "elapsed";
  const rows = db.prepare(HISTORY_SQL).all() as HistoryRow[];
  const tracks: TrackHistory[] = [];

  let current: HistoryRow[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const head = current[0] as HistoryRow;
    const reviews: HistoryReview[] = [];
    let previousMillis: number | null = null;
    for (let i = 0; i < current.length; i += 1) {
      const row = current[i] as HistoryRow;
      const millis = Date.parse(row.reviewed_at);
      const measured = previousMillis === null ? null : (millis - previousMillis) / MS_PER_DAY;
      const planned = row.planned_interval_days;
      const chosen = source === "planned" ? planned : measured;
      const remembered: 0 | 1 = row.remembered === 1 ? 1 : 0;
      reviews.push({
        reviewId: row.review_id,
        ordinal: i,
        reviewedAt: row.reviewed_at,
        localDate: row.reviewed_at.slice(0, 10),
        measuredElapsedDays: measured,
        plannedIntervalDays: planned,
        // The first review of a track has no elapsed time at all; 0 keeps the
        // arithmetic total and it is never scored.
        elapsedDays: chosen ?? measured ?? 0,
        intervalKnown: i > 0 && chosen !== null,
        remembered,
        grade: (remembered === 1 ? GRADE_GOOD : GRADE_AGAIN) as Grade,
        durationMs: row.duration_ms,
      });
      previousMillis = millis;
    }
    tracks.push({
      trackId: head.track_id,
      cardId: head.card_id,
      kind: head.kind,
      deckId: head.deck_id,
      deckPath: head.deck_path,
      rootDeckId: head.root_deck_id,
      dormant: head.dormant === 1 ? 1 : 0,
      archived: head.archived === 1 ? 1 : 0,
      reviews,
    });
    current = [];
  };

  let trackId: number | null = null;
  for (const row of rows) {
    if (row.track_id !== trackId) {
      flush();
      trackId = row.track_id;
    }
    current.push(row);
  }
  flush();
  return tracks;
}

// ─── which reviews count ─────────────────────────────────────────────────────

export interface ScoringWindow {
  /** Score reviews whose local date is >= this. Null for no lower bound. */
  readonly from?: string | null;
  /** Score reviews whose local date is < this. Null for no upper bound. */
  readonly until?: string | null;
  /** Minimum elapsed days. Default 1: see decision 3 in the header. */
  readonly minElapsedDays?: number;
  /** Maximum elapsed days, exclusive. Used to isolate the same-day rows. */
  readonly maxElapsedDaysExclusive?: number | null;
}

export function isScorable(review: HistoryReview, window: ScoringWindow = {}): boolean {
  if (review.ordinal === 0) return false;
  if (!review.intervalKnown) return false;
  const minimum = window.minElapsedDays ?? 1;
  if (review.elapsedDays < minimum) return false;
  const maximum = window.maxElapsedDaysExclusive ?? null;
  if (maximum !== null && review.elapsedDays >= maximum) return false;
  if (window.from != null && review.localDate < window.from) return false;
  if (window.until != null && review.localDate >= window.until) return false;
  return true;
}

/**
 * The local date at which `fraction` of the scorable reviews have happened.
 * Used to place the train/eval cutoff by review count rather than by calendar,
 * because the study rate is not uniform over four years.
 */
export function chooseCutoff(
  tracks: readonly TrackHistory[],
  fraction: number,
  window: ScoringWindow = {},
): string {
  const dates: string[] = [];
  for (const track of tracks) {
    for (const review of track.reviews) {
      if (isScorable(review, window)) dates.push(review.localDate);
    }
  }
  dates.sort();
  const index = Math.min(dates.length - 1, Math.max(0, Math.floor(dates.length * fraction)));
  return dates[index] as string;
}

// ─── metrics ─────────────────────────────────────────────────────────────────

export interface Metrics {
  readonly reviews: number;
  readonly passed: number;
  /** The truth: passes / reviews over exactly the rows scored. */
  readonly observedRetention: number;
  readonly meanPredicted: number;
  /** Mean negative log likelihood, natural log. Lower is better. */
  readonly logLoss: number;
  /** Root mean squared error against the 0/1 outcome. Lower is better. */
  readonly rmse: number;
  /**
   * Calibration error: RMSE between mean predicted and mean observed within 50
   * equal-width bins of predicted probability, weighted by bin count. This is
   * the number that says whether "90%" means 90%; plain RMSE on a 96%-pass
   * corpus barely moves between candidates.
   */
  readonly calibrationRmse: number;
  /** Mann-Whitney AUC: does the model ORDER outcomes at all? Null if degenerate. */
  readonly auc: number | null;
}

const PROB_EPSILON = 1e-6;
const CALIBRATION_BINS = 50;

class Accumulator {
  private n = 0;
  private passed = 0;
  private sumPredicted = 0;
  private sumSquaredError = 0;
  private sumLogLoss = 0;
  private readonly binCount = new Float64Array(CALIBRATION_BINS);
  private readonly binPredicted = new Float64Array(CALIBRATION_BINS);
  private readonly binObserved = new Float64Array(CALIBRATION_BINS);
  private readonly samples: number[] | null;
  private readonly outcomes: number[] | null;

  constructor(keepSamples = false) {
    this.samples = keepSamples ? [] : null;
    this.outcomes = keepSamples ? [] : null;
  }

  add(predicted: number, remembered: 0 | 1): void {
    const p =
      predicted < PROB_EPSILON
        ? PROB_EPSILON
        : predicted > 1 - PROB_EPSILON
          ? 1 - PROB_EPSILON
          : predicted;
    this.n += 1;
    this.passed += remembered;
    this.sumPredicted += p;
    this.sumSquaredError += (p - remembered) ** 2;
    this.sumLogLoss += remembered === 1 ? -Math.log(p) : -Math.log(1 - p);
    const bin = Math.min(CALIBRATION_BINS - 1, Math.floor(p * CALIBRATION_BINS));
    this.binCount[bin] = (this.binCount[bin] as number) + 1;
    this.binPredicted[bin] = (this.binPredicted[bin] as number) + p;
    this.binObserved[bin] = (this.binObserved[bin] as number) + remembered;
    if (this.samples !== null && this.outcomes !== null) {
      this.samples.push(p);
      this.outcomes.push(remembered);
    }
  }

  get count(): number {
    return this.n;
  }

  finish(): Metrics {
    const n = this.n;
    if (n === 0) {
      return {
        reviews: 0,
        passed: 0,
        observedRetention: Number.NaN,
        meanPredicted: Number.NaN,
        logLoss: Number.NaN,
        rmse: Number.NaN,
        calibrationRmse: Number.NaN,
        auc: null,
      };
    }
    let weighted = 0;
    for (let bin = 0; bin < CALIBRATION_BINS; bin += 1) {
      const count = this.binCount[bin] as number;
      if (count === 0) continue;
      const gap = (this.binPredicted[bin] as number) / count - (this.binObserved[bin] as number) / count;
      weighted += count * gap * gap;
    }
    return {
      reviews: n,
      passed: this.passed,
      observedRetention: this.passed / n,
      meanPredicted: this.sumPredicted / n,
      logLoss: this.sumLogLoss / n,
      rmse: Math.sqrt(this.sumSquaredError / n),
      calibrationRmse: Math.sqrt(weighted / n),
      auc: this.samples === null || this.outcomes === null ? null : auc(this.samples, this.outcomes),
    };
  }
}

/**
 * Mann-Whitney U / rank AUC, ties averaged. Reported because log loss and RMSE
 * both conflate calibration with discrimination: a model can be beaten on log
 * loss purely for being over-confident while still ordering the outcomes better.
 */
export function auc(predicted: readonly number[], outcomes: readonly number[]): number | null {
  const n = predicted.length;
  const positives = outcomes.reduce((sum, y) => sum + y, 0);
  const negatives = n - positives;
  if (positives === 0 || negatives === 0) return null;
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => (predicted[a] as number) - (predicted[b] as number),
  );
  const ranks = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && (predicted[order[j + 1] as number] as number) === (predicted[order[i] as number] as number)) {
      j += 1;
    }
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[order[k] as number] = rank;
    i = j + 1;
  }
  let rankSum = 0;
  for (let k = 0; k < n; k += 1) {
    if ((outcomes[k] as number) === 1) rankSum += ranks[k] as number;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

// ─── scoring ─────────────────────────────────────────────────────────────────

/**
 * Half-open buckets, `[low, ceiling)`, labelled to read exactly on the integral
 * elapsed times this corpus has. The boundaries matter more than they look:
 * 1,109 reviews sit at exactly 365 days, so an edge written "<= 365" rather than
 * "< 366" moves a thousand rows between the last two rows of every table.
 */
export const INTERVAL_BUCKETS: readonly (readonly [string, number])[] = [
  ["same day", 1],
  ["1d", 2],
  ["2-3d", 4],
  ["4-7d", 8],
  ["8-21d", 22],
  ["22-60d", 61],
  ["61-180d", 181],
  ["181-365d", 366],
  ["> 365d", Number.POSITIVE_INFINITY],
];

export function intervalBucket(elapsedDays: number): string {
  for (const [label, ceiling] of INTERVAL_BUCKETS) {
    if (elapsedDays < ceiling) return label;
  }
  return "> 365d";
}

export interface GroupedMetrics {
  readonly group: string;
  readonly metrics: Metrics;
}

export interface CandidateScore {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  /** True when some of the scored rows were also used to fit the parameters. */
  readonly inSample: boolean;
  readonly overall: Metrics;
  readonly byDeck: readonly GroupedMetrics[];
  readonly byInterval: readonly GroupedMetrics[];
  readonly byKind: readonly GroupedMetrics[];
}

export interface CandidateSpec {
  readonly candidate: Candidate;
  /** Marks a candidate whose parameters were fitted on part of this window. */
  readonly inSample?: boolean;
}

/**
 * Replay every track through every candidate and score the reviews inside
 * `window`. One pass per candidate; each track is replayed from its own first
 * review so state is never fabricated.
 */
export function scoreCandidates(
  tracks: readonly TrackHistory[],
  specs: readonly CandidateSpec[],
  window: ScoringWindow = {},
): readonly CandidateScore[] {
  return specs.map((spec) => {
    const overall = new Accumulator(true);
    const byDeck = new Map<string, Accumulator>();
    const byInterval = new Map<string, Accumulator>();
    const byKind = new Map<string, Accumulator>();
    const bucketFor = (map: Map<string, Accumulator>, key: string): Accumulator => {
      let acc = map.get(key);
      if (acc === undefined) {
        acc = new Accumulator();
        map.set(key, acc);
      }
      return acc;
    };

    for (const track of tracks) {
      spec.candidate.replayTrack(track.reviews, (review, predicted) => {
        if (!isScorable(review, window)) return;
        overall.add(predicted, review.remembered);
        bucketFor(byDeck, track.deckPath).add(predicted, review.remembered);
        bucketFor(byInterval, intervalBucket(review.elapsedDays)).add(predicted, review.remembered);
        bucketFor(byKind, track.kind).add(predicted, review.remembered);
      });
    }

    const grouped = (map: Map<string, Accumulator>, order?: readonly string[]): GroupedMetrics[] => {
      const rows = [...map.entries()].map(([group, acc]) => ({ group, metrics: acc.finish() }));
      if (order !== undefined) {
        return rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
      }
      return rows.sort((a, b) => b.metrics.reviews - a.metrics.reviews);
    };

    return {
      id: spec.candidate.id,
      name: spec.candidate.name,
      detail: spec.candidate.detail,
      inSample: spec.inSample === true,
      overall: overall.finish(),
      byDeck: grouped(byDeck),
      byInterval: grouped(
        byInterval,
        INTERVAL_BUCKETS.map(([label]) => label),
      ),
      byKind: grouped(byKind),
    };
  });
}

// ─── the fitter's view of the same data ──────────────────────────────────────

/**
 * Flatten to typed arrays for `fitFsrs6`. `scored` marks the rows that enter the
 * loss; every other row still advances the state, which is what makes the
 * time-ordered split causal rather than a subset.
 */
export function toTrainingSet(
  tracks: readonly TrackHistory[],
  window: ScoringWindow = {},
): Fsrs6TrainingSet {
  let total = 0;
  for (const track of tracks) total += track.reviews.length;
  const trackOffsets = new Int32Array(tracks.length + 1);
  const elapsedDays = new Float64Array(total);
  const remembered = new Uint8Array(total);
  const scored = new Uint8Array(total);
  let at = 0;
  for (let t = 0; t < tracks.length; t += 1) {
    trackOffsets[t] = at;
    const track = tracks[t] as TrackHistory;
    for (const review of track.reviews) {
      elapsedDays[at] = review.elapsedDays;
      remembered[at] = review.remembered;
      scored[at] = isScorable(review, window) ? 1 : 0;
      at += 1;
    }
  }
  trackOffsets[tracks.length] = at;
  return { trackOffsets, elapsedDays, remembered, scored };
}

// ─── measured descriptions of the corpus ─────────────────────────────────────

export interface ForgettingRow {
  readonly bucket: string;
  readonly reviews: number;
  readonly lapses: number;
  readonly observedRetention: number;
  readonly meanElapsedDays: number;
}

/**
 * Observed retention by elapsed interval — measured, not modelled. This is the
 * empirical forgetting curve, and it is NOT monotone in this corpus, which is
 * the selection bias made visible rather than merely asserted.
 */
export function measureForgetting(
  tracks: readonly TrackHistory[],
  window: ScoringWindow = { minElapsedDays: 0 },
): readonly ForgettingRow[] {
  const rows = new Map<string, { reviews: number; passed: number; sum: number }>();
  for (const track of tracks) {
    for (const review of track.reviews) {
      if (!isScorable(review, window)) continue;
      const bucket = intervalBucket(review.elapsedDays);
      const row = rows.get(bucket) ?? { reviews: 0, passed: 0, sum: 0 };
      row.reviews += 1;
      row.passed += review.remembered;
      row.sum += review.elapsedDays;
      rows.set(bucket, row);
    }
  }
  return INTERVAL_BUCKETS.filter(([label]) => rows.has(label)).map(([label]) => {
    const row = rows.get(label) as { reviews: number; passed: number; sum: number };
    return {
      bucket: label,
      reviews: row.reviews,
      lapses: row.reviews - row.passed,
      observedRetention: row.passed / row.reviews,
      meanElapsedDays: row.sum / row.reviews,
    };
  });
}

/**
 * Mean number of extra reviews a lapse costs, measured: reviews of the same
 * track within `withinDays` after a failed one. The workload model needs it
 * because a lower target retention buys longer intervals and pays in relearning,
 * and the size of that payment is in the data rather than in a rule of thumb.
 */
export function measureRelearningCost(tracks: readonly TrackHistory[], withinDays = 2): number {
  let lapses = 0;
  let followUps = 0;
  for (const track of tracks) {
    const reviews = track.reviews;
    for (let i = 0; i < reviews.length; i += 1) {
      const review = reviews[i] as HistoryReview;
      if (review.remembered === 1) continue;
      lapses += 1;
      let elapsed = 0;
      for (let j = i + 1; j < reviews.length; j += 1) {
        elapsed += (reviews[j] as HistoryReview).elapsedDays;
        if (elapsed > withinDays) break;
        followUps += 1;
      }
    }
  }
  return lapses === 0 ? 0 : followUps / lapses;
}

export interface LossConcentration {
  readonly id: string;
  readonly name: string;
  /** Scored rows the candidate put below 50% recall. */
  readonly rowsBelowHalf: number;
  /** Share of the candidate's TOTAL log loss those rows account for. */
  readonly lossShareBelowHalf: number;
  /** Share contributed by the worst 1% of rows, whatever they are. */
  readonly lossShareWorstPercent: number;
  readonly p01Predicted: number;
  readonly p50Predicted: number;
  /** Observed retention on the rows the candidate put below 50%. */
  readonly observedBelowHalf: number;
}

/**
 * Where each candidate's log loss actually comes from. Hypothesis-free on
 * purpose: log loss is a mean over 86,000 rows and a ranking between candidates
 * says nothing about whether the difference is spread evenly or concentrated in a
 * few catastrophic predictions. This says which.
 */
export function measureLossConcentration(
  tracks: readonly TrackHistory[],
  specs: readonly CandidateSpec[],
  window: ScoringWindow = {},
): readonly LossConcentration[] {
  return specs.map((spec) => {
    const predicted: number[] = [];
    const losses: number[] = [];
    let total = 0;
    let belowLoss = 0;
    let belowCount = 0;
    let belowPassed = 0;
    for (const track of tracks) {
      spec.candidate.replayTrack(track.reviews, (review, p) => {
        if (!isScorable(review, window)) return;
        const clamped = Math.min(1 - PROB_EPSILON, Math.max(PROB_EPSILON, p));
        const loss = review.remembered === 1 ? -Math.log(clamped) : -Math.log(1 - clamped);
        predicted.push(clamped);
        losses.push(loss);
        total += loss;
        if (clamped < 0.5) {
          belowLoss += loss;
          belowCount += 1;
          belowPassed += review.remembered;
        }
      });
    }
    predicted.sort((a, b) => a - b);
    losses.sort((a, b) => b - a);
    const worstCount = Math.max(1, Math.round(losses.length / 100));
    let worstLoss = 0;
    for (let i = 0; i < worstCount; i += 1) worstLoss += losses[i] as number;
    const quantile = (fraction: number): number =>
      predicted.length === 0
        ? Number.NaN
        : (predicted[Math.min(predicted.length - 1, Math.floor(predicted.length * fraction))] as number);
    return {
      id: spec.candidate.id,
      name: spec.candidate.name,
      rowsBelowHalf: belowCount,
      lossShareBelowHalf: total === 0 ? Number.NaN : belowLoss / total,
      lossShareWorstPercent: total === 0 ? Number.NaN : worstLoss / total,
      p01Predicted: quantile(0.01),
      p50Predicted: quantile(0.5),
      observedBelowHalf: belowCount === 0 ? Number.NaN : belowPassed / belowCount,
    };
  });
}

/**
 * Mochi's OWN current schedule, measured from `card_tracks.interval_days` — the
 * last interval Mochi chose for each live track. This is the anchor that makes
 * the modelled workload below auditable: run the same steady-state arithmetic
 * over Mochi's real intervals and compare its answer with the review rate the
 * user actually sustains.
 */
export interface ScheduleSummary {
  readonly label: string;
  readonly tracks: number;
  readonly medianIntervalDays: number;
  readonly meanIntervalDays: number;
  readonly reviewsPerDay: number;
}

export function measureMochiSchedule(db: Db): ScheduleSummary {
  const intervals = db
    .prepare(
      `SELECT t.interval_days AS interval_days
         FROM card_tracks t
         JOIN cards c ON c.id = t.card_id
        WHERE t.dormant = 0 AND c.archived = 0 AND t.reps > 0
          AND t.interval_days IS NOT NULL AND t.interval_days > 0
        ORDER BY t.interval_days`,
    )
    .pluck()
    .all() as number[];
  let perDay = 0;
  for (const interval of intervals) perDay += 1 / Math.max(1, interval);
  return {
    label: "Mochi's own last interval (measured)",
    tracks: intervals.length,
    medianIntervalDays: intervals.length === 0 ? Number.NaN : (intervals[intervals.length >> 1] as number),
    meanIntervalDays:
      intervals.length === 0 ? Number.NaN : intervals.reduce((a, b) => a + b, 0) / intervals.length,
    reviewsPerDay: perDay,
  };
}

export interface ScheduleCap {
  /** The modal interval among live tracks, which is where the cap sits. */
  readonly intervalDays: number;
  readonly tracksAtCap: number;
  readonly liveTracks: number;
  readonly shareAtCap: number;
  readonly reviewsScheduledAtCap: number;
  readonly reviewsScheduledAbove: number;
}

/**
 * Mochi's maximum-interval cap, found rather than assumed: the modal value of
 * `card_tracks.interval_days` over live tracks.
 *
 * This is the single most important limit on what the backtest can conclude. If
 * a large share of tracks sit on one exact value, that value is a ceiling the
 * scheduler imposed and not a memory measurement — the data says "at least this
 * long is fine" and nothing more. Every projected interval beyond it is
 * extrapolation off the end of the observed support.
 */
export function measureScheduleCap(db: Db): ScheduleCap {
  const rows = db
    .prepare(
      `SELECT t.interval_days AS interval_days, count(*) AS tracks
         FROM card_tracks t
         JOIN cards c ON c.id = t.card_id
        WHERE t.dormant = 0 AND c.archived = 0 AND t.reps > 0 AND t.interval_days IS NOT NULL
        GROUP BY t.interval_days
        ORDER BY tracks DESC, t.interval_days DESC
        LIMIT 1`,
    )
    .all() as { interval_days: number; tracks: number }[];
  const top = rows[0] ?? { interval_days: Number.NaN, tracks: 0 };
  const live = db
    .prepare(
      `SELECT count(*) FROM card_tracks t JOIN cards c ON c.id = t.card_id
        WHERE t.dormant = 0 AND c.archived = 0 AND t.reps > 0 AND t.interval_days IS NOT NULL`,
    )
    .pluck()
    .get() as number;
  const atCap = db
    .prepare(`SELECT count(*) FROM reviews WHERE next_interval_days = ?`)
    .pluck()
    .get(top.interval_days) as number;
  const above = db
    .prepare(`SELECT count(*) FROM reviews WHERE next_interval_days > ?`)
    .pluck()
    .get(top.interval_days) as number;
  return {
    intervalDays: top.interval_days,
    tracksAtCap: top.tracks,
    liveTracks: live,
    shareAtCap: live === 0 ? Number.NaN : top.tracks / live,
    reviewsScheduledAtCap: atCap,
    reviewsScheduledAbove: above,
  };
}

/** Reviews per calendar day over the last `days` days of history. Measured. */
export function measureRecentLoad(db: Db, days = 90): { readonly days: number; readonly reviewsPerDay: number } {
  const rows = db
    .prepare(
      `SELECT reviews FROM activity_by_day ORDER BY local_date DESC LIMIT ?`,
    )
    .pluck()
    .all(days) as number[];
  const total = rows.reduce((sum, value) => sum + value, 0);
  return { days: rows.length, reviewsPerDay: rows.length === 0 ? Number.NaN : total / rows.length };
}

export interface WorkloadRow {
  readonly targetRetention: number;
  readonly tracks: number;
  readonly medianIntervalDays: number;
  readonly meanIntervalDays: number;
  /** Steady state: a track with interval I contributes 1/I reviews per day. */
  readonly reviewsPerDay: number;
  /** The same, inflated by the measured cost of the lapses that target implies. */
  readonly reviewsPerDayWithRelearning: number;
}

export interface WorkloadOptions {
  /** From `measureRelearningCost`. */
  readonly relearningCost: number;
  /** Skip dormant tracks and archived cards. Default true. */
  readonly liveOnly?: boolean;
  /** Floor on the scheduled interval, in days. Default 1. */
  readonly minimumIntervalDays?: number;
}

/**
 * MODELLED, not measured, and the distinction matters more here than anywhere
 * else in this file. The measured inputs are each live track's state after its
 * real history and the relearning cost. The model is the steady-state identity
 * "a card reviewed every I days generates 1/I reviews per day", which assumes
 * the interval distribution has settled, ignores new cards entirely, and treats
 * the winning model's stability estimate as correct. It answers "what would the
 * daily load be if today's cards were scheduled at target r forever", which is
 * the question SPEC asks, and nothing more.
 */
export function estimateWorkload(
  tracks: readonly TrackHistory[],
  candidate: Candidate,
  targets: readonly number[],
  options: WorkloadOptions,
): readonly WorkloadRow[] {
  const live = (options.liveOnly ?? true)
    ? tracks.filter((track) => track.dormant === 0 && track.archived === 0)
    : tracks;
  const floor = options.minimumIntervalDays ?? 1;
  return targets.map((target) => {
    const intervals: number[] = [];
    let perDay = 0;
    for (const track of live) {
      const interval = candidate.intervalAfter(track.reviews, target);
      if (interval === null || !Number.isFinite(interval)) continue;
      const clamped = Math.max(floor, interval);
      intervals.push(clamped);
      perDay += 1 / clamped;
    }
    intervals.sort((a, b) => a - b);
    const median = intervals.length === 0 ? Number.NaN : (intervals[intervals.length >> 1] as number);
    const mean =
      intervals.length === 0 ? Number.NaN : intervals.reduce((a, b) => a + b, 0) / intervals.length;
    return {
      targetRetention: target,
      tracks: intervals.length,
      medianIntervalDays: median,
      meanIntervalDays: mean,
      reviewsPerDay: perDay,
      reviewsPerDayWithRelearning: perDay * (1 + (1 - target) * options.relearningCost),
    };
  });
}

// ─── the whole run ───────────────────────────────────────────────────────────

export interface DatasetSummary {
  readonly tracks: number;
  readonly reviews: number;
  readonly firstReviews: number;
  readonly withPredecessor: number;
  readonly sameDay: number;
  readonly sameDayLapses: number;
  readonly scorable: number;
  readonly scorablePassed: number;
  readonly plannedIntervalMissing: number;
  readonly trainReviews: number;
  readonly evalReviews: number;
  readonly cutoff: string;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly decks: number;
}

export interface BacktestOptions {
  /** Train/eval boundary as a local date. Default: the 70% point by count. */
  readonly cutoff?: string;
  readonly targetRetentions?: readonly number[];
  /** Overrides the committed fitted vector; used by the refit test. */
  readonly fittedParameters?: Fsrs6Parameters;
  /** Also score under Mochi's planned interval. Default true. */
  readonly includePlanned?: boolean;
}

export interface BacktestResult {
  readonly dataset: DatasetSummary;
  /** Every scorable review, elapsed intervals. Fitted arm flagged in-sample. */
  readonly full: readonly CandidateScore[];
  /** The held-out window only: the one table where all four are comparable. */
  readonly heldOut: readonly CandidateScore[];
  /** The 6,996 same-day reviews, scored on their own. */
  readonly sameDay: readonly CandidateScore[];
  /** Sensitivity: the same candidates under Mochi's planned interval. */
  readonly planned: readonly CandidateScore[];
  readonly forgetting: readonly ForgettingRow[];
  readonly relearningCost: number;
  /**
   * One block per model whose intervals were projected. Both the fitted and the
   * stock parameters are reported, and they turn out to agree within 5% on the
   * median interval — which is worth knowing, because it means the implausibly
   * long projections below are a property of the censored data and not of the fit.
   */
  readonly workload: readonly WorkloadBlock[];
  /** Mochi's own schedule and the review rate actually sustained. Measured. */
  readonly mochiSchedule: ScheduleSummary;
  /** Mochi's maximum-interval cap and how much of the corpus is pinned to it. */
  readonly cap: ScheduleCap;
  readonly recentLoad: { readonly days: number; readonly reviewsPerDay: number };
  /** Where each candidate's loss comes from, on the held-out window. */
  readonly concentration: readonly LossConcentration[];
  readonly trainBaseRate: number;
  readonly elapsedMs: number;
}

export interface WorkloadBlock {
  readonly candidate: string;
  readonly rows: readonly WorkloadRow[];
}

/** The candidate set SPEC names, plus the two extra rows that keep it honest. */
export function buildCandidates(options: {
  readonly fittedParameters: Fsrs6Parameters;
  readonly baseRate: number;
}): { readonly specs: readonly CandidateSpec[]; readonly fittedId: string } {
  const fitted = erase(
    fsrs6(options.fittedParameters, {
      id: "fsrs6-fitted",
      name: "FSRS-6 fitted",
      detail: "21 parameters, 17 free, fitted on the training window only",
    }),
  );
  return {
    fittedId: fitted.id,
    specs: [
      { candidate: erase(sm2()) },
      { candidate: erase(fsrs6(FSRS6_DEFAULT_PARAMETERS)) },
      { candidate: fitted, inSample: true },
      { candidate: erase(fixedMultiplier()) },
      { candidate: erase(constantRate(options.baseRate)) },
      { candidate: erase(sm2({ powerCurveDecay: 0.1542 })) },
    ],
  };
}

/**
 * Run the whole backtest against an imported database. Read-only; the caller
 * owns the connection.
 */
export function runBacktest(db: Db, options: BacktestOptions = {}): BacktestResult {
  const started = Date.now();
  const tracks = loadHistory(db);
  const cutoff = options.cutoff ?? chooseCutoff(tracks, 0.7);
  const evalWindow: ScoringWindow = { from: cutoff };

  let reviews = 0;
  let firstReviews = 0;
  let withPredecessor = 0;
  let sameDay = 0;
  let sameDayLapses = 0;
  let scorable = 0;
  let scorablePassed = 0;
  let plannedMissing = 0;
  let train = 0;
  let evaluation = 0;
  let trainPassed = 0;
  let firstDate = "9999-99-99";
  let lastDate = "0000-00-00";
  const decks = new Set<string>();

  for (const track of tracks) {
    decks.add(track.deckPath);
    for (const review of track.reviews) {
      reviews += 1;
      if (review.localDate < firstDate) firstDate = review.localDate;
      if (review.localDate > lastDate) lastDate = review.localDate;
      if (review.ordinal === 0) {
        firstReviews += 1;
        continue;
      }
      withPredecessor += 1;
      if (review.plannedIntervalDays === null) plannedMissing += 1;
      if (review.elapsedDays < 1) {
        sameDay += 1;
        if (review.remembered === 0) sameDayLapses += 1;
        continue;
      }
      scorable += 1;
      scorablePassed += review.remembered;
      if (review.localDate < cutoff) {
        train += 1;
        trainPassed += review.remembered;
      } else {
        evaluation += 1;
      }
    }
  }

  const trainBaseRate = train === 0 ? Number.NaN : trainPassed / train;
  const { specs, fittedId } = buildCandidates({
    fittedParameters: options.fittedParameters ?? FSRS6_FITTED_PARAMETERS,
    baseRate: trainBaseRate,
  });

  const full = scoreCandidates(tracks, specs);
  const heldOut = scoreCandidates(tracks, specs, evalWindow).map((score) =>
    // The fitted arm is out-of-sample HERE and only here, which is the whole
    // point of the split; every other table has it in-sample and says so.
    score.id === fittedId ? { ...score, inSample: false } : score,
  );
  const sameDayScores = scoreCandidates(tracks, specs, {
    minElapsedDays: 0,
    maxElapsedDaysExclusive: 1,
  });

  let planned: readonly CandidateScore[] = [];
  if (options.includePlanned !== false) {
    const plannedTracks = loadHistory(db, { intervalSource: "planned" });
    planned = scoreCandidates(plannedTracks, specs);
  }

  const relearningCost = measureRelearningCost(tracks);
  const targets = options.targetRetentions ?? [0.85, 0.9, 0.95];
  const workload: WorkloadBlock[] = [];
  for (const id of [fittedId, "fsrs6"]) {
    const candidate = specs.find((spec) => spec.candidate.id === id)?.candidate;
    if (candidate === undefined) continue;
    workload.push({
      candidate: candidate.name,
      rows: estimateWorkload(tracks, candidate, targets, { relearningCost }),
    });
  }

  return {
    dataset: {
      tracks: tracks.length,
      reviews,
      firstReviews,
      withPredecessor,
      sameDay,
      sameDayLapses,
      scorable,
      scorablePassed,
      plannedIntervalMissing: plannedMissing,
      trainReviews: train,
      evalReviews: evaluation,
      cutoff,
      firstDate,
      lastDate,
      decks: decks.size,
    },
    full,
    heldOut,
    sameDay: sameDayScores,
    planned,
    forgetting: measureForgetting(tracks, { minElapsedDays: 0 }),
    relearningCost,
    workload,
    mochiSchedule: measureMochiSchedule(db),
    cap: measureScheduleCap(db),
    recentLoad: measureRecentLoad(db),
    concentration: measureLossConcentration(tracks, specs, evalWindow),
    trainBaseRate,
    elapsedMs: Date.now() - started,
  };
}

// ─── report tables ───────────────────────────────────────────────────────────

function pct(value: number): string {
  return Number.isFinite(value) ? `${(100 * value).toFixed(2)}%` : "—";
}

function fixed(value: number, places = 4): string {
  return Number.isFinite(value) ? value.toFixed(places) : "—";
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** One markdown table: candidates down the side, metrics across. */
export function formatCandidateTable(scores: readonly CandidateScore[]): string {
  const ranked = [...scores].sort((a, b) => a.overall.logLoss - b.overall.logLoss);
  const lines = [
    "| Candidate | Reviews | Log loss | RMSE | Calib. RMSE | AUC | Mean predicted | Observed |",
    "|---|--:|--:|--:|--:|--:|--:|--:|",
  ];
  for (const score of ranked) {
    lines.push(
      `| ${score.name}${score.inSample ? " *(in-sample)*" : ""} | ${count(score.overall.reviews)} | ` +
        `${fixed(score.overall.logLoss)} | ${fixed(score.overall.rmse)} | ` +
        `${fixed(score.overall.calibrationRmse)} | ` +
        `${score.overall.auc === null ? "—" : fixed(score.overall.auc, 3)} | ` +
        `${pct(score.overall.meanPredicted)} | ${pct(score.overall.observedRetention)} |`,
    );
  }
  return lines.join("\n");
}

/** One metric per group, candidates across the top, so small samples are visible. */
export function formatGroupTable(
  scores: readonly CandidateScore[],
  pick: (score: CandidateScore) => readonly GroupedMetrics[],
  groupLabel: string,
  value: (metrics: Metrics) => string = (metrics) => fixed(metrics.logLoss),
): string {
  const order: string[] = [];
  const seen = new Set<string>();
  const first = scores[0];
  if (first !== undefined) {
    for (const row of pick(first)) {
      if (!seen.has(row.group)) {
        seen.add(row.group);
        order.push(row.group);
      }
    }
  }
  let head = `| ${groupLabel} | Reviews | Observed |`;
  let rule = "|---|--:|--:|";
  for (const score of scores) {
    head += ` ${score.name} |`;
    rule += "--:|";
  }
  const lines = [head, rule];
  for (const group of order) {
    const rows = scores.map((score) => pick(score).find((row) => row.group === group));
    const reference = rows[0];
    if (reference === undefined) continue;
    let line = `| ${group} | ${count(reference.metrics.reviews)} | ${pct(reference.metrics.observedRetention)} |`;
    for (const row of rows) {
      line += ` ${row === undefined ? "—" : value(row.metrics)} |`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function formatForgettingTable(rows: readonly ForgettingRow[]): string {
  const lines = [
    "| Elapsed interval | Reviews | Lapses | Observed retention | Mean elapsed |",
    "|---|--:|--:|--:|--:|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.bucket} | ${count(row.reviews)} | ${count(row.lapses)} | ` +
        `${pct(row.observedRetention)} | ${row.meanElapsedDays.toFixed(1)}d |`,
    );
  }
  return lines.join("\n");
}

export function formatConcentrationTable(rows: readonly LossConcentration[]): string {
  const lines = [
    "| Candidate | Rows predicted < 50% | Observed on those rows | Share of total loss | Worst 1% share | p01 predicted | Median predicted |",
    "|---|--:|--:|--:|--:|--:|--:|",
  ];
  for (const row of [...rows].sort((a, b) => b.rowsBelowHalf - a.rowsBelowHalf)) {
    lines.push(
      `| ${row.name} | ${count(row.rowsBelowHalf)} | ${pct(row.observedBelowHalf)} | ` +
        `${pct(row.lossShareBelowHalf)} | ${pct(row.lossShareWorstPercent)} | ` +
        `${pct(row.p01Predicted)} | ${pct(row.p50Predicted)} |`,
    );
  }
  return lines.join("\n");
}

export function formatWorkloadTable(rows: readonly WorkloadRow[]): string {
  const lines = [
    "| Target retention | Tracks | Median interval | Mean interval | Reviews/day (steady state) | + relearning |",
    "|---|--:|--:|--:|--:|--:|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${pct(row.targetRetention)} | ${count(row.tracks)} | ` +
        `${row.medianIntervalDays.toFixed(1)}d | ${row.meanIntervalDays.toFixed(1)}d | ` +
        `${row.reviewsPerDay.toFixed(1)} | ${row.reviewsPerDayWithRelearning.toFixed(1)} |`,
    );
  }
  return lines.join("\n");
}

/** Everything BACKTEST.md quotes, in one string, so the report is pasteable. */
export function formatBacktestTables(result: BacktestResult): string {
  const d = result.dataset;
  const sections: string[] = [];
  sections.push(
    [
      "### Dataset",
      "",
      `| Quantity | Value |`,
      `|---|--:|`,
      `| Reviews imported | ${count(d.reviews)} |`,
      `| Tracks with history | ${count(d.tracks)} |`,
      `| First reviews (never scored) | ${count(d.firstReviews)} |`,
      `| Reviews with a predecessor | ${count(d.withPredecessor)} |`,
      `| Same-day (elapsed 0, scored separately) | ${count(d.sameDay)} of which ${count(d.sameDayLapses)} lapses |`,
      `| Scored set | ${count(d.scorable)} at ${pct(d.scorablePassed / d.scorable)} observed retention |`,
      `| No planned interval in the export | ${count(d.plannedIntervalMissing)} |`,
      `| Training window | ${d.firstDate} to ${d.cutoff} — ${count(d.trainReviews)} reviews |`,
      `| Held-out window | ${d.cutoff} to ${d.lastDate} — ${count(d.evalReviews)} reviews |`,
      `| Training-window base rate | ${pct(result.trainBaseRate)} |`,
      `| Decks with history | ${count(d.decks)} |`,
    ].join("\n"),
  );
  sections.push(`### Held-out window (${d.cutoff} onward)\n\n${formatCandidateTable(result.heldOut)}`);
  sections.push(`### Whole scored set\n\n${formatCandidateTable(result.full)}`);
  sections.push(
    `### Same-day reviews, elapsed unknown\n\n${formatCandidateTable(result.sameDay)}`,
  );
  if (result.planned.length > 0) {
    sections.push(
      `### Sensitivity: Mochi's planned interval instead of elapsed\n\n${formatCandidateTable(result.planned)}`,
    );
  }
  sections.push(
    `### Log loss by elapsed interval (held-out window)\n\n${formatGroupTable(
      result.heldOut,
      (score) => score.byInterval,
      "Elapsed",
    )}`,
  );
  sections.push(
    `### Mean predicted recall by elapsed interval (held-out window)\n\n${formatGroupTable(
      result.heldOut,
      (score) => score.byInterval,
      "Elapsed",
      (metrics) => pct(metrics.meanPredicted),
    )}`,
  );
  sections.push(
    `### Log loss by deck (whole scored set)\n\n${formatGroupTable(
      result.full,
      (score) => score.byDeck,
      "Deck",
    )}`,
  );
  sections.push(
    `### Log loss by track (whole scored set)\n\n${formatGroupTable(
      result.full,
      (score) => score.byKind,
      "Track",
    )}`,
  );
  sections.push(`### Observed forgetting curve (measured)\n\n${formatForgettingTable(result.forgetting)}`);
  sections.push(
    `### Where each candidate's loss comes from (held-out window)\n\n${formatConcentrationTable(
      result.concentration,
    )}`,
  );
  sections.push(
    [
      "### The measured anchor for everything modelled below",
      "",
      "| Quantity | Value |",
      "|---|--:|",
      `| Live tracks with a Mochi interval | ${count(result.mochiSchedule.tracks)} |`,
      `| Median of Mochi's own last interval | ${result.mochiSchedule.medianIntervalDays.toFixed(1)}d |`,
      `| Mean of Mochi's own last interval | ${result.mochiSchedule.meanIntervalDays.toFixed(1)}d |`,
      `| Steady-state reviews/day implied by Mochi's intervals | ${result.mochiSchedule.reviewsPerDay.toFixed(1)} |`,
      `| Reviews/day actually done, last ${result.recentLoad.days} active days | ${result.recentLoad.reviewsPerDay.toFixed(1)} |`,
      `| Measured relearning cost | ${result.relearningCost.toFixed(2)} extra reviews per lapse |`,
      `| **Mochi's maximum-interval cap** | ${result.cap.intervalDays.toFixed(0)}d |`,
      `| Live tracks pinned to exactly that cap | ${count(result.cap.tracksAtCap)} of ${count(result.cap.liveTracks)} = ${pct(result.cap.shareAtCap)} |`,
      `| Reviews scheduled to exactly the cap | ${count(result.cap.reviewsScheduledAtCap)} |`,
      `| Reviews ever scheduled beyond it | ${count(result.cap.reviewsScheduledAbove)} |`,
    ].join("\n"),
  );
  for (const block of result.workload) {
    sections.push(
      `### Target retention and daily load, modelled from ${block.candidate}\n\n` +
        formatWorkloadTable(block.rows),
    );
  }
  return sections.join("\n\n");
}
