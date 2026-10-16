/**
 * Stage 2 — the read-only dashboard. Two halves, deliberately separable:
 *
 *   metrics.ts  every figure, as pure SQL over review_log. This half is the
 *               importer's acceptance test and is what test/dashboard.test.ts
 *               asserts against; it has no idea HTML exists.
 *   render.ts   one self-contained HTML file: inline CSS, inline SVG, no script,
 *               no network requests.
 *
 * 復習予測 (the forecast) was absent by design until the scheduler existed. Stage 6
 * landed 2026-08-22 and the tile is real — see `forecast`, and read its comment
 * before quoting the chart: most of the due dates in it are still Mochi's, and
 * the tile counts the two provenances rather than implying they are ours.
 */

export {
  ALL_TIME,
  BEYOND_YEAR_LABEL,
  INTERVAL_BUCKETS,
  MOCHI_INTERVAL_CAP_DAYS,
  MAX_DATE,
  MIN_DATE,
  MOCHI_2026,
  activityByDay,
  activityByMonth,
  activityByYear,
  calendarYear,
  collect,
  deckProgress,
  forecast,
  heatThresholds,
  resolveAsOf,
  longIntervalOutlook,
  beyondYear,
  retentionByDeck,
  retentionByInterval,
  retentionByIntervalBothBases,
  totals,
  type CollectOptions,
  type DashboardData,
  type DateWindow,
  type DayActivity,
  type DeckProgress,
  type DeckRetention,
  type ForecastDayCount,
  type ForecastReport,
  type IntervalBucket,
  type IntervalsByBasis,
  type LongIntervalOutlook,
  type MochiReference,
  type MonthActivity,
  type Totals,
  type TotalsOptions,
  type WindowReport,
  type YearSummary,
} from "./metrics.js";

export { renderDashboard, type RenderOptions } from "./render.js";

export {
  collectGlance,
  compareDeckPaths,
  shiftDate,
  shiftMonth,
  type Glance,
  type GlanceDay,
  type GlanceDeck,
  type GlanceForecastDay,
  type GlanceLearnedMonth,
  type GlanceOptions,
} from "./glance.js";
