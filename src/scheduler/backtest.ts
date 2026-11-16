import type { Db } from "../db/index.js";
import type { IntervalBasis } from "../schema/index.js";
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

export interface HistoryReview extends ReviewObservation {
  readonly reviewId: number;
  readonly reviewedAt: string;
  readonly localDate: string;
  readonly measuredElapsedDays: number | null;
  readonly scheduledDays: number | null;
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

export type IntervalSource = IntervalBasis;

export interface LoadOptions {
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
       r.scheduled_days     AS scheduled_days,
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
  readonly scheduled_days: number | null;
  readonly duration_ms: number | null;
}

const MS_PER_DAY = 86_400_000;

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
      const scheduled = row.scheduled_days;
      const chosen = source === "scheduled" ? scheduled : measured;
      const remembered: 0 | 1 = row.remembered === 1 ? 1 : 0;
      reviews.push({
        reviewId: row.review_id,
        ordinal: i,
        reviewedAt: row.reviewed_at,
        localDate: row.reviewed_at.slice(0, 10),
        measuredElapsedDays: measured,
        scheduledDays: scheduled,
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

export interface ScoringWindow {
  readonly from?: string | null;
  readonly until?: string | null;
  readonly minElapsedDays?: number;
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

export interface Metrics {
  readonly reviews: number;
  readonly passed: number;
  readonly observedRetention: number;
  readonly meanPredicted: number;
  readonly logLoss: number;
  readonly rmse: number;
  readonly calibrationRmse: number;
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

export const INTERVAL_BUCKETS: readonly (readonly [string, number])[] = [
  ["same day", 0],
  ["1d", 1],
  ["2-3d", 3],
  ["4-7d", 7],
  ["8-21d", 21],
  ["22-60d", 60],
  ["61-180d", 180],
  ["181-365d", 365],
  ["> 365d", Number.POSITIVE_INFINITY],
];

export const VIEW_BUCKET_LABEL: Readonly<Record<string, string>> = {
  "same day": "<= 1d",
  "1d": "<= 1d",
  "2-3d": "1-3d",
  "4-7d": "3-7d",
  "8-21d": "7-21d",
  "22-60d": "21-60d",
  "61-180d": "60-180d",
  "181-365d": "180-365d",
  "> 365d": "> 365d",
};

export const BEYOND_YEAR_LABEL = "> 365d";

export function intervalBucket(elapsedDays: number): string {
  for (const [label, ceiling] of INTERVAL_BUCKETS) {
    if (elapsedDays <= ceiling) return label;
  }
  return BEYOND_YEAR_LABEL;
}

export interface GroupedMetrics {
  readonly group: string;
  readonly metrics: Metrics;
}

export interface CandidateScore {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly inSample: boolean;
  readonly overall: Metrics;
  readonly byDeck: readonly GroupedMetrics[];
  readonly byInterval: readonly GroupedMetrics[];
  readonly byKind: readonly GroupedMetrics[];
}

export interface CandidateSpec {
  readonly candidate: Candidate;
  readonly inSample?: boolean;
}

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

export interface ForgettingRow {
  readonly bucket: string;
  readonly reviews: number;
  readonly lapses: number;
  readonly observedRetention: number;
  readonly meanElapsedDays: number;
}

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
  readonly rowsBelowHalf: number;
  readonly lossShareBelowHalf: number;
  readonly lossShareWorstPercent: number;
  readonly p01Predicted: number;
  readonly p50Predicted: number;
  readonly observedBelowHalf: number;
}

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
      `SELECT t.scheduled_days AS scheduled_days
         FROM card_tracks t
         JOIN cards c ON c.id = t.card_id
        WHERE t.dormant = 0 AND c.archived = 0 AND t.reps > 0
          AND t.scheduled_days IS NOT NULL AND t.scheduled_days > 0
        ORDER BY t.scheduled_days`,
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
  readonly intervalDays: number;
  readonly tracksAtCap: number;
  readonly liveTracks: number;
  readonly shareAtCap: number;
  readonly reviewsScheduledAtCap: number;
  readonly reviewsScheduledAbove: number;
  readonly liftedOn: string | null;
  readonly maxPlannedDays: number | null;
  readonly tracksOnStaleCap: number;
}

export function measureScheduleCap(db: Db): ScheduleCap {
  const rows = db
    .prepare(
      `SELECT t.scheduled_days AS scheduled_days, count(*) AS tracks
         FROM card_tracks t
         JOIN cards c ON c.id = t.card_id
        WHERE t.dormant = 0 AND c.archived = 0 AND t.reps > 0 AND t.scheduled_days IS NOT NULL
        GROUP BY t.scheduled_days
        ORDER BY tracks DESC, t.scheduled_days DESC
        LIMIT 1`,
    )
    .all() as { scheduled_days: number; tracks: number }[];
  const top = rows[0] ?? { scheduled_days: Number.NaN, tracks: 0 };
  const live = db
    .prepare(
      `SELECT count(*) FROM card_tracks t JOIN cards c ON c.id = t.card_id
        WHERE t.dormant = 0 AND c.archived = 0 AND t.reps > 0 AND t.scheduled_days IS NOT NULL`,
    )
    .pluck()
    .get() as number;
  const atCap = db
    .prepare(`SELECT count(*) FROM reviews WHERE next_scheduled_days = ?`)
    .pluck()
    .get(top.scheduled_days) as number;
  const above = db
    .prepare(`SELECT count(*) FROM reviews WHERE next_scheduled_days > ?`)
    .pluck()
    .get(top.scheduled_days) as number;
  const liftedOn = db
    .prepare(`SELECT min(local_date) FROM review_log WHERE next_scheduled_days > ?`)
    .pluck()
    .get(top.scheduled_days) as string | null;
  const maxPlanned = db
    .prepare(`SELECT max(next_scheduled_days) FROM reviews`)
    .pluck()
    .get() as number | null;
  const stale =
    liftedOn === null
      ? 0
      : (db
          .prepare(
            `SELECT count(*) FROM card_tracks t
               JOIN cards c ON c.id = t.card_id
              WHERE t.dormant = 0 AND c.archived = 0 AND t.reps > 0
                AND t.scheduled_days = ?
                AND (SELECT rl.local_date FROM review_log rl
                      WHERE rl.track_id = t.id
                      ORDER BY rl.reviewed_at DESC, rl.review_id DESC LIMIT 1) < ?`,
          )
          .pluck()
          .get(top.scheduled_days, liftedOn) as number);
  return {
    intervalDays: top.scheduled_days,
    tracksAtCap: top.tracks,
    liveTracks: live,
    shareAtCap: live === 0 ? Number.NaN : top.tracks / live,
    reviewsScheduledAtCap: atCap,
    reviewsScheduledAbove: above,
    liftedOn,
    maxPlannedDays: maxPlanned,
    tracksOnStaleCap: stale,
  };
}

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
  readonly reviewsPerDay: number;
  readonly reviewsPerDayWithRelearning: number;
}

export interface WorkloadOptions {
  readonly relearningCost: number;
  readonly liveOnly?: boolean;
  readonly minimumIntervalDays?: number;
}

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
  readonly cutoff?: string;
  readonly targetRetentions?: readonly number[];
  readonly fittedParameters?: Fsrs6Parameters;
  readonly includePlanned?: boolean;
}

export interface BacktestResult {
  readonly dataset: DatasetSummary;
  readonly full: readonly CandidateScore[];
  readonly heldOut: readonly CandidateScore[];
  readonly sameDay: readonly CandidateScore[];
  readonly planned: readonly CandidateScore[];
  readonly forgetting: readonly ForgettingRow[];
  readonly relearningCost: number;
  readonly workload: readonly WorkloadBlock[];
  readonly mochiSchedule: ScheduleSummary;
  readonly cap: ScheduleCap;
  readonly recentLoad: { readonly days: number; readonly reviewsPerDay: number };
  readonly concentration: readonly LossConcentration[];
  readonly trainBaseRate: number;
  readonly elapsedMs: number;
}

export interface WorkloadBlock {
  readonly candidate: string;
  readonly rows: readonly WorkloadRow[];
}

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
      if (review.scheduledDays === null) plannedMissing += 1;
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
    score.id === fittedId ? { ...score, inSample: false } : score,
  );
  const sameDayScores = scoreCandidates(tracks, specs, {
    minElapsedDays: 0,
    maxElapsedDaysExclusive: 1,
  });

  let planned: readonly CandidateScore[] = [];
  if (options.includePlanned !== false) {
    const plannedTracks = loadHistory(db, { intervalSource: "scheduled" });
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

function pct(value: number): string {
  return Number.isFinite(value) ? `${(100 * value).toFixed(2)}%` : "—";
}

function fixed(value: number, places = 4): string {
  return Number.isFinite(value) ? value.toFixed(places) : "—";
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

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
