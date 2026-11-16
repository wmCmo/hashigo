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

for (const [label, stability] of [
  ["young  (S = 10d)", 10],
  ["mature (S = 120d)", 120],
  ["at cap (S = 900d)", 900],
] as const) {
  const difficulty = 5;
  const elapsed = Math.round(interval(stability));
  const r = retrievabilityOf({ stability, difficulty }, elapsed, w);
  const lapsed = fsrs6Step(w, { stability, difficulty }, elapsed, AGAIN, r);

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
