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

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const EXPORT_DIRS = EXPORT_NAMES.map((name) => resolve(import.meta.dirname, "..", "exports", name));
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));
const REFIT = process.env["HASHIGO_FSRS_FIT"] === "1";
const REFIT_SWEEPS = Number(process.env["HASHIGO_FSRS_SWEEPS"] ?? "12");

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
    expect(fsrs6NextInterval(w, 100, 0.85)).toBeGreaterThan(fsrs6NextInterval(w, 100, 0.95));
  });

  it("ships the published FSRS-6 defaults, 21 of them, decay 0.1542", () => {
    expect(FSRS6_DEFAULT_PARAMETERS.length).toBe(FSRS6_PARAMETER_COUNT);
    expect(FSRS6_DEFAULT_PARAMETERS[0]).toBe(0.212);
    expect(FSRS6_DEFAULT_PARAMETERS[20]).toBe(0.1542);
    expect(FSRS6_CLAMPS.length).toBe(FSRS6_PARAMETER_COUNT);
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

describe("FSRS-6 against the upstream fixture", () => {
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
    const tracks = [track([observation(0, 1, 0), observation(1, 1), observation(1, 1), observation(1, 1), observation(1, 0)])];
    const [score] = scoreCandidates(tracks, [{ candidate: erase(constantRate(0.75)) }]);
    expect(score?.overall.reviews).toBe(4);
    expect(score?.overall.logLoss).toBeCloseTo(0.5623351446, 9);
    expect(score?.overall.rmse).toBeCloseTo(Math.sqrt((3 * 0.0625 + 0.5625) / 4), 9);
    expect(score?.overall.observedRetention).toBeCloseTo(0.75, 12);
    expect(score?.overall.auc).toBeCloseTo(0.5, 12);
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

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    expect(fit.loss).toBeLessThan(fit.initialLoss);
    expect(fit.loss).toBeLessThan(atTruth + 0.01);
    expect(fit.frozen).toEqual([...FSRS6_UNIDENTIFIABLE]);
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

const describeCorpus = HAVE_EXPORTS ? describe : describe.skip;

describeCorpus("the 103,110-review backtest", () => {
  let db: Db;
  let tracks: readonly TrackHistory[];
  let result: BacktestResult;

  beforeAll(() => {
    db = openDatabase(MEMORY);
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
    expect(d.firstReviews + d.sameDay + d.scorable).toBe(103_110);
    expect(d.sameDay).toBe(7_050);
    expect(d.sameDayLapses).toBe(256);
    expect(d.scorable).toBe(86_975);
    expect(d.trainReviews + d.evalReviews).toBe(d.scorable);
    expect(d.firstDate).toBe("2022-06-28");
    expect(d.decks).toBe(34);
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
    expect(late / bothKnown).toBeGreaterThan(0.26);
    expect(beyondAYear).toBe(3_217);
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
    expect(result.planned[0]?.overall.reviews).toBeLessThan(86_975);
  });

  it("optimises exactly the loss it reports: fitter hot loop == generic replay", () => {
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
    const trainSet = toTrainingSet(tracks, { until: result.dataset.cutoff });
    expect(fsrs6Loss(FSRS6_DEFAULT_PARAMETERS, trainSet).loss).toBeCloseTo(0.15159, 6);
    expect(fsrs6Loss(FSRS6_FITTED_PARAMETERS, trainSet).loss).toBeCloseTo(0.144269, 6);
  });

  it("carries Japanese deck paths through grouping and formatting unchanged", () => {
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
      expect(path.normalize("NFC")).toBe(path);
      expect(tables).toContain(`| ${path} | ${reviews.toLocaleString("en-US")} |`);
    }
    expect(byDeck.get("日本語/単語")).not.toBe(byDeck.get("日本語/単語/尊敬語🤵"));
    expect([...byDeck.keys()].filter((path) => path.startsWith("日本語/")).length).toBe(10);
  });

  it("splits the history by time, not at random", () => {
    const d = result.dataset;
    expect(d.cutoff).toBe(chooseCutoff(tracks, 0.7));
    expect(d.cutoff > d.firstDate).toBe(true);
    expect(d.cutoff < d.lastDate).toBe(true);
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

    expect(loss(stock)).toBeLessThan(loss(fixed));
    expect(loss(fitted)).toBeLessThan(loss(fixed));

    expect(loss(fitted)).toBeLessThan(loss(stock));

    expect(loss(classic)).toBeGreaterThan(loss(fixed));

    expect(loss(fitted)).toBeLessThan(loss(constant));
    expect(loss(stock)).toBeLessThan(loss(constant));
    expect(loss(classic)).toBeGreaterThan(loss(constant));
    expect(loss(held.get("sm2-power"))).toBeGreaterThan(loss(constant));

    expect(constant?.overall.rmse ?? 1).toBeLessThan(stock?.overall.rmse ?? 0);
    expect(fitted?.overall.rmse ?? 1).toBeLessThan(constant?.overall.rmse ?? 0);

    const order = [...result.heldOut]
      .sort((a, b) => a.overall.logLoss - b.overall.logLoss)
      .map((score) => score.id);
    expect(order).toEqual(["fsrs6-fitted", "fsrs6", "constant", "sm2-power", "fixed", "sm2"]);

    expect(constant?.overall.auc).toBeCloseTo(0.5, 6);
    for (const id of ["fsrs6-fitted", "fsrs6", "sm2", "sm2-power", "fixed"]) {
      expect(held.get(id)?.overall.auc ?? 0).toBeGreaterThan(0.6);
    }
  });

  it("locates WHY SM-2 loses to the naive floor, and it is the curve, not SM-2", () => {
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

    expect(lossOf(frozenEase)).toBeGreaterThan(0.95 * lossOf(classic));
    expect(lossOf(powerCurve)).toBeLessThan(lossOf(classic) / 3);
    expect(lossOf(powerCurve)).toBeLessThan(lossOf(floor));

    const byId = new Map(result.concentration.map((row) => [row.id, row]));
    const exponential = byId.get("sm2");
    const power = byId.get("sm2-power");
    const stockFsrs = byId.get("fsrs6");
    expect(exponential?.rowsBelowHalf ?? 0).toBeGreaterThan(3_000);
    expect(exponential?.lossShareBelowHalf ?? 0).toBeGreaterThan(0.7);
    expect(exponential?.observedBelowHalf ?? 0).toBeGreaterThan(0.8);
    expect(power?.rowsBelowHalf ?? 0).toBeLessThan((exponential?.rowsBelowHalf ?? 0) / 3);
    expect(stockFsrs?.rowsBelowHalf ?? 1e9).toBeLessThan(200);
    expect(exponential?.p01Predicted ?? 1).toBeLessThan(1e-5);
  });

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

    expect(beyondYear(retentionByInterval(db, ALL_TIME, "scheduled")).reviews).toBe(0);
  });

  it("agrees with the dashboard on EVERY bucket, not only the contested one", () => {
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
        expect(bucket.reviews).toBe(9_085);
        expect(folded.has("unknown")).toBe(false);
        continue;
      }
      expect(folded.get(bucket.label)?.reviews, `reviews in ${bucket.label}`).toBe(bucket.reviews);
      expect(folded.get(bucket.label)?.lapses, `lapses in ${bucket.label}`).toBe(bucket.lapses);
    }

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
      expect(low?.medianIntervalDays ?? 0).toBeGreaterThan(mid?.medianIntervalDays ?? 0);
      expect(mid?.medianIntervalDays ?? 0).toBeGreaterThan(high?.medianIntervalDays ?? 0);
      expect(low?.reviewsPerDay ?? 1).toBeLessThan(mid?.reviewsPerDay ?? 0);
      expect(mid?.reviewsPerDay ?? 1).toBeLessThan(high?.reviewsPerDay ?? 0);
      expect(low?.tracks).toBe(mid?.tracks);
      expect(mid?.tracks).toBe(high?.tracks);
    }
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
    const cap = result.cap;
    expect(cap.intervalDays).toBe(365);
    expect(cap.tracksAtCap).toBe(3_417);
    expect(cap.liveTracks).toBe(9_011);
    expect(cap.shareAtCap).toBeGreaterThan(0.37);
    expect(cap.reviewsScheduledAtCap).toBe(7_440);
    expect(cap.reviewsScheduledAbove).toBe(1_386);

    expect(cap.liftedOn).toBe("2026-02-22");
    expect(cap.maxPlannedDays).toBe(2_707);
    expect(cap.tracksOnStaleCap).toBe(3_306);
    expect(cap.tracksAtCap - cap.tracksOnStaleCap).toBe(111);
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
