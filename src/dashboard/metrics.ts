/**
 * Stage 2 — every number the dashboard shows, computed in SQL over the review
 * log and nowhere else.
 *
 * WHY THIS EXISTS BEFORE THE SCHEDULER.  SPEC.html, build order: "Dashboard,
 * read-only.  Reproduce Mochi's figures from the imported data.  This is the
 * import's acceptance test — matching numbers means the import is right."  So
 * this module is a test instrument first and a UI second, and every function
 * here is a pure query: give it a database and a window, get numbers back.
 *
 * DEFINITIONS ARE PART OF THE OUTPUT.  Mochi's own dashboard agrees with us
 * exactly on active days (211) and retention (95%) for calendar 2026 and is
 * 8.2% below us on the review count (13,240 vs 14,420).  Eight candidate
 * definitions were ruled out in notes/dashboard-reconciliation.md; the leading
 * hypothesis (one review per card per day, 13,258) misses by 18.  We do not
 * tune toward an undocumented number.  Instead each metric is defined once,
 * here, and the definition is rendered next to the figure:
 *
 *   reviews       grading events, all tracks (forward + reverse + cloze)
 *   cardsStudied  distinct cards with >= 1 grading event in the window
 *   activeDays    distinct local dates with >= 1 grading event
 *   daysElapsed   inclusive of both endpoints, clamped to `asOf`
 *   retention     passed / total grading events
 *   hours         sum(duration_ms); 9,931 reviews carry no duration at all
 *
 * `cardDays` is carried alongside `reviews` because it is the leading
 * hypothesis for what Mochi counts, not because we believe it: labelling it is
 * how the 8.2% stays characterised instead of hidden.
 *
 * BUCKETING BY LOCAL DATE, NEVER UTC.  review_log already does this, using each
 * review's own tz_offset_minutes, and every imported review is flagged
 * time_unknown so it stays out of the hour-of-day view.  Nothing here
 * recomputes a date or an hour; that logic lives in views.sql exactly once.
 *
 * WHAT THE 2026 MATCH DOES *NOT* PROVE.  It is tempting to read "211 active days
 * and 95% retention agree with Mochi" as proof that the JST bucketing is right.
 * It is not, and that was measured rather than assumed: every review in the
 * corpus carries 15:00:00Z, so the UTC date is uniformly one day behind the JST
 * date, and there is no review on 2026-01-01 JST or on 2025-12-31 JST.  Bucket
 * calendar 2026 by UTC instead and you still get 14,420 reviews over 211 days at
 * 95.10% -- every published 2026 figure is bucketing-invariant.  What actually
 * pins the timezone is the all-time span: firstDate 2022-06-28 and lastDate
 * 2026-08-18 both shift by a day under UTC.  test/dashboard.test.ts asserts the
 * invariance explicitly so that nobody re-derives the wrong conclusion.
 */

// `SqliteHandle`, not better-sqlite3's `Db`: the dashboard runs in the OPFS worker
// now (his #1), and everything in this file uses `prepare`, `get`, `all` and one
// `pragma` — the four members both handles share. A type-only import, so nothing
// here reaches a `node:` module at runtime.
import type { SqliteHandle } from "../db/browser.js";
import { INTERVAL_BASES, type IntervalBasis } from "../schema/index.js";
import { queueCounts, reviewForecast } from "../scheduler/queue.js";

// ─── windows ────────────────────────────────────────────────────────────────

/** Inclusive local-date range. Dates are 'YYYY-MM-DD', compared as strings. */
export interface DateWindow {
  /** Stable id, for tests and CLI output. */
  readonly id: string;
  /** Display label, Japanese, as the tiles are titled. */
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

export const MIN_DATE = "0000-01-01";
export const MAX_DATE = "9999-12-31";

export const ALL_TIME: DateWindow = {
  id: "all",
  label: "全期間",
  from: MIN_DATE,
  to: MAX_DATE,
};

/** The window Mochi's dashboard was screenshotted over: one calendar year. */
export function calendarYear(year: number): DateWindow {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new RangeError(`calendar year out of range: ${year}`);
  }
  const y = String(year).padStart(4, "0");
  return { id: y, label: `${y}年`, from: `${y}-01-01`, to: `${y}-12-31` };
}

// ─── row helpers ────────────────────────────────────────────────────────────

type Params = Record<string, string | number | null>;

function all<T>(db: SqliteHandle, sql: string, params: Params = {}): T[] {
  return db.prepare(sql).all(params) as T[];
}

function one<T>(db: SqliteHandle, sql: string, params: Params = {}): T | undefined {
  return db.prepare(sql).get(params) as T | undefined;
}

function scope(window: DateWindow): Params {
  return { from: window.from, to: window.to };
}

function ratio(passed: number, total: number): number | null {
  return total === 0 ? null : passed / total;
}

// ─── totals: 復習数 / 定着率 / 復習時間 / 学習カード数 ────────────────────────

export interface Totals {
  readonly window: DateWindow;
  /** Grading events, all tracks. */
  readonly reviews: number;
  readonly passed: number;
  readonly lapses: number;
  /** passed / reviews, or null on an empty window. */
  readonly retention: number | null;
  /** Distinct cards with at least one grading event. */
  readonly cardsStudied: number;
  /** Distinct (card, day) pairs — the leading hypothesis for Mochi's count. */
  readonly cardDays: number;
  readonly activeDays: number;
  readonly firstDate: string | null;
  readonly lastDate: string | null;
  /** Both endpoints inclusive, clamped to `asOf`. */
  readonly daysElapsed: number;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly hours: number;
  readonly timedReviews: number;
  readonly medianSeconds: number | null;
  readonly meanSeconds: number | null;
  readonly reviewsPerActiveDay: number | null;
  /** Imported history is date-only, so no hour-of-day analysis is possible. */
  readonly reviewsTimeUnknown: number;
  readonly forwardReviews: number;
  readonly reverseReviews: number;
  /** Anything that is neither: cloze tracks. Zero in this corpus. */
  readonly otherReviews: number;
}

interface TotalsRow {
  reviews: number;
  passed: number;
  lapses: number;
  retention: number | null;
  cards_studied: number;
  card_days: number;
  active_days: number;
  first_date: string | null;
  last_date: string | null;
  hours: number;
  timed_reviews: number;
  mean_seconds: number | null;
  median_seconds: number | null;
  reviews_time_unknown: number;
  forward_reviews: number;
  reverse_reviews: number;
}

const TOTALS_SQL = `
WITH scoped AS (
  SELECT card_id, local_date, remembered, duration_ms, time_unknown, track_kind
    FROM review_log
   WHERE local_date BETWEEN @from AND @to
),
timed AS (SELECT duration_ms FROM scoped WHERE duration_ms IS NOT NULL)
SELECT count(*)                                            AS reviews,
       COALESCE(sum(remembered), 0)                         AS passed,
       COALESCE(sum(1 - remembered), 0)                     AS lapses,
       CASE WHEN count(*) = 0 THEN NULL
            ELSE 1.0 * sum(remembered) / count(*) END       AS retention,
       count(DISTINCT card_id)                              AS cards_studied,
       (SELECT count(*) FROM (SELECT DISTINCT card_id, local_date FROM scoped))
                                                            AS card_days,
       count(DISTINCT local_date)                           AS active_days,
       min(local_date)                                      AS first_date,
       max(local_date)                                      AS last_date,
       COALESCE(sum(duration_ms), 0) / 3600000.0            AS hours,
       (SELECT count(*) FROM timed)                         AS timed_reviews,
       (SELECT avg(duration_ms) / 1000.0 FROM timed)        AS mean_seconds,
       -- Median without an extension: the middle row, or the mean of the two
       -- middle rows on an even count.  92,089 timed reviews, median 10 s.
       (SELECT avg(duration_ms) / 1000.0 FROM (
          SELECT duration_ms FROM timed ORDER BY duration_ms
           LIMIT 2 - ((SELECT count(*) FROM timed) % 2)
          OFFSET ((SELECT count(*) FROM timed) - 1) / 2
        ))                                                  AS median_seconds,
       COALESCE(sum(time_unknown), 0)                       AS reviews_time_unknown,
       COALESCE(sum(CASE WHEN track_kind = 'forward' THEN 1 ELSE 0 END), 0)
                                                            AS forward_reviews,
       COALESCE(sum(CASE WHEN track_kind = 'reverse' THEN 1 ELSE 0 END), 0)
                                                            AS reverse_reviews
  FROM scoped
`;

const SPAN_SQL = `
WITH bounds AS (
  SELECT max(@from, COALESCE((SELECT min(local_date) FROM review_log), @from)) AS window_start,
         min(@to, COALESCE(@as_of,
                           (SELECT max(local_date) FROM review_log), @to))     AS window_end
)
SELECT window_start,
       window_end,
       CASE WHEN window_end >= window_start
            THEN CAST(julianday(window_end) - julianday(window_start) AS INTEGER) + 1
            ELSE 0 END AS days_elapsed
  FROM bounds
`;

export interface TotalsOptions {
  /**
   * "Today" for the elapsed-days count. Defaults to the last review date in the
   * whole log, which keeps the figure a property of the data rather than of the
   * clock. Mochi's 231日 for 2026 is this count taken on 2026-08-19; the same
   * window taken on our last review date (2026-08-18) is 230.
   */
  readonly asOf?: string | null;
}

interface SpanRow {
  window_start: string | null;
  window_end: string | null;
  days_elapsed: number;
}

export function totals(db: SqliteHandle, window: DateWindow, options: TotalsOptions = {}): Totals {
  const row = one<TotalsRow>(db, TOTALS_SQL, scope(window));
  if (!row) throw new Error("totals query returned no row");
  const span = one<SpanRow>(db, SPAN_SQL, { ...scope(window), as_of: options.asOf ?? null });
  const empty = row.reviews === 0;
  return {
    window,
    reviews: row.reviews,
    passed: row.passed,
    lapses: row.lapses,
    retention: row.retention,
    cardsStudied: row.cards_studied,
    cardDays: row.card_days,
    activeDays: row.active_days,
    firstDate: row.first_date,
    lastDate: row.last_date,
    daysElapsed: empty ? 0 : (span?.days_elapsed ?? 0),
    windowStart: empty ? null : (span?.window_start ?? null),
    windowEnd: empty ? null : (span?.window_end ?? null),
    hours: row.hours,
    timedReviews: row.timed_reviews,
    medianSeconds: row.median_seconds,
    meanSeconds: row.mean_seconds,
    reviewsPerActiveDay: row.active_days === 0 ? null : row.reviews / row.active_days,
    reviewsTimeUnknown: row.reviews_time_unknown,
    forwardReviews: row.forward_reviews,
    reverseReviews: row.reverse_reviews,
    otherReviews: row.reviews - row.forward_reviews - row.reverse_reviews,
  };
}

// ─── 活動 heatmap / 学習カード数 / 累計 ──────────────────────────────────────

/** One local date. `newCards` counts cards first seen *within this window*. */
export interface DayActivity {
  readonly date: string;
  readonly reviews: number;
  readonly cardsSeen: number;
  readonly passed: number;
  readonly retention: number;
  readonly minutes: number;
  readonly newCards: number;
  /** Running total of newCards — 累計. Ends at Totals.cardsStudied. */
  readonly cumulativeCards: number;
}

const DAYS_SQL = `
WITH scoped AS (
  SELECT card_id, local_date, remembered, duration_ms
    FROM review_log
   WHERE local_date BETWEEN @from AND @to
),
first_seen AS (
  SELECT card_id, min(local_date) AS first_date FROM scoped GROUP BY card_id
),
per_day AS (
  SELECT local_date,
         count(*)                AS reviews,
         count(DISTINCT card_id) AS cards_seen,
         sum(remembered)         AS passed,
         COALESCE(sum(duration_ms), 0) / 60000.0 AS minutes
    FROM scoped
   GROUP BY local_date
),
new_per_day AS (
  SELECT first_date AS local_date, count(*) AS new_cards
    FROM first_seen
   GROUP BY first_date
)
SELECT p.local_date               AS date,
       p.reviews                  AS reviews,
       p.cards_seen               AS cards_seen,
       p.passed                   AS passed,
       1.0 * p.passed / p.reviews AS retention,
       p.minutes                  AS minutes,
       COALESCE(n.new_cards, 0)   AS new_cards,
       sum(COALESCE(n.new_cards, 0)) OVER (ORDER BY p.local_date) AS cumulative_cards
  FROM per_day p
  LEFT JOIN new_per_day n ON n.local_date = p.local_date
 ORDER BY p.local_date
`;

interface DayRow {
  date: string;
  reviews: number;
  cards_seen: number;
  passed: number;
  retention: number;
  minutes: number;
  new_cards: number;
  cumulative_cards: number;
}

export function activityByDay(db: SqliteHandle, window: DateWindow): DayActivity[] {
  return all<DayRow>(db, DAYS_SQL, scope(window)).map((r) => ({
    date: r.date,
    reviews: r.reviews,
    cardsSeen: r.cards_seen,
    passed: r.passed,
    retention: r.retention,
    minutes: r.minutes,
    newCards: r.new_cards,
    cumulativeCards: r.cumulative_cards,
  }));
}

export interface MonthActivity {
  readonly month: string;
  readonly reviews: number;
  readonly cardsSeen: number;
  readonly newCards: number;
  readonly retention: number;
  readonly hours: number;
}

const MONTHS_SQL = `
WITH scoped AS (
  SELECT card_id, local_date, remembered, duration_ms
    FROM review_log
   WHERE local_date BETWEEN @from AND @to
),
first_seen AS (
  SELECT card_id, min(local_date) AS first_date FROM scoped GROUP BY card_id
),
-- Grouped, never correlated: as a per-row subquery this cost 12.9 s over the
-- full corpus (102,020 rows x 5,674 first-seen dates) against 0.4 s here.
new_per_month AS (
  SELECT substr(first_date, 1, 7) AS month, count(*) AS new_cards
    FROM first_seen
   GROUP BY month
),
per_month AS (
  SELECT substr(local_date, 1, 7)                 AS month,
         count(*)                                 AS reviews,
         count(DISTINCT card_id)                  AS cards_seen,
         1.0 * sum(remembered) / count(*)          AS retention,
         COALESCE(sum(duration_ms), 0) / 3600000.0 AS hours
    FROM scoped
   GROUP BY month
)
SELECT p.month                    AS month,
       p.reviews                  AS reviews,
       p.cards_seen               AS cards_seen,
       p.retention                AS retention,
       p.hours                    AS hours,
       COALESCE(n.new_cards, 0)   AS new_cards
  FROM per_month p
  LEFT JOIN new_per_month n ON n.month = p.month
 ORDER BY p.month
`;

interface MonthRow {
  month: string;
  reviews: number;
  cards_seen: number;
  new_cards: number;
  retention: number;
  hours: number;
}

export function activityByMonth(db: SqliteHandle, window: DateWindow): MonthActivity[] {
  return all<MonthRow>(db, MONTHS_SQL, scope(window)).map((r) => ({
    month: r.month,
    reviews: r.reviews,
    cardsSeen: r.cards_seen,
    newCards: r.new_cards,
    retention: r.retention,
    hours: r.hours,
  }));
}

export interface YearSummary {
  readonly year: string;
  readonly reviews: number;
  readonly activeDays: number;
  readonly cardsStudied: number;
  readonly retention: number;
  readonly hours: number;
}

const YEARS_SQL = `
SELECT substr(local_date, 1, 4)                   AS year,
       count(*)                                   AS reviews,
       count(DISTINCT local_date)                 AS active_days,
       count(DISTINCT card_id)                    AS cards_studied,
       1.0 * sum(remembered) / count(*)           AS retention,
       COALESCE(sum(duration_ms), 0) / 3600000.0  AS hours
  FROM review_log
 WHERE local_date BETWEEN @from AND @to
 GROUP BY year
 ORDER BY year
`;

interface YearRow {
  year: string;
  reviews: number;
  active_days: number;
  cards_studied: number;
  retention: number;
  hours: number;
}

export function activityByYear(db: SqliteHandle, window: DateWindow = ALL_TIME): YearSummary[] {
  return all<YearRow>(db, YEARS_SQL, scope(window)).map((r) => ({
    year: r.year,
    reviews: r.reviews,
    activeDays: r.active_days,
    cardsStudied: r.cards_studied,
    retention: r.retention,
    hours: r.hours,
  }));
}

/**
 * Shared heatmap bins, so one year strip is comparable to the next. Cut at the
 * quartiles of *active* days — a day with no reviews is its own bin, not the
 * bottom of the ramp, because "did not study" is a different fact from
 * "studied once".
 */
export function heatThresholds(days: readonly DayActivity[]): readonly [number, number, number] {
  const counts = days.map((d) => d.reviews).sort((a, b) => a - b);
  if (counts.length === 0) return [1, 2, 3];
  const at = (q: number): number =>
    counts[Math.min(counts.length - 1, Math.floor(counts.length * q))] ?? 1;
  // Strictly increasing, so four bins always exist even on a flat corpus.
  const t1 = Math.max(1, at(0.25));
  const t2 = Math.max(t1 + 1, at(0.5));
  const t3 = Math.max(t2 + 1, at(0.75));
  return [t1, t2, t3];
}

// --- BUCKETS -------------------------------------------------------------

/**
 * The bucket boundaries live in views.sql (review_log_bucketed) so they are
 * defined exactly once, and views.sql applies them TWICE -- once per basis.
 * This list only names them, in order, so that a bucket with NO reviews still
 * gets a row.  That empty row is the whole point of the tile: under the
 * `scheduled` basis nothing in four years was ever PLANNED past a year, and
 * under `elapsed` 3,009 reviews actually HAPPENED past one.  An absent row
 * would hide whichever fact you were not looking for.
 *
 * test/dashboard.test.ts asserts these labels against the view's own output,
 * for BOTH bases, so the three cannot drift apart silently.
 */
export const INTERVAL_BUCKETS: readonly { readonly bucket: number; readonly label: string }[] = [
  { bucket: 0, label: "unknown" },
  { bucket: 1, label: "<= 1d" },
  { bucket: 2, label: "1-3d" },
  { bucket: 3, label: "3-7d" },
  { bucket: 4, label: "7-21d" },
  { bucket: 5, label: "21-60d" },
  { bucket: 6, label: "60-180d" },
  { bucket: 7, label: "180-365d" },
  { bucket: 8, label: "> 365d" },
];

/** The label of the bucket every long-interval argument turns on. */
export const BEYOND_YEAR_LABEL = "> 365d";

export interface IntervalBucket {
  /** Which definition of "interval" produced this row.  Never implicit. */
  readonly basis: IntervalBasis;
  readonly bucket: number;
  readonly label: string;
  readonly reviews: number;
  readonly lapses: number;
  /** null when the bucket has no observations at all. */
  readonly retention: number | null;
  readonly meanIntervalDays: number | null;
  readonly hours: number;
}

/**
 * One query per basis, built from one piece of text so the two can never
 * diverge in anything but the column prefix.  `basis` is a closed union and is
 * checked against it before interpolation.
 */
function intervalsSql(basis: IntervalBasis): string {
  if (!INTERVAL_BASES.includes(basis)) throw new RangeError(`unknown interval basis: ${basis}`);
  return `
SELECT ${basis}_bucket                            AS bucket,
       ${basis}_bucket_label                      AS label,
       count(*)                                   AS reviews,
       sum(1 - remembered)                        AS lapses,
       1.0 * sum(remembered) / count(*)           AS retention,
       avg(${basis}_days)                         AS mean_interval_days,
       COALESCE(sum(duration_ms), 0) / 3600000.0  AS hours
  FROM review_log_bucketed
 WHERE local_date BETWEEN @from AND @to
 GROUP BY bucket, label
 ORDER BY bucket
`;
}

const INTERVALS_SQL: Readonly<Record<IntervalBasis, string>> = {
  elapsed: intervalsSql("elapsed"),
  scheduled: intervalsSql("scheduled"),
};

interface IntervalRow {
  bucket: number;
  label: string;
  reviews: number;
  lapses: number;
  retention: number;
  mean_interval_days: number | null;
  hours: number;
}

/**
 * Retention by interval, on ONE named basis.  There is no default: the two
 * answers differ in every bucket and disagree completely in the last one, and
 * a caller that never said which it meant is the exact bug this signature
 * exists to prevent.
 */
export function retentionByInterval(
  db: SqliteHandle,
  window: DateWindow,
  basis: IntervalBasis,
): IntervalBucket[] {
  // Checked here and not only where the SQL is built: the two statements are
  // prepared once at module load, so an unknown basis would otherwise reach
  // better-sqlite3 as `undefined` and fail with a message about arguments
  // rather than about the mistake.
  if (!INTERVAL_BASES.includes(basis)) throw new RangeError(`unknown interval basis: ${basis}`);
  const found = new Map<number, IntervalBucket>();
  for (const r of all<IntervalRow>(db, INTERVALS_SQL[basis], scope(window))) {
    found.set(r.bucket, {
      basis,
      bucket: r.bucket,
      label: r.label,
      reviews: r.reviews,
      lapses: r.lapses,
      retention: r.retention,
      meanIntervalDays: r.mean_interval_days,
      hours: r.hours,
    });
  }
  return INTERVAL_BUCKETS.map(
    (b) =>
      found.get(b.bucket) ?? {
        basis,
        bucket: b.bucket,
        label: b.label,
        reviews: 0,
        lapses: 0,
        retention: null,
        meanIntervalDays: null,
        hours: 0,
      },
  );
}

/** Both bases at once, which is the only honest way to render the tile. */
export interface IntervalsByBasis {
  readonly elapsed: readonly IntervalBucket[];
  readonly scheduled: readonly IntervalBucket[];
}

export function retentionByIntervalBothBases(db: SqliteHandle, window: DateWindow): IntervalsByBasis {
  return {
    elapsed: retentionByInterval(db, window, "elapsed"),
    scheduled: retentionByInterval(db, window, "scheduled"),
  };
}

/** The `> 365d` row of a bucket list, which several callers want by name. */
export function beyondYear(buckets: readonly IntervalBucket[]): IntervalBucket {
  const row = buckets.find((b) => b.label === BEYOND_YEAR_LABEL);
  if (row === undefined) throw new Error(`no ${BEYOND_YEAR_LABEL} bucket in the list`);
  return row;
}

// --- THE YEAR BOUNDARY ---------------------------------------------------

/**
 * Everything the page needs to say about intervals longer than a year, and the
 * reason the two bases disagree completely there.
 *
 * WHY THE PLANNED BASIS SHOWS ZERO PAST A YEAR, measured rather than asserted.
 * It is not that Mochi never planned past a year -- it did so 1,356 times.  It
 * is that `reviews.scheduled_days` is the PRECEDING review's
 * `next_scheduled_days`, so a plan only becomes a `scheduled_days` once the
 * review it scheduled has actually been taken.  Every one of those 1,356 plans
 * is the last review of its track and not one has come due (the earliest falls
 * 2027-03-16), so the planned basis structurally cannot see them yet.  That is
 * a censoring artefact, not a fact about memory, and it is why this page
 * reports the ELAPSED basis as the observation.
 *
 * THE CAP, WITH ITS DATE.  A 365-day ceiling was in force from the first review
 * until it was lifted; `capLiftedOn` is the first local date on which any
 * review planned beyond a year -- found, not assumed.  "Mochi caps at 365"
 * without that date implies a constraint that has stopped operating.
 */
export interface LongIntervalOutlook {
  /** Reviews whose MEASURED gap exceeded a year. */
  readonly observedBeyondYear: number;
  readonly observedRetention: number | null;
  /** Longest gap any review was actually taken at, in days. */
  readonly maxObservedElapsedDays: number | null;
  /** Reviews that PLANNED beyond a year.  None of them has come due. */
  readonly plannedBeyondYear: number;
  /** Longest interval ever planned, in days. */
  readonly maxPlannedDays: number | null;
  /** First local date on which a review planned beyond a year, or null. */
  readonly capLiftedOn: string | null;
  /** LIVE tracks whose current plan is beyond a year. */
  readonly tracksBeyondYear: number;
  /** LIVE tracks whose current plan is exactly the old cap. */
  readonly tracksAtCap: number;
  /**
   * The denominator for `tracksAtCap`, and it is the LIVE population -- not
   * dormant, not on an archived card, with at least one review and a plan.
   * This is character for character the population `measureScheduleCap` in
   * src/scheduler/backtest.ts counts, so that the page and BACKTEST.md quote
   * the same 3,874 of 8,956 rather than two defensible different numbers.
   */
  readonly tracksWithPlan: number;
  /**
   * Tracks sitting on exactly the old cap whose LAST REVIEW predates the lift:
   * parked on a stale plan that post-lift Mochi would not have chosen.  This is
   * the constraint that is still real, and it is narrower than the headline
   * "43% of tracks are capped", which includes tracks re-scheduled since.
   */
  readonly tracksOnStaleCap: number;
  readonly firstDueAt: string | null;
  readonly lastDueAt: string | null;
}

/** The old ceiling, named once rather than as a literal in six queries. */
export const MOCHI_INTERVAL_CAP_DAYS = 365;

/**
 * REVIEW-level figures count every review, so they reconcile with the bucket
 * table above (3,009 here is the same 3,009 as the `> 365d` row).  TRACK-level
 * figures count the LIVE population only -- the same filter
 * `measureScheduleCap` applies in the backtest -- so the two artefacts quote
 * one denominator between them.
 */
const LIVE_TRACKS = `
    FROM card_tracks t
    JOIN cards c ON c.id = t.card_id
   WHERE t.dormant = 0 AND c.archived = 0 AND t.reps > 0
     AND t.scheduled_days IS NOT NULL`;

const LONG_INTERVAL_SQL = `
WITH observed AS (
  SELECT count(*)                         AS reviews,
         1.0 * sum(remembered) / count(*) AS retention
    FROM review_log_elapsed
   WHERE elapsed_days > @cap
),
lift AS (
  SELECT min(local_date) AS lifted_on
    FROM review_log
   WHERE next_scheduled_days > @cap
),
capped AS (
  SELECT (SELECT rl.local_date FROM review_log rl
           WHERE rl.track_id = t.id
           ORDER BY rl.reviewed_at DESC, rl.review_id DESC LIMIT 1) AS last_local_date
  ${LIVE_TRACKS} AND t.scheduled_days = @cap
)
SELECT (SELECT reviews   FROM observed)                                  AS observed_beyond_year,
       (SELECT retention FROM observed)                                  AS observed_retention,
       (SELECT max(elapsed_days) FROM review_log_elapsed)                AS max_observed_elapsed,
       (SELECT count(*) FROM review_log WHERE next_scheduled_days > @cap)
                                                                         AS planned_beyond_year,
       (SELECT max(next_scheduled_days) FROM review_log)                 AS max_planned,
       (SELECT lifted_on FROM lift)                                      AS cap_lifted_on,
       (SELECT count(*) ${LIVE_TRACKS} AND t.scheduled_days > @cap)      AS tracks_beyond_year,
       (SELECT count(*) ${LIVE_TRACKS} AND t.scheduled_days = @cap)      AS tracks_at_cap,
       (SELECT count(*) ${LIVE_TRACKS})                                  AS tracks_with_plan,
       (SELECT count(*) FROM capped
         WHERE last_local_date < (SELECT lifted_on FROM lift))           AS tracks_on_stale_cap,
       (SELECT min(t.due_at) ${LIVE_TRACKS} AND t.scheduled_days > @cap) AS first_due_at,
       (SELECT max(t.due_at) ${LIVE_TRACKS} AND t.scheduled_days > @cap) AS last_due_at
`;

export function longIntervalOutlook(db: SqliteHandle): LongIntervalOutlook {
  const row = one<{
    observed_beyond_year: number;
    observed_retention: number | null;
    max_observed_elapsed: number | null;
    planned_beyond_year: number;
    max_planned: number | null;
    cap_lifted_on: string | null;
    tracks_beyond_year: number;
    tracks_at_cap: number;
    tracks_with_plan: number;
    tracks_on_stale_cap: number;
    first_due_at: string | null;
    last_due_at: string | null;
  }>(db, LONG_INTERVAL_SQL, { cap: MOCHI_INTERVAL_CAP_DAYS });
  if (!row) throw new Error("long-interval query returned no row");
  return {
    observedBeyondYear: row.observed_beyond_year,
    observedRetention: row.observed_retention,
    maxObservedElapsedDays: row.max_observed_elapsed,
    plannedBeyondYear: row.planned_beyond_year,
    maxPlannedDays: row.max_planned,
    capLiftedOn: row.cap_lifted_on,
    tracksBeyondYear: row.tracks_beyond_year,
    tracksAtCap: row.tracks_at_cap,
    tracksWithPlan: row.tracks_with_plan,
    tracksOnStaleCap: row.tracks_on_stale_cap,
    firstDueAt: row.first_due_at,
    lastDueAt: row.last_due_at,
  };
}

// ─── デッキ別定着率 — the other tile Mochi lacks ────────────────────────────

/**
 * Per deck, twice over: `reviews` rolls the whole subtree up (so 日本語 has a
 * number even though it holds no cards directly) and `direct*` counts only the
 * deck's own cards (so the two can never be added together by accident).
 * Forward and reverse are split because that is where the variation lives —
 * 漢字 reverse lapses 1,027 times against forward's 304.
 */
export interface DeckRetention {
  readonly deckId: string;
  readonly path: string;
  readonly depth: number;
  readonly reviews: number;
  readonly lapses: number;
  readonly retention: number | null;
  readonly hours: number;
  readonly directReviews: number;
  readonly directLapses: number;
  readonly directRetention: number | null;
  /** Subtree. */
  readonly forwardReviews: number;
  readonly forwardRetention: number | null;
  readonly reverseReviews: number;
  readonly reverseRetention: number | null;
  /**
   * The deck's own cards only. The chart plots these, never the subtree pair:
   * 日本語/言葉 has 1,948 direct reviews but 2,379 in its subtree, and mixing
   * the two bases in one row is how a chart ends up quietly lying.
   */
  readonly directForwardReviews: number;
  readonly directForwardRetention: number | null;
  readonly directReverseReviews: number;
  readonly directReverseRetention: number | null;
}

const DECK_RETENTION_SQL = `
WITH scoped AS (
  SELECT deck_id, track_kind, remembered, duration_ms
    FROM review_log
   WHERE local_date BETWEEN @from AND @to
),
agg AS (
  SELECT deck_id,
         count(*)                                                         AS reviews,
         sum(remembered)                                                   AS passed,
         COALESCE(sum(duration_ms), 0)                                     AS ms,
         sum(CASE WHEN track_kind = 'forward' THEN 1 ELSE 0 END)           AS fwd,
         sum(CASE WHEN track_kind = 'forward' THEN remembered ELSE 0 END)  AS fwd_passed,
         sum(CASE WHEN track_kind = 'reverse' THEN 1 ELSE 0 END)           AS rev,
         sum(CASE WHEN track_kind = 'reverse' THEN remembered ELSE 0 END)  AS rev_passed
    FROM scoped
   GROUP BY deck_id
)
SELECT an.ancestor_id      AS deck_id,
       dp.path             AS path,
       dp.depth            AS depth,
       sum(a.reviews)      AS reviews,
       sum(a.passed)       AS passed,
       sum(a.ms) / 3600000.0 AS hours,
       sum(a.fwd)          AS forward_reviews,
       sum(a.fwd_passed)   AS forward_passed,
       sum(a.rev)          AS reverse_reviews,
       sum(a.rev_passed)   AS reverse_passed,
       COALESCE((SELECT reviews FROM agg WHERE agg.deck_id = an.ancestor_id), 0)
                           AS direct_reviews,
       COALESCE((SELECT passed FROM agg WHERE agg.deck_id = an.ancestor_id), 0)
                           AS direct_passed,
       COALESCE((SELECT fwd FROM agg WHERE agg.deck_id = an.ancestor_id), 0)
                           AS direct_forward_reviews,
       COALESCE((SELECT fwd_passed FROM agg WHERE agg.deck_id = an.ancestor_id), 0)
                           AS direct_forward_passed,
       COALESCE((SELECT rev FROM agg WHERE agg.deck_id = an.ancestor_id), 0)
                           AS direct_reverse_reviews,
       COALESCE((SELECT rev_passed FROM agg WHERE agg.deck_id = an.ancestor_id), 0)
                           AS direct_reverse_passed
  FROM deck_ancestry an
  JOIN agg a         ON a.deck_id = an.deck_id
  JOIN deck_paths dp ON dp.deck_id = an.ancestor_id
 GROUP BY an.ancestor_id, dp.path, dp.depth
 ORDER BY sum(a.reviews) DESC, dp.path
`;

interface DeckRetentionRow {
  deck_id: string;
  path: string;
  depth: number;
  reviews: number;
  passed: number;
  hours: number;
  forward_reviews: number;
  forward_passed: number;
  reverse_reviews: number;
  reverse_passed: number;
  direct_reviews: number;
  direct_passed: number;
  direct_forward_reviews: number;
  direct_forward_passed: number;
  direct_reverse_reviews: number;
  direct_reverse_passed: number;
}

export function retentionByDeck(db: SqliteHandle, window: DateWindow): DeckRetention[] {
  return all<DeckRetentionRow>(db, DECK_RETENTION_SQL, scope(window)).map((r) => ({
    deckId: r.deck_id,
    path: r.path,
    depth: r.depth,
    reviews: r.reviews,
    lapses: r.reviews - r.passed,
    retention: ratio(r.passed, r.reviews),
    hours: r.hours,
    directReviews: r.direct_reviews,
    directLapses: r.direct_reviews - r.direct_passed,
    directRetention: ratio(r.direct_passed, r.direct_reviews),
    forwardReviews: r.forward_reviews,
    forwardRetention: ratio(r.forward_passed, r.forward_reviews),
    reverseReviews: r.reverse_reviews,
    reverseRetention: ratio(r.reverse_passed, r.reverse_reviews),
    directForwardReviews: r.direct_forward_reviews,
    directForwardRetention: ratio(r.direct_forward_passed, r.direct_forward_reviews),
    directReverseReviews: r.direct_reverse_reviews,
    directReverseRetention: ratio(r.direct_reverse_passed, r.direct_reverse_reviews),
  }));
}

// ─── デッキの進捗 ───────────────────────────────────────────────────────────

/** Track counts, not card counts: a card with reverse on is two tracks. */
export interface DeckProgress {
  readonly deckId: string;
  readonly path: string;
  readonly depth: number;
  readonly cards: number;
  readonly tracks: number;
  readonly newTracks: number;
  readonly youngTracks: number;
  readonly matureTracks: number;
  readonly dormantTracks: number;
  readonly lapses: number;
  readonly directCards: number;
  readonly directTracks: number;
  readonly directNewTracks: number;
  readonly directYoungTracks: number;
  readonly directMatureTracks: number;
}

const DECK_PROGRESS_SQL = `
WITH cards_per_deck AS (
  SELECT deck_id, count(*) AS cards FROM cards GROUP BY deck_id
),
tracks_per_deck AS (
  SELECT deck_id,
         sum(tracks)         AS tracks,
         sum(new_tracks)     AS new_tracks,
         sum(young_tracks)   AS young_tracks,
         sum(mature_tracks)  AS mature_tracks,
         sum(dormant_tracks) AS dormant_tracks,
         sum(lapses)         AS lapses
    FROM deck_progress
   GROUP BY deck_id
)
SELECT an.ancestor_id                     AS deck_id,
       dp.path                            AS path,
       dp.depth                           AS depth,
       COALESCE(sum(c.cards), 0)          AS cards,
       COALESCE(sum(t.tracks), 0)         AS tracks,
       COALESCE(sum(t.new_tracks), 0)     AS new_tracks,
       COALESCE(sum(t.young_tracks), 0)   AS young_tracks,
       COALESCE(sum(t.mature_tracks), 0)  AS mature_tracks,
       COALESCE(sum(t.dormant_tracks), 0) AS dormant_tracks,
       COALESCE(sum(t.lapses), 0)         AS lapses,
       COALESCE((SELECT cards FROM cards_per_deck WHERE deck_id = an.ancestor_id), 0)
                                          AS direct_cards,
       COALESCE((SELECT tracks FROM tracks_per_deck WHERE deck_id = an.ancestor_id), 0)
                                          AS direct_tracks,
       COALESCE((SELECT new_tracks FROM tracks_per_deck WHERE deck_id = an.ancestor_id), 0)
                                          AS direct_new_tracks,
       COALESCE((SELECT young_tracks FROM tracks_per_deck WHERE deck_id = an.ancestor_id), 0)
                                          AS direct_young_tracks,
       COALESCE((SELECT mature_tracks FROM tracks_per_deck WHERE deck_id = an.ancestor_id), 0)
                                          AS direct_mature_tracks
  FROM deck_ancestry an
  JOIN deck_paths dp          ON dp.deck_id = an.ancestor_id
  LEFT JOIN cards_per_deck c  ON c.deck_id = an.deck_id
  LEFT JOIN tracks_per_deck t ON t.deck_id = an.deck_id
 GROUP BY an.ancestor_id, dp.path, dp.depth
 ORDER BY dp.path
`;

interface DeckProgressRow {
  deck_id: string;
  path: string;
  depth: number;
  cards: number;
  tracks: number;
  new_tracks: number;
  young_tracks: number;
  mature_tracks: number;
  dormant_tracks: number;
  lapses: number;
  direct_cards: number;
  direct_tracks: number;
  direct_new_tracks: number;
  direct_young_tracks: number;
  direct_mature_tracks: number;
}

export function deckProgress(db: SqliteHandle): DeckProgress[] {
  return all<DeckProgressRow>(db, DECK_PROGRESS_SQL).map((r) => ({
    deckId: r.deck_id,
    path: r.path,
    depth: r.depth,
    cards: r.cards,
    tracks: r.tracks,
    newTracks: r.new_tracks,
    youngTracks: r.young_tracks,
    matureTracks: r.mature_tracks,
    dormantTracks: r.dormant_tracks,
    lapses: r.lapses,
    directCards: r.direct_cards,
    directTracks: r.direct_tracks,
    directNewTracks: r.direct_new_tracks,
    directYoungTracks: r.direct_young_tracks,
    directMatureTracks: r.direct_mature_tracks,
  }));
}

// ─── 復習予測 ────────────────────────────────────────────────────────────────

/**
 * The forecast tile. SPEC deferred it until the scheduler existed; stage 6
 * landed 2026-08-22 and this is it.
 *
 * WHAT IT IS HONESTLY A CHART OF, which is the whole reason the tile was blank
 * rather than approximated. The old `FORECAST_UNAVAILABLE` text said: due dates
 * could be plotted from `card_tracks.due_at` today, "and it would be a chart of
 * Mochi's scheduling decisions wearing Hashigo's label". THAT IS STILL TRUE OF
 * MOST OF THE ROWS. Having a scheduler did not retroactively reschedule
 * anything: a track keeps the due date Mochi gave it until it is graded here
 * (deliberately — see `src/scheduler/README.md` note 1), so on the day this
 * shipped essentially every bar was Mochi's.
 *
 * So the tile counts the two provenances and prints them, instead of choosing
 * between a blank panel and a mislabelled one. `card_tracks.scheduler` is the
 * discriminator: `'mochi'` for an imported plan, `'fsrs6'` for one this app
 * issued. The mix moves toward Hashigo one card per review, and the tile shows
 * the mix rather than implying an answer.
 */
export interface ForecastDayCount {
  /** Local date, `2026-08-22`. */
  readonly date: string;
  readonly tracks: number;
}

export interface ForecastReport {
  /** The local date the forecast was taken against. */
  readonly asOf: string;
  /** Days AFTER `asOf`, one entry each, zeroes included. */
  readonly days: readonly ForecastDayCount[];
  readonly horizonDays: number;
  /** Due on or before `asOf` — the backlog, deliberately not the first bar. */
  readonly backlog: number;
  /** Of the backlog, due strictly before `asOf`. */
  readonly overdue: number;
  /** Never reviewed. Not scheduled, so not in any bar. */
  readonly fresh: number;
  /** Scheduled and not yet due, in total — the window shows part of this. */
  readonly scheduled: number;
  /** Whose plan the bars are: an imported Mochi due date, or one we issued. */
  readonly provenance: { readonly mochi: number; readonly hashigo: number };
  /** The busiest day in the window, for the callout. */
  readonly peak: ForecastDayCount | null;
}

import { dueAfter, liveTrack } from "../scheduler/index.js";

const FORECAST_PROVENANCE_SQL = `
SELECT sum(CASE WHEN t.scheduler = 'fsrs6' THEN 1 ELSE 0 END) AS hashigo,
       sum(CASE WHEN t.scheduler IS NULL OR t.scheduler <> 'fsrs6' THEN 1 ELSE 0 END) AS mochi
  FROM card_tracks t JOIN cards c ON c.id = t.card_id
 WHERE ${liveTrack()} AND t.due_at IS NOT NULL
   AND ${dueAfter("t", ":as_of")}`;

/**
 * `asOf` resolves the same way every other figure on the page does — the last
 * review date in the log, not the wall clock — so `dashboard.html` is
 * reproducible and its byte-identity test means something.
 */
export function resolveAsOf(db: SqliteHandle, asOf: string | null = null): string {
  const row = one<{ as_of: string | null }>(
    db,
    `SELECT coalesce(:as_of, max(local_date)) AS as_of FROM review_log`,
    { as_of: asOf },
  );
  // An empty review log leaves max(local_date) NULL, which is a real state — a
  // database imported with cards and no history. MIN_DATE then means "nothing
  // has happened yet", and every count below comes out zero rather than throwing.
  return row?.as_of ?? asOf ?? MIN_DATE;
}

export function forecast(db: SqliteHandle, asOf: string | null = null, horizonDays = 30): ForecastReport {
  const on = resolveAsOf(db, asOf);
  // Only the local DATE of this instant is read; see src/scheduler/queue.ts.
  const now = `${on}T00:00:00Z`;
  const counts = queueCounts(db, { now });
  const days = reviewForecast(db, { now, days: horizonDays }).map((day) => ({
    date: day.date,
    tracks: day.count,
  }));
  const rawProvenance = one<{ hashigo: number | null; mochi: number | null }>(
    db,
    FORECAST_PROVENANCE_SQL,
    { as_of: on },
  );
  let peak: ForecastDayCount | null = null;
  for (const day of days) if (peak === null || day.tracks > peak.tracks) peak = day;
  return {
    asOf: on,
    days,
    horizonDays,
    backlog: counts.due,
    overdue: counts.overdue,
    fresh: counts.fresh,
    scheduled: counts.scheduled,
    provenance: { mochi: rawProvenance?.mochi ?? 0, hashigo: rawProvenance?.hashigo ?? 0 },
    peak: peak === null || peak.tracks === 0 ? null : peak,
  };
}

// ─── Mochi's own figures, for the acceptance test ───────────────────────────

/**
 * Read off the user's Mochi dashboard for calendar 2026 (see
 * notes/dashboard-reconciliation.md). These are the only hard-coded numbers in
 * this module and they are *reference* data: the page shows them beside ours
 * and states where the definitions part company. Nothing here is tuned to make
 * them agree.
 */
export interface MochiReference {
  readonly key: "reviews" | "daysElapsed" | "activeDays" | "retention" | "cardsStudied";
  readonly label: string;
  readonly mochi: number;
  /** How to read ours against theirs. */
  readonly note: string;
}

export const MOCHI_2026: readonly MochiReference[] = [
  { key: "reviews", label: "復習数", mochi: 13_240, note: "定義の差。下の注記を参照" },
  { key: "daysElapsed", label: "日数", mochi: 231, note: "両端を含む数え方。2026-08-19 時点で一致" },
  { key: "activeDays", label: "活動日数", mochi: 211, note: "完全一致" },
  { key: "retention", label: "定着率", mochi: 95, note: "完全一致（表示桁で）" },
  // The GAP is the 差 column's job. This used to open with "−68" and the
  // 2026-09-05 re-import made it read "−68" beside a printed +141.
  { key: "cardsStudied", label: "累計学習カード数", mochi: 5_250, note: "窓内で学習した実カード数" },
];

/**
 * The year the reference screenshot covers, and the last day of data behind it.
 *
 * MOCHI_2026 IS A PHOTOGRAPH, SO ITS WINDOW HAS AN END, AND SAYING SO IS A BUG FIX.
 *
 * The screenshot was taken 2026-08-19 and the export of the day before ended on the
 * 18th, so "calendar 2026" and "everything Mochi could have counted" were the same
 * rows — and the comparison table compared like with like by accident. The
 * 2026-09-05 export runs 19 days further and broke that silently: the table went on
 * printing the verdict `完全一致` beside `211 | 227 | +16`, because the verdicts are
 * authored strings and nothing checked them against the numbers underneath.
 *
 * Bounding the window is the honest repair. Moving the reference to match our own
 * output would not be — a reference you edit to agree with you has stopped being
 * one, which is what "こちらの数字を Mochi に合わせて調整はしていない" promises the
 * reader two lines above the table.
 *
 * `asOf` cannot do this: it clamps `daysElapsed` — that is where Mochi's 231 comes
 * from — and does not decide which reviews fall inside the window.
 */
export const MOCHI_REFERENCE_YEAR = 2026;
export const MOCHI_DATA_THROUGH = "2026-08-18";

/** Calendar `year`, cut at the screenshot for the year the reference covers. */
export function mochiComparisonWindow(year: number): DateWindow {
  const window = calendarYear(year);
  return year === MOCHI_REFERENCE_YEAR ? { ...window, to: MOCHI_DATA_THROUGH } : window;
}

// ─── the whole page's data in one call ──────────────────────────────────────

export interface WindowReport {
  readonly totals: Totals;
  readonly days: readonly DayActivity[];
  readonly months: readonly MonthActivity[];
  /**
   * Both interval bases, never one.  `elapsed` is what happened and is what the
   * page plots; `scheduled` is what Mochi planned and is kept beside it because
   * the difference between them is the finding, not a footnote.
   */
  readonly intervals: IntervalsByBasis;
  readonly decks: readonly DeckRetention[];
}

export interface DashboardData {
  readonly generatedAt: string;
  readonly source: string;
  readonly schemaVersion: number;
  /** All-time, the page's headline. */
  readonly primary: WindowReport;
  /** The calendar year Mochi's dashboard covered. */
  readonly comparison: WindowReport;
  readonly years: readonly YearSummary[];
  readonly heat: readonly [number, number, number];
  readonly progress: readonly DeckProgress[];
  readonly longIntervals: LongIntervalOutlook;
  readonly mochi: readonly MochiReference[];
  /** Stage 6 made this real. See `forecast`. */
  readonly forecast: ForecastReport;
}

export interface CollectOptions extends TotalsOptions {
  /** Calendar year for the Mochi comparison section. Default 2026. */
  readonly comparisonYear?: number;
  /** Shown in the page header; better-sqlite3 does not expose the path. */
  readonly source?: string;
  /** Frozen timestamp, for reproducible output. */
  readonly generatedAt?: string;
}

function windowReport(db: SqliteHandle, window: DateWindow, options: TotalsOptions): WindowReport {
  return {
    totals: totals(db, window, options),
    days: activityByDay(db, window),
    months: activityByMonth(db, window),
    intervals: retentionByIntervalBothBases(db, window),
    decks: retentionByDeck(db, window),
  };
}

export function collect(db: SqliteHandle, options: CollectOptions = {}): DashboardData {
  const asOf = options.asOf ?? null;
  const primary = windowReport(db, ALL_TIME, { asOf });
  const comparison = windowReport(
    db,
    mochiComparisonWindow(options.comparisonYear ?? MOCHI_REFERENCE_YEAR),
    { asOf },
  );
  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: options.source ?? "(in memory)",
    schemaVersion: Number(db.pragma("user_version", { simple: true })),
    primary,
    comparison,
    years: activityByYear(db),
    heat: heatThresholds(primary.days),
    progress: deckProgress(db),
    longIntervals: longIntervalOutlook(db),
    mochi: MOCHI_2026,
    forecast: forecast(db, asOf),
  };
}
