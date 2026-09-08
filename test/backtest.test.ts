import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { importExportDirs } from "../src/import/index.js";
import { constantRate, fixedMultiplier } from "../src/scheduler/algorithms/baseline.js";
import {
  FSRS6_CLAMPS,
  FSRS6_DEFAULT_PARAMETERS,
  FSRS6_FITTED_PARAMETERS,
  FSRS6_PARAMETER_COUNT,
  FSRS6_UNIDENTIFIABLE,
  clampFsrs6Parameters,
  fitFsrs6,
  fsrs6,
  fsrs6Loss,
  fsrs6NextInterval,
  fsrs6Step,
  powerForgettingCurve,
  type Fsrs6Parameters,
  type Fsrs6TrainingSet,
} from "../src/scheduler/algorithms/fsrs6.js";
import { erase, type ReviewObservation } from "../src/scheduler/algorithms/index.js";
import { sm2 } from "../src/scheduler/algorithms/sm2.js";
import { ALL_TIME, beyondYear, retentionByInterval } from "../src/dashboard/index.js";
import {
  BEYOND_YEAR_LABEL,
  VIEW_BUCKET_LABEL,
  auc,
  chooseCutoff,
  formatBacktestTables,
  isScorable,
  loadHistory,
  measureRelearningCost,
  runBacktest,
  scoreCandidates,
  toTrainingSet,
  type BacktestResult,
  type CandidateScore,
  type HistoryReview,
  type TrackHistory,
} from "../src/scheduler/backtest.js";

/**
 * Stage 5 acceptance — the scheduler backtest.
 *
 * Two halves, and they check different things.
 *
 * 1. THE ARITHMETIC. FSRS-6's curve, SM-2's ease ladder, the metrics and the
 *    fitter, pinned on synthetic data where the right answer is known in closed
 *    form. R = 0.9 exactly at t = stability is the load-bearing identity: it is
 *    what makes "stability" mean "the interval at 90%", and getting it wrong
 *    would shift every candidate's predictions in the same direction, which no
 *    comparison between candidates could reveal.
 *
 * 2. THE RANKING. All three real exports, imported, replayed and scored. This
 *    block prints the tables that BACKTEST.md quotes; the assertions lock in the
 *    counts (103,110 reviews -> 86,975 scored) and the ORDER of the candidates,
 *    so a change to any algorithm that reshuffles the ranking fails here rather
 *    than silently rewriting the recommendation.
 *
 * The fitted parameters are committed in fsrs6.ts because a full fit takes about
 * forty seconds, which does not belong in every `npm test`. Set
 * HASHIGO_FSRS_FIT=1 to refit from scratch and assert the committed vector comes
 * back — that is the reproduction path, and it is the only place the fitter
 * touches the real corpus.
 */

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const EXPORT_DIRS = EXPORT_NAMES.map((name) => resolve(import.meta.dirname, "..", "exports", name));
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));
const REFIT = process.env["HASHIGO_FSRS_FIT"] === "1";
/** Sweeps for the refit. The committed vector was produced with the default. */
const REFIT_SWEEPS = Number(process.env["HASHIGO_FSRS_SWEEPS"] ?? "12");

// ─── half one: the arithmetic ────────────────────────────────────────────────

function observation(elapsedDays: number, remembered: 0 | 1, ordinal = 1): ReviewObservation {
  return { ordinal, elapsedDays, remembered, grade: remembered === 1 ? 3 : 1 };
}

describe("FSRS-6 forgetting curve", () => {
  it("is pinned at R = 0.9 when elapsed equals stability, for every decay", () => {
    for (const decay of [0.1542, 0.2, 0.5, 0.8]) {
      const w = [...FSRS6_DEFAULT_PARAMETERS];
      w[20] = decay;
      for (const stability of [0.5, 1, 7, 100, 3650]) {
        expect(powerForgettingCurve(w, stability, stability)).toBeCloseTo(0.9, 10);
      }
    }
  });

  it("returns 1 at t = 0 and decreases monotonically", () => {
    const w = FSRS6_DEFAULT_PARAMETERS;
    expect(powerForgettingCurve(w, 0, 10)).toBe(1);
    let previous = 1;
    for (const t of [0.5, 1, 2, 5, 10, 30, 100, 365, 3650]) {
      const r = powerForgettingCurve(w, t, 10);
      expect(r).toBeLessThan(previous);
      expect(r).toBeGreaterThan(0);
      previous = r;
    }
  });

  it("inverts through fsrs6NextInterval", () => {
    const w = FSRS6_DEFAULT_PARAMETERS;
    for (const stability of [1, 10, 250]) {
      for (const target of [0.7, 0.8, 0.9, 0.95, 0.99]) {
        const interval = fsrs6NextInterval(w, stability, target);
        expect(powerForgettingCurve(w, interval, stability)).toBeCloseTo(target, 10);
      }
    }
    // Lower target retention must mean a longer interval, or the whole
    // target-retention argument in SPEC is upside down.
    expect(fsrs6NextInterval(w, 100, 0.85)).toBeGreaterThan(fsrs6NextInterval(w, 100, 0.95));
  });

  it("ships the published FSRS-6 defaults, 21 of them, decay 0.1542", () => {
    expect(FSRS6_DEFAULT_PARAMETERS.length).toBe(FSRS6_PARAMETER_COUNT);
    expect(FSRS6_DEFAULT_PARAMETERS[0]).toBe(0.212);
    expect(FSRS6_DEFAULT_PARAMETERS[20]).toBe(0.1542);
    expect(FSRS6_CLAMPS.length).toBe(FSRS6_PARAMETER_COUNT);
    // Every default is inside its own clamp, i.e. clamping is a no-op on them.
    expect(clampFsrs6Parameters(FSRS6_DEFAULT_PARAMETERS)).toEqual([...FSRS6_DEFAULT_PARAMETERS]);
  });

  it("clamps out-of-range parameters instead of trusting them", () => {
    const wild = FSRS6_DEFAULT_PARAMETERS.map(() => 1e6);
    const clamped = clampFsrs6Parameters(wild);
    clamped.forEach((value, index) => {
      const [low, high] = FSRS6_CLAMPS[index] as readonly [number, number];
      expect(value).toBeGreaterThanOrEqual(low);
      expect(value).toBeLessThanOrEqual(high);
    });
    expect(() => clampFsrs6Parameters([1, 2, 3])).toThrow(/21 parameters/);
  });

  it("raises stability on a pass and lowers it on a lapse", () => {
    const model = fsrs6();
    const start = model.init(observation(0, 1, 0));
    const passed = model.next(start, observation(10, 1), model.predict(start, 10));
    const lapsed = model.next(start, observation(10, 0), model.predict(start, 10));
    expect(passed.stability).toBeGreaterThan(start.stability);
    expect(lapsed.stability).toBeLessThan(start.stability);
    // A lapse makes the card harder, a pass does not make it easier than it was.
    expect(lapsed.difficulty).toBeGreaterThan(passed.difficulty);
  });

  it("takes the short-term branch when elapsed is 0", () => {
    const model = fsrs6();
    const start = model.init(observation(0, 0, 0));
    const sameDay = model.next(start, observation(0, 1), model.predict(start, 0));
    const nextDay = model.next(start, observation(1, 1), model.predict(start, 1));
    expect(model.predict(start, 0)).toBe(1);
    expect(sameDay.stability).not.toBe(nextDay.stability);
    expect(sameDay.stability).toBeGreaterThanOrEqual(start.stability);
  });
});

/**
 * The one test in this file that can catch a TRANSCRIPTION error rather than an
 * internal inconsistency.
 *
 * Every other FSRS assertion here is an invariant that holds for a whole family
 * of wrong implementations: R(S) = 0.9 and the interval inversion are true for
 * any decay, and `stabilityAfterSuccess` could have `(10 - D)` where the paper
 * has `(11 - D)` without a single one of them noticing. That mattered, because
 * BACKTEST.md's stock-FSRS row is only meaningful if this file is FSRS-6.
 *
 * fsrs-rs carries its own regression fixture — `assert_memory_state` in
 * `src/inference.rs`, ratings [1,3,3,3,3,3] at delta_t [0,0,1,3,8,21] from the
 * published defaults — and states the answer as a literal. Reproducing it pins
 * init stability, init difficulty, the short-term branch, the success branch,
 * linear damping and mean reversion simultaneously against upstream.
 *
 * Upstream computes in f32 and asserts to 1e-4; this port is f64, so the same
 * absolute tolerance is used and the observed gaps are 7e-6 and 4e-5.
 *
 * NOT covered, because upstream's fixture does not cover it either: w[15] and
 * w[16] are only reachable through Hard and Easy, which neither this fixture nor
 * the corpus contains. They are two of the four FSRS6_UNIDENTIFIABLE.
 */
describe("FSRS-6 against the upstream fixture", () => {
  /** fsrs-rs `assert_memory_state`: replay one track, return the final state. */
  function upstreamFixture(w: Fsrs6Parameters): { stability: number; difficulty: number } {
    const ratings = [1, 3, 3, 3, 3, 3] as const;
    const deltas = [0, 0, 1, 3, 8, 21] as const;
    let state = fsrs6(w).init({
      ordinal: 0,
      elapsedDays: deltas[0],
      remembered: 0,
      grade: ratings[0],
    });
    for (let i = 1; i < ratings.length; i += 1) {
      const elapsed = deltas[i] as number;
      const grade = ratings[i] as number;
      state = fsrs6Step(w, state, elapsed, grade, powerForgettingCurve(w, elapsed, state.stability));
    }
    return state;
  }

  it("reproduces fsrs-rs's own memory-state fixture from the published defaults", () => {
    const state = upstreamFixture(FSRS6_DEFAULT_PARAMETERS);
    expect(Math.abs(state.stability - 53.62691)).toBeLessThan(1e-4);
    expect(Math.abs(state.difficulty - 6.3574867)).toBeLessThan(1e-4);
  });

  it("reproduces it again with the short-term parameters frozen", () => {
    // Upstream's second assertion, w17 = w18 = w19 = 0. Only the delta_t == 0
    // step changes, so this isolates the short-term branch: it is the one place
    // the two expected stabilities differ (53.62691 against 53.335106).
    const w = [...FSRS6_DEFAULT_PARAMETERS];
    w[17] = 0;
    w[18] = 0;
    w[19] = 0;
    const state = upstreamFixture(w);
    expect(Math.abs(state.stability - 53.335106)).toBeLessThan(1e-4);
    expect(Math.abs(state.difficulty - 6.3574867)).toBeLessThan(1e-4);
    expect(state.stability).not.toBeCloseTo(53.62691, 3);
  });
});

describe("SM-2", () => {
  const model = sm2();

  it("walks the published interval ladder 1, 6, then ×ease", () => {
    let state = model.init(observation(0, 1, 0));
    expect(state.intervalDays).toBe(1);
    expect(state.ease).toBe(2.5);
    state = model.next(state, observation(1, 1), 1);
    expect(state.intervalDays).toBe(6);
    state = model.next(state, observation(6, 1), 1);
    expect(state.intervalDays).toBeCloseTo(15, 10);
    expect(state.ease).toBe(2.5);
  });

  it("only ever lowers the ease, because the grades are binary", () => {
    let state = model.init(observation(0, 1, 0));
    state = model.next(state, observation(1, 0), 1);
    // The published quality formula at q = 2: 0.1 - 3 * (0.08 + 3 * 0.02) = -0.32.
    expect(state.ease).toBeCloseTo(2.18, 10);
    expect(state.intervalDays).toBe(1);
    expect(state.repetition).toBe(0);
    for (let i = 0; i < 10; i += 1) state = model.next(state, observation(1, 0), 1);
    expect(state.ease).toBe(1.3);
  });

  it("believes its own interval is the 90% point", () => {
    const state = model.next(model.init(observation(0, 1, 0)), observation(1, 1), 1);
    expect(state.intervalDays).toBe(6);
    expect(model.predict(state, 6)).toBeCloseTo(0.9, 10);
    expect(model.predict(state, 0)).toBe(1);
    expect(model.predict(state, 12)).toBeCloseTo(0.81, 10);
    expect(model.stabilityOf(state)).toBeCloseTo(6, 10);
  });

  it("scores differently under the power curve, which is why both are reported", () => {
    const exponential = sm2();
    const power = sm2({ powerCurveDecay: 0.1542 });
    const a = exponential.next(exponential.init(observation(0, 1, 0)), observation(1, 1), 1);
    const b = power.next(power.init(observation(0, 1, 0)), observation(1, 1), 1);
    expect(power.predict(b, 6)).toBeCloseTo(0.9, 10);
    // Same interval, same 90% point, different tail: the power curve is fatter,
    // so a very late review is predicted far less harshly.
    expect(power.predict(b, 60)).toBeGreaterThan(exponential.predict(a, 60));
  });
});

describe("baselines", () => {
  it("multiplies a fixed interval and resets on a lapse", () => {
    const model = fixedMultiplier();
    let state = model.init(observation(0, 1, 0));
    expect(state.intervalDays).toBe(1);
    state = model.next(state, observation(1, 1), 1);
    expect(state.intervalDays).toBe(2.5);
    state = model.next(state, observation(2, 1), 1);
    expect(state.intervalDays).toBe(6.25);
    state = model.next(state, observation(6, 0), 1);
    expect(state.intervalDays).toBe(1);
  });

  it("predicts one number, for ever, from whatever rate it is given", () => {
    const model = constantRate(0.9624);
    expect(model.predict(null, 0)).toBe(0.9624);
    expect(model.predict(null, 10_000)).toBe(0.9624);
    expect(model.intervalFor(null, 0.9)).toBeNull();
    expect(model.stabilityOf(null)).toBeNull();
  });
});

describe("replay contract", () => {
  it("never scores a track's first review and scores every later one", () => {
    const candidate = erase(fsrs6());
    const reviews = [observation(0, 1, 0), observation(3, 1, 1), observation(9, 0, 2)];
    const seen: number[] = [];
    candidate.replayTrack(reviews, (review) => seen.push(review.ordinal));
    expect(seen).toEqual([1, 2]);
  });

  it("emits nothing for a track with a single review", () => {
    const candidate = erase(fsrs6());
    const seen: number[] = [];
    candidate.replayTrack([observation(0, 1, 0)], (review) => seen.push(review.ordinal));
    expect(seen).toEqual([]);
  });
});

describe("metrics", () => {
  const track = (reviews: readonly ReviewObservation[]): TrackHistory => ({
    trackId: 1,
    cardId: "c",
    kind: "forward",
    deckId: "d",
    deckPath: "d",
    rootDeckId: "d",
    dormant: 0,
    archived: 0,
    reviews: reviews.map((review, index) => ({
      ...review,
      ordinal: index,
      reviewId: index,
      reviewedAt: `2025-01-0${index + 1}T00:00:00+09:00`,
      localDate: `2025-01-0${index + 1}`,
      measuredElapsedDays: index === 0 ? null : review.elapsedDays,
      scheduledDays: index === 0 ? null : review.elapsedDays,
      intervalKnown: index > 0,
      durationMs: null,
    })) as readonly HistoryReview[],
  });

  it("reproduces the closed-form log loss of a constant predictor", () => {
    // Four scored reviews, three passes: entropy of a 0.75 prediction against a
    // 0.75 base rate is -(0.75 ln 0.75 + 0.25 ln 0.25) = 0.5623351446.
    const tracks = [track([observation(0, 1, 0), observation(1, 1), observation(1, 1), observation(1, 1), observation(1, 0)])];
    const [score] = scoreCandidates(tracks, [{ candidate: erase(constantRate(0.75)) }]);
    expect(score?.overall.reviews).toBe(4);
    expect(score?.overall.logLoss).toBeCloseTo(0.5623351446, 9);
    expect(score?.overall.rmse).toBeCloseTo(Math.sqrt((3 * 0.0625 + 0.5625) / 4), 9);
    expect(score?.overall.observedRetention).toBeCloseTo(0.75, 12);
    // A constant predictor cannot order anything: AUC is exactly a coin flip.
    expect(score?.overall.auc).toBeCloseTo(0.5, 12);
    // And it is perfectly calibrated at the base rate, by construction.
    expect(score?.overall.calibrationRmse).toBeCloseTo(0, 12);
  });

  it("ranks a perfect predictor at AUC 1 and an inverted one at 0", () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
    expect(auc([0.5, 0.5, 0.5, 0.5], [0, 0, 1, 1])).toBe(0.5);
    expect(auc([0.1, 0.2], [1, 1])).toBeNull();
  });

  it("excludes first reviews, same-day reviews and out-of-window reviews", () => {
    const rows = track([observation(0, 1, 0), observation(0, 1), observation(5, 1), observation(30, 0)])
      .reviews;
    expect(rows.map((review) => isScorable(review))).toEqual([false, false, true, true]);
    // Same-day rows come back when the window asks for them.
    expect(rows.map((review) => isScorable(review, { minElapsedDays: 0, maxElapsedDaysExclusive: 1 }))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(rows.map((review) => isScorable(review, { from: "2025-01-04" }))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });
});

// ─── the fitter, on data whose answer is known ───────────────────────────────

/** Deterministic PRNG so a fit test cannot pass or fail by luck. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulate tracks FROM a known parameter vector: schedule each next review at
 * that model's own 90% interval, then sample the outcome from its own predicted
 * probability. The fitter's job is to find its way back.
 */
function simulate(truth: Fsrs6Parameters, tracks: number, reviewsPerTrack: number): Fsrs6TrainingSet {
  const random = mulberry32(20260819);
  const model = fsrs6(truth);
  const total = tracks * reviewsPerTrack;
  const trackOffsets = new Int32Array(tracks + 1);
  const elapsedDays = new Float64Array(total);
  const remembered = new Uint8Array(total);
  const scored = new Uint8Array(total);
  let at = 0;
  for (let t = 0; t < tracks; t += 1) {
    trackOffsets[t] = at;
    const first: 0 | 1 = random() < 0.9 ? 1 : 0;
    let state = model.init(observation(0, first, 0));
    elapsedDays[at] = 0;
    remembered[at] = first;
    scored[at] = 0;
    at += 1;
    for (let i = 1; i < reviewsPerTrack; i += 1) {
      const elapsed = Math.max(1, Math.round(model.intervalFor(state, 0.9) ?? 1));
      const p = model.predict(state, elapsed);
      const outcome: 0 | 1 = random() < p ? 1 : 0;
      elapsedDays[at] = elapsed;
      remembered[at] = outcome;
      scored[at] = 1;
      at += 1;
      state = model.next(state, observation(elapsed, outcome), p);
    }
  }
  trackOffsets[tracks] = at;
  return { trackOffsets, elapsedDays, remembered, scored };
}

describe("fitFsrs6", () => {
  it("walks downhill toward the parameters the data was generated from", () => {
    // A truth vector deliberately away from the defaults in the directions the
    // corpus can see: higher initial stability, flatter decay, easier cards.
    const truth = [...FSRS6_DEFAULT_PARAMETERS];
    truth[0] = 0.5;
    truth[2] = 6;
    truth[8] = 2.4;
    truth[20] = 0.35;
    const set = simulate(truth, 600, 12);

    const atDefaults = fsrs6Loss(FSRS6_DEFAULT_PARAMETERS, set).loss;
    const atTruth = fsrs6Loss(truth, set).loss;
    const fit = fitFsrs6(set, { sweeps: 4 });

    expect(fit.scored).toBe(600 * 11);
    expect(fit.initialLoss).toBeCloseTo(atDefaults, 12);
    // Monotone by construction, and it must get past the defaults.
    expect(fit.loss).toBeLessThan(fit.initialLoss);
    // It should reach the generating parameters' own loss, give or take the
    // sampling noise of 6,600 Bernoulli draws.
    expect(fit.loss).toBeLessThan(atTruth + 0.01);
    expect(fit.frozen).toEqual([...FSRS6_UNIDENTIFIABLE]);
    // Frozen parameters are exactly where they started.
    for (const index of FSRS6_UNIDENTIFIABLE) {
      expect(fit.parameters[index]).toBe(FSRS6_DEFAULT_PARAMETERS[index]);
    }
  });

  it("is deterministic", () => {
    const set = simulate(FSRS6_DEFAULT_PARAMETERS, 200, 8);
    const a = fitFsrs6(set, { sweeps: 2 });
    const b = fitFsrs6(set, { sweeps: 2 });
    expect(a.parameters).toEqual(b.parameters);
    expect(a.loss).toBe(b.loss);
  });

  it("scores only the rows marked scored, and state still flows through the rest", () => {
    const set = simulate(FSRS6_DEFAULT_PARAMETERS, 50, 6);
    const all = fsrs6Loss(FSRS6_DEFAULT_PARAMETERS, set);
    const halved = fsrs6Loss(FSRS6_DEFAULT_PARAMETERS, {
      ...set,
      scored: set.scored.map((flag, index) => (index % 2 === 0 ? flag : 0)) as Uint8Array,
    });
    expect(all.scored).toBe(50 * 5);
    expect(halved.scored).toBeLessThan(all.scored);
    expect(Number.isFinite(halved.loss)).toBe(true);
  });
});

// ─── half two: the real corpus ───────────────────────────────────────────────

const describeCorpus = HAVE_EXPORTS ? describe : describe.skip;

describeCorpus("the 103,110-review backtest", () => {
  let db: Db;
  let tracks: readonly TrackHistory[];
  let result: BacktestResult;

  beforeAll(() => {
    db = openDatabase(MEMORY);
    // No blobs: 627 MB of mp3 hashing has nothing to do with scheduling.
    importExportDirs(db, EXPORT_DIRS, { blobs: false, verify: false });
    tracks = loadHistory(db);
    result = runBacktest(db);
  }, 240_000);

  afterAll(() => {
    db?.close();
  });

  it("replays the whole imported log, and loses none of it", () => {
    const total = tracks.reduce((sum, track) => sum + track.reviews.length, 0);
    expect(total).toBe(103_110);
    expect(tracks.length).toBe(9_085);
    const d = result.dataset;
    expect(d.reviews).toBe(103_110);
    expect(d.firstReviews).toBe(9_085);
    expect(d.withPredecessor).toBe(94_025);
    // Every review is either a first, a same-day, or scored. Nothing vanishes.
    expect(d.firstReviews + d.sameDay + d.scorable).toBe(103_110);
    expect(d.sameDay).toBe(7_050);
    expect(d.sameDayLapses).toBe(256);
    expect(d.scorable).toBe(86_975);
    expect(d.trainReviews + d.evalReviews).toBe(d.scorable);
    expect(d.firstDate).toBe("2022-06-28");
    expect(d.decks).toBe(34);
    // The whole-corpus oracle still holds through this path.
    expect(
      (db.prepare("SELECT retention FROM study_totals").pluck().get() as number) * 100,
    ).toBeCloseTo(96.24, 2);
  });

  it("uses elapsed time, which is not the interval Mochi planned", () => {
    let bothKnown = 0;
    let late = 0;
    let early = 0;
    let agree = 0;
    let beyondAYear = 0;
    let plannedMissing = 0;
    let longestElapsed = 0;
    for (const track of tracks) {
      for (const review of track.reviews) {
        if (review.ordinal === 0) continue;
        const measured = review.measuredElapsedDays;
        if (measured !== null && measured > longestElapsed) longestElapsed = measured;
        if (measured !== null && measured > 365) beyondAYear += 1;
        if (review.scheduledDays === null) {
          plannedMissing += 1;
          continue;
        }
        if (measured === null) continue;
        bothKnown += 1;
        const difference = measured - review.scheduledDays;
        if (Math.abs(difference) <= 1.5) agree += 1;
        else if (difference > 0) late += 1;
        else early += 1;
      }
    }
    expect(plannedMissing).toBe(8_988);
    expect(bothKnown).toBe(85_037);
    expect(agree).toBe(62_284);
    expect(late).toBe(22_513);
    expect(early).toBe(240);
    // 26.4% of reviews were taken more than a day and a half late, so the
    // planned interval is not a stand-in for the time that actually passed.
    expect(late / bothKnown).toBeGreaterThan(0.26);
    // And under the elapsed definition the corpus DOES observe recall past a
    // year, which the planned-interval definition says never happens.
    expect(beyondAYear).toBe(3_217);
    // The hard ceiling on what this backtest can ever conclude: not one review in
    // four years follows an interval longer than 454 days, so every projected
    // interval past that is extrapolation with zero observations behind it. This is
    // the number that keeps the target-retention section in BACKTEST.md hedged.
    expect(longestElapsed).toBe(454);
    const plannedIntervals = loadHistory(db, { intervalSource: "scheduled" });
    const beyondAYearPlanned = plannedIntervals
      .flatMap((track) => track.reviews)
      .filter((review) => isScorable(review) && review.elapsedDays > 365).length;
    expect(beyondAYearPlanned).toBe(0);
  });

  it("scores every candidate over the same rows", () => {
    for (const table of [result.full, result.heldOut, result.sameDay, result.planned]) {
      const counts = new Set(table.map((score) => score.overall.reviews));
      expect(counts.size).toBe(1);
      for (const score of table) {
        expect(Number.isFinite(score.overall.logLoss)).toBe(true);
        expect(Number.isFinite(score.overall.rmse)).toBe(true);
        expect(score.overall.rmse).toBeGreaterThan(0);
        expect(score.overall.rmse).toBeLessThan(1);
      }
    }
    expect(result.full[0]?.overall.reviews).toBe(86_975);
    expect(result.sameDay[0]?.overall.reviews).toBe(7_050);
    // Mochi's planned interval is missing on 8,934 rows, so that table is
    // necessarily smaller — which is one of the reasons it is not the primary.
    expect(result.planned[0]?.overall.reviews).toBeLessThan(86_975);
  });

  it("optimises exactly the loss it reports: fitter hot loop == generic replay", () => {
    // fsrs6.ts keeps TWO implementations of the same arithmetic — the readable
    // Scheduler that scoreCandidates replays, and the allocation-free typed-array
    // loop the fitter calls a few thousand times. Every number in BACKTEST.md
    // comes from the first; every number the fit CHOSE came from the second. If
    // they ever drift, the fitted vector is the optimum of a function nobody
    // reports and nothing else in this file would notice. So: same corpus, same
    // windows, both parameter vectors, compared to the floating-point bit.
    const windows = [
      { label: "train", window: { until: result.dataset.cutoff } },
      { label: "held-out", window: { from: result.dataset.cutoff } },
      { label: "whole scored set", window: {} },
    ] as const;
    for (const [label, w] of [
      ["stock", FSRS6_DEFAULT_PARAMETERS],
      ["fitted", FSRS6_FITTED_PARAMETERS],
    ] as const) {
      for (const { label: name, window } of windows) {
        const fitterView = fsrs6Loss(w, toTrainingSet(tracks, window));
        const [reported] = scoreCandidates(tracks, [{ candidate: erase(fsrs6(w)) }], window);
        expect(fitterView.scored, `${label} ${name} rows`).toBe(reported?.overall.reviews);
        expect(fitterView.loss, `${label} ${name} loss`).toBe(reported?.overall.logLoss);
      }
    }
    // And the two numbers BACKTEST.md quotes for the fit are these, not a
    // separately maintained copy of them.
    const trainSet = toTrainingSet(tracks, { until: result.dataset.cutoff });
    expect(fsrs6Loss(FSRS6_DEFAULT_PARAMETERS, trainSet).loss).toBeCloseTo(0.15159, 6);
    expect(fsrs6Loss(FSRS6_FITTED_PARAMETERS, trainSet).loss).toBeCloseTo(0.144269, 6);
  });

  it("carries Japanese deck paths through grouping and formatting unchanged", () => {
    // The only place Japanese text reaches stage 5 is the deck path, and it goes
    // through three hazards on the way to the report: a SQLite TEXT column, a Map
    // key, and a markdown cell. All three are byte-transparent only if nothing
    // normalises — so this asserts the paths arrive identical, including the two
    // subdecks whose names end in an astral-plane emoji (surrogate pair) and the
    // one that mixes kanji with a Latin letter.
    const expected: readonly (readonly [string, number])[] = [
      ["日本語/単語", 45_491],
      ["日本語/漢字", 23_610],
      ["日本語/部首", 2_228],
      ["日本語/言葉/オノマトペ", 363],
      ["日本語/単語/尊敬語🤵", 318],
      ["日本語/単語/謙譲語🙇", 284],
      ["基本情報/科目B", 17],
    ];
    const byDeck = new Map(
      (result.full[0]?.byDeck ?? []).map((row) => [row.group, row.metrics.reviews]),
    );
    const tables = formatBacktestTables(result);
    for (const [path, reviews] of expected) {
      expect(byDeck.get(path), path).toBe(reviews);
      // NFC == NFD would silently merge or split decks; assert the stored form.
      expect(path.normalize("NFC")).toBe(path);
      expect(tables).toContain(`| ${path} | ${reviews.toLocaleString("en-US")} |`);
    }
    // 単語's three subdecks are distinct groups, not folded into their parent.
    expect(byDeck.get("日本語/単語")).not.toBe(byDeck.get("日本語/単語/尊敬語🤵"));
    expect([...byDeck.keys()].filter((path) => path.startsWith("日本語/")).length).toBe(10);
  });

  it("splits the history by time, not at random", () => {
    const d = result.dataset;
    expect(d.cutoff).toBe(chooseCutoff(tracks, 0.7));
    expect(d.cutoff > d.firstDate).toBe(true);
    expect(d.cutoff < d.lastDate).toBe(true);
    // The fit never sees an evaluation-window review.
    const trainSet = toTrainingSet(tracks, { until: d.cutoff });
    let scored = 0;
    let scoredAfterCutoff = 0;
    let at = 0;
    for (const track of tracks) {
      for (const review of track.reviews) {
        if (trainSet.scored[at] === 1) {
          scored += 1;
          if (review.localDate >= d.cutoff) scoredAfterCutoff += 1;
        }
        at += 1;
      }
    }
    expect(scored).toBe(d.trainReviews);
    expect(scoredAfterCutoff).toBe(0);
  });

  it("ranks the candidates, and every one of them beats the naive floor", () => {
    const by = (table: readonly CandidateScore[]): Map<string, CandidateScore> =>
      new Map(table.map((score) => [score.id, score]));
    const held = by(result.heldOut);
    const fixed = held.get("fixed");
    const constant = held.get("constant");
    const stock = held.get("fsrs6");
    const fitted = held.get("fsrs6-fitted");
    const classic = held.get("sm2");
    expect(fixed && constant && stock && fitted && classic).toBeTruthy();
    const loss = (score: CandidateScore | undefined): number => score?.overall.logLoss ?? Number.NaN;

    // SPEC's sanity floor. Both FSRS arms clear it comfortably.
    expect(loss(stock)).toBeLessThan(loss(fixed));
    expect(loss(fitted)).toBeLessThan(loss(fixed));

    // Fitting on an earlier window must help on a later one, or there is nothing
    // to fit.
    expect(loss(fitted)).toBeLessThan(loss(stock));

    // AND THE RESULT SPEC DID NOT EXPECT: classic SM-2 does NOT clear the naive
    // floor. Asserted rather than smoothed over, because it is a real property of
    // the pair and the next test shows the mechanism.
    expect(loss(classic)).toBeGreaterThan(loss(fixed));

    // Only the FSRS arms beat "always predict the training base rate". SM-2 and
    // the fixed multiplier both lose to a model with no inputs at all.
    expect(loss(fitted)).toBeLessThan(loss(constant));
    expect(loss(stock)).toBeLessThan(loss(constant));
    expect(loss(classic)).toBeGreaterThan(loss(constant));
    expect(loss(held.get("sm2-power"))).toBeGreaterThan(loss(constant));

    // The two mandated metrics disagree, and the disagreement is reported rather
    // than resolved: on RMSE the constant baseline beats STOCK FSRS-6, while on
    // log loss it loses to it. Only the fitted arm wins on both.
    expect(constant?.overall.rmse ?? 1).toBeLessThan(stock?.overall.rmse ?? 0);
    expect(fitted?.overall.rmse ?? 1).toBeLessThan(constant?.overall.rmse ?? 0);

    // The order that BACKTEST.md reports. Locked in deliberately: an algorithm
    // change that reshuffles it should fail here and be re-argued.
    const order = [...result.heldOut]
      .sort((a, b) => a.overall.logLoss - b.overall.logLoss)
      .map((score) => score.id);
    expect(order).toEqual(["fsrs6-fitted", "fsrs6", "constant", "sm2-power", "fixed", "sm2"]);

    // Discrimination, not just calibration: every real candidate orders the
    // outcomes better than a coin flip, and the constant baseline cannot. This is
    // why the ranking above is a statement about calibration, not about knowledge.
    expect(constant?.overall.auc).toBeCloseTo(0.5, 6);
    for (const id of ["fsrs6-fitted", "fsrs6", "sm2", "sm2-power", "fixed"]) {
      expect(held.get(id)?.overall.auc ?? 0).toBeGreaterThan(0.6);
    }
  });

  it("locates WHY SM-2 loses to the naive floor, and it is the curve, not SM-2", () => {
    // A candidate failing SPEC's sanity floor demands a mechanism before it can be
    // reported, so this measures rather than argues. Two hypotheses, both testable
    // by changing exactly one thing:
    //
    //   (a) the ease adjustment, which binary grades reduce to "can only fall"
    //   (b) the exponential curve this harness must attach to any interval-only
    //       scheduler to get a probability out of it
    //
    // (a) is nearly free of blame and (b) is the whole effect.
    const window = { from: result.dataset.cutoff };
    const [classic, frozenEase, powerCurve, floor] = scoreCandidates(
      tracks,
      [
        { candidate: erase(sm2()) },
        { candidate: erase(sm2({ lapseEaseDelta: 0 })) },
        { candidate: erase(sm2({ powerCurveDecay: 0.1542 })) },
        { candidate: erase(fixedMultiplier()) },
      ],
      window,
    );
    const lossOf = (score: CandidateScore | undefined): number =>
      score?.overall.logLoss ?? Number.NaN;
    console.log(
      `SM-2 held-out log loss: as published ${lossOf(classic).toFixed(4)} · ` +
        `ease frozen at 2.5 ${lossOf(frozenEase).toFixed(4)} · ` +
        `same intervals, power curve ${lossOf(powerCurve).toFixed(4)} · ` +
        `fixed ×2.5 floor ${lossOf(floor).toFixed(4)}`,
    );

    // (a) Freezing the ease changes almost nothing: under 5% of the loss.
    expect(lossOf(frozenEase)).toBeGreaterThan(0.95 * lossOf(classic));
    // (b) Swapping ONLY the curve, with byte-identical interval logic, removes
    // three quarters of the loss and lifts SM-2 clear of the floor.
    expect(lossOf(powerCurve)).toBeLessThan(lossOf(classic) / 3);
    expect(lossOf(powerCurve)).toBeLessThan(lossOf(floor));

    // And the concentration table says where those losses live: the exponential
    // candidates put thousands of rows under 50% recall, and those rows — which
    // were remembered five times out of six — are most of their total loss.
    const byId = new Map(result.concentration.map((row) => [row.id, row]));
    const exponential = byId.get("sm2");
    const power = byId.get("sm2-power");
    const stockFsrs = byId.get("fsrs6");
    expect(exponential?.rowsBelowHalf ?? 0).toBeGreaterThan(3_000);
    expect(exponential?.lossShareBelowHalf ?? 0).toBeGreaterThan(0.7);
    expect(exponential?.observedBelowHalf ?? 0).toBeGreaterThan(0.8);
    expect(power?.rowsBelowHalf ?? 0).toBeLessThan((exponential?.rowsBelowHalf ?? 0) / 3);
    expect(stockFsrs?.rowsBelowHalf ?? 1e9).toBeLessThan(200);
    // Its 1st-percentile prediction is under 1e-5, so at least 258 of the 25,835
    // held-out rows are assertions of near-certain failure — charged at the metric
    // floor of 13.8 nats each, on reviews the user mostly passed.
    expect(exponential?.p01Predicted ?? 1).toBeLessThan(1e-5);
  });

  // ── THE DASHBOARD AND THIS BACKTEST REPORT THE SAME NUMBERS ──────────────
  //
  // They are computed two completely different ways: the dashboard aggregates
  // in SQL through review_log_bucketed, this file replays every track in
  // TypeScript. They used to disagree spectacularly at `> 365d` -- 0 against
  // 3,217 -- because the dashboard bucketed the PLANNED interval and this file
  // scores ELAPSED time. Same basis and same boundaries now, so they must agree
  // everywhere, and this asserts everywhere rather than only the one bucket.

  it("agrees with the dashboard on the > 365d bucket — the number that was wrong", () => {
    const fromSql = beyondYear(retentionByInterval(db, ALL_TIME, "elapsed"));
    const fromReplay = result.forgetting.find((row) => row.bucket === BEYOND_YEAR_LABEL);

    expect(fromReplay?.reviews).toBe(3_217);
    expect(fromSql.reviews).toBe(3_217);
    expect(fromSql.reviews).toBe(fromReplay?.reviews);
    expect(fromSql.lapses).toBe(fromReplay?.lapses);
    expect((fromSql.retention ?? 0).toFixed(6)).toBe(
      (fromReplay?.observedRetention ?? 0).toFixed(6),
    );

    // And the other basis, which is where the contradiction came from: zero.
    expect(beyondYear(retentionByInterval(db, ALL_TIME, "scheduled")).reviews).toBe(0);
  });

  it("agrees with the dashboard on EVERY bucket, not only the contested one", () => {
    // Fold this file's finer table onto views.sql's labels. The only difference
    // between the two partitions is that the view merges `same day` and `1d`
    // into `<= 1d`; VIEW_BUCKET_LABEL is that mapping and this proves it is the
    // whole of the difference.
    const folded = new Map<string, { reviews: number; lapses: number }>();
    for (const row of result.forgetting) {
      const label = VIEW_BUCKET_LABEL[row.bucket] as string;
      const acc = folded.get(label) ?? { reviews: 0, lapses: 0 };
      acc.reviews += row.reviews;
      acc.lapses += row.lapses;
      folded.set(label, acc);
    }

    const sql = retentionByInterval(db, ALL_TIME, "elapsed");
    for (const bucket of sql) {
      if (bucket.label === "unknown") {
        // The view's `unknown` is exactly the rows this file never scores: a
        // track's first review, which has no predecessor and so no elapsed gap.
        expect(bucket.reviews).toBe(9_085);
        expect(folded.has("unknown")).toBe(false);
        continue;
      }
      expect(folded.get(bucket.label)?.reviews, `reviews in ${bucket.label}`).toBe(bucket.reviews);
      expect(folded.get(bucket.label)?.lapses, `lapses in ${bucket.label}`).toBe(bucket.lapses);
    }

    // Nothing lost either way: 94,025 scored + 9,026 first reviews = 103,110.
    const replayTotal = result.forgetting.reduce((sum, row) => sum + row.reviews, 0);
    const sqlTotal = sql.reduce((sum, b) => sum + b.reviews, 0);
    expect(replayTotal).toBe(94_025);
    expect(sqlTotal).toBe(103_110);
    expect(replayTotal + 9_085).toBe(sqlTotal);
  });

  it("measures the forgetting curve, and it is not monotone", () => {
    const rows = new Map(result.forgetting.map((row) => [row.bucket, row]));
    expect(rows.get("same day")?.reviews).toBe(7_050);
    const mid = rows.get("61-180d");
    const long = rows.get("> 365d");
    expect(mid && long).toBeTruthy();
    expect(long?.reviews).toBe(3_217);
    // Selection bias, visible rather than asserted: retention RISES again past a
    // year, because only cards that keep being remembered are ever given a
    // year-long interval.
    expect((long?.observedRetention ?? 0)).toBeGreaterThan(mid?.observedRetention ?? 1);
    const total = result.forgetting.reduce((sum, row) => sum + row.reviews, 0);
    expect(total).toBe(94_025);
  });

  it("turns target retention into a daily load, monotonically", () => {
    expect(result.relearningCost).toBeGreaterThan(0);
    expect(result.workload.length).toBe(2);
    for (const block of result.workload) {
      expect(block.rows.length).toBe(3);
      const [low, mid, high] = block.rows;
      expect(low?.targetRetention).toBe(0.85);
      expect(high?.targetRetention).toBe(0.95);
      // Higher target retention means shorter intervals means more reviews a day.
      expect(low?.medianIntervalDays ?? 0).toBeGreaterThan(mid?.medianIntervalDays ?? 0);
      expect(mid?.medianIntervalDays ?? 0).toBeGreaterThan(high?.medianIntervalDays ?? 0);
      expect(low?.reviewsPerDay ?? 1).toBeLessThan(mid?.reviewsPerDay ?? 0);
      expect(mid?.reviewsPerDay ?? 1).toBeLessThan(high?.reviewsPerDay ?? 0);
      // Every live track is projected, none silently dropped.
      expect(low?.tracks).toBe(mid?.tracks);
      expect(mid?.tracks).toBe(high?.tracks);
    }
    // Fitting barely moves the projection — 988d against 1,032d at a 90% target —
    // so the enormous intervals below are not an artefact of the fitted vector.
    // Both models say the same thing, and both say something the data cannot
    // support: Mochi's own median last interval is 365 days, because 365 is where
    // Mochi caps. The next test measures that cap.
    const [fitted, stock] = result.workload;
    expect(fitted?.candidate).toBe("FSRS-6 fitted");
    expect(stock?.candidate).toBe("FSRS-6");
    const at90 = (block: (typeof result.workload)[number] | undefined): number =>
      block?.rows[1]?.medianIntervalDays ?? Number.NaN;
    expect(Math.abs(at90(stock) - at90(fitted)) / at90(fitted)).toBeLessThan(0.1);
    expect(at90(fitted)).toBeGreaterThan(2.5 * result.mochiSchedule.medianIntervalDays);
    expect(measureRelearningCost(tracks)).toBeCloseTo(result.relearningCost, 12);
  });

  it("finds Mochi's 365-day cap, AND the date it stopped applying", () => {
    // Not assumed — the modal interval of the live corpus. 43% of tracks sitting
    // on one exact value is a ceiling the scheduler imposed, so for those tracks
    // the data says only "at least a year is fine". Every projected interval past
    // it is extrapolation off the end of the observed support, which is why the
    // workload rows above are labelled modelled and the recommendation is hedged.
    const cap = result.cap;
    expect(cap.intervalDays).toBe(365);
    expect(cap.tracksAtCap).toBe(3_417);
    expect(cap.liveTracks).toBe(9_011);
    expect(cap.shareAtCap).toBeGreaterThan(0.37);
    expect(cap.reviewsScheduledAtCap).toBe(7_440);
    // 1,386 reviews were scheduled beyond the cap — all after the user raised the
    // setting in 2026-02, per the note in schema.sql — so it is a real ceiling for
    // almost all of the history and a recently lifted one at the very end.
    expect(cap.reviewsScheduledAbove).toBe(1_386);

    // The correction. An earlier draft of BACKTEST.md called the cap "the
    // binding constraint", which stopped being true in February.
    expect(cap.liftedOn).toBe("2026-02-22");
    expect(cap.maxPlannedDays).toBe(2_707);
    // What actually survives the lift: tracks parked on a stale 365-day plan
    // because they have not been reviewed since. 3,306 of the 3,417, so 111 were
    // deliberately re-scheduled to 365 by an uncapped scheduler.
    expect(cap.tracksOnStaleCap).toBe(3_306);
    expect(cap.tracksAtCap - cap.tracksOnStaleCap).toBe(111);
    // The measured anchor: the steady-state arithmetic applied to Mochi's own
    // intervals gives 54.4 reviews a day where the user actually does 69.2, so the
    // model is a LOWER bound by about a quarter. Stated, not corrected.
    expect(result.mochiSchedule.reviewsPerDay).toBeLessThan(result.recentLoad.reviewsPerDay);
    expect(result.mochiSchedule.medianIntervalDays).toBe(365);
  });

  it("prints the tables BACKTEST.md quotes", () => {
    const tables = formatBacktestTables(result);
    console.log(`\n${tables}\n`);
    expect(tables).toContain("| Candidate | Reviews | Log loss | RMSE |");
    expect(tables).toContain("86,975");
  });

  it.runIf(REFIT)(
    "refits from scratch and reproduces the committed parameters",
    () => {
      const trainSet = toTrainingSet(tracks, { until: result.dataset.cutoff });
      const fit = fitFsrs6(trainSet, {
        sweeps: REFIT_SWEEPS,
        onSweep: (sweep, loss) => console.log(`sweep ${sweep} train loss ${loss.toFixed(6)}`),
      });
      console.log(
        `\nFSRS6_FITTED_PARAMETERS = [\n  ${fit.parameters
          .map((value) => Number(value.toPrecision(6)))
          .join(", ")},\n];\n` +
          `train rows ${fit.scored} · loss ${fit.initialLoss.toFixed(6)} -> ${fit.loss.toFixed(6)} · ` +
          `${fit.sweeps} sweeps · ${fit.evaluations} evaluations · ${(fit.elapsedMs / 1000).toFixed(1)}s\n`,
      );
      // What the freshly fitted vector scores on the held-out window, printed so
      // the fit is auditable end to end rather than on trust. The sweep count is
      // fixed in advance from the TRAINING curve's diminishing returns; nothing
      // below is allowed to choose it, or the held-out number stops being one.
      const heldOut = scoreCandidates(
        tracks,
        [
          { candidate: erase(fsrs6(fit.parameters)) },
          { candidate: erase(fsrs6(FSRS6_DEFAULT_PARAMETERS)) },
        ],
        { from: result.dataset.cutoff },
      );
      console.log(
        `held-out log loss  refitted ${heldOut[0]?.overall.logLoss.toFixed(6)} · ` +
          `stock ${heldOut[1]?.overall.logLoss.toFixed(6)} over ${heldOut[0]?.overall.reviews} reviews`,
      );

      expect(fit.loss).toBeLessThan(fit.initialLoss);
      expect(fit.parameters.map((value) => Number(value.toPrecision(6)))).toEqual([
        ...FSRS6_FITTED_PARAMETERS,
      ]);
    },
    600_000,
  );
});
