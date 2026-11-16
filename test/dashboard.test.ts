import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import {
  ALL_TIME,
  BEYOND_YEAR_LABEL,
  INTERVAL_BUCKETS,
  MOCHI_2026,
  MOCHI_INTERVAL_CAP_DAYS,
  activityByDay,
  activityByMonth,
  activityByYear,
  calendarYear,
  collect,
  deckProgress,
  heatThresholds,
  beyondYear,
  longIntervalOutlook,
  renderDashboard,
  retentionByDeck,
  retentionByInterval,
  totals,
  type DashboardData,
  type DateWindow,
  type DayActivity,
} from "../src/dashboard/index.js";
import { importExports, readSource, type ImportSource } from "../src/import/index.js";
import { INTERVAL_BASES } from "../src/schema/index.js";
import { TARGET_RETENTION } from "../src/scheduler/policy.js";
import { queueCounts } from "../src/scheduler/queue.js";

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const EXPORT_DIRS = EXPORT_NAMES.map((name) =>
  resolve(import.meta.dirname, "..", "exports", name),
);
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

const PAGE = resolve(import.meta.dirname, "..", "dashboard.html");
const JA_GOLDEN = resolve(import.meta.dirname, "fixtures", "dashboard", "ja.golden.html");

const MOCHI = {
  reviews: 13_240,
  days: 231,
  activeDays: 211,
  retentionPct: 95,
  cardsStudied: 5_250,
} as const;

const LAST_REVIEW_DATE = "2026-09-06";
const MOCHI_SCREENSHOT_DATE = "2026-08-19";
const MOCHI_DATA_THROUGH = "2026-08-18";

const MOCHI_WINDOW: DateWindow = {
  id: "2026",
  label: "2026年",
  from: "2026-01-01",
  to: MOCHI_DATA_THROUGH,
};

function day(reviews: number): DayActivity {
  return {
    date: "2026-01-01",
    reviews,
    cardsSeen: reviews,
    passed: reviews,
    retention: 1,
    minutes: 0,
    newCards: 0,
    cumulativeCards: 0,
  };
}

let db: Db;
let data: DashboardData;
let outlook: ReturnType<typeof longIntervalOutlook>;

describe.skipIf(!HAVE_EXPORTS)("stage 2 dashboard over the real corpus", () => {
  beforeAll(() => {
    db = openDatabase(MEMORY);
    const sources: ImportSource[] = EXPORT_DIRS.map(readSource);
    importExports(db, sources, { blobs: false });
    data = collect(db, { source: "test (in memory)", generatedAt: "2026-08-18T00:00:00.000Z" });
    outlook = longIntervalOutlook(db);
  }, 600_000);

  afterAll(() => {
    db?.close();
  });

  it("lands every all-time oracle figure", () => {
    const all = data.primary.totals;

    expect(all.reviews).toBe(103_110);
    expect(all.forwardReviews).toBe(59_514);
    expect(all.reverseReviews).toBe(43_596);
    expect(all.otherReviews).toBe(0);

    expect(((all.retention ?? 0) * 100).toFixed(2)).toBe("96.24");
    expect(all.passed).toBe(99_228);
    expect(all.lapses).toBe(3_882);
    expect(all.passed + all.lapses).toBe(all.reviews);

    expect(all.activeDays).toBe(1_333);
    expect(all.firstDate).toBe("2022-06-28");
    expect(all.lastDate).toBe(LAST_REVIEW_DATE);

    expect(Number(all.hours.toFixed(1))).toBe(641.2);
    expect(all.timedReviews).toBe(93_124);
    expect(all.medianSeconds).toBe(10);
    expect(Number((all.meanSeconds ?? 0).toFixed(1))).toBe(24.8);

    expect(all.reviewsTimeUnknown).toBe(103_110);

    expect(all.cardsStudied).toBe(5_701);
  });

  it("matches Mochi EXACTLY on active days and retention, up to the screenshot", () => {
    const year = totals(db, MOCHI_WINDOW);
    expect(year.window.id).toBe("2026");

    expect(year.activeDays).toBe(MOCHI.activeDays);
    expect(year.activeDays).toBe(211);
    expect(Math.round((year.retention ?? 0) * 100)).toBe(MOCHI.retentionPct);
    expect(Math.round((year.retention ?? 0) * 100)).toBe(95);
    expect(((year.retention ?? 0) * 100).toFixed(2)).toBe("95.10");
  });

  it("reads 14,416 reviews and 5,181 cards studied, by our own definitions", () => {
    const year = totals(db, MOCHI_WINDOW);
    expect(year.reviews).toBe(14_416);
    expect(year.cardsStudied).toBe(5_181);

    expect(year.reviews).toBeGreaterThan(MOCHI.reviews);
    expect(year.cardsStudied).toBeLessThan(MOCHI.cardsStudied);
    expect(MOCHI.cardsStudied - year.cardsStudied).toBe(69);
  });

  it("does not tune the review count toward Mochi's 13,240", () => {
    const year = totals(db, MOCHI_WINDOW);
    expect(year.cardDays).toBe(13_255);
    expect(year.cardDays).not.toBe(MOCHI.reviews);
    expect(year.cardDays - MOCHI.reviews).toBe(15);
    expect(year.reviews).not.toBe(MOCHI.reviews);
  });

  it("CUTS the published comparison at the screenshot, so its verdicts stay true", () => {
    expect(data.comparison.totals.window.to).toBe(MOCHI_DATA_THROUGH);
    expect(data.comparison.totals).toMatchObject({
      activeDays: MOCHI.activeDays,
      reviews: 14_416,
      cardsStudied: 5_181,
      cardDays: 13_255,
    });

    expect(collect(db, { comparisonYear: 2025 }).comparison.totals.window.to).toBe("2025-12-31");
  });

  it("never prints a verdict of 完全一致 next to a non-zero gap", () => {
    const year = data.comparison.totals;
    const ours: Record<string, number> = {
      reviews: year.reviews,
      daysElapsed: year.daysElapsed,
      activeDays: year.activeDays,
      retention: Math.round((year.retention ?? 0) * 100),
      cardsStudied: year.cardsStudied,
    };
    for (const row of MOCHI_2026) {
      if (!row.note.startsWith("完全一致")) continue;
      expect({ key: row.key, ours: ours[row.key] }).toEqual({ key: row.key, ours: row.mochi });
    }
  });

  it("counts elapsed days inclusively, which is where Mochi's 231 comes from", () => {
    expect(data.comparison.totals.daysElapsed).toBe(230);
    const asOf = totals(db, calendarYear(2026), { asOf: MOCHI_SCREENSHOT_DATE });
    expect(asOf.daysElapsed).toBe(MOCHI.days);
    expect(asOf.daysElapsed).toBe(231);
    expect(data.primary.totals.windowStart).toBe("2022-06-28");
    expect(data.primary.totals.windowEnd).toBe(LAST_REVIEW_DATE);
    expect(data.primary.totals.daysElapsed).toBe(1_532);
  });

  it("is bucketed by JST, not UTC — and the 2026 match is not what proves it", () => {
    const shift = db
      .prepare(
        `SELECT count(*)                        AS n,
                sum(CASE WHEN local_date = date(reviewed_at, '+1 day')
                         THEN 1 ELSE 0 END)     AS ahead,
                count(DISTINCT time(reviewed_at)) AS distinct_times
           FROM review_log`,
      )
      .get() as { n: number; ahead: number; distinct_times: number };
    expect(shift.n).toBe(103_110);
    expect(shift.ahead).toBe(103_110);
    expect(shift.distinct_times).toBe(1);

    expect(data.primary.totals.firstDate).toBe("2022-06-28");
    expect(data.primary.totals.lastDate).toBe(LAST_REVIEW_DATE);
    const utcSpan = db
      .prepare(`SELECT min(date(reviewed_at)) AS lo, max(date(reviewed_at)) AS hi FROM review_log`)
      .get() as { lo: string; hi: string };
    expect(utcSpan.lo).toBe("2022-06-27");
    expect(utcSpan.hi).toBe("2026-09-05");

    const boundary = db
      .prepare(
        `SELECT count(*) AS n FROM review_log WHERE local_date IN ('2025-12-31', '2026-01-01')`,
      )
      .get() as { n: number };
    expect(boundary.n).toBe(0);
    const utc2026 = db
      .prepare(
        `SELECT count(*)                            AS reviews,
                count(DISTINCT date(reviewed_at))   AS active_days,
                1.0 * sum(remembered) / count(*)    AS retention
           FROM review_log
          WHERE date(reviewed_at) BETWEEN '2025-12-31' AND '2026-08-17'`,
      )
      .get() as { reviews: number; active_days: number; retention: number };
    expect(utc2026.reviews).toBe(data.comparison.totals.reviews);
    expect(utc2026.active_days).toBe(data.comparison.totals.activeDays);
    expect((utc2026.retention * 100).toFixed(2)).toBe("95.10");
  });

  it("cuts the heatmap at quartiles of active days, not at a constant", () => {
    const counts = data.primary.days.map((d) => d.reviews).sort((a, b) => a - b);
    const [t1, t2, t3] = data.heat;
    const share = (t: number): number => counts.filter((c) => c <= t).length / counts.length;

    expect(counts.length).toBe(1_333);
    expect(t1).toBeLessThan(t2);
    expect(t2).toBeLessThan(t3);
    expect(share(t1)).toBeGreaterThan(0.2);
    expect(share(t1)).toBeLessThan(0.3);
    expect(share(t2)).toBeGreaterThan(0.45);
    expect(share(t2)).toBeLessThan(0.55);
    expect(share(t3)).toBeGreaterThan(0.7);
    expect(share(t3)).toBeLessThan(0.8);

    const uniform = Array.from({ length: 100 }, (_, i) => day(i + 1));
    const [u1, u2, u3] = heatThresholds(uniform);
    expect(u1 / 100).toBeGreaterThan(0.2);
    expect(u1 / 100).toBeLessThan(0.3);
    expect(u2 / 100).toBeGreaterThan(0.45);
    expect(u2 / 100).toBeLessThan(0.55);
    expect(u3 / 100).toBeGreaterThan(0.7);
    expect(u3 / 100).toBeLessThan(0.8);

    expect(heatThresholds([])).toEqual([1, 2, 3]);
    const flat = heatThresholds(Array.from({ length: 40 }, () => day(1)));
    expect(flat[0]).toBeLessThan(flat[1]);
    expect(flat[1]).toBeLessThan(flat[2]);
  });

  it("has a heatmap that adds up to the totals", () => {
    const days = data.primary.days;
    expect(days.length).toBe(data.primary.totals.activeDays);
    expect(days.reduce((sum, d) => sum + d.reviews, 0)).toBe(103_110);
    expect(days.every((d) => d.reviews > 0)).toBe(true);
    const dates = days.map((d) => d.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates);
  });

  it("has a cumulative series that is monotone and ends at cards studied", () => {
    const days = data.primary.days;
    let previous = 0;
    for (const day of days) {
      expect(day.cumulativeCards).toBeGreaterThanOrEqual(previous);
      previous = day.cumulativeCards;
    }
    expect(days[days.length - 1]?.cumulativeCards).toBe(data.primary.totals.cardsStudied);
    expect(days.reduce((sum, d) => sum + d.newCards, 0)).toBe(5_701);
  });

  it("agrees with itself across day, month and year groupings", () => {
    const byMonth = activityByMonth(db, ALL_TIME);
    const byYear = activityByYear(db);
    expect(byMonth.reduce((sum, m) => sum + m.reviews, 0)).toBe(103_110);
    expect(byYear.reduce((sum, y) => sum + y.reviews, 0)).toBe(103_110);
    expect(byYear.reduce((sum, y) => sum + y.activeDays, 0)).toBe(1_333);
    expect(byMonth.reduce((sum, m) => sum + m.newCards, 0)).toBe(5_701);
    expect(byYear.map((y) => y.year)).toEqual(["2022", "2023", "2024", "2025", "2026"]);
    const y2026 = byYear.find((y) => y.year === "2026");
    expect(y2026?.reviews).toBe(15_510);
    expect(y2026?.activeDays).toBe(227);
  });

  it("keeps its bucket labels identical to views.sql's own, on BOTH bases", () => {
    for (const basis of INTERVAL_BASES) {
      const fromView = db
        .prepare(
          `SELECT DISTINCT ${basis}_bucket AS bucket, ${basis}_bucket_label AS label
             FROM review_log_bucketed ORDER BY bucket`,
        )
        .all() as { bucket: number; label: string }[];
      expect(fromView.length).toBeGreaterThan(0);
      for (const row of fromView) {
        expect(INTERVAL_BUCKETS[row.bucket]?.label).toBe(row.label);
      }
    }
    expect(INTERVAL_BUCKETS.map((b) => b.bucket)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("refuses to bucket by an unnamed basis, because that was the whole bug", () => {
    expect(() =>
      retentionByInterval(db, ALL_TIME, "whatever" as unknown as "elapsed"),
    ).toThrow(/unknown interval basis/);
  });

  it("partitions all 103,110 reviews under EITHER basis, and only the split differs", () => {
    const { elapsed, scheduled } = data.primary.intervals;
    for (const buckets of [elapsed, scheduled]) {
      expect(buckets).toHaveLength(9);
      expect(buckets.reduce((sum, b) => sum + b.reviews, 0)).toBe(103_110);
      expect(buckets.reduce((sum, b) => sum + b.lapses, 0)).toBe(3_882);
    }
    expect(elapsed.every((b) => b.basis === "elapsed")).toBe(true);
    expect(scheduled.every((b) => b.basis === "scheduled")).toBe(true);

    expect(elapsed[0]?.label).toBe("unknown");
    expect(elapsed[0]?.reviews).toBe(9_085);
    expect(scheduled[0]?.reviews).toBe(18_073);
  });

  it("shows over-studying, and names the bands that miss the target", () => {
    const { elapsed } = data.primary.intervals;

    for (const bucket of elapsed) {
      if (bucket.retention === null) continue;
      expect(bucket.retention).toBeGreaterThan(TARGET_RETENTION);
    }
    const below = elapsed
      .filter((b) => b.retention !== null && b.retention < TARGET_RETENTION)
      .map((b) => b.label);
    expect(TARGET_RETENTION).toBe(0.9);
    expect(below).toEqual([]);

    expect(
      elapsed.filter((b) => b.retention !== null && b.retention < 0.95).map((b) => b.label),
    ).toEqual(["21-60d", "60-180d", "180-365d"]);

    const long = elapsed.find((b) => b.label === "60-180d");
    expect(long?.reviews).toBe(14_505);
    expect((long?.retention ?? 1) < (data.primary.totals.retention ?? 0)).toBe(true);
    expect(((long?.retention ?? 0) * 100).toFixed(2)).toBe("93.34");
  });

  it("finds 3,217 observations past a year, where the planned basis finds none", () => {
    const { elapsed, scheduled } = data.primary.intervals;

    const measured = beyondYear(elapsed);
    expect(measured.reviews).toBe(3_217);
    expect(measured.lapses).toBe(100);
    expect(((measured.retention ?? 0) * 100).toFixed(2)).toBe("96.89");

    const planned = beyondYear(scheduled);
    expect(planned.reviews).toBe(0);
    expect(planned.retention).toBeNull();
  });

  it("explains the zero rather than reporting it: the plans exist, none is due", () => {
    expect(outlook.observedBeyondYear).toBe(3_217);
    expect(((outlook.observedRetention ?? 0) * 100).toFixed(2)).toBe("96.89");
    expect(outlook.maxObservedElapsedDays).toBe(454);

    expect(outlook.plannedBeyondYear).toBe(1_386);
    expect(outlook.maxPlannedDays).toBe(2_707);
    expect(outlook.tracksBeyondYear).toBe(1_378);
    expect(outlook.firstDueAt?.slice(0, 10)).toBe("2027-03-17");
    expect(outlook.lastDueAt?.slice(0, 10)).toBe("2033-10-17");
  });

  it("dates the cap lift on the LOCAL calendar, not UTC", () => {
    expect(outlook.capLiftedOn).toBe("2026-02-22");
    const utc = db
      .prepare(`SELECT min(date(reviewed_at)) FROM reviews WHERE next_scheduled_days > 365`)
      .pluck()
      .get() as string;
    expect(utc).toBe("2026-02-21");

    const before = db
      .prepare(
        `SELECT count(*) FROM review_log WHERE next_scheduled_days > ? AND local_date < ?`,
      )
      .pluck()
      .get(MOCHI_INTERVAL_CAP_DAYS, outlook.capLiftedOn) as number;
    expect(before).toBe(0);
  });

  it("counts the tracks the lifted cap actually left behind", () => {
    expect(outlook.tracksAtCap).toBe(3_417);
    expect(outlook.tracksWithPlan).toBe(9_011);
    expect(((outlook.tracksAtCap / outlook.tracksWithPlan) * 100).toFixed(2)).toBe("37.92");

    expect(outlook.tracksOnStaleCap).toBe(3_306);
    expect(outlook.tracksOnStaleCap).toBeLessThan(outlook.tracksAtCap);
    expect(outlook.tracksAtCap - outlook.tracksOnStaleCap).toBe(111);
  });

  it("shows the variation that 96.24% overall hides", () => {
    const decks = data.primary.decks;
    const byPath = new Map(decks.map((d) => [d.path, d]));

    expect(((byPath.get("日本語/単語")?.directRetention ?? 0) * 100).toFixed(2)).toBe("97.20");
    expect(((byPath.get("日本語/漢字")?.directRetention ?? 0) * 100).toFixed(2)).toBe("95.10");
    expect(((byPath.get("English/Vocabulary")?.directRetention ?? 0) * 100).toFixed(2)).toBe(
      "93.41",
    );
    expect(((byPath.get("日本語/数字")?.directRetention ?? 0) * 100).toFixed(2)).toBe("100.00");

    const busy = decks.filter((d) => d.directReviews >= 500 && d.directRetention !== null);
    const values = busy.map((d) => (d.directRetention ?? 0) * 100);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(3);

    const kanji = byPath.get("日本語/漢字");
    expect((kanji?.directForwardRetention ?? 0) > (kanji?.directReverseRetention ?? 1)).toBe(true);
    expect(((kanji?.directReverseRetention ?? 0) * 100).toFixed(2)).toBe("92.90");
  });

  it("never mixes a deck's own reviews with its subtree's", () => {
    for (const deck of data.primary.decks) {
      expect(deck.directForwardReviews + deck.directReverseReviews).toBe(deck.directReviews);
      expect(deck.forwardReviews + deck.reverseReviews).toBe(deck.reviews);
      expect(deck.reviews).toBeGreaterThanOrEqual(deck.directReviews);
    }
    const kotoba = data.primary.decks.find((d) => d.path === "日本語/言葉");
    expect(kotoba?.directReviews).toBe(1_968);
    expect(kotoba?.reviews).toBe(2_405);

    const roots = data.primary.decks.filter((d) => d.depth === 0);
    expect(roots.reduce((sum, d) => sum + d.reviews, 0)).toBe(103_110);
    expect(roots.map((d) => d.path).sort()).toEqual(["English", "基本情報", "日本語"]);
  });

  it("counts tracks, and every track is exactly one of new / young / mature", () => {
    const progress = data.progress;
    const roots = progress.filter((d) => d.depth === 0);
    expect(roots.reduce((sum, d) => sum + d.tracks, 0)).toBe(13_393);
    expect(roots.reduce((sum, d) => sum + d.cards, 0)).toBe(7_716);
    for (const deck of progress) {
      expect(deck.newTracks + deck.youngTracks + deck.matureTracks).toBe(deck.tracks);
      expect(deck.directNewTracks + deck.directYoungTracks + deck.directMatureTracks).toBe(
        deck.directTracks,
      );
      expect(deck.tracks).toBeGreaterThanOrEqual(deck.directTracks);
    }
    expect(deckProgress(db)).toHaveLength(39);
  });

  it("survives a window with no reviews without producing NaN", () => {
    const empty = calendarYear(2000);
    const t = totals(db, empty);
    expect(t.reviews).toBe(0);
    expect(t.retention).toBeNull();
    expect(t.medianSeconds).toBeNull();
    expect(t.meanSeconds).toBeNull();
    expect(t.reviewsPerActiveDay).toBeNull();
    expect(t.activeDays).toBe(0);
    expect(t.daysElapsed).toBe(0);
    expect(t.windowStart).toBeNull();
    expect(activityByDay(db, empty)).toEqual([]);
    expect(retentionByDeck(db, empty)).toEqual([]);
    for (const basis of INTERVAL_BASES) {
      const buckets = retentionByInterval(db, empty, basis);
      expect(buckets).toHaveLength(9);
      expect(buckets.every((b) => b.reviews === 0 && b.retention === null)).toBe(true);
      expect(buckets.every((b) => b.basis === basis)).toBe(true);
    }
  });

  it("RECONCILES the forecast against the queue, day for day", () => {
    const report = data.forecast;
    expect(report.asOf).toBe("2026-09-06");
    expect(report.backlog).toBe(526);

    let running = report.backlog;
    for (const day of report.days.slice(0, 8)) {
      running += day.tracks;
      const live = queueCounts(db, { now: `${day.date}T00:00:00Z` });
      expect({ date: day.date, due: live.due }).toEqual({ date: day.date, due: running });
    }

    const inWindow = db
      .prepare(
        `SELECT count(*) AS n FROM card_tracks t JOIN cards c ON c.id = t.card_id
          WHERE t.dormant = 0 AND c.archived = 0 AND t.due_at IS NOT NULL
            AND substr(t.due_at, 1, 10) > ? AND substr(t.due_at, 1, 10) <= ?`,
      )
      .get(report.asOf, report.days.at(-1)?.date ?? report.asOf) as { n: number };
    expect(report.days.reduce((sum, day) => sum + day.tracks, 0)).toBe(inWindow.n);
  });

  it("says whose plans the forecast is charting, and today they are all Mochi's", () => {
    const { provenance } = data.forecast;
    expect(provenance.hashigo).toBe(0);
    expect(provenance.mochi).toBeGreaterThan(8_000);
    expect(data.forecast.days.length).toBe(data.forecast.horizonDays);
    expect(new Set(data.forecast.days.map((d) => d.date)).size).toBe(data.forecast.horizonDays);
    const first = data.forecast.days[0];
    expect(first).toBeDefined();
    expect((first as { date: string }).date > data.forecast.asOf).toBe(true);
  });

  it("renders a self-contained page carrying the real numbers", () => {
    const html = renderDashboard(data);

    for (const figure of [
      "103,110",
      "96.24%",
      "1,333",
      "641.2",
      "93,124",
      "5,701",
      "14,416",
      "211",
      "5,181",
      "13,255",
      "3,882",
      "13,393",
    ]) {
      expect(html).toContain(figure);
    }

    for (const label of [
      "activity",
      "cards studied",
      "reviews",
      "retention",
      "study time",
      "deck progress",
      "forecast",
    ]) {
      expect(html).toContain(label);
    }

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/\ssrc=/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/https?:\/\//i);

    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain(':root:not([data-theme="light"])');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toMatch(/body\s*\{[^}]*background:\s*var\(--page\)/);

    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("Infinity");

    expect(html).toContain("forecast");
    expect(html).toContain("Where these bars come from");
    const ja = renderDashboard(data, { locale: "ja" });
    expect(ja).toContain("復習予測");
    expect(ja).toContain("この棒の出どころ");
    for (const page of [html, ja]) {
      expect(page).not.toContain("このタイルは意図的に空");
      expect(page).not.toContain("スケジューラ未実装");
    }

    const charts = html.match(/<svg /g)?.length ?? 0;
    const tables = html.match(/<table>/g)?.length ?? 0;
    expect(charts).toBeGreaterThan(5);
    expect(tables).toBeGreaterThanOrEqual(5);
  });

  it("gives every day that has reviews a table row, not just a tooltip", () => {
    const html = renderDashboard(data);

    const counts = [...html.matchAll(/see (\d{4}) day by day as a table \(([\d,]+) days\)/g)].map(
      (m) => [m[1] as string, Number((m[2] as string).replace(/,/g, ""))] as const,
    );
    expect(counts.map(([year]) => year)).toEqual(data.years.map((y) => y.year));
    for (const [year, rows] of counts) {
      const summary = data.years.find((y) => y.year === year);
      expect(rows, `${year} row count`).toBe(summary?.activeDays);
    }
    const total = counts.reduce((sum, [, rows]) => sum + rows, 0);
    expect(total).toBe(data.primary.totals.activeDays);
    expect(total).toBeLessThan(data.primary.totals.daysElapsed);

    const busiest = [...data.primary.days].sort((a, b) => b.reviews - a.reviews)[0];
    expect(busiest).toBeDefined();
    const day = busiest as { date: string; reviews: number };
    expect(html).toContain(`<td>${day.date}</td>`);
  });

  it.skipIf(!existsSync(PAGE))("is byte-identical to dashboard.html as committed", () => {
    const html = readFileSync(PAGE, "utf8");
    const source = /<dt>source<\/dt><dd>([^<]*)<\/dd>/.exec(html)?.[1];
    const generatedAt = /<dt>generated<\/dt><dd>([^<]*)<\/dd>/.exec(html)?.[1];
    expect(source, "committed page has no source").toBeTruthy();
    expect(generatedAt, "committed page has no generated").toBeTruthy();

    const fresh = renderDashboard(
      collect(db, { source: source as string, generatedAt: generatedAt as string }),
    );
    expect(fresh.length).toBe(html.length);
    expect(fresh).toBe(html);
  }, 120_000);

  it.skipIf(!existsSync(JA_GOLDEN))("renders the Japanese page byte-identically to before the extraction", () => {
    const golden = readFileSync(JA_GOLDEN, "utf8");
    const rendered = renderDashboard(
      collect(db, { source: "ORACLE", generatedAt: "2000-01-01T00:00:00.000Z", asOf: "2026-08-18" }),
      { locale: "ja" },
    );
    expect(rendered.length).toBe(golden.length);
    expect(rendered).toBe(golden);
  }, 120_000);

  it("leaves no Japanese in the English page except the names Zach authored", () => {
    const html = renderDashboard(data);
    expect(html).toContain('<html lang="en">');

    const authored = new Set<string>();
    for (const sql of [
      "SELECT name FROM decks",
      "SELECT name FROM templates",
      "SELECT name FROM template_fields",
      "SELECT path FROM tags",
    ]) {
      for (const row of db.prepare(sql).pluck().all() as string[]) {
        for (const part of String(row).split(/[\s/]+/)) if (part) authored.add(part);
      }
    }
    authored.add("梯子");
    expect(authored.size).toBeGreaterThan(30);

    const CJK = /[぀-ヿ㐀-䶿一-鿿]+/g;
    const unexplained = new Set<string>();
    for (const run of html.match(CJK) ?? []) {
      if (![...authored].some((name) => name.includes(run))) unexplained.add(run);
    }
    expect([...unexplained], "Japanese in the English page that is not a name").toEqual([]);

    const ja = renderDashboard(data, { locale: "ja" });
    const jaRuns = new Set(
      (ja.match(CJK) ?? []).filter((run) => ![...authored].some((n) => n.includes(run))),
    );
    expect(jaRuns.size).toBeGreaterThan(50);
  });

  it("renders deterministically", () => {
    expect(renderDashboard(data)).toBe(renderDashboard(data));
    expect(renderDashboard(data)).toContain("2026-08-18T00:00:00.000Z");
  });

const BACKTEST_DOC = resolve(import.meta.dirname, "..", "BACKTEST.md");

function markdownBeyondYearCounts(markdown: string): number[] {
  const counts: number[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 3) continue;
    if (cells[1] !== BEYOND_YEAR_LABEL) continue;
    const n = Number((cells[2] ?? "").replace(/,/g, ""));
    if (Number.isFinite(n)) counts.push(n);
  }
  return counts;
}

describe.skipIf(!existsSync(PAGE) || !existsSync(BACKTEST_DOC))(
  "dashboard.html and BACKTEST.md, as committed",
  () => {
    it("report the SAME count for the > 365d bucket", () => {
      const html = readFileSync(PAGE, "utf8");
      const markdown = readFileSync(BACKTEST_DOC, "utf8");

      const measured = beyondYear(retentionByInterval(db, ALL_TIME, "elapsed"));
      expect(measured.reviews).toBe(3_217);

      const fromDoc = markdownBeyondYearCounts(markdown);
      expect(fromDoc.length).toBeGreaterThan(0);
      expect(fromDoc).toContain(measured.reviews);
      for (const n of fromDoc) expect(n).toBeLessThanOrEqual(measured.reviews);

      expect(html).toContain("3,217");
      expect(html).not.toContain("観測なし</text>");

      expect(html).toContain("elapsed_days");
      expect(html).toContain("scheduled_days");
    });

    it("agree on the retention at that interval too, not just the count", () => {
      const markdown = readFileSync(BACKTEST_DOC, "utf8");
      const html = readFileSync(PAGE, "utf8");
      const measured = beyondYear(retentionByInterval(db, ALL_TIME, "elapsed"));
      const percent = `${((measured.retention ?? 0) * 100).toFixed(2)}%`;

      expect(percent).toBe("96.89%");
      expect(markdown).toContain(percent);
      expect(html).toContain(percent);
    });

    it("agree on the cap, its lift date, and what the lift left behind", () => {
      const markdown = readFileSync(BACKTEST_DOC, "utf8");
      const html = readFileSync(PAGE, "utf8");
        for (const doc of [markdown, html]) {
        expect(doc).toContain(outlook.capLiftedOn as string);
        expect(doc).toContain("2,707");
        expect(doc).toContain("1,386");
        expect(doc).toContain("3,417");
      }
      expect(markdown).not.toMatch(/binding constraint[^.]*365-day interval\s*\n?\s*cap/i);
    });
  },
);
});

describe.skipIf(!existsSync(PAGE))("dashboard.html as committed", () => {
  it("was generated from the real database, not a fixture", () => {
    const html = readFileSync(PAGE, "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    for (const figure of ["103,110", "96.24%", "1,333", "641.2", "14,416", "5,181", "5,701"]) {
      expect(html).toContain(figure);
    }
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toContain("NaN");
  });

  it("stays one self-contained file that is readable in either theme", () => {
    const html = readFileSync(PAGE, "utf8");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\((?!['"]?data:)/i);

    expect(html).toMatch(/:root\s*\{/);
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain(':root:not([data-theme="light"])');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toMatch(/body\s*\{[^}]*background/);
  });
});
