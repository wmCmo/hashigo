/**
 * WHERE THE QUESTION ENDS AND THE ANSWER BEGINS. THIS RULE HAS BEEN WRONG ONCE, IN
 * FRONT OF HIM, AND IT WAS THE FIRST CARD THE FIRST REAL SESSION SERVED.
 *
 * `NEXT.md` records the failure: a first version took the boundary to be "every side
 * up to the first one that hides or sounds something", and a REVERSE track — order
 * permuted to Meaning → Example → Vocab, whose Example side carries audio — pulled
 * the sentence *"time constraints make it impossible to do everything"* into the
 * question, printing the answer above it.
 *
 * The rule that replaced it is deliberately dumb: **the first non-empty side, plus a
 * following side that carries a widget AND NOTHING ELSE.** It is positional because
 * reverse tracks permute the order, so anything cleverer is reasoning about a layout
 * that the permutation has already moved.
 *
 * The widget exception is 漢字, and only 漢字 today: `<draw>` sits on its own side and
 * has to be on screen while he draws the kanji from memory. A side that carries a
 * widget *and* text is an answer side — that is what "and nothing else" is for.
 *
 * WHY THIS FILE EXISTS, RATHER THAN THE SAME CODE INSIDE `main.ts`. It lived there,
 * in a 1,987-line module with no tests, and `test/` cannot reach `app/main.ts`: the
 * root `tsconfig.json` excludes `app/` on purpose (bundler resolution, `vite/client`
 * types), so a test importing it would drag those requirements into the Node config.
 *
 * So the rule is stated over a STRUCTURAL shape instead of over `RenderResult<
 * HTMLElement>` — four plain fields, no DOM, no imports at all. `main.ts` maps its
 * mounted card into it. That is what makes `test/app-logic.test.ts` possible, and it
 * is why this module imports nothing: it compiles unchanged under the root config
 * (NodeNext) and under `app/tsconfig.json` (bundler), so BOTH gates check it.
 *
 * Do not add an import here. The moment this file needs `./protocol.js` it stops
 * being reachable from `npm run typecheck`, and the tests go with it.
 */

/** One rendered side, reduced to the four things the boundary rule looks at. */
export interface BoundarySide {
  /** Display order AFTER the reverse permutation. What the reader sees. */
  readonly position: number;
  /** Authored side index, BEFORE the permutation. What a widget is keyed on. */
  readonly index: number;
  /** A side the renderer produced nothing for — side 1 of a `Reading = false` 単語. */
  readonly empty: boolean;
  /** `element.textContent`, trimmed by the caller or not; this trims it again. */
  readonly text: string;
}

/**
 * The positions a reader can actually see, in display order.
 *
 * Empty sides are skipped rather than rendered blank, which is why the screen of a
 * `Reading = false` 単語 card starts at side 2: its side 1 body sits entirely inside
 * `<<#Reading>>` and resolves to nothing.
 */
export function visiblePositions(sides: readonly BoundarySide[]): number[] {
  return sides.filter((side) => !side.empty).map((side) => side.position);
}

/**
 * The question. `widgetSideIndexes` are AUTHORED side indexes (`index`, not
 * `position`) because that is how the renderer reports a widget's home.
 *
 * Returns display positions, in order, always starting with the first visible side.
 * An empty card yields an empty question rather than throwing — a card that renders
 * nothing is a data problem for the caller to report, not a crash here.
 */
export function promptPositions(
  sides: readonly BoundarySide[],
  widgetSideIndexes: readonly number[],
): number[] {
  const shown = visiblePositions(sides);
  const first = shown[0];
  if (first === undefined) return [];

  const prompt = [first];
  // `-1` for a widget whose side is missing, so it can never match a real position.
  // Preserved from the original deliberately: a widget pointing at a side that did
  // not render must not silently extend the question.
  const widgetPositions = new Set(
    widgetSideIndexes.map((index) => sides.find((side) => side.index === index)?.position ?? -1),
  );

  for (const position of shown.slice(1)) {
    if (!widgetPositions.has(position)) break;
    const side = sides.find((entry) => entry.position === position);
    // Widget AND nothing else. A side that also carries text is an answer side.
    if (side === undefined || side.text.trim() !== "") break;
    prompt.push(position);
  }
  return prompt;
}
