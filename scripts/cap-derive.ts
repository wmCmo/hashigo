/**
 * WHERE SHOULD THE MAXIMUM INTERVAL BE, AND SHOULD THERE BE ONE AT ALL?
 *
 *   npx vite-node scripts/cap-derive.ts -- --db build/hashigo.db
 *
 * Zach's question, 2026-08-22: "365 days was a default number from mochi
 * flashcards, and I just accepted it as a good number because it's a year, but I
 * didn't derive it.  Are we supposed to have a max date at all?"
 *
 * A fair question, because `BACKTEST.md` shows MOCHI ITSELF LIFTED that cap on
 * 2026-02-22 and has since planned intervals up to 2,707 days.  So 365 is not
 * the source app's number any more either.
 *
 * Three sections, three separate questions:
 *
 *   A. Zach's Math.min proposal -- fuzz two-sided, then clamp back to the cap.
 *      The number to watch is not the worst day but how many tracks land on
 *      EXACTLY the cap, because each of those is back in the clump.
 *   B. Where does OBSERVATION run out?  A cap's only honest job is to stop the
 *      model extrapolating past its evidence, so this asks where the evidence
 *      ends rather than where a calendar year does.
 *   C. What each candidate cap costs in reviews per year.
 */
import { openDatabase } from "../src/db/index.js";
import { fsrs6NextInterval } from "../src/scheduler/algorithms/fsrs6.js";
import {
  INTERVAL_FUZZ,
  MAX_INTERVAL_DAYS,
  SCHEDULER_PARAMETERS,
  TARGET_RETENTION,
} from "../src/scheduler/policy.js";
import { fuzzFactor, seedMemory } from "../src/scheduler/schedule.js";
import { trackObservations } from "../src/scheduler/tracks.js";

process.stdout.setDefaultEncoding("utf8");
const dbArg = process.argv.indexOf("--db");
const dbPath = dbArg > -1 ? (process.argv[dbArg + 1] as string) : "build/hashigo.db";
const todayArg = process.argv.indexOf("--today");
const today =
  todayArg > -1 ? (process.argv[todayArg + 1] as string) : new Date().toISOString().slice(0, 10);
const db = openDatabase(dbPath, { readOnly: true, applySchema: false });

const MS_PER_DAY = 86_400_000;
const dayNumber = (d: string): number => Math.round(Date.parse(`${d}T00:00:00Z`) / MS_PER_DAY);

interface Row {
  track_id: number;
  due: string;
  sched: number;
}

const rows = db
  .prepare(
    `SELECT t.id AS track_id, substr(t.due_at, 1, 10) AS due, coalesce(t.scheduled_days, 0) AS sched
       FROM card_tracks t JOIN cards c ON c.id = t.card_id
      WHERE t.dormant = 0 AND c.archived = 0 AND t.due_at IS NOT NULL
        AND substr(t.due_at, 1, 10) > ?`,
  )
  .all(today) as Row[];

function spread(shift: (row: Row) => number): { worst: number; cv: number } {
  const byDay = new Map<number, number>();
  for (const row of rows) {
    const day = dayNumber(row.due) + shift(row);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const counts = [...byDay.values()];
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length);
  return { worst: Math.max(...counts), cv: sd / mean };
}

// --- A. the Math.min proposal ----------------------------------------------
console.log(`\nA. TWO-SIDED FUZZ, THEN CLAMPED BACK TO THE CAP - as of ${today}`);
console.log(`   ${rows.length} live scheduled tracks\n`);

// THE COHORT THAT MATTERS is the one sitting on exactly the cap -- that is the
// clump fuzz exists to break.  Counting "tracks that end on exactly 365d" is
// the honest measure of whether a scheme breaks it, because a track shoved back
// onto the cap by a re-clamp has not been spread at all.
const atCap = rows.filter((row) => row.sched === MAX_INTERVAL_DAYS);

const report = (label: string, shift: (row: Row) => number): void => {
  const s = spread(shift);
  const landsOnCap = atCap.filter((row) => shift(row) === 0).length;
  console.log(
    `   ${label.padEnd(38)} worst ${String(s.worst).padStart(4)}   CV ${s.cv.toFixed(2)}` +
      `   of ${atCap.length} at the cap, ${String(landsOnCap).padStart(4)} still land on it`,
  );
};

report("no fuzz", () => 0);
report(`two-sided +/-${INTERVAL_FUZZ * 100}% (in the code now)`, (row) =>
  Math.round(row.sched * fuzzFactor(row.track_id)),
);
report("two-sided +/-5%, then min(., 365)", (row) => {
  const shifted = Math.round(row.sched * fuzzFactor(row.track_id));
  return Math.min(row.sched + shifted, MAX_INTERVAL_DAYS) - row.sched;
});
report("downward-only, 10% width", (row) => {
  const f = fuzzFactor(row.track_id, 0.1);
  return Math.round(row.sched * (row.sched >= MAX_INTERVAL_DAYS ? -Math.abs(f) : f));
});

// --- B. where does observation run out? ------------------------------------
console.log(`\nB. WHERE THE EVIDENCE ENDS - measured elapsed gaps\n`);

const tail = db
  .prepare(
    `SELECT count(*) AS n,
            sum(CASE WHEN elapsed_days > 300 THEN 1 ELSE 0 END) AS over300,
            sum(CASE WHEN elapsed_days > 365 THEN 1 ELSE 0 END) AS over365,
            sum(CASE WHEN elapsed_days > 400 THEN 1 ELSE 0 END) AS over400,
            sum(CASE WHEN elapsed_days > 454 THEN 1 ELSE 0 END) AS over454,
            max(elapsed_days) AS longest
       FROM reviews WHERE elapsed_days IS NOT NULL`,
  )
  .get() as Record<string, number>;

const totalGaps = tail.n ?? 0;
const longestGap = tail.longest ?? 0;
console.log(`   ${totalGaps.toLocaleString()} reviews carry a measured elapsed interval`);
for (const [label, key] of [
  ["longer than 300d", "over300"],
  ["longer than 365d", "over365"],
  ["longer than 400d", "over400"],
  ["longer than 454d", "over454"],
] as const) {
  const v = tail[key] ?? 0;
  console.log(
    `     ${label.padEnd(18)} ${String(v).padStart(6)}   ${((v / totalGaps) * 100).toFixed(3)}%`,
  );
}
console.log(`   longest gap ever measured: ${longestGap}d\n`);

const buckets = db
  .prepare(
    `SELECT CASE
              WHEN elapsed_days <= 365 THEN '181-365d'
              WHEN elapsed_days <= 400 THEN '366-400d'
              WHEN elapsed_days <= 454 THEN '401-454d'
              ELSE 'over 454d' END AS bucket,
            count(*) AS n, sum(remembered) AS ok, round(avg(elapsed_days), 1) AS mean
       FROM reviews WHERE elapsed_days > 180 GROUP BY bucket ORDER BY mean`,
  )
  .all() as { bucket: string; n: number; ok: number; mean: number }[];

console.log(`   bucket        reviews   retention   mean gap`);
for (const b of buckets) {
  console.log(
    `   ${b.bucket.padEnd(12)} ${String(b.n).padStart(7)}   ` +
      `${((b.ok / b.n) * 100).toFixed(2).padStart(8)}%   ${String(b.mean).padStart(7)}d`,
  );
}

// THE CENSORING CHECK, and it decides how much the 454d edge is worth.
//
// Mochi capped its own intervals at 365d until 2026-02-22.  So if every gap
// longer than 365 days came from a 365-day PLAN that he was simply late on,
// then 454d is not a fact about his memory at 454 days -- it is Mochi's cap plus
// his lateness.  There would then be no evidence about 500d or 900d at all,
// and no amount of this corpus can produce any.
const late = db
  .prepare(
    `SELECT count(*) AS n,
            sum(CASE WHEN scheduled_days IS NULL THEN 1 ELSE 0 END) AS noplan,
            sum(CASE WHEN scheduled_days <= 365 THEN 1 ELSE 0 END) AS fromCapOrLess,
            sum(CASE WHEN scheduled_days > 365 THEN 1 ELSE 0 END) AS fromBeyond,
            max(scheduled_days) AS longestPlan
       FROM reviews WHERE elapsed_days > 365`,
  )
  .get() as Record<string, number>;

console.log(`\n   Of the ${late.n} gaps longer than 365d, what interval was PLANNED?`);
console.log(`     planned <= 365d (so: he was LATE)   ${late.fromCapOrLess}`);
console.log(`     planned  > 365d (real long plan)    ${late.fromBeyond}`);
console.log(`     no plan recorded                    ${late.noplan}`);
console.log(`     longest plan behind any of them     ${late.longestPlan ?? 0}d`);
console.log(
  late.fromBeyond === 0
    ? `   => EVERY gap past a year is lateness against a <=365d plan. The 454d edge is\n` +
        `      Mochi's cap plus his lateness, NOT evidence about memory at 454 days.\n` +
        `      There is no evidence past the cap, and this corpus cannot produce any.`
    : `   => ${late.fromBeyond} of them came from a genuinely longer plan.`,
);

// --- C. what each candidate cap costs -------------------------------------
console.log(`\nC. WHAT EACH CANDIDATE CAP COSTS\n`);

const ids = db
  .prepare(
    `SELECT t.id FROM card_tracks t JOIN cards c ON c.id = t.card_id
      WHERE t.dormant = 0 AND c.archived = 0 AND t.reps > 0 ORDER BY t.id`,
  )
  .all() as { id: number }[];

const raw: number[] = [];
for (const { id } of ids) {
  const memory = seedMemory(trackObservations(db, id));
  if (memory !== null) {
    raw.push(fsrs6NextInterval(SCHEDULER_PARAMETERS, memory.stability, TARGET_RETENTION));
  }
}
raw.sort((a, b) => a - b);
const at = (p: number): number => raw[Math.floor((raw.length - 1) * p)] as number;

console.log(`   ${raw.length} live tracks seeded, asked what they want at retention ${TARGET_RETENTION}:`);
console.log(
  `     p50 ${at(0.5).toFixed(0)}d - p75 ${at(0.75).toFixed(0)}d - p90 ${at(0.9).toFixed(0)}d - ` +
    `p99 ${at(0.99).toFixed(0)}d - max ${(raw.at(-1) ?? 0).toFixed(0)}d\n`,
);

// A track on interval i contributes 365/i reviews a year.  Capping LOWERS
// intervals, so it RAISES this number: the cap's cost is extra reviews.
const loadPerYear = (cap: number): number =>
  raw.reduce((sum, want) => sum + 365 / Math.max(1, Math.min(want, cap)), 0);
const uncapped = loadPerYear(Number.POSITIVE_INFINITY);

// The evidence column keys off the longest PLAN (365d), not the longest GAP
// (454d).  Section B's censoring check is why: every gap past a year is
// lateness against a <=365d request, so a 454d cap is no better evidenced than
// a 500d one.  Both are extrapolation; only the amount differs.
const LONGEST_PLAN = 365;
console.log(`   cap        clipped tracks       reviews/yr   vs none   extrapolation past any PLAN`);
for (const cap of [365, 400, 454, 500, 730, 1095, Number.POSITIVE_INFINITY]) {
  const clipped = raw.filter((r) => r > cap).length;
  const load = loadPerYear(cap);
  const label = Number.isFinite(cap) ? `${cap}d` : "none";
  const evidence = !Number.isFinite(cap)
    ? `unbounded - out to ${(raw.at(-1) ?? 0).toFixed(0)}d`
    : cap > LONGEST_PLAN
      ? `+${cap - LONGEST_PLAN}d (${((cap / LONGEST_PLAN - 1) * 100).toFixed(0)}% beyond)`
      : "none - inside every plan ever made";
  console.log(
    `   ${label.padEnd(9)} ${String(clipped).padStart(6)} (${((clipped / raw.length) * 100).toFixed(1).padStart(4)}%)   ` +
      `${load.toFixed(0).padStart(10)}   ${(((load - uncapped) / uncapped) * 100).toFixed(1).padStart(6)}%   ${evidence}`,
  );
}
console.log("");
db.close();
