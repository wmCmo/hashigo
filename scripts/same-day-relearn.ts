/**
 * SHOULD A FORGOTTEN CARD COME BACK BEFORE THE SESSION ENDS?
 *
 *   npx vite-node scripts/same-day-relearn.ts -- --db build/hashigo.db
 *
 * Zach asked what the trade-off is and how Mochi and Anki do it.  The useful
 * answer is not Anki lore: HIS OWN LOG ALREADY CONTAINS 6,996 SAME-DAY REVIEWS,
 * so whatever Mochi was doing, he has already lived with it for four years and
 * the outcomes are measured, not modelled.
 *
 * Four questions, in order:
 *
 *   1. Are same-day reviews a LAPSE mechanism, or something else?  If Mochi
 *      re-asked forgotten cards the same day, the review before a same-day one
 *      should overwhelmingly be a failure.
 *   2. Does the re-ask work?  Retention on the second attempt.
 *   3. What happens when he fails twice in one day -- his explicit question.
 *   4. What does it cost per session, in cards.
 */
import { openDatabase } from "../src/db/index.js";

process.stdout.setDefaultEncoding("utf8");
const dbArg = process.argv.indexOf("--db");
const dbPath = dbArg > -1 ? (process.argv[dbArg + 1] as string) : "build/hashigo.db";
const db = openDatabase(dbPath, { readOnly: true, applySchema: false });

// Every review with its predecessor on the same track, in the canonical order
// review_gaps uses: (reviewed_at, id).  Every imported timestamp is date-only,
// so two reviews of one track tie exactly and `id` breaks the tie in export
// order -- which is why this orders by both and not by the timestamp alone.
const SEQ = `
WITH seq AS (
  SELECT r.track_id, r.review_id, r.local_date, r.remembered, r.elapsed_days,
         lag(r.remembered) OVER w AS prev_ok,
         lag(r.local_date) OVER w AS prev_date,
         row_number() OVER w AS n
    FROM review_log_elapsed r
  WINDOW w AS (PARTITION BY r.track_id ORDER BY r.reviewed_at, r.review_id)
)`;

// --- 1. is it a lapse mechanism? -------------------------------------------
const q1 = db
  .prepare(
    `${SEQ}
     SELECT count(*) AS n,
            sum(CASE WHEN prev_ok = 0 THEN 1 ELSE 0 END) AS afterLapse,
            sum(CASE WHEN prev_ok = 1 THEN 1 ELSE 0 END) AS afterPass
       FROM seq WHERE elapsed_days = 0 AND prev_ok IS NOT NULL`,
  )
  .get() as Record<string, number>;

const sameDay = q1.n ?? 0;
const afterLapse = q1.afterLapse ?? 0;
console.log(`\n1. IS A SAME-DAY REVIEW A LAPSE MECHANISM?\n`);
console.log(`   ${sameDay.toLocaleString()} reviews follow another review of the same track on the SAME DAY`);
console.log(
  `     the one before it was a FAILURE   ${String(afterLapse).padStart(6)}   ` +
    `${((afterLapse / Math.max(1, sameDay)) * 100).toFixed(1)}%`,
);
console.log(
  `     the one before it was a PASS      ${String(q1.afterPass ?? 0).padStart(6)}   ` +
    `${(((q1.afterPass ?? 0) / Math.max(1, sameDay)) * 100).toFixed(1)}%`,
);

// --- 2. does the re-ask work? ----------------------------------------------
const q2 = db
  .prepare(
    `${SEQ}
     SELECT sum(CASE WHEN prev_ok = 0 AND remembered = 1 THEN 1 ELSE 0 END) AS recovered,
            sum(CASE WHEN prev_ok = 0 THEN 1 ELSE 0 END) AS retries
       FROM seq WHERE elapsed_days = 0 AND prev_ok IS NOT NULL`,
  )
  .get() as Record<string, number>;

const retries = q2.retries ?? 0;
console.log(`\n2. DOES THE SAME-DAY RE-ASK ACTUALLY WORK?\n`);
console.log(
  `   of ${retries.toLocaleString()} same-day retries after a failure, ` +
    `${(q2.recovered ?? 0).toLocaleString()} were remembered — ` +
    `${(((q2.recovered ?? 0) / Math.max(1, retries)) * 100).toFixed(1)}%`,
);

// --- 3. failing twice in one day -------------------------------------------
//
// His explicit question: "what happens if we also can't get it right the second
// time".  Count runs of consecutive failures inside one local day.
const q3 = db
  .prepare(
    `WITH seq AS (
       SELECT r.track_id, r.local_date, r.remembered,
              row_number() OVER (PARTITION BY r.track_id, r.local_date
                                 ORDER BY r.reviewed_at, r.review_id) AS n
         FROM review_log_elapsed r
     )
     SELECT local_date, track_id, count(*) AS attempts,
            sum(CASE WHEN remembered = 0 THEN 1 ELSE 0 END) AS fails
       FROM seq GROUP BY track_id, local_date HAVING attempts > 1`,
  )
  .all() as { local_date: string; track_id: number; attempts: number; fails: number }[];

const multi = q3.length;
const twoPlusFails = q3.filter((r) => r.fails >= 2).length;
const threePlus = q3.filter((r) => r.attempts >= 3).length;
console.log(`\n3. WHAT HAPPENS WHEN THE SECOND ATTEMPT ALSO FAILS?\n`);
console.log(`   ${multi.toLocaleString()} (track, day) pairs saw more than one attempt`);
console.log(
  `     failed TWICE or more in the same day   ${String(twoPlusFails).padStart(6)}   ` +
    `${((twoPlusFails / Math.max(1, multi)) * 100).toFixed(1)}% of them`,
);
console.log(
  `     needed 3+ attempts in one day          ${String(threePlus).padStart(6)}   ` +
    `${((threePlus / Math.max(1, multi)) * 100).toFixed(1)}% of them`,
);
const worst = q3.reduce((m, r) => Math.max(m, r.attempts), 0);
console.log(`     most attempts ever on one card in one day   ${worst}`);

// --- 4. what does it cost per session? -------------------------------------
const q4 = db
  .prepare(
    `SELECT count(DISTINCT local_date) AS days,
            count(*) AS reviews,
            sum(CASE WHEN remembered = 0 THEN 1 ELSE 0 END) AS lapses
       FROM review_log_elapsed`,
  )
  .get() as Record<string, number>;

const days = q4.days ?? 1;
console.log(`\n4. WHAT IT COSTS\n`);
console.log(
  `   ${(q4.reviews ?? 0).toLocaleString()} reviews over ${days.toLocaleString()} active days ` +
    `= ${((q4.reviews ?? 0) / days).toFixed(1)}/day`,
);
console.log(
  `   ${(q4.lapses ?? 0).toLocaleString()} lapses = ${((q4.lapses ?? 0) / days).toFixed(1)}/day, ` +
    `so a re-ask-every-lapse rule adds about that many cards to a session`,
);
console.log(
  `   already-happening same-day retries: ${(afterLapse / days).toFixed(1)}/day, ` +
    `which is ${((afterLapse / Math.max(1, q4.lapses ?? 1)) * 100).toFixed(0)}% of lapses\n`,
);
db.close();
