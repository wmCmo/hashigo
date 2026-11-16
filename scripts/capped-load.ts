import { openDatabase } from "../src/db/index.js";
import { erase } from "../src/scheduler/algorithms/index.js";
import {
  fsrs6,
  FSRS6_DEFAULT_PARAMETERS,
  FSRS6_FITTED_PARAMETERS,
} from "../src/scheduler/algorithms/fsrs6.js";
import { loadHistory, measureRecentLoad, measureRelearningCost } from "../src/scheduler/backtest.js";

const dbArg = process.argv.indexOf("--db");
const dbPath = dbArg > -1 ? (process.argv[dbArg + 1] as string) : "build/hashigo.db";

const db = openDatabase(dbPath, { readOnly: true });
const tracks = loadHistory(db);
const live = tracks.filter((t) => t.dormant === 0 && t.archived === 0);
const relearningCost = measureRelearningCost(tracks);
const recent = measureRecentLoad(db, 90);

const CORRECTION = 1.27;

const CANDIDATES = [
  { name: "FSRS-6 fitted", c: erase(fsrs6(FSRS6_FITTED_PARAMETERS)) },
  { name: "FSRS-6 stock ", c: erase(fsrs6(FSRS6_DEFAULT_PARAMETERS)) },
];
const TARGETS = [0.85, 0.9, 0.95];
const CAPS = [365, 730, Infinity];

function project(candidate: (typeof CANDIDATES)[number]["c"], target: number, cap: number) {
  const intervals: number[] = [];
  let perDay = 0;
  let clippedByCap = 0;
  for (const track of live) {
    const raw = candidate.intervalAfter(track.reviews, target);
    if (raw === null || !Number.isFinite(raw)) continue;
    const capped = Math.min(cap, Math.max(1, raw));
    if (raw > cap) clippedByCap++;
    intervals.push(capped);
    perDay += 1 / capped;
  }
  intervals.sort((a, b) => a - b);
  const median = intervals[intervals.length >> 1] as number;
  const withRelearn = perDay * (1 + (1 - target) * relearningCost);
  return {
    tracks: intervals.length,
    median,
    perDay: withRelearn,
    corrected: withRelearn * CORRECTION,
    clippedPct: (100 * clippedByCap) / intervals.length,
  };
}

console.log(`live tracks ${live.length}  relearning cost ${relearningCost.toFixed(2)}`);
console.log(`measured load, last ${recent.days} active days: ${recent.reviewsPerDay.toFixed(1)} reviews/day\n`);
console.log("cap    target  median      reviews/day   vs today   % clipped by cap");
console.log("-".repeat(72));
for (const cap of CAPS) {
  for (const target of TARGETS) {
    const rows = CANDIDATES.map((k) => project(k.c, target, cap));
    const lo = Math.min(...rows.map((r) => r.corrected));
    const hi = Math.max(...rows.map((r) => r.corrected));
    const medLo = Math.min(...rows.map((r) => r.median));
    const medHi = Math.max(...rows.map((r) => r.median));
    const clip = rows.map((r) => r.clippedPct);
    const label = cap === Infinity ? "none " : `${cap}d`.padEnd(5);
    console.log(
      `${label}  ${(target * 100).toFixed(0)}%     ` +
        `${medLo.toFixed(0)}-${medHi.toFixed(0)}d`.padEnd(12) +
        `${lo.toFixed(0)}-${hi.toFixed(0)}`.padEnd(14) +
        `${(lo / recent.reviewsPerDay).toFixed(2)}-${(hi / recent.reviewsPerDay).toFixed(2)}x`.padEnd(11) +
        `${Math.min(...clip).toFixed(0)}-${Math.max(...clip).toFixed(0)}%`,
    );
  }
  console.log();
}
