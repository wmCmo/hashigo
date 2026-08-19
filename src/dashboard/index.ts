/**
 * Stage 2 — the read-only dashboard. Two halves, deliberately separable:
 *
 *   metrics.ts  every figure, as pure SQL over review_log. This half is the
 *               importer's acceptance test and is what test/dashboard.test.ts
 *               asserts against; it has no idea HTML exists.
 *   render.ts   one self-contained HTML file: inline CSS, inline SVG, no script,
 *               no network requests.
 *
 * 復習予測 (the forecast) is absent by design — it needs the scheduler, which is
 * stage 6. See FORECAST_UNAVAILABLE.
 */

export {
  ALL_TIME,
  BEYOND_YEAR_LABEL,
  FORECAST_UNAVAILABLE,
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
  heatThresholds,
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
