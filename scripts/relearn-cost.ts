/**
 * IF A FORGOTTEN CARD COMES BACK THE SAME DAY, WHAT DOES THAT DO TO THE SCHEDULE?
 *
 *   npx vite-node scripts/relearn-cost.ts
 *
 * Zach's question, 2026-08-22: "we'll come to a question whether reviewing at the
 * end of the session would affect the scheduler, and what happens if we also
 * can't get it right the second time."
 *
 * It is answerable exactly, because FSRS-6 has a separate SHORT-TERM branch for
 * delta_t == 0 (`stabilityShortTerm`, driven by w17/w18/w19) and this project
 * feeds the model WHOLE LOCAL DAYS -- so a same-day re-ask arrives as a 0-day
 * observation and takes that branch by construction.
 *
 * Three arms, from one lapsed state:
 *
 *   A. lapse only, no re-ask                     (what the code does today)
 *   B. lapse, re-ask same day, PASSED
 *   C. lapse, re-ask same day, FAILED AGAIN      -- his second question
 *
 * The parameters are the shipped fitted set, so these are this scheduler's real
 * numbers rather than FSRS defaults.
 */
import { fsrs6NextInterval, fsrs6Step } from "../src/scheduler/algorithms/fsrs6.js";
import { BINARY_GRADE } from "../src/schema/index.js";
import { SCHEDULER_PARAMETERS, TARGET_RETENTION } from "../src/scheduler/policy.js";
import { retrievabilityOf } from "../src/scheduler/schedule.js";

process.stdout.setDefaultEncoding("utf8");
const w = SCHEDULER_PARAMETERS;
const AGAIN = BINARY_GRADE.forgot;
const GOOD = BINARY_GRADE.remembered;

const interval = (stability: number): number =>
  fsrs6NextInterval(w, stability, TARGET_RETENTION);

console.log(`\nparameters: shipped fitted set · target retention ${TARGET_RETENTION}`);
console.log(`grades: forgot = ${AGAIN}, remembered = ${GOOD} (binary, by design)\n`);

// A few starting points spanning the collection: a young card, a typical mature
// one, and one at the cap.
for (const [label, stability] of [
  ["young  (S = 10d)", 10],
  ["mature (S = 120d)", 120],
  ["at cap (S = 900d)", 900],
] as const) {
  const difficulty = 5;
  // The lapse itself: reviewed at its own due interval, so r is the target.
  const elapsed = Math.round(interval(stability));
  const r = retrievabilityOf({ stability, difficulty }, elapsed, w);
  const lapsed = fsrs6Step(w, { stability, difficulty }, elapsed, AGAIN, r);

  // A. no re-ask. B/C: one same-day observation on top.
  const passed = fsrs6Step(w, lapsed, 0, GOOD, retrievabilityOf(lapsed, 0, w));
  const failed = fsrs6Step(w, lapsed, 0, AGAIN, retrievabilityOf(lapsed, 0, w));

  console.log(`${label}   lapses at ${elapsed}d (r = ${(r * 100).toFixed(1)}%)`);
  for (const [arm, state] of [
    ["A. no same-day re-ask", lapsed],
    ["B. re-asked, PASSED", passed],
    ["C. re-asked, FAILED again", failed],
  ] as const) {
    const next = interval(state.stability);
    const delta = ((next / interval(lapsed.stability) - 1) * 100).toFixed(1);
    console.log(
      `   ${arm.padEnd(28)} S ${state.stability.toFixed(2).padStart(8)}d  ` +
        `D ${state.difficulty.toFixed(2)}  -> next interval ${next.toFixed(1).padStart(6)}d` +
        `  (${delta.startsWith("-") ? "" : "+"}${delta}% vs A)`,
    );
  }
  console.log("");
}

console.log(
  `READ IT THIS WAY. Arm B is the cost of BELIEVING a same-day pass: the model\n` +
    `treats "recalled after zero days" as evidence and lengthens the interval, on a\n` +
    `card he had just failed. Arm C is what a second failure does. If neither\n` +
    `movement is one you want, the fix is not a different branch -- it is to SHOW\n` +
    `the card again without GRADING it, which leaves the schedule at arm A.\n`,
);
