/**
 * Interval fuzz: does it actually unstack the schedule, and which way round does
 * it have to go?
 *
 *   npx vite-node scripts/fuzz-load.ts -- --db build/hashigo.db
 *
 * Two sections, answering two different questions. `src/scheduler/policy.ts`
 * quotes both, so re-run this rather than trusting the numbers in that comment.
 *
 * SECTION 1 — HOW MUCH DOES FUZZ SPREAD THE CLUMP, AND HOW MUST IT BE KEYED?
 *
 * Basis, stated because the number moves with it: every LIVE SCHEDULED track
 * (`dormant = 0`, card not archived, due strictly after today), shifted by
 * ±width of ITS OWN planned interval, grouped by local due date. That is the
 * question "if fuzz had been applied when each of these plans was made, what
 * would the coming year look like". It is a projection over existing plans, not
 * a replay — fuzz applies at grade time and cannot move a due date already set.
 *
 * The keying rows are the point. Per COHORT — every track sharing a due date, or
 * an interval value, getting the SAME shift — translates the clump rather than
 * spreading it, and two translated clumps can land on one day. It measures worse
 * than no fuzz at all, which is why it is in this script rather than in a
 * paragraph.
 *
 * SECTION 2 — BEFORE OR AFTER THE CAP?
 *
 * Seeds every live track from its own review history through the shipped FSRS-6
 * parameters and asks what interval the model wants at the settled target. The
 * question it answers: of the tracks the 365-day cap clips, how many could a −5%
 * fuzz applied BEFORE the cap pull back under it? If a track wants more than
 * 365 / 0.95 = 384 days, the answer is none — it clamps straight back onto
 * exactly 365 and the spike survives untouched.
 *
 * This is the measurement behind `FUZZ_MAY_EXCEED_MAX_INTERVAL`, and it is the
 * reason an interval this app issues can reach 383 days.
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
const today = todayArg > -1 ? (process.argv[todayArg + 1] as string) : new Date().toISOString().slice(0, 10);

const db = openDatabase(dbPath, { readOnly: true, applySchema: false });

// ─── section 1: the spread ───────────────────────────────────────────────────

interface Row {
  track_id: number;
  due: string;
  sched: number;
}

const rows = db
  .prepare(
    `SELECT t.id AS track_id, substr(t.due_at, 1, 10) AS due,
            coalesce(t.scheduled_days, 0) AS sched
       FROM card_tracks t JOIN cards c ON c.id = t.card_id
      WHERE t.dormant = 0 AND c.archived = 0 AND t.due_at IS NOT NULL
        AND substr(t.due_at, 1, 10) > ?`,
  )
  .all(today) as Row[];

const MS_PER_DAY = 86_400_000;
const dayNumber = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY);

function spread(shift: (row: Row) => number): { worst: number; cv: number; days: number } {
  const byDay = new Map<number, number>();
  for (const row of rows) {
    const day = dayNumber(row.due) + shift(row);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const counts = [...byDay.values()];
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length);
  return { worst: Math.max(...counts), cv: sd / mean, days: counts.length };
}

const line = (label: string, shift: (row: Row) => number): void => {
  const s = spread(shift);
  console.log(`  ${label.padEnd(34)} worst ${String(s.worst).padStart(4)}   CV ${s.cv.toFixed(2)}   days ${s.days}`);
};

const atCap = rows.filter((row) => row.sched === MAX_INTERVAL_DAYS).length;
console.log(
  `\nSECTION 1 — spread, as of ${today}\n` +
    `  ${rows.length} live scheduled tracks · ${atCap} (${((atCap / rows.length) * 100).toFixed(1)}%) ` +
    `planned at exactly ${MAX_INTERVAL_DAYS}d\n`,
);
line("no fuzz (baseline)", () => 0);
line(`±${INTERVAL_FUZZ * 100}% keyed per TRACK`, (row) => Math.round(row.sched * fuzzFactor(row.track_id)));
line("  ... downward only at the cap", (row) => {
  const f = fuzzFactor(row.track_id);
  return Math.round(row.sched * (row.sched >= MAX_INTERVAL_DAYS ? -Math.abs(f) : f));
});
// REVIEWER'S QUESTION: the two-sided +/-5% option widens the window to
// [347, 383] = 36 days, and buys its spread with 18 days ABOVE the cap. A
// DOWNWARD-ONLY fuzz of twice the width gives [329, 365] -- the same 36-day
// window -- while leaving 365 a hard ceiling. Does it spread as well?
for (const w of [0.05, 0.075, 0.1, 0.15]) {
  line(`  ... downward only, width ${(w * 100).toFixed(1)}%`, (row) => {
    const f = fuzzFactor(row.track_id, w);
    return Math.round(row.sched * (row.sched >= MAX_INTERVAL_DAYS ? -Math.abs(f) : f));
  });
}
line("keyed per COHORT (due date)", (row) => Math.round(row.sched * fuzzFactor(dayNumber(row.due))));
line("keyed per COHORT (interval)", (row) => Math.round(row.sched * fuzzFactor(Math.round(row.sched))));

console.log("");
for (const width of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08]) {
  line(`width ±${(width * 100).toFixed(0)}%, per track`, (row) =>
    Math.round(row.sched * fuzzFactor(row.track_id, width)),
  );
}

// ─── section 2: the cap order ────────────────────────────────────────────────

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

const overCap = raw.filter((r) => r > MAX_INTERVAL_DAYS);
const unmoveable = MAX_INTERVAL_DAYS / (1 - INTERVAL_FUZZ);
const pinned = raw.filter((r) => r > unmoveable);

console.log(`\nSECTION 2 — before or after the cap, as of ${today}\n`);
console.log(`  ${raw.length} live tracks with history, seeded and asked for an interval at ${TARGET_RETENTION}`);
console.log(
  `  p10 ${at(0.1).toFixed(0)}d · p25 ${at(0.25).toFixed(0)}d · median ${at(0.5).toFixed(0)}d · ` +
    `p75 ${at(0.75).toFixed(0)}d · p90 ${at(0.9).toFixed(0)}d · max ${(raw.at(-1) ?? 0).toFixed(0)}d`,
);
console.log(
  `  over the ${MAX_INTERVAL_DAYS}d cap: ${overCap.length} (${((overCap.length / raw.length) * 100).toFixed(1)}%)`,
);
console.log(
  `  over ${unmoveable.toFixed(0)}d, so UNMOVEABLE by a -${INTERVAL_FUZZ * 100}% fuzz applied BEFORE the cap: ` +
    `${pinned.length} (${((pinned.length / Math.max(1, overCap.length)) * 100).toFixed(1)}% of the capped set)`,
);
console.log(
  `\n  => fuzz before the cap leaves ${pinned.length} tracks on exactly ${MAX_INTERVAL_DAYS}d.\n` +
    `     fuzz after the cap spreads all ${overCap.length} over ` +
    `${Math.round(MAX_INTERVAL_DAYS * (1 - INTERVAL_FUZZ))}..${Math.round(MAX_INTERVAL_DAYS * (1 + INTERVAL_FUZZ))}d, ` +
    `which is why it is applied after.\n`,
);

db.close();
