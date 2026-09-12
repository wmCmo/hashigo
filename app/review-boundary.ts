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
 *
 * ─── IT CARRIES TWO RULES NOW, AND `sideScale` IS THE SECOND ────────────────
 *
 * Both answer the same kind of question — what does the SCREEN make of a rendered
 * side — over the same `BoundarySide` shape, and both were wrong in a way only a
 * human looking at a real card could catch. They live together for that reason.
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

// ── how big the text on a side should be ──────────────────────────────────────

/**
 * TYPE SIZE FOLLOWS THE CONTENT, NOT THE POSITION.
 *
 * ─── ZACH, 2026-09-12, WITH A SCREENSHOT OF A REVERSE 単語 TRACK ────────────
 *
 * *"this ui is kinda funny, i think it's correct that the 漢字 has the big text
 * because it's short, but when it's reverse, why is 漢字 small and the definition
 * big...? this is super ugly lol"*
 *
 * He is right twice and the second half is the interesting one. The old rule was
 * **positional** — `main.ts` marked the QUESTION side `.drill` and the stylesheet
 * set that side to `clamp(26px, 7vw, 40px)`. On a forward track the question is
 * the head word, which is one to three characters, so the rule looked like a
 * typographic decision. It was not: it was "the first side is big", and a reverse
 * track puts a six-synonym English definition there.
 *
 * **And it made the kanji small.** On a reverse track the word sits on a LATER
 * side, which was body text — so the one thing on the card that earns display type
 * was the one thing not getting it.
 *
 * His own sentence states the correct rule: *"because it's short"*. So it is
 * measured length, applied to EVERY side in both directions, and reverse then
 * needs no special case at all.
 *
 * ─── THE THRESHOLDS ARE MEASURED, over 1,200 cards in both directions ───────
 *
 * Rendered `textContent` length of the QUESTION side, by template:
 *
 * ```
 *                        p10   p50   p90   max
 *   単語      forward       2    12    18    26
 *   単語      reverse      28    60   155  1027
 *   漢字      forward       1     1     1     1
 *   漢字      reverse      54    75   100   147
 *   言葉      forward       8    11    14    16
 *   言葉      reverse      29    81   180   464
 *   New Vocab forward       4     7    10    20
 *   New Vocab reverse      34    61   107   168
 *   基本情報   forward      26    41    72   170   <- already too long, already big
 * ```
 *
 * The gap between the two groups is wide and real: every forward vocabulary
 * prompt fits in 26 characters, and 90% of reverse prompts start at 28. **`28`
 * therefore separates them with nothing sitting on the line** — it is not a round
 * number picked to look principled.
 *
 * **基本情報 forward is the reason this is a LENGTH rule and not a DIRECTION
 * rule.** Its forward prompts run to 170 characters and have been rendering at
 * 40px this whole time, in the direction the old rule assumed was safe. He has
 * not complained about that deck yet; the rule that fixes reverse fixes it too.
 *
 * `mid` exists so the fall is not a cliff — a 40-character definition at body size
 * beside a 40px head word reads as two different cards.
 */
export type SideScale = "display" | "mid" | "body";

/**
 * Counted in CODE POINTS, not UTF-16 units — `[...text].length`, so 𠮟 counts
 * once. A surrogate pair counted twice would push short kanji prompts a bucket
 * down, which is precisely the direction that hurts.
 */
export function sideScale(text: string): SideScale {
  const length = [...text.trim().replace(/\s+/g, " ")].length;
  if (length <= 28) return "display";
  if (length <= 64) return "mid";
  return "body";
}
