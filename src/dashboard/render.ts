/**
 * Stage 2 — the dashboard as one self-contained HTML file.
 *
 * NO SCRIPT, NO REQUESTS, ON PURPOSE.  SPEC.html's first problem statement is
 * battery drain: "no polling, no sockets, precomputed renders".  So this is a
 * precomputed render — every figure is baked in at generation time, charts are
 * inline SVG, hover text is native <title>, and the page makes zero network
 * requests.  It opens from a file:// URL on the phone with the radio off.
 *
 * COLOUR IS BY ROLE, VALIDATED, NOT PICKED BY EYE.  Tokens on :root, redefined
 * for dark under both prefers-color-scheme and an explicit [data-theme] stamp,
 * with an explicit background on body.  The four palettes in use were run
 * through the data-viz validator rather than eyeballed:
 *
 *   categorical 2 (forward / reverse)  #2a78d6 #eb6834  light  ALL PASS
 *                                      #3987e5 #d95926  dark   ALL PASS
 *   heatmap ramp, 4 bins               #86b6ef #3987e5 #1c5cab #0d366b  light
 *                                      #b7d3f6 #6da7ec #2a78d6 #184f95  dark
 *   ordinal 3 (new / young / mature)   #86b6ef #2a78d6 #104281  light
 *                                      #9ec5f4 #3987e5 #184f95  dark
 *
 * Both ramps run light-to-dark on the light surface and dark-to-light on the
 * dark one, so "more" always means "more ink" rather than flipping meaning
 * between themes.
 *
 * NO DUAL AXES.  Retention and volume are two different scales, so they are two
 * charts sharing one category axis, never one plot with two y-axes.
 *
 * EVERY VALUE HAS A TABLE, AS OF 2026-08-22.  Every aggregate chart has a table
 * twin under a <details>, and so now does each activity-heatmap year strip --
 * one row per day that has reviews, which is where the last hover-only numbers
 * were.  Zero-review days are the one thing with no row, because their tooltip
 * carries no number: it says 学習なし and stops.  Say it that way.  "No value is
 * hover-only" is the claim to make; "no cell is hover-only" is still false.
 */

import { TARGET_RETENTION as TARGET_RETENTION_SETTING } from "../scheduler/policy.js";
import {
  BEYOND_YEAR_LABEL,
  MOCHI_INTERVAL_CAP_DAYS,
  beyondYear,
  type DashboardData,
  type DayActivity,
  type DeckProgress,
  type DeckRetention,
  type ForecastReport,
  type IntervalBucket,
  type MonthActivity,
  type Totals,
} from "./metrics.js";

// ─── formatting ─────────────────────────────────────────────────────────────

const DASH = "—";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Thousands separators without Intl, so output is byte-identical anywhere. */
function group(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits.charAt(i);
  }
  return out;
}

function int(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const sign = value < 0 ? "-" : "";
  return sign + group(String(Math.round(Math.abs(value))));
}

function dec(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const fixed = Math.abs(value).toFixed(digits);
  const dot = fixed.indexOf(".");
  const whole = dot === -1 ? fixed : fixed.slice(0, dot);
  const frac = dot === -1 ? "" : fixed.slice(dot);
  return (value < 0 ? "-" : "") + group(whole) + frac;
}

function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${dec(value * 100, digits)}%`;
}

function signed(value: number, digits = 0): string {
  return (value > 0 ? "+" : "") + dec(value, digits);
}

// ─── geometry ───────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function weekday(ms: number): number {
  return new Date(ms).getUTCDay();
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

type Scale = (value: number) => number;

function linear(d0: number, d1: number, r0: number, r1: number): Scale {
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** Two decimals is plenty for SVG coordinates and keeps the file small. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─── 活動 heatmap ───────────────────────────────────────────────────────────

const CELL = 10;
const PITCH = 13;
const HEAT_GUTTER = 26;
const MONTH_BAND = 14;
const WEEKDAY_LABELS: readonly (readonly [number, string])[] = [
  [1, "月"],
  [3, "水"],
  [5, "金"],
];

function heatBin(reviews: number, thresholds: readonly [number, number, number]): number {
  if (reviews <= 0) return 0;
  if (reviews <= thresholds[0]) return 1;
  if (reviews <= thresholds[1]) return 2;
  if (reviews <= thresholds[2]) return 3;
  return 4;
}

function heatmapYear(
  year: string,
  byDate: Map<string, DayActivity>,
  thresholds: readonly [number, number, number],
  lastDate: string,
): string {
  const start = dayMs(`${year}-01-01`);
  const yearEnd = dayMs(`${year}-12-31`);
  const end = Math.min(yearEnd, dayMs(lastDate));
  const firstSunday = start - weekday(start) * DAY_MS;
  const cols = Math.floor((end - firstSunday) / (7 * DAY_MS)) + 1;
  const width = HEAT_GUTTER + cols * PITCH + 4;
  const height = MONTH_BAND + 7 * PITCH;

  const cells: string[] = [];
  for (let ms = start; ms <= end; ms += DAY_MS) {
    const date = isoDate(ms);
    const day = byDate.get(date);
    const reviews = day?.reviews ?? 0;
    const col = Math.floor((ms - firstSunday) / (7 * DAY_MS));
    const x = HEAT_GUTTER + col * PITCH;
    const y = MONTH_BAND + weekday(ms) * PITCH;
    const tip = day
      ? `${date} · ${int(day.reviews)}回 · 定着率 ${pct(day.retention, 0)} · ${dec(day.minutes, 0)}分`
      : `${date} · 学習なし`;
    cells.push(
      `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" ` +
        `fill="var(--heat-${heatBin(reviews, thresholds)})"><title>${esc(tip)}</title></rect>`,
    );
  }

  const months: string[] = [];
  for (let m = 1; m <= 12; m += 1) {
    const first = dayMs(`${year}-${String(m).padStart(2, "0")}-01`);
    if (first > end) break;
    const col = Math.floor((first - firstSunday) / (7 * DAY_MS));
    months.push(
      `<text class="ax" x="${HEAT_GUTTER + col * PITCH}" y="10">${m}月</text>`,
    );
  }

  const weekdays = WEEKDAY_LABELS.map(
    ([row, label]) =>
      `<text class="ax" x="0" y="${MONTH_BAND + row * PITCH + 8}">${label}</text>`,
  );

  const summary = byDate.size;
  return (
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="img" aria-label="${esc(`${year}年の活動ヒートマップ。1日1マス、色は復習数の四分位。`)}">` +
    `${months.join("")}${weekdays.join("")}${cells.join("")}` +
    `</svg><!-- ${summary} active days in the map -->`
  );
}

/**
 * The table twin for one year's heatmap strip.
 *
 * The strip's per-day values were hover-only until 2026-08-22, and there is no
 * hover on a phone -- which is the device this page is FOR.  So every day that
 * carries a value gets a row.  Days with no reviews are deliberately absent:
 * their tooltip says 学習なし and nothing else, so a row for them would add
 * length without adding a value.  That is the whole of what stays hover-only.
 */
function heatmapYearTable(year: string, byDate: Map<string, DayActivity>): string {
  const rows = [...byDate.values()]
    .filter((d) => d.date.startsWith(`${year}-`) && d.reviews > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => [
      esc(d.date),
      int(d.reviews),
      int(d.cardsSeen),
      pct(d.retention),
      dec(d.minutes, 0),
      int(d.newCards),
    ]);
  return details(
    `${year}年の1日ごとの数字を表で見る（${rows.length}日）`,
    table(["日付", "復習数", "カード数", "定着率", "分", "新規"], rows),
  );
}

function heatLegend(thresholds: readonly [number, number, number]): string {
  const labels = [
    "0",
    `1–${int(thresholds[0])}`,
    `${int(thresholds[0] + 1)}–${int(thresholds[1])}`,
    `${int(thresholds[1] + 1)}–${int(thresholds[2])}`,
    `${int(thresholds[2] + 1)}+`,
  ];
  const swatches = labels
    .map((label, i) => `<span><i style="background:var(--heat-${i})"></i> ${esc(label)}</span>`)
    .join("");
  return `<div class="heat-legend"><span>1日の復習数</span>${swatches}</div>`;
}

// ─── 累計学習カード数 ────────────────────────────────────────────────────────

function cumulativeChart(days: readonly DayActivity[]): string {
  if (days.length === 0) return '<p class="def">データなし</p>';
  const W = 720;
  const H = 190;
  const L = 46;
  const R = 74;
  const T = 12;
  const B = 24;
  const first = days[0] as DayActivity;
  const last = days[days.length - 1] as DayActivity;
  const x = linear(dayMs(first.date), dayMs(last.date), L, W - R);
  const top = niceCeil(last.cumulativeCards);
  const y = linear(0, top, H - B, T);

  const points = days.map((d) => `${round(x(dayMs(d.date)))},${round(y(d.cumulativeCards))}`);
  const area =
    `M${round(x(dayMs(first.date)))},${round(y(0))} L` +
    points.join(" L") +
    ` L${round(x(dayMs(last.date)))},${round(y(0))} Z`;

  const ticks: string[] = [];
  for (let i = 0; i <= 3; i += 1) {
    const value = (top / 3) * i;
    const yy = round(y(value));
    ticks.push(
      `<line class="grid-line" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"/>` +
        `<text class="ax" x="${L - 6}" y="${yy + 3}" text-anchor="end">${int(value)}</text>`,
    );
  }

  const yearMarks: string[] = [];
  let seen = "";
  for (const d of days) {
    const year = d.date.slice(0, 4);
    if (year === seen) continue;
    seen = year;
    const xx = round(x(dayMs(d.date)));
    yearMarks.push(
      `<line class="grid-line" x1="${xx}" y1="${T}" x2="${xx}" y2="${H - B}"/>` +
        `<text class="ax" x="${xx}" y="${H - B + 14}">${year}</text>`,
    );
  }

  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
      `累計学習カード数の推移。${first.date} の 0 枚から ${last.date} の ${int(last.cumulativeCards)} 枚まで。`,
    )}">` +
    `${ticks.join("")}${yearMarks.join("")}` +
    `<path d="${area}" fill="var(--series-1)" fill-opacity="0.12"/>` +
    `<polyline points="${points.join(" ")}" fill="none" stroke="var(--series-1)" stroke-width="2" ` +
    `stroke-linejoin="round"/>` +
    `<circle cx="${round(x(dayMs(last.date)))}" cy="${round(y(last.cumulativeCards))}" r="4" ` +
    `fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>` +
    `<text class="val" x="${W - R + 8}" y="${round(y(last.cumulativeCards)) }" dy="4">` +
    `${int(last.cumulativeCards)}枚</text>` +
    `<line class="axis-line" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>` +
    `</svg>`
  );
}

function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

function monthlyCardsChart(months: readonly MonthActivity[]): string {
  if (months.length === 0) return '<p class="def">データなし</p>';
  const W = 720;
  const H = 130;
  const L = 46;
  const R = 74;
  const T = 10;
  const B = 24;
  const plot = W - R - L;
  const pitch = plot / months.length;
  const barW = Math.max(2, pitch - 2);
  const top = niceCeil(Math.max(...months.map((m) => m.cardsSeen)));
  const y = linear(0, top, H - B, T);
  let peak = months[0] as MonthActivity;
  for (const m of months) if (m.cardsSeen > peak.cardsSeen) peak = m;

  const ticks = [0, top / 2, top].map((value) => {
    const yy = round(y(value));
    return (
      `<line class="grid-line" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"/>` +
      `<text class="ax" x="${L - 6}" y="${yy + 3}" text-anchor="end">${int(value)}</text>`
    );
  });

  const bars: string[] = [];
  const yearTicks: string[] = [];
  let seen = "";
  months.forEach((m, i) => {
    const xx = L + i * pitch + (pitch - barW) / 2;
    const h = Math.max(1, H - B - y(m.cardsSeen));
    bars.push(
      `<rect x="${round(xx)}" y="${round(H - B - h)}" width="${round(barW)}" height="${round(h)}" ` +
        `rx="2" fill="var(--series-1)"><title>${esc(
          `${m.month} · ${int(m.cardsSeen)}枚 · 新規 ${int(m.newCards)}枚 · ${int(m.reviews)}回`,
        )}</title></rect>`,
    );
    const year = m.month.slice(0, 4);
    if (year !== seen) {
      seen = year;
      yearTicks.push(`<text class="ax" x="${round(xx)}" y="${H - B + 14}">${year}</text>`);
    }
  });

  const peakIndex = months.indexOf(peak);
  const peakX = L + peakIndex * pitch + pitch / 2;
  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
      "月ごとに学習したカード数。最大は " + peak.month + " の " + int(peak.cardsSeen) + " 枚。",
    )}">` +
    `${ticks.join("")}${bars.join("")}${yearTicks.join("")}` +
    `<text class="val" x="${round(peakX)}" y="${round(y(peak.cardsSeen)) - 6}" text-anchor="middle">` +
    `${int(peak.cardsSeen)}</text>` +
    `<line class="axis-line" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>` +
    `</svg>`
  );
}

// ─── 定着率 × 復習間隔 ───────────────────────────────────────────────────────

/**
 * SETTLED by Zach: 0.90, revised down from 0.95 on 2026-08-19 after measuring the
 * daily load under the 365-day cap -- 0.95 projects 130-204 reviews/day against a
 * realised 69.2, where 0.90 projects 62-97.  Imported rather than written here so
 * the page and the scheduler cannot disagree about what the app is aiming at --
 * see src/scheduler/policy.ts and scripts/capped-load.ts.
 *
 * Where this line sits changes what the page SAYS, so the copy below reads the
 * data rather than repeating a slogan: three of the nine elapsed bands (21-60d,
 * 60-180d, 180-365d) sit between 90% and 95%, so they clear a 0.90 target and
 * miss a 0.95 one.
 */
const TARGET_RETENTION = TARGET_RETENTION_SETTING;

/** e.g. "95%" -- one place, so no label can drift from the line it names. */
const TARGET_LABEL = `${Math.round(TARGET_RETENTION * 100)}%`;

/**
 * Retention against interval, BOTH BASES on one pair of axes.
 *
 * The elapsed series is drawn solid because it is what happened; the scheduled
 * series is drawn hollow and dashed because it is what was intended.  Drawing
 * only one of them is what produced the contradiction this chart exists to
 * close: the page used to bucket by the PLANNED interval and print "観測なし"
 * over `> 365d`, while BACKTEST.md scored the same corpus by ELAPSED time and
 * reported 3,009 observations there at 96.88%.  Both were reading real columns.
 * Neither said which.
 */
function intervalRetentionChart(
  buckets: readonly IntervalBucket[],
  scheduled: readonly IntervalBucket[],
): string {
  const W = 720;
  const H = 210;
  const L = 46;
  const R = 16;
  const T = 16;
  const B = 30;
  const observed = buckets.filter((b) => b.retention !== null);
  const lowest = Math.min(
    TARGET_RETENTION,
    ...observed.map((b) => b.retention ?? 1),
    ...scheduled.filter((b) => b.retention !== null).map((b) => b.retention ?? 1),
  );
  const d0 = Math.min(88, Math.floor(lowest * 100) - 1);
  const y = linear(d0, 100, H - B, T);
  const pitch = (W - L - R) / buckets.length;

  const ticks: string[] = [];
  for (let value = Math.ceil(d0 / 5) * 5; value <= 100; value += 5) {
    const yy = round(y(value));
    ticks.push(
      `<line class="grid-line" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"/>` +
        `<text class="ax" x="${L - 6}" y="${yy + 3}" text-anchor="end">${value}%</text>`,
    );
  }

  const targetY = round(y(TARGET_RETENTION * 100));
  const target =
    `<line class="axis-line" x1="${L}" y1="${targetY}" x2="${W - R}" y2="${targetY}"/>` +
    `<text class="ax" x="${W - R}" y="${targetY + 13}" text-anchor="end">目標 ${TARGET_LABEL}</text>`;

  let best = observed[0];
  let worst = observed[0];
  for (const b of observed) {
    if (best && (b.retention ?? 0) > (best.retention ?? 0)) best = b;
    if (worst && (b.retention ?? 1) < (worst.retention ?? 1)) worst = b;
  }

  // The planned series first, so the measured one draws on top of it.
  const planned: string[] = [];
  scheduled.forEach((b, i) => {
    if (b.retention === null) return;
    const cx = L + pitch * (i + 0.5) + 7;
    const cy = y(b.retention * 100);
    planned.push(
      `<circle cx="${round(cx)}" cy="${round(cy)}" r="4" fill="none" ` +
        `stroke="var(--series-2)" stroke-width="2" stroke-dasharray="2 2">` +
        `<title>${esc(
          `${b.label}（予定 scheduled）· 定着率 ${pct(b.retention)} · ${int(b.reviews)}回`,
        )}</title></circle>`,
    );
  });

  const marks: string[] = [];
  buckets.forEach((b, i) => {
    const cx = L + pitch * (i + 0.5);
    marks.push(
      `<text class="ax" x="${round(cx)}" y="${H - B + 16}" text-anchor="middle">${esc(b.label)}</text>`,
    );
    if (b.retention === null) {
      marks.push(
        `<text class="ax" x="${round(cx)}" y="${targetY - 10}" text-anchor="middle">観測なし</text>`,
      );
      return;
    }
    const cy = y(b.retention * 100);
    marks.push(
      `<line x1="${round(cx)}" y1="${targetY}" x2="${round(cx)}" y2="${round(cy)}" ` +
        `stroke="var(--series-1)" stroke-width="2"/>` +
        `<circle cx="${round(cx)}" cy="${round(cy)}" r="5" fill="var(--series-1)" ` +
        `stroke="var(--surface)" stroke-width="2"><title>${esc(
          `${b.label} · 定着率 ${pct(b.retention)} · ${int(b.reviews)}回 · 失敗 ${int(b.lapses)}`,
        )}</title></circle>`,
    );
    if (b === best || b === worst) {
      marks.push(
        `<text class="val" x="${round(cx)}" y="${round(cy) - 10}" text-anchor="middle">` +
          `${pct(b.retention, 1)}</text>`,
      );
    }
  });

  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
      `直前の復習間隔ごとの定着率。実測(elapsed)と予定(scheduled)の2系列。目標 ${TARGET_LABEL} の線からの高さが余剰。`,
    )}">${ticks.join("")}${target}${planned.join("")}${marks.join("")}</svg>`
  );
}

function intervalVolumeChart(
  buckets: readonly IntervalBucket[],
  scheduled: readonly IntervalBucket[],
): string {
  const W = 720;
  const H = 110;
  const L = 46;
  const R = 16;
  const T = 12;
  const B = 22;
  const pitch = (W - L - R) / buckets.length;
  const barW = Math.min(22, (pitch - 12) / 2);
  const top = niceCeil(
    Math.max(...buckets.map((b) => b.reviews), ...scheduled.map((b) => b.reviews)),
  );
  const y = linear(0, top, H - B, T);
  let peak = buckets[0] as IntervalBucket;
  for (const b of buckets) if (b.reviews > peak.reviews) peak = b;

  const ticks = [0, top / 2, top].map((value) => {
    const yy = round(y(value));
    return (
      `<line class="grid-line" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"/>` +
      `<text class="ax" x="${L - 6}" y="${yy + 3}" text-anchor="end">${int(value)}</text>`
    );
  });

  const bar = (
    cx: number,
    value: number,
    token: string,
    opacity: string,
    title: string,
  ): string => {
    const h = H - B - y(value);
    if (value === 0) {
      return `<text class="ax" x="${round(cx)}" y="${H - B - 6}" text-anchor="middle">0</text>`;
    }
    return (
      `<rect x="${round(cx - barW / 2)}" y="${round(H - B - h)}" width="${round(barW)}" ` +
      `height="${round(h)}" rx="3" fill="var(--${token})" fill-opacity="${opacity}">` +
      `<title>${esc(title)}</title></rect>`
    );
  };

  const bars = buckets.map((b, i) => {
    const cx = L + pitch * (i + 0.5);
    const other = scheduled[i] as IntervalBucket | undefined;
    return (
      bar(
        cx - barW / 2 - 1,
        b.reviews,
        "series-1",
        "0.55",
        `${b.label}（実測 elapsed）· ${int(b.reviews)}回`,
      ) +
      bar(
        cx + barW / 2 + 1,
        other?.reviews ?? 0,
        "series-2",
        "0.35",
        `${b.label}（予定 scheduled）· ${int(other?.reviews ?? 0)}回`,
      )
    );
  });

  const peakX = L + pitch * (buckets.indexOf(peak) + 0.5);
  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc("復習間隔ごとの復習回数。")}">` +
    `${ticks.join("")}${bars.join("")}` +
    `<text class="val" x="${round(peakX)}" y="${round(y(peak.reviews)) - 6}" text-anchor="middle">` +
    `${int(peak.reviews)}</text>` +
    `<line class="axis-line" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/></svg>`
  );
}

// ─── デッキ別定着率 ─────────────────────────────────────────────────────────

/** Below this many reviews a retention figure is drawn hollow, not solid. */
export const SMALL_SAMPLE = 100;

function deckRetentionChart(decks: readonly DeckRetention[]): string {
  if (decks.length === 0) return '<p class="def">データなし</p>';
  const W = 720;
  const GUT = 168;
  const R = 54;
  const ROW = 26;
  const T = 18;
  const H = T + decks.length * ROW + 14;

  // Direct figures only, matching how the rows were selected. Mixing a deck's
  // own reviews with its subtree's in one row would put two different
  // denominators on the same dot.
  interface Dot {
    readonly row: number;
    readonly value: number;
    readonly reviews: number;
    readonly token: string;
    readonly name: string;
  }
  const dots: Dot[] = [];
  decks.forEach((d, row) => {
    if (d.directForwardRetention !== null) {
      dots.push({
        row,
        value: d.directForwardRetention,
        reviews: d.directForwardReviews,
        token: "--series-1",
        name: "順方向",
      });
    }
    if (d.directReverseRetention !== null) {
      dots.push({
        row,
        value: d.directReverseRetention,
        reviews: d.directReverseReviews,
        token: "--series-2",
        name: "逆方向",
      });
    }
  });

  const d0 = Math.min(
    88,
    Math.floor(Math.min(TARGET_RETENTION, ...dots.map((dot) => dot.value)) * 100) - 1,
  );
  const x = linear(d0, 100, GUT, W - R);

  const ticks: string[] = [];
  for (let value = Math.ceil(d0 / 5) * 5; value <= 100; value += 5) {
    const xx = round(x(value));
    ticks.push(
      `<line class="${value === 90 ? "axis-line" : "grid-line"}" x1="${xx}" y1="${T - 8}" ` +
        `x2="${xx}" y2="${H - 16}"/>` +
        `<text class="ax" x="${xx}" y="${H - 4}" text-anchor="middle">${value}%</text>`,
    );
  }

  // Label the two extremes, not every dot and not an arbitrary row: at this
  // scale two dots on the same row sit ~28px apart and their labels collide.
  // Ties go to the bigger sample, so the labelled dot is the one worth reading:
  // 日本語/数字 is 100% over 688 reviews, English/Vocabulary reverse over 48.
  let hi = dots[0];
  let lo = dots[0];
  for (const dot of dots) {
    if (hi && (dot.value > hi.value || (dot.value === hi.value && dot.reviews > hi.reviews))) {
      hi = dot;
    }
    if (lo && (dot.value < lo.value || (dot.value === lo.value && dot.reviews > lo.reviews))) {
      lo = dot;
    }
  }

  const parts: string[] = [];
  decks.forEach((d, row) => {
    const cy = round(T + row * ROW + ROW / 2);
    parts.push(
      `<text class="lbl" x="${GUT - 10}" y="${cy + 4}" text-anchor="end">${esc(d.path)}</text>`,
    );
    const fwd = d.directForwardRetention;
    const rev = d.directReverseRetention;
    if (fwd !== null && rev !== null) {
      parts.push(
        `<line x1="${round(x(fwd * 100))}" y1="${cy}" x2="${round(x(rev * 100))}" y2="${cy}" ` +
          `stroke="var(--axis)" stroke-width="1"/>`,
      );
    }
  });

  for (const dot of dots) {
    const cx = round(x(dot.value * 100));
    const cy = round(T + dot.row * ROW + ROW / 2);
    const small = dot.reviews < SMALL_SAMPLE;
    const deck = decks[dot.row] as DeckRetention;
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="4.5" ` +
        (small
          ? `fill="var(--surface)" stroke="var(${dot.token})" stroke-width="2"`
          : `fill="var(${dot.token})" stroke="var(--surface)" stroke-width="2"`) +
        `><title>${esc(
          `${deck.path} · ${dot.name} ${pct(dot.value)} · ${int(dot.reviews)}回` +
            (small ? "（標本が小さい）" : ""),
        )}</title></circle>`,
    );
    if (dot === hi || dot === lo) {
      const atEdge = cx > W - R - 34;
      parts.push(
        `<text class="val" x="${atEdge ? cx - 8 : cx}" y="${cy - 9}" ` +
          `text-anchor="${atEdge ? "end" : "middle"}">${pct(dot.value, 2)}</text>`,
      );
    }
  }

  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
      `デッキごとの順方向・逆方向の定着率。${TARGET_LABEL} の線が目標。最高と最低に値を表示。`,
    )}">${ticks.join("")}${parts.join("")}</svg>`
  );
}

// ─── デッキの進捗 ───────────────────────────────────────────────────────────

const PROGRESS_SEGMENTS: readonly (readonly [keyof DeckProgress, string, string])[] = [
  ["directNewTracks", "--ord-1", "未学習"],
  ["directYoungTracks", "--ord-2", "学習中"],
  ["directMatureTracks", "--ord-3", "定着"],
];

/**
 * Proportional bars, not absolute ones. 単語 has 7,404 tracks and 基本情報/第10章
 * has 40; on a shared absolute scale every deck but the first two collapses to a
 * sliver and the tile answers nothing. The question here is "how far along is
 * this deck", which is a share — the absolute total is printed at the row end.
 */
function deckProgressChart(decks: readonly DeckProgress[]): string {
  if (decks.length === 0) return '<p class="def">データなし</p>';
  const W = 720;
  const GUT = 168;
  const R = 62;
  const ROW = 24;
  const BAR = 12;
  const H = decks.length * ROW + 20;
  const x0 = GUT;
  const x1 = W - R;
  const span = x1 - x0;

  const rows = decks.map((d, i) => {
    const y = i * ROW + (ROW - BAR) / 2;
    const parts: string[] = [
      `<text class="lbl" x="${GUT - 10}" y="${y + BAR - 2}" text-anchor="end">${esc(d.path)}</text>`,
    ];
    const total = Math.max(1, d.directTracks);
    let cursor = 0;
    for (const [key, token, name] of PROGRESS_SEGMENTS) {
      const value = d[key] as number;
      if (value <= 0) continue;
      const left = x0 + (cursor / total) * span;
      const right = x0 + ((cursor + value) / total) * span;
      // 2px surface gap between segments, never a stroke around them.
      const w = Math.max(1.5, right - left - 2);
      parts.push(
        `<rect x="${round(left)}" y="${y}" width="${round(w)}" height="${BAR}" rx="2" ` +
          `fill="var(${token})"><title>${esc(
            `${d.path} · ${name} ${int(value)} / ${int(d.directTracks)}トラック ` +
              `(${pct(value / total, 0)})`,
          )}</title></rect>`,
      );
      cursor += value;
    }
    parts.push(`<text class="ax" x="${x1 + 8}" y="${y + BAR - 2}">${int(d.directTracks)}</text>`);
    return parts.join("");
  });

  const scale = [0, 25, 50, 75, 100].map((p) => {
    const xx = round(x0 + (p / 100) * span);
    return `<text class="ax" x="${xx}" y="${H - 4}" text-anchor="middle">${p}%</text>`;
  });

  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
      "デッキごとのトラックの状態の割合。未学習・学習中・定着。行末は総トラック数。",
    )}">${rows.join("")}${scale.join("")}</svg>`
  );
}

// ─── tiles and tables ───────────────────────────────────────────────────────

interface Tile {
  readonly key: string;
  readonly latin: string;
  readonly value: string;
  readonly unit?: string;
  readonly sub: string;
}

// ─── 復習予測 ────────────────────────────────────────────────────────────────

/**
 * The forecast, as bars over the coming `horizonDays`.
 *
 * THREE THINGS IT REFUSES TO DO, each of which would make it read better and
 * say less:
 *
 *   * It does not put the BACKLOG in the first bar. 443 cards due today or
 *     earlier is a fact about the past; folding it into "tomorrow" draws a spike
 *     that no scheduler planned. It is called out beside the chart instead.
 *   * It does not drop empty days. A quiet fortnight compressed out of the axis
 *     shows a workload that does not exist.
 *   * It does not claim the bars are Hashigo's plan. Most of them are Mochi's,
 *     because a track keeps its imported due date until it is graded here — the
 *     provenance line under the chart counts both, and the ratio moves one card
 *     per review.
 */
function forecastChart(report: ForecastReport): string {
  const days = report.days;
  if (days.length === 0) return '<p class="def">データなし</p>';
  const W = 720;
  const H = 132;
  const L = 46;
  const R = 16;
  const T = 14;
  const B = 30;
  const pitch = (W - L - R) / days.length;
  const barW = Math.max(2, Math.min(16, pitch - 3));
  const top = niceCeil(Math.max(1, ...days.map((d) => d.tracks)));
  const y = linear(0, top, H - B, T);

  const ticks = [0, top / 2, top].map((value) => {
    const yy = round(y(value));
    return (
      `<line class="grid-line" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"/>` +
      `<text class="ax" x="${L - 6}" y="${yy + 3}" text-anchor="end">${int(value)}</text>`
    );
  });

  const bars = days.map((day, i) => {
    const cx = L + pitch * (i + 0.5);
    const h = H - B - y(day.tracks);
    const title = `${day.date} · ${int(day.tracks)}件`;
    if (day.tracks === 0) {
      // Drawn as a baseline stub rather than nothing: an empty day is a fact,
      // and a gap in a bar row reads as missing data instead of as zero.
      return (
        `<rect x="${round(cx - barW / 2)}" y="${H - B - 1}" width="${round(barW)}" height="1" ` +
        `fill="var(--muted)" fill-opacity="0.45"><title>${esc(title)}</title></rect>`
      );
    }
    return (
      `<rect x="${round(cx - barW / 2)}" y="${round(H - B - h)}" width="${round(barW)}" ` +
      `height="${round(h)}" rx="2" fill="var(--series-1)" fill-opacity="0.75">` +
      `<title>${esc(title)}</title></rect>`
    );
  });

  // Weekly date labels only; thirty of them would collide at this width.
  const labels = days
    .map((day, i) =>
      i % 7 === 0
        ? `<text class="ax" x="${round(L + pitch * (i + 0.5))}" y="${H - 8}" text-anchor="middle">` +
          `${esc(day.date.slice(5))}</text>`
        : "",
    )
    .filter((t) => t !== "");

  const peak = report.peak;
  const peakLabel =
    peak === null
      ? ""
      : `<text class="val" x="${round(L + pitch * (days.indexOf(peak) + 0.5))}" ` +
        `y="${round(y(peak.tracks)) - 6}" text-anchor="middle">${int(peak.tracks)}</text>`;

  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
      `${report.asOf} の翌日から ${report.horizonDays} 日間に予定されている復習件数。` +
        `当日以前の ${report.backlog} 件は含まない。`,
    )}">${ticks.join("")}${bars.join("")}${labels.join("")}${peakLabel}` +
    `<line class="axis-line" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/></svg>`
  );
}

function tile(t: Tile): string {
  return (
    `<div class="tile"><div class="k">${esc(t.key)} <span class="latin">${esc(t.latin)}</span></div>` +
    `<div class="v">${esc(t.value)}${t.unit ? `<span class="u">${esc(t.unit)}</span>` : ""}</div>` +
    `<div class="s">${esc(t.sub)}</div></div>`
  );
}

function tilesFor(totals: Totals, cardsTotal: number, activeSpan: number): string {
  const tiles: Tile[] = [
    {
      key: "復習数",
      latin: "reviews",
      value: int(totals.reviews),
      sub: `採点イベント、全トラック（順方向 ${int(totals.forwardReviews)} / 逆方向 ${int(
        totals.reverseReviews,
      )}）`,
    },
    {
      key: "定着率",
      latin: "retention",
      value: pct(totals.retention),
      sub: `合格 ${int(totals.passed)} / 失敗 ${int(totals.lapses)} · 目標 ${TARGET_LABEL} に対して ${signed(
        (totals.retention ?? 0) * 100 - TARGET_RETENTION * 100,
        2,
      )} ポイント`,
    },
    {
      key: "復習時間",
      latin: "study time",
      value: dec(totals.hours, 1),
      unit: "時間",
      sub: `${dec(totals.hours / 24, 1)}日ぶん · 所要時間を持つ復習 ${int(
        totals.timedReviews,
      )} / ${int(totals.reviews)}`,
    },
    {
      key: "学習カード数",
      latin: "cards studied",
      value: int(totals.cardsStudied),
      sub: `1回以上採点されたカード。全カード ${int(cardsTotal)} 枚のうち`,
    },
    {
      key: "活動日数",
      latin: "active days",
      value: int(totals.activeDays),
      sub: `1回以上採点した日 / 経過 ${int(activeSpan)}日（両端を含む）`,
    },
    {
      key: "失敗",
      latin: "lapses",
      value: int(totals.lapses),
      sub: `「覚えていない」と採点した回数。${pct(
        totals.lapses / Math.max(1, totals.reviews),
        2,
      )}`,
    },
    {
      key: "1日あたり",
      latin: "per active day",
      value: dec(totals.reviewsPerActiveDay, 1),
      unit: "回",
      sub: `活動日で割った値。休んだ日は含めない`,
    },
    {
      key: "1回あたり",
      latin: "per review",
      value: dec(totals.medianSeconds, 0),
      unit: "秒",
      sub: `中央値。平均は ${dec(totals.meanSeconds, 1)}秒 — 裾が長い`,
    },
  ];
  return `<div class="tiles">${tiles.map(tile).join("")}</div>`;
}

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const thead = head.map((h) => `<th>${esc(h)}</th>`).join("");
  const tbody = rows
    .map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="scroll"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
}

function details(summary: string, body: string): string {
  return `<details><summary>${esc(summary)}</summary>${body}</details>`;
}

// ─── the page ───────────────────────────────────────────────────────────────

const STYLE = `
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  /* 5.03:1 on --surface. The dark themes below keep #898781, which is 4.85:1
     on their own surface; one shared grey cannot clear AA on both. */
  --ink-muted: #6f6d68;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11, 11, 11, 0.10);
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --heat-0: #e6e5df;
  --heat-1: #86b6ef;
  --heat-2: #3987e5;
  --heat-3: #1c5cab;
  --heat-4: #0d366b;
  --ord-1: #86b6ef;
  --ord-2: #2a78d6;
  --ord-3: #104281;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --ink-muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255, 255, 255, 0.10);
    --series-1: #3987e5;
    --series-2: #d95926;
    --heat-0: #262624;
    --heat-1: #184f95;
    --heat-2: #2a78d6;
    --heat-3: #6da7ec;
    --heat-4: #b7d3f6;
    --ord-1: #184f95;
    --ord-2: #3987e5;
    --ord-3: #9ec5f4;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d;
  --surface: #1a1a19;
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --ink-muted: #898781;
  --grid: #2c2c2a;
  --axis: #383835;
  --border: rgba(255, 255, 255, 0.10);
  --series-1: #3987e5;
  --series-2: #d95926;
  --heat-0: #262624;
  --heat-1: #184f95;
  --heat-2: #2a78d6;
  --heat-3: #6da7ec;
  --heat-4: #b7d3f6;
  --ord-1: #184f95;
  --ord-2: #3987e5;
  --ord-3: #9ec5f4;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN",
        "Yu Gothic UI", "Noto Sans JP", sans-serif;
}
main { max-width: 1080px; margin: 0 auto; padding: 30px 18px 72px; }
.eyebrow { margin: 0; font-size: 12px; letter-spacing: .10em; text-transform: uppercase;
  color: var(--ink-muted); }
h1 { font-size: 27px; margin: 6px 0 8px; font-weight: 650; letter-spacing: .01em; }
.lede { margin: 0 0 14px; color: var(--ink-2); font-size: 14px; max-width: 74ch; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 0 0 26px; padding: 0;
  font-size: 12px; color: var(--ink-muted); }
.meta div { display: flex; gap: 6px; }
.meta dt { color: var(--ink-muted); }
.meta dd { margin: 0; color: var(--ink-2); font-variant-numeric: tabular-nums; }
section.card { background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 18px 20px; margin: 0 0 18px; }
h2 { font-size: 17px; margin: 0 0 3px; font-weight: 620; }
h2 .latin { color: var(--ink-muted); font-weight: 400; font-size: 12.5px; margin-left: 9px; }
h3 { font-size: 13px; margin: 18px 0 6px; font-weight: 600; color: var(--ink-2); }
p.def { margin: 0 0 14px; color: var(--ink-2); font-size: 12.5px; max-width: 84ch; }
p.read { margin: 14px 0 0; color: var(--ink-2); font-size: 13px; max-width: 74ch; }
p.read + p.def, p.def + p.def, p.read + p.read { margin-top: 13px; }
p.read b { color: var(--ink); font-weight: 600; }
.tiles { display: grid; gap: 12px; margin: 0 0 18px;
  grid-template-columns: repeat(auto-fit, minmax(226px, 1fr)); }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 13px 15px; }
.tile .k { font-size: 12px; color: var(--ink-2); }
.tile .v { font-size: 29px; line-height: 1.12; margin: 3px 0 3px; }
.tile .v .u { font-size: 14px; color: var(--ink-2); margin-left: 3px; }
.tile .s { font-size: 11.5px; color: var(--ink-muted); }
table { border-collapse: collapse; width: 100%; font-size: 12.5px;
  font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 5px 9px; border-bottom: 1px solid var(--grid);
  white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
thead th { color: var(--ink-2); font-weight: 600; border-bottom: 1px solid var(--axis); }
tbody tr:hover { background: var(--page); }
td.num { font-variant-numeric: tabular-nums; }
details { margin-top: 14px; }
summary { cursor: pointer; color: var(--ink-2); font-size: 12.5px; }
summary:hover { color: var(--ink); }
.scroll { overflow-x: auto; margin-top: 8px; }
svg { display: block; max-width: 100%; height: auto; }
svg text { font: 10px system-ui, -apple-system, "Segoe UI", sans-serif; }
.ax { fill: var(--ink-muted); }
.lbl { fill: var(--ink-2); font-size: 11px; }
.val { fill: var(--ink); font-size: 11px; font-weight: 600; }
.grid-line { stroke: var(--grid); stroke-width: 1; }
.axis-line { stroke: var(--axis); stroke-width: 1; }
rect:hover, circle:hover { fill-opacity: 1; }
.legend { display: flex; gap: 18px; align-items: center; flex-wrap: wrap;
  font-size: 12px; color: var(--ink-2); margin: 0 0 10px; }
.legend i, .heat-legend i { width: 10px; height: 10px; border-radius: 3px;
  display: inline-block; margin-right: 6px; vertical-align: -1px; }
.heat-legend { display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  font-size: 11px; color: var(--ink-muted); margin: 4px 0 12px; }
.heat-legend i { margin-right: 4px; }
.years { display: grid; gap: 10px; }
.year { display: grid; gap: 2px; }
.year h3 { margin: 4px 0 0; }
.year details { margin-top: 6px; }
.placeholder { border: 1px solid var(--axis); border-radius: 8px; padding: 22px 20px;
  color: var(--ink-2); background: var(--page); font-size: 13px; }
.placeholder strong { color: var(--ink); }
footer { margin-top: 30px; color: var(--ink-muted); font-size: 12px; max-width: 84ch; }
footer h2 { font-size: 14px; color: var(--ink-2); margin-top: 22px; }
footer ul { padding-left: 18px; margin: 6px 0; }
footer code { font-size: 11.5px; }
`;

function head(title: string): string {
  return (
    `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${esc(title)}</title>\n` +
    `<!-- Generated by src/dashboard/render.ts. No script, no network requests: every\n` +
    `     figure is precomputed at generation time (SPEC.html: "no polling, no sockets,\n` +
    `     precomputed renders"). Hover text is native SVG <title>. Every aggregate chart\n` +
    `     has a table twin below it; the heatmap per-day cells are the one exception and\n` +
    `     are summarised by the per-year and per-month tables. -->\n` +
    `<style>${STYLE}</style>\n</head>\n<body>\n<main>\n`
  );
}

export interface RenderOptions {
  /** Minimum direct reviews for a deck to appear in the retention chart. */
  readonly deckChartMinReviews?: number;
  /** Minimum tracks for a deck to appear in the progress chart. */
  readonly progressChartMinTracks?: number;
}

export function renderDashboard(data: DashboardData, options: RenderOptions = {}): string {
  const { primary, comparison } = data;
  const totalsAll = primary.totals;
  const cardsTotal = data.progress
    .filter((d) => d.depth === 0)
    .reduce((sum, d) => sum + d.cards, 0);
  const byDate = new Map(primary.days.map((d) => [d.date, d]));
  const lastDate = totalsAll.lastDate ?? isoDate(Date.now());
  const deckMin = options.deckChartMinReviews ?? 300;
  const progressMin = options.progressChartMinTracks ?? 40;

  const chartDecks = primary.decks
    .filter((d) => d.directReviews >= deckMin)
    .sort((a, b) => b.directReviews - a.directReviews);
  const chartProgress = data.progress
    .filter((d) => d.directTracks >= progressMin)
    .sort((a, b) => b.directTracks - a.directTracks);

  const out: string[] = [];
  out.push(head("Hashigo · 学習ダッシュボード"));

  // ── header
  out.push(
    `<p class="eyebrow">Hashigo 梯子 · Stage 2 · read-only</p>`,
    `<h1>学習ダッシュボード</h1>`,
    `<p class="lede">インポート済みの復習ログだけを読む静的ページ。すべての数字は生成時に確定` +
      `していて、スクリプトも外部リクエストもない。これは同時にインポータの受け入れテストで` +
      `もある — Mochi 自身のダッシュボードが既知の正解を持っているので、一致すればインポート` +
      `は正しい。</p>`,
    `<dl class="meta">` +
      `<div><dt>データ元</dt><dd>${esc(data.source)}</dd></div>` +
      `<div><dt>生成</dt><dd>${esc(data.generatedAt)}</dd></div>` +
      `<div><dt>スキーマ</dt><dd>v${int(data.schemaVersion)}</dd></div>` +
      `<div><dt>期間</dt><dd>${esc(totalsAll.firstDate ?? DASH)} … ${esc(
        totalsAll.lastDate ?? DASH,
      )}</dd></div>` +
      `<div><dt>タイムゾーン</dt><dd>各復習の tz_offset で日付を切る（UTC ではない）</dd></div>` +
      `</dl>`,
  );

  // ── totals
  out.push(
    `<section class="card"><h2>全期間の合計 <span class="latin">all time</span></h2>`,
    `<p class="def">窓 = ${esc(totalsAll.windowStart ?? DASH)} 〜 ${esc(
      totalsAll.windowEnd ?? DASH,
    )}（両端を含む ${int(totalsAll.daysElapsed)}日）。復習数は採点イベント数で、` +
      `1枚のカードの順方向と逆方向は別に数える。定着率 = 合格 / 全採点イベント。` +
      `復習時間 = duration の合計で、${int(
        totalsAll.reviews - totalsAll.timedReviews,
      )}件は所要時間を持たないため時間には寄与しない。</p>`,
    tilesFor(totalsAll, cardsTotal, totalsAll.daysElapsed),
    `<p class="read">読み: <b>96% を超える定着率は、間隔が必要より短いという意味</b>。` +
      `設定した目標は ${TARGET_LABEL}（FSRS 既定の 90% ではなく、Zach が決めた値）で、` +
      `いまの位置はそれより ${signed(
        (totalsAll.retention ?? 0) * 100 - TARGET_RETENTION * 100,
        2,
      )} ポイント上にある。すでに持っている定着率のために毎日の復習を払っている、` +
      `というのが SPEC の指摘で、下の「定着率 × 復習間隔」がその payment を可視化する。</p>`,
    `<p class="def">時刻について: ${int(
      totalsAll.reviewsTimeUnknown,
    )}件すべてが time_unknown = 1。Mochi は日付だけを保存し JST 深夜を書いていたので、` +
      `時刻帯別の分析は原理的に不可能。だから 00:00 の偽のピークを作らず、` +
      `retention_by_hour は空のままにしてある。</p>`,
    `</section>`,
  );

  // ── activity heatmap
  const yearStrips = data.years
    .map(
      (y) =>
        `<div class="year"><h3>${esc(y.year)}年 · ${int(y.reviews)}回 · ${int(
          y.activeDays,
        )}日 · 定着率 ${pct(y.retention, 1)}</h3>${heatmapYear(
          y.year,
          byDate,
          data.heat,
          lastDate,
        )}${heatmapYearTable(y.year, byDate)}</div>`,
    )
    .join("");
  out.push(
    `<section class="card"><h2>活動 <span class="latin">activity · reviews per day</span></h2>`,
    `<p class="def">1マスが1日。色は復習数の四分位で、全期間で共通のしきい値を使うので年どうしを` +
      `比較できる。学習しなかった日は 0 の独立した色 — 「1回だけやった日」と同じ色にしない。` +
      `日付は各復習の tz_offset で切る。</p>`,
    heatLegend(data.heat),
    `<div class="years">${yearStrips}</div>`,
    `<p class="read">全期間で <b>${int(totalsAll.activeDays)}日</b>が活動日、` +
      `経過 ${int(totalsAll.daysElapsed)}日のうち ${pct(
        totalsAll.activeDays / Math.max(1, totalsAll.daysElapsed),
        0,
      )}。</p>`,
    details(
      "年ごとの数字を表で見る",
      table(
        ["年", "復習数", "活動日数", "学習カード数", "定着率", "時間"],
        data.years.map((y) => [
          esc(`${y.year}年`),
          int(y.reviews),
          int(y.activeDays),
          int(y.cardsStudied),
          pct(y.retention),
          dec(y.hours, 1),
        ]),
      ),
    ),
    `</section>`,
  );

  // ── cards studied / cumulative
  out.push(
    `<section class="card"><h2>学習カード数と累計 <span class="latin">cards studied · cumulative</span></h2>`,
    `<p class="def">累計 = その日までに1回以上採点されたカードの実数（重複なし）。` +
      `最終値 ${int(totalsAll.cardsStudied)} は全期間の学習カード数と定義上一致する。` +
      `月ごとの棒はその月に採点されたカードの実数で、月をまたぐと同じカードが再度数えられる` +
      `ため合計しても累計にはならない。</p>`,
    cumulativeChart(primary.days),
    `<h3>月ごとの学習カード数</h3>`,
    monthlyCardsChart(primary.months),
    `<p class="read">全 ${int(cardsTotal)} 枚のうち <b>${int(
      totalsAll.cardsStudied,
    )} 枚</b>が一度でも採点されている。残り ${int(
      cardsTotal - totalsAll.cardsStudied,
    )} 枚は未着手（reps = 0）。</p>`,
    details(
      "月ごとの数字を表で見る",
      table(
        ["月", "復習数", "学習カード数", "新規カード", "定着率", "時間"],
        primary.months.map((m) => [
          esc(m.month),
          int(m.reviews),
          int(m.cardsSeen),
          int(m.newCards),
          pct(m.retention),
          dec(m.hours, 1),
        ]),
      ),
    ),
    `</section>`,
  );

  // ── retention x interval — the tile Mochi lacks, and the one that was wrong
  //
  // THIS TILE USED TO CONTRADICT BACKTEST.md.  It bucketed by the PLANNED
  // interval, found nothing past a year, and printed "> 365d 観測なし" — while
  // the backtest bucketed the same 102,020 reviews by ELAPSED time and reported
  // 3,009 observations there at 96.88%.  Both numbers were real; neither
  // artefact named its basis.  Now both name it, both use the schema's own
  // column names, and test/dashboard.test.ts asserts that the number rendered
  // here is the number written in BACKTEST.md.
  const elapsed = primary.intervals.elapsed;
  const scheduled = primary.intervals.scheduled;
  const longest = [...elapsed].reverse().find((b) => b.retention !== null);
  const worst = elapsed.reduce<IntervalBucket | null>(
    (acc, b) => (b.retention === null ? acc : acc === null || b.retention < (acc.retention ?? 1) ? b : acc),
    null,
  );
  const below = elapsed.filter((b) => b.retention !== null && b.retention < TARGET_RETENTION);
  const elapsedYear = beyondYear(elapsed);
  const scheduledYear = beyondYear(scheduled);
  const lift = data.longIntervals;
  out.push(
    `<section class="card"><h2>定着率 × 復習間隔 ` +
      `<span class="latin">retention vs interval — Mochi にはないタイル</span></h2>`,
    `<p class="def">横軸は<strong>直前の</strong>復習間隔。境界は views.sql の ` +
      `review_log_bucketed で一度だけ定義され、ここでは名前を並べるだけ。` +
      `<strong>「間隔」には2つの定義があり、この図は両方を描く</strong>：` +
      `<b>実測 elapsed</b>（<code>reviews.elapsed_days</code>＝実際に空いた日数、塗りつぶし）と、` +
      `<b>予定 scheduled</b>（<code>reviews.scheduled_days</code>＝スケジューラが空けるつもりだった日数、破線の中抜き）。` +
      `unknown はその定義での直前間隔が存在しない復習。線は目標 ${TARGET_LABEL}。</p>`,
    intervalRetentionChart(elapsed, scheduled),
    `<h3>各バケットの復習回数（実測 / 予定）</h3>`,
    intervalVolumeChart(elapsed, scheduled),
    `<div class="legend"><span><i style="background:var(--series-1)"></i>実測 elapsed（実際に空いた日数）</span>` +
      `<span><i style="background:var(--series-2)"></i>予定 scheduled（予定していた日数）</span>` +
      `<span>横の実線 = 目標 ${TARGET_LABEL}</span></div>`,
    `<p class="read">読み: 目標 ${TARGET_LABEL} を下回るのは実測で` +
      `${below.length === 0 ? "どのバケットでもない" : `<b>${below.map((b) => esc(b.label)).join("・")}</b> の${int(below.length)}帯だけ`}` +
      `、最も悪い${worst ? ` <b>${esc(worst.label)} で ${pct(worst.retention, 2)}</b>` : ""}。` +
      `それ以外の帯は目標より上、すなわち<b>必要より短い間隔で復習している</b>。` +
      `最長の観測帯 ${longest ? esc(longest.label) : DASH} でも ${pct(longest?.retention ?? null, 2)} で、` +
      `これが「間隔を伸ばす余地がある」という主張の実データ。</p>`,
    `<p class="def"><b>2つの定義が ${esc(BEYOND_YEAR_LABEL)} で完全に食い違う理由</b>。` +
      `実測では ${int(elapsedYear.reviews)}回 / 定着率 ${pct(elapsedYear.retention, 2)}、` +
      `予定では ${int(scheduledYear.reviews)}回。予定が0なのは Mochi が1年より先を予定しなかったからではなく` +
      `（${int(lift.plannedBeyondYear)}回予定しており、最長 ${int(lift.maxPlannedDays)}日）、` +
      `<code>scheduled_days</code> は「直前の復習が予定した間隔」なので、` +
      `<strong>その予定に対応する復習がまだ行われていない</strong>ぶんは集計に現れないため。` +
      `${int(lift.tracksBeyondYear)}件のトラックが1年超で予定されているが、期日は ` +
      `${esc((lift.firstDueAt ?? DASH).slice(0, 10))} 〜 ${esc((lift.lastDueAt ?? DASH).slice(0, 10))} で1件も来ていない。` +
      `だからこのページは<strong>実測を観測値として読む</strong>。BACKTEST.md も同じ基準で採点しており、` +
      `${esc(BEYOND_YEAR_LABEL)} の件数は両方で ${int(elapsedYear.reviews)} で一致する。</p>`,
    `<p class="def"><b>365日の上限は${lift.capLiftedOn === null ? "解除されていない" : `${esc(lift.capLiftedOn)} に解除された`}</b>。` +
      `${lift.capLiftedOn === null ? "" : `それ以前に1年超を予定した復習は0件、以後は ${int(lift.plannedBeyondYear)}件（最長 ${int(lift.maxPlannedDays)}日）。`}` +
      `いま上限ちょうど（${int(MOCHI_INTERVAL_CAP_DAYS)}日）に止まっているトラックは ` +
      `${int(lift.tracksAtCap)} / ${int(lift.tracksWithPlan)}件 = ${pct(lift.tracksAtCap / Math.max(1, lift.tracksWithPlan), 2)}。` +
      `${lift.capLiftedOn === null ? "" : `うち <b>${int(lift.tracksOnStaleCap)}件</b>は最後の復習が解除より前で、` +
        `解除後の Mochi なら選ばなかったはずの古い予定のまま止まっている — これが実際に残っている制約。`}` +
      `ただし実際に経過した最長間隔は ${int(lift.maxObservedElapsedDays)}日なので、` +
      `そこから先はどちらにせよ観測の外側（外挿）になる。</p>`,
    details(
      "バケットごとの数字を表で見る（実測と予定を並べて）",
      table(
        [
          "直前の間隔",
          "実測 復習数",
          "実測 失敗",
          "実測 定着率",
          "実測 平均日数",
          "予定 復習数",
          "予定 定着率",
          "予定 平均日数",
        ],
        elapsed.map((b, i) => {
          const other = scheduled[i] as IntervalBucket | undefined;
          return [
            esc(b.label),
            int(b.reviews),
            int(b.lapses),
            pct(b.retention),
            b.meanIntervalDays === null ? DASH : dec(b.meanIntervalDays, 1),
            int(other?.reviews ?? 0),
            pct(other?.retention ?? null),
            other?.meanIntervalDays == null ? DASH : dec(other.meanIntervalDays, 1),
          ];
        }),
      ),
    ),
    `</section>`,
  );

  // ── per-deck retention — the other tile Mochi lacks
  const spreadDecks = primary.decks.filter(
    (d) => d.directReviews >= 500 && d.directRetention !== null,
  );
  const highest = spreadDecks.reduce<DeckRetention | null>(
    (acc, d) => (acc === null || (d.directRetention ?? 0) > (acc.directRetention ?? 0) ? d : acc),
    null,
  );
  const lowest = spreadDecks.reduce<DeckRetention | null>(
    (acc, d) => (acc === null || (d.directRetention ?? 1) < (acc.directRetention ?? 1) ? d : acc),
    null,
  );
  out.push(
    `<section class="card"><h2>デッキ別定着率 ` +
      `<span class="latin">retention by deck — Mochi にはないタイル</span></h2>`,
    `<p class="def">全体 ${pct(
      totalsAll.retention,
    )} は変動を隠す。ここは直接カードを持つデッキ（そのデッキ自身の復習 ${int(
      deckMin,
    )}回以上）を復習数の多い順に並べ、順方向と逆方向を別の点で描いたもの。` +
      `点も選抜も<strong>そのデッキ自身の復習だけ</strong>で、子デッキを含む小計は表の側にある` +
      `（同じ行に2つの分母を混ぜないため）。2点を結ぶ細線がその差。</p>`,
    `<div class="legend"><span><i style="background:var(--series-1)"></i>順方向 forward</span>` +
      `<span><i style="background:var(--series-2)"></i>逆方向 reverse</span>` +
      `<span>縦の実線 = 目標 ${TARGET_LABEL}</span>` +
      `<span>中抜きの点 = ${int(SMALL_SAMPLE)}回未満（標本が小さい）</span></div>`,
    deckRetentionChart(chartDecks),
    highest && lowest && highest !== lowest
      ? `<p class="read">復習500回以上のデッキで、<b>${esc(highest.path)} ${pct(
          highest.directRetention,
          2,
        )}</b> から <b>${esc(lowest.path)} ${pct(lowest.directRetention, 2)}</b> まで ` +
        `${dec(
          ((highest.directRetention ?? 0) - (lowest.directRetention ?? 0)) * 100,
          2,
        )} ポイントの幅がある。目標定着率がデッキごとの設定であるべき理由がこれ。</p>`
      : "",
    details(
      "全デッキを表で見る",
      table(
        [
          "デッキ",
          "復習数（小計）",
          "復習数（自身）",
          "失敗",
          "定着率（自身）",
          "順方向（自身）",
          "逆方向（自身）",
          "定着率（小計）",
          "時間（小計）",
        ],
        primary.decks.map((d) => [
          esc(d.path),
          int(d.reviews),
          int(d.directReviews),
          int(d.directLapses),
          pct(d.directRetention),
          d.directForwardReviews === 0
            ? DASH
            : `${pct(d.directForwardRetention)} <small>(${int(d.directForwardReviews)})</small>`,
          d.directReverseReviews === 0
            ? DASH
            : `${pct(d.directReverseRetention)} <small>(${int(d.directReverseReviews)})</small>`,
          pct(d.retention),
          dec(d.hours, 1),
        ]),
      ),
    ),
    `</section>`,
  );

  // ── deck progress
  const rootProgress = data.progress.filter((d) => d.depth === 0);
  const tracksTotal = rootProgress.reduce((sum, d) => sum + d.tracks, 0);
  const dormantTotal = rootProgress.reduce((sum, d) => sum + d.dormantTracks, 0);
  out.push(
    `<section class="card"><h2>デッキの進捗 <span class="latin">deck progress</span></h2>`,
    `<p class="def">数えているのはカードではなく<strong>トラック</strong>: 逆方向が有効な` +
      `カードは2トラック。全 ${int(tracksTotal)} トラック。` +
      `未学習 = reps 0、学習中 = 現在の間隔 21日未満、定着 = 21日以上（views.sql の` +
      ` deck_progress の定義そのまま）。休眠（逆方向を後から切ったトラック）は ${int(
        dormantTotal,
      )}件なので描いていない。この図は直接カードを持つデッキのみ、` +
      `トラック ${int(progressMin)}件以上。</p>`,
    `<div class="legend"><span><i style="background:var(--ord-1)"></i>未学習 new</span>` +
      `<span><i style="background:var(--ord-2)"></i>学習中 young &lt; 21d</span>` +
      `<span><i style="background:var(--ord-3)"></i>定着 mature ≥ 21d</span></div>`,
    deckProgressChart(chartProgress),
    details(
      "全デッキを表で見る（小計込み）",
      table(
        ["デッキ", "カード", "トラック", "未学習", "学習中", "定着", "休眠", "失敗回数"],
        data.progress.map((d) => [
          esc(d.path),
          int(d.cards),
          int(d.tracks),
          int(d.newTracks),
          int(d.youngTracks),
          int(d.matureTracks),
          int(d.dormantTracks),
          int(d.lapses),
        ]),
      ),
    ),
    `</section>`,
  );

  // ── 復習予測
  const fc = data.forecast;
  const fcTotal = fc.days.reduce((sum, day) => sum + day.tracks, 0);
  const fcOwn = fc.provenance.mochi + fc.provenance.hashigo;
  out.push(
    `<section class="card"><h2>復習予測 <span class="latin">forecast</span></h2>`,
    `<p class="def">${esc(fc.asOf)} 時点。翌日から ${fc.horizonDays} 日間で ` +
      `<strong>${int(fcTotal)}</strong> 件（1日あたり ${dec(fcTotal / fc.horizonDays, 1)} 件）。` +
      `当日以前に期限が来ている <strong>${int(fc.backlog)}</strong> 件` +
      `（うち ${int(fc.overdue)} 件は前日以前）は棒グラフに含まない — ` +
      `それは予測ではなく残務だから。未学習の ${int(fc.fresh)} 件も予定日を持たないため含まない。</p>`,
    forecastChart(fc),
    `<p class="def"><strong>この棒の出どころ。</strong> 期限が先の ${int(fcOwn)} 件のうち、` +
      `Mochi から取り込んだ予定日が <strong>${int(fc.provenance.mochi)}</strong> 件、` +
      `Hashigo が出した予定日が <strong>${int(fc.provenance.hashigo)}</strong> 件。` +
      `取り込んだトラックは、ここで採点されるまで Mochi の予定日を保持する（意図的）。` +
      `したがってこのグラフは、採点のたびに1件ずつ Hashigo のものになる。</p>`,
    details(
      `日ごとの内訳（${fc.days.length} 日）`,
      table(
        ["日付", "件数"],
        fc.days.map((day) => [esc(day.date), int(day.tracks)]),
      ),
    ),
    `</section>`,
  );

  // ── Mochi reconciliation
  const ours: Record<string, number | null> = {
    reviews: comparison.totals.reviews,
    daysElapsed: comparison.totals.daysElapsed,
    activeDays: comparison.totals.activeDays,
    retention: comparison.totals.retention === null ? null : comparison.totals.retention * 100,
    cardsStudied: comparison.totals.cardsStudied,
  };
  const mochiRows = data.mochi.map((ref) => {
    const value = ours[ref.key] ?? null;
    const exact =
      value !== null &&
      (ref.key === "retention" ? Math.round(value) === ref.mochi : Math.round(value) === ref.mochi);
    const shown = ref.key === "retention" ? pct((value ?? 0) / 100) : int(value);
    const delta = value === null ? DASH : signed(value - ref.mochi, ref.key === "retention" ? 2 : 0);
    return [
      esc(ref.label),
      ref.key === "retention" ? `${int(ref.mochi)}%` : int(ref.mochi),
      shown,
      delta,
      exact ? "一致" : esc(ref.note),
    ];
  });
  // Mochi's review count comes from data.mochi, never a second literal: the
  // reference figure must have exactly one home or the prose and the table can
  // drift apart without any test noticing.
  const mochiReviews = data.mochi.find((r) => r.key === "reviews")?.mochi ?? null;
  const reviewGap = mochiReviews === null ? null : comparison.totals.reviews - mochiReviews;
  const cardDayGap = mochiReviews === null ? null : comparison.totals.cardDays - mochiReviews;
  out.push(
    `<section class="card"><h2>Mochi との照合 ` +
      `<span class="latin">acceptance test · ${esc(comparison.totals.window.label)}</span></h2>`,
    `<p class="def">Mochi 側の数字はユーザのダッシュボードのスクリーンショットから` +
      `（notes/dashboard-reconciliation.md）。<strong>こちらの数字を Mochi に合わせて調整は` +
      `していない。</strong>活動日数と定着率が完全一致することは、窓の取り方とトラックの` +
      `選び方が正しいことを示す。ただし<strong>タイムゾーンの受け入れシグナルではない</strong>` +
      `— この窓では 2026-01-01 と 2025-12-31 のどちらにも復習がないので、日付を JST で切っても` +
      `UTC で切っても 2026 年の数字は 14,420 回 / 211 日で変わらない（測定済み）。JST を実際に` +
      `固定しているのは全期間の初日 ${esc(totalsAll.firstDate ?? DASH)} と最終日 ${esc(
        totalsAll.lastDate ?? DASH,
      )} で、UTC で切ると両方とも1日ずれる。</p>`,
    table(["指標", "Mochi", "Hashigo", "差", "判定"], mochiRows),
    `<p class="read">復習数の差 ${reviewGap === null ? DASH : signed(reviewGap)} 件` +
      `（Mochi 側がこちらより ${
        reviewGap === null ? DASH : pct(reviewGap / comparison.totals.reviews, 1)
      } 少ない）は、インポートの誤りではない — インポートは ${int(
        totalsAll.reviews,
      )} 件でエクスポートとバイト一致している。` +
      `候補となる定義を8つ試して却下した記録が notes/dashboard-reconciliation.md にある。` +
      `最有力は「1日1カード1回として数える」で、この窓では <b>${int(
        comparison.totals.cardDays,
      )}</b> 件 — Mochi の ${int(mochiReviews)} とは ${
        cardDayGap === null ? DASH : signed(cardDayGap)
      } 件ずれる。${
        cardDayGap === null || mochiReviews === null
          ? ""
          : `${pct(Math.abs(cardDayGap) / mochiReviews, 2)} の差を説明できないので、`
      }仮説として書いておくだけにして、` +
      `表示する数字は定義がはっきりしている採点イベント数のままにした。</p>`,
    `</section>`,
  );

  // ── footer
  out.push(
    `<footer>`,
    `<h2>この表の言葉の定義</h2>`,
    `<ul>` +
      `<li><b>復習数</b> — 採点イベントの数。全トラック（順方向・逆方向・cloze）を数える。</li>` +
      `<li><b>学習カード数</b> — 窓の中で1回以上採点されたカードの実数。</li>` +
      `<li><b>活動日数</b> — 1回以上採点した日の数。日付は各復習の tz_offset で切る（UTC ではない）。</li>` +
      `<li><b>日数</b> — 両端を含む。窓の終わりは最後の復習日で止める。</li>` +
      `<li><b>定着率</b> — 合格 / 全採点イベント。</li>` +
      `<li><b>復習時間</b> — duration の合計。所要時間を持たない復習は寄与しない。</li>` +
      `<li><b>直前の間隔</b> — その復習が何日ぶりだったか。Mochi の <code>interval</code> は` +
      `<em>次の</em>間隔なので、インポート時に前のレコードから導出している。</li>` +
      `</ul>`,
    `<h2>このページについて</h2>`,
    `<p>src/dashboard/render.ts が生成。スクリプトなし、外部リクエストなし、フォント読み込み` +
      `なし — 電波を切った端末で file:// から開ける。集計図にはすべて対応する表が付いている` +
      `（年別・月別・バケット別・デッキ別）。<b>例外は活動ヒートマップの日ごとの値で、` +
      `${int(totalsAll.activeDays)}日ぶんあるため表にはせずマスの <code>title</code> に置いた` +
      `— 年別・月別の表がその要約にあたる。</b>色はライト・ダークで別々に選び、` +
      `data-viz バリデータを通してある。</p>`,
    `</footer>`,
    `</main>\n</body>\n</html>\n`,
  );

  return out.join("\n");
}
