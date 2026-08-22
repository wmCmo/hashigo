import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { importExportDirs } from "../src/import/index.js";
import { formatInstant as importerFormatInstant } from "../src/import/reviews.js";
import {
  FSRS6_DEFAULT_PARAMETERS,
  FSRS6_UNIDENTIFIABLE,
  respectsFrozenWeights,
} from "../src/scheduler/algorithms/fsrs6.js";
import { GRADE_AGAIN, GRADE_GOOD, type ReviewObservation } from "../src/scheduler/algorithms/index.js";
import {
  DormantTrackError,
  FUZZ_MAY_EXCEED_MAX_INTERVAL,
  INTERVAL_FUZZ,
  InstantFormatError,
  MAX_INTERVAL_DAYS,
  PARAMETERS_ARE_PROVISIONAL,
  SCHEDULER_ALGORITHM,
  SCHEDULER_PARAMETERS,
  SchedulerStateError,
  TARGET_RETENTION,
  TrackNotFoundError,
  dueInstant,
  dueTracks,
  exactDaysBetween,
  formatInstant,
  fuzzFactor,
  fuzzInterval,
  gradeMemory,
  gradeTrack,
  intervalForMemory,
  localDate,
  localDayNumber,
  newTracks,
  nowInHostOffset,
  parseInstant,
  parseMemory,
  queueCounts,
  retrievabilityOf,
  reviewForecast,
  seedMemory,
  seedTrackMemory,
  serialiseMemory,
  targetRetentionForCard,
  trackMemory,
  trackObservations,
  wholeDaysBetween,
} from "../src/scheduler/index.js";

/**
 * Stage 6 acceptance — the scheduler, as the app uses it.
 *
 * Three halves, and the third is the one with teeth.
 *
 * 1. THE DAY ARITHMETIC. Every claim in `day.ts` about local dates, offsets and
 *    midnight, plus the assertion that its `formatInstant` and the IMPORTER's
 *    agree character for character. The two are separate implementations on
 *    purpose (the importer pulls in the Transit decoder; the scheduler ships to
 *    the browser), and a drift between them would put two shapes of due date in
 *    one column with nothing to notice.
 *
 * 2. THE SCHEDULING ARITHMETIC. Pure, no database. The properties that have to
 *    hold for the policy in `policy.ts` to mean what it says: a pass lengthens
 *    and a lapse shortens, the cap binds, lower target retention means a longer
 *    interval, and a binary grade can never reach w[15] or w[16].
 *
 * 3. THE DATABASE PATH. What actually gets written. The load-bearing ones:
 *    grading an imported track SEEDS from its history instead of treating it as
 *    new, `review_interval_audit` returns no rows after grading (the invariant
 *    that keeps both interval columns safe), and the append-only trigger still
 *    stands.
 */

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const EXPORT_DIRS = EXPORT_NAMES.map((name) => resolve(import.meta.dirname, "..", "exports", name));
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

// ─── half one: the day ───────────────────────────────────────────────────────

describe("instants and the local day", () => {
  it("keeps the offset it was given and refuses one it was not", () => {
    expect(parseInstant("2026-08-22T09:00:00+09:00").offsetMinutes).toBe(540);
    expect(parseInstant("2026-08-22T09:00:00-05:30").offsetMinutes).toBe(-330);
    expect(parseInstant("2026-08-22T00:00:00Z").offsetMinutes).toBe(0);
    // A naked local time is not an instant. The host's zone is not an answer.
    expect(() => parseInstant("2026-08-22T09:00:00")).toThrow(InstantFormatError);
    expect(() => parseInstant("yesterday")).toThrow(InstantFormatError);
  });

  it("emits exactly what the importer emits", () => {
    // Separate implementations, one column. If this ever diverges, imported and
    // locally written due dates stop being comparable as strings — which is what
    // the queue's `substr(due_at, 1, 10)` comparison rests on.
    for (const iso of [
      "2022-06-28T00:00:00Z",
      "2026-08-22T14:37:09Z",
      "2026-01-01T15:00:00Z",
      "2026-12-31T23:59:59Z",
    ]) {
      for (const offset of [540, 0, -300, 330, -720]) {
        const ms = Date.parse(iso);
        expect(formatInstant(ms, offset)).toBe(importerFormatInstant(new Date(ms), offset));
      }
    }
  });

  it("reads the local date off the string, because that is what an offset means", () => {
    // 15:00Z is midnight JST the NEXT day — the exact shape all 102,020 imported
    // reviews carry.
    expect(localDate("2026-08-21T15:00:00Z")).toBe("2026-08-21");
    expect(localDate(formatInstant(Date.parse("2026-08-21T15:00:00Z"), 540))).toBe("2026-08-22");
    expect(formatInstant(Date.parse("2026-08-21T15:00:00Z"), 540)).toBe("2026-08-22T00:00:00+09:00");
  });

  it("counts WHOLE days between local dates, and 0 within one", () => {
    const morning = "2026-08-22T09:00:00+09:00";
    const night = "2026-08-22T23:40:00+09:00";
    const tomorrow = "2026-08-23T00:10:00+09:00";
    expect(wholeDaysBetween(morning, night)).toBe(0);
    expect(wholeDaysBetween(morning, tomorrow)).toBe(1);
    // The exact measurement is a DIFFERENT number, deliberately: 0.6 of a day.
    expect(exactDaysBetween(morning, night)).toBeCloseTo(0.6111, 3);
    expect(exactDaysBetween(morning, tomorrow)).toBeCloseTo(0.6319, 3);
    expect(localDayNumber("1970-01-01T00:00:00Z")).toBe(0);
    expect(localDayNumber("1970-01-01T00:00:00+09:00")).toBe(0);
  });

  it("puts a due date at local midnight, N whole days on", () => {
    // The learn-ahead defect this prevents: graded at 23:40 with a one-day
    // interval, due at TOMORROW'S MIDNIGHT and therefore in tomorrow's session.
    expect(dueInstant("2026-08-22T23:40:00+09:00", 1)).toBe("2026-08-23T00:00:00+09:00");
    expect(dueInstant("2026-08-22T00:10:00+09:00", 1)).toBe("2026-08-23T00:00:00+09:00");
    expect(dueInstant("2026-08-22T09:00:00+09:00", 365)).toBe("2027-08-22T00:00:00+09:00");
    // Same shape as Mochi's own due values, which is what lets the two mix.
    expect(dueInstant("2026-08-22T09:00:00+09:00", 30)).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\+09:00$/);
    expect(() => dueInstant("2026-08-22T09:00:00+09:00", 1.5)).toThrow(/whole days/);
  });

  it("stamps now in the host's offset rather than inventing a timezone", () => {
    const at = new Date("2026-08-22T05:00:00Z");
    const stamped = nowInHostOffset(at);
    expect(parseInstant(stamped).ms).toBe(at.getTime());
    expect(parseInstant(stamped).offsetMinutes).toBe(-at.getTimezoneOffset());
  });
});

// ─── half two: the arithmetic ────────────────────────────────────────────────

function observations(...spec: readonly (readonly [number, 0 | 1])[]): ReviewObservation[] {
  return spec.map(([elapsedDays, remembered], ordinal) => ({
    ordinal,
    elapsedDays,
    remembered,
    grade: remembered === 1 ? GRADE_GOOD : GRADE_AGAIN,
  }));
}

describe("the settled policy", () => {
  it("ships FSRS-6, 365 days, 0.90, and says the weights are provisional", () => {
    expect(SCHEDULER_ALGORITHM).toBe("fsrs6");
    expect(MAX_INTERVAL_DAYS).toBe(365);
    expect(TARGET_RETENTION).toBe(0.9);
    expect(SCHEDULER_PARAMETERS.length).toBe(21);
    expect(PARAMETERS_ARE_PROVISIONAL).toBe(true);
    // The fit's real content, per BACKTEST.md: a flatter forgetting curve.
    expect(SCHEDULER_PARAMETERS[20]).toBeCloseTo(0.1, 4);
    expect(FSRS6_DEFAULT_PARAMETERS[20]).toBeCloseTo(0.1542, 4);
  });

  it("agrees with the schema's seeded default, so a fresh database is consistent", () => {
    const db = openDatabase(MEMORY);
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("target_retention.default") as
      | { value: string }
      | undefined;
    expect(Number(row?.value)).toBe(TARGET_RETENTION);
    db.close();
  });
});

describe("grading, as arithmetic", () => {
  it("initialises a new card from the grade alone, with no retrievability", () => {
    const remembered = gradeMemory({ memory: null, elapsedDays: 0, remembered: 1 });
    const forgot = gradeMemory({ memory: null, elapsedDays: 0, remembered: 0 });
    expect(remembered.firstReview).toBe(true);
    expect(remembered.retrievability).toBeNull();
    expect(remembered.grade).toBe(GRADE_GOOD);
    expect(forgot.grade).toBe(GRADE_AGAIN);
    // Good must start stronger than Again, or w[0..2] are the wrong way round.
    expect(remembered.memory.stability).toBeGreaterThan(forgot.memory.stability);
    expect(remembered.intervalDays).toBeGreaterThanOrEqual(1);
  });

  it("lengthens on a pass and shortens on a lapse, from the same state", () => {
    const memory = { stability: 40, difficulty: 5 };
    const pass = gradeMemory({ memory, elapsedDays: 30, remembered: 1 });
    const lapse = gradeMemory({ memory, elapsedDays: 30, remembered: 0 });
    expect(pass.memory.stability).toBeGreaterThan(memory.stability);
    expect(lapse.memory.stability).toBeLessThan(memory.stability);
    expect(pass.intervalDays).toBeGreaterThan(lapse.intervalDays);
    // Both are told what the model predicted before it saw the outcome, and it
    // is the same number for both — the outcome cannot change the prediction.
    expect(pass.retrievability).toBe(lapse.retrievability);
    expect(pass.retrievability).toBeCloseTo(retrievabilityOf(memory, 30), 12);
  });

  it("never issues less than a day or more than the cap, and says when the cap bound", () => {
    const weak = gradeMemory({ memory: { stability: 0.01, difficulty: 9 }, elapsedDays: 5, remembered: 0 });
    expect(weak.intervalDays).toBe(1);
    expect(weak.clippedByCap).toBe(false);

    const strong = gradeMemory({ memory: { stability: 20_000, difficulty: 2 }, elapsedDays: 1, remembered: 1 });
    expect(strong.intervalDays).toBe(MAX_INTERVAL_DAYS);
    expect(strong.clippedByCap).toBe(true);
    expect(strong.rawIntervalDays).toBeGreaterThan(MAX_INTERVAL_DAYS);

    // The cap is a policy ceiling, not a data limit: raise it and the model's
    // own number comes through unchanged.
    const uncapped = gradeMemory({
      memory: { stability: 20_000, difficulty: 2 },
      elapsedDays: 1,
      remembered: 1,
      maxIntervalDays: 100_000,
    });
    expect(uncapped.intervalDays).toBeGreaterThan(MAX_INTERVAL_DAYS);
    expect(uncapped.clippedByCap).toBe(false);
  });

  it("asks for a longer interval at a lower target retention", () => {
    // The whole target-retention argument in policy.ts depends on this
    // direction. Uncapped, or 365 hides it.
    const memory = { stability: 100, difficulty: 5 };
    const at85 = intervalForMemory(memory, 0.85, 100_000);
    const at90 = intervalForMemory(memory, 0.9, 100_000);
    const at95 = intervalForMemory(memory, 0.95, 100_000);
    expect(at85).toBeGreaterThan(at90);
    expect(at90).toBeGreaterThan(at95);
  });

  it("cannot reach the two weights binary grading makes unreachable", () => {
    // w[15] is the Hard penalty, w[16] the Easy bonus. Move them to absurd
    // values: nothing this module can produce may change, because ratings 2 and
    // 4 cannot occur. This is the test that would catch a four-button grade
    // sneaking in through a default argument.
    const tampered = [...SCHEDULER_PARAMETERS];
    tampered[15] = 0.1;
    tampered[16] = 6;
    for (const remembered of [0, 1] as const) {
      for (const elapsedDays of [0, 1, 30, 400]) {
        const base = gradeMemory({ memory: { stability: 25, difficulty: 6 }, elapsedDays, remembered });
        const other = gradeMemory({
          memory: { stability: 25, difficulty: 6 },
          elapsedDays,
          remembered,
          parameters: tampered,
        });
        expect(other.memory).toEqual(base.memory);
        expect(other.intervalDays).toBe(base.intervalDays);
      }
    }
  });

  /**
   * `respectsFrozenWeights` DESCRIBES ITSELF AS "a runtime assertion target" and
   * had ZERO call sites — in src/, in test/, anywhere. A predicate nobody
   * evaluates is a comment.
   *
   * The test above proves the frozen weights are UNREACHABLE at grade time, which
   * is the behavioural half. This is the other half and it is about the shipped
   * vector: decision 2 says w[15] and w[16] are "frozen at their published
   * defaults, permanently", and nothing checked that the fitted set actually
   * leaves them there. A refit that moved them would produce a vector whose two
   * unreachable weights are fitted noise — harmless today, and a lie in the file
   * that says they are defaults.
   */
  it("ships a parameter vector that leaves every unreachable weight at its default", () => {
    expect(respectsFrozenWeights(SCHEDULER_PARAMETERS)).toBe(true);
    // Against the wider list the fitter freezes, not just the two the schema
    // names: w[1] and w[3] are the initial stabilities for Hard and Easy and are
    // unreachable for the same reason.
    expect(respectsFrozenWeights(SCHEDULER_PARAMETERS, FSRS6_UNIDENTIFIABLE)).toBe(true);
    expect([...FSRS6_UNIDENTIFIABLE].sort((a, b) => a - b)).toEqual([1, 3, 15, 16]);

    // Teeth: the predicate must be capable of returning false, or the two
    // assertions above are decoration.
    const moved = [...SCHEDULER_PARAMETERS] as unknown as typeof SCHEDULER_PARAMETERS;
    (moved as number[])[15] = 0.1234;
    expect(respectsFrozenWeights(moved)).toBe(false);
  });

  it("treats a same-day re-review as elapsed 0, which is a different branch", () => {
    const memory = { stability: 30, difficulty: 5 };
    const sameDay = gradeMemory({ memory, elapsedDays: 0, remembered: 1 });
    const nextDay = gradeMemory({ memory, elapsedDays: 1, remembered: 1 });
    expect(sameDay.memory.stability).not.toBeCloseTo(nextDay.memory.stability, 6);
    // Retrievability at elapsed 0 is exactly 1: no time has been recorded as
    // passing, which is the honest reading of a date-only log.
    expect(sameDay.retrievability).toBe(1);
  });

  it("rounds a fractional elapsedDays rather than passing it to the model", () => {
    // `gradeMemory` is a PUBLIC entry point, so it cannot assume its caller went
    // through `wholeDaysBetween`. The `Math.round` guarding that is defence in
    // depth — and a fault injection proved it was the ONE part of the whole-days
    // rule with no test behind it: replacing it with the raw value turned nothing
    // red, while breaking `wholeDaysBetween` itself turned 3 red.
    const memory = { stability: 30, difficulty: 5 };
    const whole = gradeMemory({ memory, elapsedDays: 7, remembered: 1 });
    for (const fraction of [6.6, 7.0, 7.4]) {
      const rounded = gradeMemory({ memory, elapsedDays: fraction, remembered: 1 });
      expect(rounded.intervalDays, `elapsedDays ${fraction}`).toBe(whole.intervalDays);
      expect(rounded.memory.stability, `elapsedDays ${fraction}`).toBeCloseTo(
        whole.memory.stability,
        9,
      );
    }
    // And it rounds rather than truncating: 7.6 is 8 days, not 7.
    expect(gradeMemory({ memory, elapsedDays: 7.6, remembered: 1 }).intervalDays).toBe(
      gradeMemory({ memory, elapsedDays: 8, remembered: 1 }).intervalDays,
    );
    // And a fractional value must not equal the TRUNCATED neighbour, or the
    // assertion above would pass under `Math.floor` too.
    expect(gradeMemory({ memory, elapsedDays: 7.6, remembered: 1 }).rawIntervalDays).not.toBeCloseTo(
      gradeMemory({ memory, elapsedDays: 7, remembered: 1 }).rawIntervalDays,
      9,
    );
  });

  it("spreads an interval by ±5%, keyed on the track and nothing coarser", () => {
    // THE PROPERTY THE DECISION IS ABOUT. 3,650 of the 8,518 live scheduled
    // tracks sit on exactly 365 days, so the thing fuzz has to do is give two
    // tracks that agree on everything DIFFERENT due dates. Keyed on the interval
    // instead, they would all agree and the clump would merely translate —
    // measured at worst-day 295 against a no-fuzz baseline of 188.
    const shipped = new Set<number>();
    for (let trackId = 1; trackId <= 200; trackId += 1) {
      shipped.add(fuzzInterval(365, trackId));
    }
    expect(shipped.size).toBeGreaterThan(20);
    // What keying it per COHORT would produce, as one line: one value, 200 times.
    const cohortKeyed = new Set([...Array(200)].map(() => fuzzInterval(365, 365)));
    expect(cohortKeyed.size).toBe(1);

    // Inside the width, and never outside it.
    for (const interval of shipped) {
      expect(interval).toBeGreaterThanOrEqual(Math.floor(365 * (1 - INTERVAL_FUZZ)));
      expect(interval).toBeLessThanOrEqual(Math.ceil(365 * (1 + INTERVAL_FUZZ)));
    }
    // Deterministic: the same track always lands on the same day, which is what
    // lets two synced devices agree without exchanging a random seed.
    expect(fuzzInterval(365, 42)).toBe(fuzzInterval(365, 42));
  });

  it("keeps the fuzz factor centred and bounded over many keys", () => {
    let low = 1;
    let high = -1;
    let sum = 0;
    const N = 20_000;
    for (let key = 0; key < N; key += 1) {
      const f = fuzzFactor(key);
      expect(f).toBeGreaterThanOrEqual(-INTERVAL_FUZZ);
      expect(f).toBeLessThan(INTERVAL_FUZZ);
      low = Math.min(low, f);
      high = Math.max(high, f);
      sum += f;
    }
    // Centred: a biased hash would lengthen or shorten every interval he has.
    expect(Math.abs(sum / N)).toBeLessThan(0.001);
    // And it actually reaches the ends rather than hugging the middle.
    expect(low).toBeLessThan(-INTERVAL_FUZZ * 0.99);
    expect(high).toBeGreaterThan(INTERVAL_FUZZ * 0.99);
  });

  it("leaves one and two days alone, and never returns less than a day", () => {
    for (let key = 0; key < 50; key += 1) {
      expect(fuzzInterval(1, key)).toBe(1);
      expect(fuzzInterval(2, key)).toBe(2);
      expect(fuzzInterval(3, key)).toBeGreaterThanOrEqual(1);
    }
    // Width 0 is the off switch a measurement uses; it must be exact, not close.
    expect(fuzzInterval(365, 7, 0)).toBe(365);
  });

  it("applies fuzz AFTER the cap, which is the only order that moves anything", () => {
    // Measured, and the reason this order was chosen: seeding every live track
    // and asking the fitted model what it wants at 0.90 gives a MEDIAN raw
    // interval of 988 days, and 6,617 of the 6,669 tracks over the cap (99.2%)
    // want more than 365/0.95 = 384 days. Fuzz applied before the cap cannot
    // pull any of those under 365 — they clamp straight back onto it.
    const strong = { stability: 20_000, difficulty: 2 };
    const shipped = new Set<number>();
    for (let trackId = 1; trackId <= 100; trackId += 1) {
      const result = gradeMemory({ memory: strong, elapsedDays: 1, remembered: 1, fuzzKey: trackId });
      expect(result.cappedIntervalDays).toBe(MAX_INTERVAL_DAYS);
      expect(result.clippedByCap).toBe(true);
      shipped.add(result.intervalDays);
    }
    // The cap cohort is spread, not pinned.
    expect(shipped.size).toBeGreaterThan(10);
    expect(Math.min(...shipped)).toBeLessThan(MAX_INTERVAL_DAYS);
    expect(Math.max(...shipped)).toBeGreaterThan(MAX_INTERVAL_DAYS);
    // And the overshoot is bounded by the width, not open-ended. 383 < 454, the
    // longest gap ever observed, which is what the cap exists to stay inside.
    expect(Math.max(...shipped)).toBeLessThanOrEqual(383);
    expect(FUZZ_MAY_EXCEED_MAX_INTERVAL).toBe(true);
  });

  it("is off unless a key is given, so the pure tests stay exact", () => {
    const unfuzzed = gradeMemory({ memory: { stability: 100, difficulty: 5 }, elapsedDays: 30, remembered: 1 });
    expect(unfuzzed.intervalDays).toBe(unfuzzed.cappedIntervalDays);
  });

  it("replays a history into a state, and returns null for no history", () => {
    expect(seedMemory([])).toBeNull();
    const seeded = seedMemory(observations([0, 1], [3, 1], [10, 1], [30, 0], [1, 1]));
    expect(seeded).not.toBeNull();
    expect(seeded?.stability).toBeGreaterThan(0);
    // A long clean history must end up stronger than one lapse-riddled review.
    const easy = seedMemory(observations([0, 1], [7, 1], [30, 1], [90, 1], [200, 1]));
    const hard = seedMemory(observations([0, 0], [1, 0], [1, 0], [1, 0], [1, 0]));
    expect(easy?.stability).toBeGreaterThan(hard?.stability as number);
    expect(easy?.difficulty).toBeLessThan(hard?.difficulty as number);
  });

  it("round-trips scheduler_state, and throws rather than resetting a card", () => {
    const memory = { stability: 12.5, difficulty: 6.25 };
    expect(parseMemory(serialiseMemory(memory))).toEqual(memory);
    expect(parseMemory(null)).toBeNull();
    expect(parseMemory("")).toBeNull();
    for (const bad of ["{", "null", "[]", '{"stability":0,"difficulty":5}', '{"stability":"x","difficulty":5}', '{"stability":5}']) {
      expect(() => parseMemory(bad)).toThrow(SchedulerStateError);
    }
  });
});

// ─── half three: the database ────────────────────────────────────────────────

/** A one-deck, one-card, one-track database with an optional review history. */
function fixture(options: { readonly history?: readonly (readonly [string, 0 | 1, number | null])[] } = {}): {
  db: Db;
  trackId: number;
} {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name) VALUES ('d', '日本語')").run();
  db.prepare("INSERT INTO cards (id, deck_id, name) VALUES ('c', 'd', '橋')").run();
  const track = db
    .prepare("INSERT INTO card_tracks (card_id, kind, scheduler) VALUES ('c', 'forward', ?) RETURNING id")
    .get(options.history === undefined ? null : "mochi") as { id: number };

  let previousNext: number | null = null;
  let previousAt: string | null = null;
  let reps = 0;
  let lapses = 0;
  let lastDue: string | null = null;
  for (const [reviewedAt, remembered, nextScheduledDays] of options.history ?? []) {
    const dueAt = nextScheduledDays === null ? null : dueInstant(reviewedAt, nextScheduledDays);
    db.prepare(
      `INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown, remembered,
                            elapsed_days, scheduled_days, next_scheduled_days, due_at, source)
       VALUES (?, ?, 540, 1, ?, ?, ?, ?, ?, 'mochi')`,
    ).run(
      track.id,
      reviewedAt,
      remembered,
      previousAt === null ? null : exactDaysBetween(previousAt, reviewedAt),
      previousNext,
      nextScheduledDays,
      dueAt,
    );
    previousNext = nextScheduledDays;
    previousAt = reviewedAt;
    reps += 1;
    if (remembered === 0) lapses += 1;
    lastDue = dueAt;
  }
  if (reps > 0) {
    db.prepare(
      `UPDATE card_tracks SET reps = ?, lapses = ?, last_reviewed_at = ?, due_at = ?, scheduled_days = ?
        WHERE id = ?`,
    ).run(reps, lapses, previousAt, lastDue, previousNext, track.id);
  }
  return { db, trackId: track.id };
}

const MOCHI_HISTORY = [
  ["2026-01-05T00:00:00+09:00", 1, 3],
  ["2026-01-08T00:00:00+09:00", 1, 10],
  ["2026-01-18T00:00:00+09:00", 0, 1],
  ["2026-01-19T00:00:00+09:00", 1, 12],
  ["2026-01-31T00:00:00+09:00", 1, 40],
] as const satisfies readonly (readonly [string, 0 | 1, number | null])[];

function auditRows(db: Db): unknown[] {
  return db.prepare("SELECT * FROM review_interval_audit").all();
}

describe("grading against the database", () => {
  it("writes a review and advances the track in one step", () => {
    const { db, trackId } = fixture();
    const result = gradeTrack(db, {
      trackId,
      remembered: 1,
      reviewedAt: "2026-08-22T21:30:00+09:00",
      durationMs: 4200,
    });

    expect(result.firstReview).toBe(true);
    expect(result.memorySource).toBe("new");
    // Literal, not `dueInstant(...)` — asserting a function against itself would
    // pass however wrong that function is. Local midnight, in his own offset,
    // which is also the shape every imported Mochi due date has.
    expect(result.dueAt.endsWith("T00:00:00+09:00")).toBe(true);
    expect(result.dueAt).toBe(dueInstant("2026-08-22T21:30:00+09:00", result.intervalDays));

    const review = db.prepare("SELECT * FROM reviews WHERE id = ?").get(result.reviewId) as Record<
      string,
      unknown
    >;
    expect(review["source"]).toBe("local");
    // The whole point of SPEC's "the one that cannot wait": a real time of day.
    expect(review["time_unknown"]).toBe(0);
    expect(review["tz_offset_minutes"]).toBe(540);
    expect(review["remembered"]).toBe(1);
    expect(review["elapsed_days"]).toBeNull();
    expect(review["scheduled_days"]).toBeNull();
    expect(review["next_scheduled_days"]).toBe(result.intervalDays);
    expect(review["duration_ms"]).toBe(4200);
    expect(review["import_key"]).toBeNull();

    const track = db.prepare("SELECT * FROM card_tracks WHERE id = ?").get(trackId) as Record<
      string,
      unknown
    >;
    expect(track["reps"]).toBe(1);
    expect(track["lapses"]).toBe(0);
    expect(track["scheduler"]).toBe("fsrs6");
    expect(track["due_at"]).toBe(result.dueAt);
    expect(track["scheduled_days"]).toBe(result.intervalDays);
    expect(track["last_reviewed_at"]).toBe("2026-08-22T21:30:00+09:00");
    expect(parseMemory(track["scheduler_state"] as string)).toEqual(result.memory);
    expect(auditRows(db)).toEqual([]);
    db.close();
  });

  it("puts a card graded at 23:40 into TOMORROW MORNING's queue, not tomorrow night's", () => {
    // The queue is day-grained, end to end: a card graded near midnight is due
    // on its whole due DATE and not before it. This is what actually prevents
    // the learn-ahead defect — `dueInstant` storing local midnight is the
    // canonical form, and breaking it leaves this test green. See day.ts.
    const { db, trackId } = fixture();
    const result = gradeTrack(db, {
      trackId,
      remembered: 0,
      reviewedAt: "2026-08-22T23:40:00+09:00",
    });
    expect(result.intervalDays).toBe(1);
    expect(dueTracks(db, { now: "2026-08-23T07:00:00+09:00" }).map((r) => r.trackId)).toEqual([
      trackId,
    ]);
    // And not before its day: still not due at 23:59 on the day it was graded.
    expect(dueTracks(db, { now: "2026-08-22T23:59:00+09:00" })).toEqual([]);
    db.close();
  });

  it("SEEDS an imported Mochi track from its history rather than treating it as new", () => {
    const { db, trackId } = fixture({ history: MOCHI_HISTORY });

    const before = trackMemory(db, {
      id: trackId,
      cardId: "c",
      kind: "forward",
      dormant: 0,
      dueAt: null,
      scheduledDays: null,
      reps: 5,
      lapses: 1,
      lastReviewedAt: null,
      scheduler: "mochi",
      schedulerState: null,
    });
    expect(before.source).toBe("seeded");
    // The same state a replay of the same observations produces — this is the
    // claim that four years of history survives the move off Mochi.
    expect(before.memory).toEqual(seedMemory(trackObservations(db, trackId)));

    const result = gradeTrack(db, {
      trackId,
      remembered: 1,
      reviewedAt: "2026-03-12T20:00:00+09:00",
    });
    expect(result.memorySource).toBe("seeded");
    expect(result.firstReview).toBe(false);
    expect(result.retrievability).not.toBeNull();
    // 40 days after the last Mochi review on 2026-01-31.
    expect(result.elapsedDaysWhole).toBe(40);
    expect(result.elapsedDaysExact).toBeCloseTo(40.8333, 3);
    // The planned interval it was answering comes from the PREVIOUS ROW, which
    // is what `review_interval_audit` checks against.
    expect(result.scheduledDays).toBe(40);

    // A track graded from a seeded state must schedule further out than the same
    // card treated as brand new, or the seed did nothing.
    const asNew = gradeMemory({ memory: null, elapsedDays: 0, remembered: 1 });
    expect(result.intervalDays).toBeGreaterThan(asNew.intervalDays);
    expect(auditRows(db)).toEqual([]);
    db.close();
  });

  it("feeds the model WHOLE days, so the time of day cannot move the schedule", () => {
    // Decision 6 in CLAUDE.md, as a test: name the basis or the number is not a
    // fact. Two identical reviews 40 whole days after the same predecessor, one
    // at 02:00 and one at 20:00. Whole days are 40 for both, exact days are
    // 40.08 and 40.83 — so feeding the model the exact gap makes the hour of the
    // evening change the interval, on a fit that has never seen an hour.
    const early = fixture({ history: MOCHI_HISTORY });
    const late = fixture({ history: MOCHI_HISTORY });
    const a = gradeTrack(early.db, { trackId: early.trackId, remembered: 1, reviewedAt: "2026-03-12T02:00:00+09:00" });
    const b = gradeTrack(late.db, { trackId: late.trackId, remembered: 1, reviewedAt: "2026-03-12T20:00:00+09:00" });

    expect(a.elapsedDaysWhole).toBe(40);
    expect(b.elapsedDaysWhole).toBe(40);
    expect(a.memory).toEqual(b.memory);
    expect(a.retrievability).toBe(b.retrievability);
    // `cappedIntervalDays`, not `intervalDays`: the claim here is about the
    // MODEL, and fuzz is keyed on the track id, so comparing the shipped
    // interval would only agree because both fixtures happen to number their
    // one track the same.
    expect(a.cappedIntervalDays).toBe(b.cappedIntervalDays);

    // The MEASURED column is the other number, and it does differ — which is the
    // whole reason both exist.
    expect(a.elapsedDaysExact).toBeCloseTo(40.0833, 3);
    expect(b.elapsedDaysExact).toBeCloseTo(40.8333, 3);
    expect(a.elapsedDaysExact).not.toBe(b.elapsedDaysExact);
    const stored = early.db.prepare("SELECT elapsed_days FROM reviews WHERE id = ?").get(a.reviewId) as {
      elapsed_days: number;
    };
    expect(stored.elapsed_days).toBeCloseTo(40.0833, 3);
    early.db.close();
    late.db.close();
  });

  it("fuzzes with the TRACK ID, so two identical cards do not stack on one day", () => {
    // End to end, through the write path. Two tracks on two cards with byte-
    // identical histories, graded at the same instant: everything the model sees
    // is the same, so the only thing that can separate their due dates is the
    // fuzz key — and it has to, or a heavy study day returns as a spike a year
    // later. Today that spike is real and measured: worst future day 188.
    const db = openDatabase(MEMORY);
    db.prepare("INSERT INTO decks (id, name) VALUES ('d', '日本語')").run();
    const dueDates = new Set<string>();
    const intervals = new Set<number>();
    const preFuzz = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      const cardId = `c${i}`;
      db.prepare("INSERT INTO cards (id, deck_id, name) VALUES (?, 'd', '橋')").run(cardId);
      const track = db
        .prepare("INSERT INTO card_tracks (card_id, kind) VALUES (?, 'forward') RETURNING id")
        .get(cardId) as { id: number };
      // Two graded reviews each, identical timing, so they reach a long interval.
      gradeTrack(db, { trackId: track.id, remembered: 1, reviewedAt: "2026-01-01T20:00:00+09:00" });
      const second = gradeTrack(db, {
        trackId: track.id,
        remembered: 1,
        reviewedAt: "2026-03-01T20:00:00+09:00",
      });
      dueDates.add(second.dueAt);
      intervals.add(second.intervalDays);
      preFuzz.add(second.cappedIntervalDays);
    }
    // Every card had an identical history, so the model's own answer is ONE
    // value for all forty — which is precisely the stacking fuzz has to break.
    expect(preFuzz.size).toBe(1);
    expect(intervals.size).toBeGreaterThan(5);
    expect(dueDates.size).toBeGreaterThan(5);
    expect(auditRows(db)).toEqual([]);
    db.close();
  });

  it("stores the FUZZED interval, which is what keeps the audit honest", () => {
    // The fuzzed value is what was PLANNED, so it is what belongs in
    // reviews.next_scheduled_days — and the next review's scheduled_days must
    // then match it. Storing the unfuzzed value instead would break the chain on
    // every single review, which is exactly the invariant review_interval_audit
    // exists to catch.
    const { db, trackId } = fixture({ history: MOCHI_HISTORY });
    const first = gradeTrack(db, { trackId, remembered: 1, reviewedAt: "2026-03-12T20:00:00+09:00" });
    const stored = db.prepare("SELECT next_scheduled_days FROM reviews WHERE id = ?").get(first.reviewId) as {
      next_scheduled_days: number;
    };
    expect(stored.next_scheduled_days).toBe(first.intervalDays);
    const second = gradeTrack(db, { trackId, remembered: 1, reviewedAt: "2026-06-01T20:00:00+09:00" });
    expect(second.scheduledDays).toBe(first.intervalDays);
    expect(auditRows(db)).toEqual([]);
    db.close();
  });

  it("takes the planned interval from the previous REVIEW, not from the track column", () => {
    // `card_tracks.scheduled_days` is a cache of the last review's
    // `next_scheduled_days`; `review_interval_audit` checks the rows, not the
    // cache. Drift the cache and the invariant must still hold — otherwise the
    // audit passes only for as long as nothing has ever gone wrong, which is not
    // what an audit is for.
    const { db, trackId } = fixture({ history: MOCHI_HISTORY });
    db.prepare("UPDATE card_tracks SET scheduled_days = 999 WHERE id = ?").run(trackId);
    const result = gradeTrack(db, { trackId, remembered: 1, reviewedAt: "2026-03-12T20:00:00+09:00" });
    expect(result.scheduledDays).toBe(40);
    expect(auditRows(db)).toEqual([]);
    // And the cache is repaired on the way out rather than left wrong.
    const track = db.prepare("SELECT scheduled_days FROM card_tracks WHERE id = ?").get(trackId) as {
      scheduled_days: number;
    };
    expect(track.scheduled_days).toBe(result.intervalDays);
    db.close();
  });

  it("keeps the interval chain intact across a run of local reviews", () => {
    const { db, trackId } = fixture({ history: MOCHI_HISTORY });
    const days = ["2026-03-12", "2026-04-02", "2026-05-01", "2026-05-02", "2026-08-01"];
    const grades: (0 | 1)[] = [1, 1, 0, 1, 1];
    let previousInterval: number | null = null;
    for (let i = 0; i < days.length; i += 1) {
      const result = gradeTrack(db, {
        trackId,
        remembered: grades[i] as 0 | 1,
        reviewedAt: `${days[i] as string}T20:00:00+09:00`,
      });
      if (previousInterval !== null) expect(result.scheduledDays).toBe(previousInterval);
      previousInterval = result.intervalDays;
    }
    // The invariant the two interval columns rest on, after five local reviews.
    expect(auditRows(db)).toEqual([]);
    const track = db.prepare("SELECT reps, lapses FROM card_tracks WHERE id = ?").get(trackId) as {
      reps: number;
      lapses: number;
    };
    expect(track.reps).toBe(MOCHI_HISTORY.length + days.length);
    expect(track.lapses).toBe(2);
    // Second grade onward reads the STORED state rather than reseeding.
    const state = db.prepare("SELECT scheduler, scheduler_state FROM card_tracks WHERE id = ?").get(trackId) as {
      scheduler: string;
      scheduler_state: string;
    };
    expect(state.scheduler).toBe("fsrs6");
    expect(trackMemory(db, {
      id: trackId,
      cardId: "c",
      kind: "forward",
      dormant: 0,
      dueAt: null,
      scheduledDays: null,
      reps: 10,
      lapses: 2,
      lastReviewedAt: null,
      scheduler: "fsrs6",
      schedulerState: state.scheduler_state,
    }).source).toBe("stored");
    db.close();
  });

  it("reseeds instead of losing a track to unusable stored state", () => {
    const { db, trackId } = fixture({ history: MOCHI_HISTORY });
    db.prepare("UPDATE card_tracks SET scheduler = 'fsrs6', scheduler_state = ? WHERE id = ?").run(
      "{not json",
      trackId,
    );
    const result = gradeTrack(db, { trackId, remembered: 1, reviewedAt: "2026-03-12T20:00:00+09:00" });
    expect(result.memorySource).toBe("reseeded");
    expect(result.firstReview).toBe(false);
    db.close();
  });

  it("refuses a dormant track and a track that does not exist", () => {
    const { db, trackId } = fixture();
    db.prepare("UPDATE card_tracks SET dormant = 1 WHERE id = ?").run(trackId);
    expect(() => gradeTrack(db, { trackId, remembered: 1 })).toThrow(DormantTrackError);
    expect(() => gradeTrack(db, { trackId: 9999, remembered: 1 })).toThrow(TrackNotFoundError);
    // And nothing was written by the attempt.
    expect(db.prepare("SELECT count(*) AS n FROM reviews").get()).toEqual({ n: 0 });
    db.close();
  });

  it("leaves reviews append-only — history is corrected by adding, never rewriting", () => {
    const { db, trackId } = fixture();
    const result = gradeTrack(db, { trackId, remembered: 0, reviewedAt: "2026-08-22T20:00:00+09:00" });
    expect(() =>
      db.prepare("UPDATE reviews SET remembered = 1 WHERE id = ?").run(result.reviewId),
    ).toThrow(/append-only/);
    db.close();
  });

  it("resolves target retention per deck, inheriting down the tree", () => {
    const db = openDatabase(MEMORY);
    db.prepare("INSERT INTO decks (id, name) VALUES ('root', '日本語')").run();
    db.prepare("INSERT INTO decks (id, parent_id, name) VALUES ('kid', 'root', '漢字')").run();
    db.prepare("INSERT INTO cards (id, deck_id) VALUES ('c1', 'kid')").run();
    expect(targetRetentionForCard(db, "c1")).toBe(TARGET_RETENTION);

    db.prepare("UPDATE decks SET target_retention = 0.95 WHERE id = 'root'").run();
    expect(targetRetentionForCard(db, "c1")).toBe(0.95);
    db.prepare("UPDATE decks SET target_retention = 0.8 WHERE id = 'kid'").run();
    expect(targetRetentionForCard(db, "c1")).toBe(0.8);

    // And it reaches the schedule: a stricter target must mean a shorter one.
    const track = db
      .prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('c1', 'forward') RETURNING id")
      .get() as { id: number };
    const strict = gradeTrack(db, {
      trackId: track.id,
      remembered: 1,
      reviewedAt: "2026-08-22T20:00:00+09:00",
      targetRetention: 0.99,
    });
    expect(strict.targetRetention).toBe(0.99);
    const loose = gradeMemory({ memory: null, elapsedDays: 0, remembered: 1, targetRetention: 0.7 });
    expect(loose.intervalDays).toBeGreaterThan(strict.intervalDays);
    db.close();
  });

  it("seeds every track in bulk without moving a single due date", () => {
    const { db, trackId } = fixture({ history: MOCHI_HISTORY });
    const dueBefore = db.prepare("SELECT due_at FROM card_tracks WHERE id = ?").get(trackId) as {
      due_at: string;
    };
    const report = seedTrackMemory(db);
    expect(report).toEqual({
      tracks: 1,
      seeded: 1,
      alreadyStored: 0,
      withoutHistory: 0,
      dormant: 0,
    });
    const after = db.prepare("SELECT due_at, scheduler, scheduler_state FROM card_tracks WHERE id = ?").get(
      trackId,
    ) as { due_at: string; scheduler: string; scheduler_state: string };
    expect(after.due_at).toBe(dueBefore.due_at);
    expect(after.scheduler).toBe("fsrs6");
    expect(parseMemory(after.scheduler_state)).toEqual(seedMemory(trackObservations(db, trackId)));
    // Idempotent: a second pass has nothing to do.
    expect(seedTrackMemory(db)).toEqual({
      tracks: 1,
      seeded: 0,
      alreadyStored: 1,
      withoutHistory: 0,
      dormant: 0,
    });
    db.close();
  });

  /**
   * `alreadyStored` MIXED TWO BASES, and the corpus hid it: it was
   * `tracks - ids.length`, i.e. an all-rows count minus a `dormant = 0` count, so
   * every dormant track was reported as "already had state" when seeding had
   * never looked at it. Zero dormant tracks in the export, so the arithmetic was
   * right by accident. This is the test that would have caught it, and the reason
   * `dormant` is now reported: four numbers that reconcile beat three and a
   * remainder.
   */
  it("reports dormant tracks separately instead of counting them as already seeded", () => {
    const { db, trackId } = fixture({ history: MOCHI_HISTORY });
    // A second track on the same card, dormant — the state seeding skips.
    db.prepare(
      `INSERT INTO card_tracks (card_id, kind, dormant, reps, lapses)
       SELECT card_id, 'reverse', 1, 0, 0 FROM card_tracks WHERE id = ?`,
    ).run(trackId);

    const report = seedTrackMemory(db);
    expect(report.tracks).toBe(2);
    expect(report.dormant).toBe(1);
    // The dormant one is NOT "already stored" — it was never considered.
    expect(report.alreadyStored).toBe(0);
    expect(report.seeded).toBe(1);

    // And the four live figures reconcile against the total, which is the whole
    // point of naming the basis.
    expect(report.seeded + report.alreadyStored + report.withoutHistory + report.dormant).toBe(
      report.tracks,
    );

    // Seeding did not touch it.
    const dormantRow = db
      .prepare("SELECT scheduler_state FROM card_tracks WHERE dormant <> 0")
      .get() as { scheduler_state: string | null };
    expect(dormantRow.scheduler_state).toBeNull();
    db.close();
  });
});

describe("the queue", () => {
  /** Two decks, four cards, hand-placed due dates. */
  function queueFixture(): Db {
    const db = openDatabase(MEMORY);
    db.prepare("INSERT INTO decks (id, name) VALUES ('root', '日本語')").run();
    db.prepare("INSERT INTO decks (id, parent_id, name) VALUES ('kid', 'root', '単語')").run();
    db.prepare("INSERT INTO decks (id, name) VALUES ('other', 'English')").run();
    const rows: readonly (readonly [string, string, string | null, number, number])[] = [
      // card, deck, due_at local date, reps, archived
      ["overdue", "kid", "2026-08-01", 4, 0],
      ["today", "kid", "2026-08-22", 9, 0],
      ["tomorrow", "kid", "2026-08-23", 2, 0],
      ["fresh", "kid", null, 0, 0],
      ["archived-due", "kid", "2026-08-01", 3, 1],
      ["other-deck", "other", "2026-08-02", 5, 0],
    ];
    for (const [id, deck, due, reps, archived] of rows) {
      db.prepare("INSERT INTO cards (id, deck_id, name, archived, pos) VALUES (?, ?, ?, ?, ?)").run(
        id,
        deck,
        id,
        archived,
        id,
      );
      db.prepare(
        "INSERT INTO card_tracks (card_id, kind, due_at, reps) VALUES (?, 'forward', ?, ?)",
      ).run(id, due === null ? null : `${due}T00:00:00+09:00`, reps);
    }
    return db;
  }

  const NOW = "2026-08-22T09:00:00+09:00";

  it("returns what is due on or before today, most overdue first", () => {
    const db = queueFixture();
    const due = dueTracks(db, { now: NOW });
    expect(due.map((row) => row.cardId)).toEqual(["overdue", "other-deck", "today"]);
    expect(due[0]?.overdueDays).toBe(21);
    expect(due[2]?.overdueDays).toBe(0);
    // Tomorrow is not due today, an archived card is never due, and a card with
    // no due date is new rather than due.
    expect(due.map((row) => row.cardId)).not.toContain("tomorrow");
    expect(due.map((row) => row.cardId)).not.toContain("archived-due");
    expect(due.map((row) => row.cardId)).not.toContain("fresh");
    db.close();
  });

  it("treats a deck as its subtree unless told otherwise", () => {
    const db = queueFixture();
    expect(dueTracks(db, { now: NOW, deckId: "root" }).map((r) => r.cardId)).toEqual([
      "overdue",
      "today",
    ]);
    expect(dueTracks(db, { now: NOW, deckId: "root", includeSubdecks: false })).toEqual([]);
    expect(dueTracks(db, { now: NOW, deckId: "kid" }).map((r) => r.cardId)).toEqual([
      "overdue",
      "today",
    ]);
    expect(dueTracks(db, { now: NOW, kinds: ["reverse"] })).toEqual([]);
    expect(dueTracks(db, { now: NOW, limit: 1 }).map((r) => r.cardId)).toEqual(["overdue"]);
    expect(() => dueTracks(db, { now: NOW, limit: -1 })).toThrow(RangeError);
    db.close();
  });

  it("counts due, overdue, new and scheduled separately, and reports dormant", () => {
    const db = queueFixture();
    expect(queueCounts(db, { now: NOW })).toEqual({
      due: 3,
      overdue: 2,
      fresh: 1,
      scheduled: 1,
      dormant: 0,
      asOf: "2026-08-22",
    });
    // Overdue is a SUBSET of due, not a sibling: 3 due of which 2 are old debt.
    db.prepare("UPDATE card_tracks SET dormant = 1 WHERE card_id = 'today'").run();
    const after = queueCounts(db, { now: NOW });
    expect(after).toMatchObject({ due: 2, overdue: 2, dormant: 1 });
    db.close();
  });

  it("lists new tracks separately", () => {
    const db = queueFixture();
    expect(newTracks(db, { now: NOW }).map((r) => r.cardId)).toEqual(["fresh"]);
    // A track with reps but no due date is NOT new — it is a data problem, and
    // silently offering it as new would hide it.
    db.prepare("UPDATE card_tracks SET due_at = NULL WHERE card_id = 'today'").run();
    expect(newTracks(db, { now: NOW }).map((r) => r.cardId)).toEqual(["fresh"]);
    db.close();
  });

  it("forecasts forward only, and keeps the empty days", () => {
    const db = queueFixture();
    const forecast = reviewForecast(db, { now: NOW, days: 3 });
    expect(forecast).toEqual([
      { date: "2026-08-23", count: 1 },
      { date: "2026-08-24", count: 0 },
      { date: "2026-08-25", count: 0 },
    ]);
    // Today's backlog is queueCounts().due, deliberately not the first bar.
    expect(forecast.some((day) => day.date === "2026-08-22")).toBe(false);
    expect(() => reviewForecast(db, { now: NOW, days: 0 })).toThrow(RangeError);
    db.close();
  });
});

// ─── the real corpus ─────────────────────────────────────────────────────────

const describeCorpus = HAVE_EXPORTS ? describe : describe.skip;

describeCorpus("the real collection", () => {
  /**
   * DECISION 15, and the reason it needs a corpus-scale test rather than a
   * fixture one: the defect it guards against is invisible at small n.
   *
   * `newTracks` used to `ORDER BY c.pos, c.id, t.id` and push `limit` into SQL.
   * With one new card in a fixture that looks identical to the correct
   * behaviour. Over the real 3,980 unlearned tracks it returned track ids
   * `1, 2, 3, 8, 12, 20, 26, 28, 30, 34` — the front of the list — and the SAME
   * TEN EVERY DAY, so the backlog would be worked in authoring order forever.
   * The assertion that catches it is "a new day deals a new hand".
   *
   * A limit applied to a sorted query has already chosen the sample, so no
   * amount of shuffling by the session layer recovers this. That is why the
   * order moved into the function and the limit moved after it.
   */
  it("picks new tracks at random, unpaired, and stably within a day", () => {
    const db = openDatabase(MEMORY);
    importExportDirs(db, EXPORT_DIRS);

    const morning = newTracks(db, { now: "2026-08-22T02:00:00+09:00", limit: 10 });
    const evening = newTracks(db, { now: "2026-08-22T20:00:00+09:00", limit: 10 });
    const tomorrow = newTracks(db, { now: "2026-08-23T10:00:00+09:00", limit: 10 });

    expect(morning).toHaveLength(10);

    // STABLE WITHIN A DAY. Re-reading the queue mid-session must not reshuffle
    // it — that is why the key is hashed rather than Math.random().
    expect(evening.map((t) => t.trackId)).toEqual(morning.map((t) => t.trackId));

    // A NEW DAY DEALS A NEW HAND.
    expect(tomorrow.map((t) => t.trackId)).not.toEqual(morning.map((t) => t.trackId));

    // UNPAIRED: ten tracks must not be five cards twice over. HONEST LABEL —
    // this is a GUARD, not a regression witness: measured, the old ordering also
    // returned ten distinct cards, because a card's forward and reverse tracks
    // are rarely both new. It passes before and after the fix. It is kept because
    // decision 15 states the property, and a future ordering change could break
    // it; it is not what caught the bug.
    expect(new Set(morning.map((t) => t.cardId)).size).toBe(10);

    // AND IT IS A SAMPLE OF THE WHOLE SET, not a prefix of it. Under the old
    // ordering every id here came from the front of `c.pos`; now they are spread
    // across the corpus, so the ten cannot all be in the first 10% of track ids.
    const all = newTracks(db, {});
    expect(all.length).toBeGreaterThan(3_000);
    const ids = all.map((t) => t.trackId).sort((a, b) => a - b);
    const cutoff = ids[Math.floor(ids.length * 0.1)] as number;
    expect(morning.filter((t) => t.trackId <= cutoff).length).toBeLessThan(10);

    db.close();
  });

  it("REGRESSION: reports the queue the export actually implies", () => {
    const db = openDatabase(MEMORY);
    importExportDirs(db, EXPORT_DIRS);

    // Every figure here is measured from the real export, not chosen. They are
    // pinned because each one is a claim CLAUDE.md or a README makes.
    const tracks = db.prepare("SELECT count(*) AS n FROM card_tracks").get() as { n: number };
    expect(tracks.n).toBe(13_392);

    const counts = queueCounts(db, { now: "2026-08-22T09:00:00+09:00" });
    expect(counts).toEqual({
      due: 443,
      overdue: 328,
      fresh: 3_980,
      scheduled: 8_518,
      dormant: 0,
      asOf: "2026-08-22",
    });

    // The archived filter is load-bearing: 33 of the 476 tracks whose due date
    // has passed sit on cards he archived.
    const withArchived = db
      .prepare(
        `SELECT count(*) AS n FROM card_tracks t JOIN cards c ON c.id = t.card_id
          WHERE t.dormant = 0 AND t.due_at IS NOT NULL AND substr(t.due_at, 1, 10) <= '2026-08-22'`,
      )
      .get() as { n: number };
    expect(withArchived.n - counts.due).toBe(33);

    // Every deck resolves to the settled default; no deck overrides it yet.
    const retentions = db
      .prepare("SELECT DISTINCT target_retention AS r FROM deck_target_retention_resolved")
      .all() as { r: number }[];
    expect(retentions).toEqual([{ r: TARGET_RETENTION }]);

    // And the queue is answerable end to end: take the most overdue card,
    // grade it, and the interval invariant still holds over 102,021 reviews.
    const [first] = dueTracks(db, { now: "2026-08-22T09:00:00+09:00", limit: 1 });
    expect(first).toBeDefined();
    const graded = gradeTrack(db, {
      trackId: (first as { trackId: number }).trackId,
      remembered: 1,
      reviewedAt: "2026-08-22T09:05:00+09:00",
    });
    expect(graded.memorySource).toBe("seeded");
    expect(graded.intervalDays).toBeGreaterThanOrEqual(1);
    // Fuzz is applied AFTER the cap, so the shipped interval may sit up to 5%
    // past 365 — and on this card it does. The cap still binds the model's own
    // answer, which is what `cappedIntervalDays` reports.
    expect(graded.cappedIntervalDays).toBeLessThanOrEqual(MAX_INTERVAL_DAYS);
    expect(graded.intervalDays).toBeLessThanOrEqual(
      Math.round(MAX_INTERVAL_DAYS * (1 + INTERVAL_FUZZ)),
    );
    expect(db.prepare("SELECT count(*) AS n FROM reviews").get()).toEqual({ n: 102_021 });
    expect(auditRows(db)).toEqual([]);
    db.close();
  }, 120_000);
});
