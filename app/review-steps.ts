/**
 * WHAT ONE PRESS OF `reveal` DOES — the order Zach asked for, as a plan.
 *
 * ─── HIS REPORT, 2026-09-12 ─────────────────────────────────────────────────
 *
 * *"when you click reveal, it shows the whole thing, the next slide, and the third
 * slide, and every cloze. the correct order should be, each cloze in that slide,
 * once every clozes are shown, the next side and so on. for the reverse, the cloze
 * are still in the same ascending order, just the side reverse."*
 *
 * So a reveal is a STEP, not a switch. This module turns a mounted card into the
 * list of steps, once, at mount time; `main.ts` walks it.
 *
 * ─── THE UNITS, AND WHY THEY ARE NOT ONE-PER-CLOZE ──────────────────────────
 *
 * A hidden side's arrival and its FIRST cloze are one step, not two. Splitting
 * them would mean a press that shows an empty-looking side with every answer on
 * it still masked — a whole tap that changes nothing he can read. Every further
 * cloze on that side is its own step, which is the part he asked for.
 *
 *     単語, Reading = true      side 2 (1 cloze) · side 3 · side 4 (1 cloze)  = 3
 *     単語, Reading = false     side 2's two clozes · side 3 · side 4         = 4
 *
 * **A side with no clozes still earns a step when it carries AUDIO**, even if it
 * is part of the question and already on screen. That is 敬語 and New Vocab —
 * 1,204 cards whose head word is unmasked beside its clip, where the clip is the
 * only answer there is. Before the stepper those sounded because the one-shot
 * reveal picked "the first side with audio"; dropping them here would have made
 * exactly those cards silent, which is the bug this whole change is chasing.
 *
 * A side with no clozes and no audio that is ALREADY on screen earns no step:
 * there is nothing left to do to it.
 *
 * ─── REVERSE IS FREE, AND THAT IS THE POINT OF WORKING IN POSITIONS ─────────
 *
 * The second half of his sentence — *"the cloze are still in the same ascending
 * order, just the side reverse"* — needs no code. Sides arrive here already
 * permuted, keyed by `position` (display order); a side's clozes are in document
 * order within the side, which the permutation never touches. So reverse reverses
 * sides and nothing else, by construction. `test/app-logic.test.ts` pins it
 * anyway, because "by construction" is how it stops being true.
 *
 * NO IMPORTS — the same rule as `./review-boundary.ts` and for the same reason:
 * the root `tsconfig.json` excludes `app/`, so a module with no imports is
 * reachable from `test/` and one that touches `src/render`'s types is not. The
 * shape below is what `main.ts` reduces a `MountedCard` to.
 */

/** One rendered side, reduced to what the ordering actually looks at. */
export interface StepSide {
  /** Display order AFTER the reverse permutation. */
  readonly position: number;
  /** How many clozes are on it, in document order. */
  readonly clozes: number;
  /** How many audio/video mounts are on it. Only zero-or-more matters. */
  readonly audio: number;
  /** It is part of the question, so it is on screen before the first press. */
  readonly prompt: boolean;
}

export interface RevealStep {
  readonly position: number;
  /** Index into that side's clozes, or null for a step that reveals no cloze. */
  readonly cloze: number | null;
  /** This step is what puts the side on screen. */
  readonly show: boolean;
}

/**
 * The steps for one card, in press order.
 *
 * `sides` must be the VISIBLE sides in display order — empty sides are skipped
 * upstream (単語's side 1 is empty whenever `Reading` is false, and a blank screen
 * to tap through is not a side).
 *
 * An empty result is a real answer, not a failure: a card with one plain side and
 * no clip has nothing to step through, and `main.ts` treats the first press as
 * "done" so grading still opens.
 */
export function revealSteps(sides: readonly StepSide[]): RevealStep[] {
  const steps: RevealStep[] = [];
  for (const side of sides) {
    const show = !side.prompt;
    if (side.clozes === 0) {
      if (show || side.audio > 0) steps.push({ position: side.position, cloze: null, show });
      continue;
    }
    for (let index = 0; index < side.clozes; index += 1) {
      steps.push({ position: side.position, cloze: index, show: show && index === 0 });
    }
  }
  return steps;
}
