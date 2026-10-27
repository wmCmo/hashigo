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
 * The rule that replaced it is deliberately dumb: **the first non-empty side, and
 * nothing else.** It is positional because reverse tracks permute the order, so
 * anything cleverer is reasoning about a layout that the permutation has already
 * moved.
 *
 * ─── IT CARRIED AN EXCEPTION UNTIL 2026-09-14, AND THE EXCEPTION WAS MINE ───
 *
 * The rule used to extend over "a following side that carries a widget AND NOTHING
 * ELSE" — which was 漢字 and only 漢字, so that `<draw>` was on screen while he drew
 * the kanji from memory. That reasoning sounds right and was never his. It arrived
 * in the stage-9 shell commit (`16afee6`), was recorded in no decision, and rested
 * on an agent's guess about what the canvas needs.
 *
 * **Zach, 2026-09-14, on seeing side 2 up before he had pressed anything:** *"so it
 * doesn't follow the `---`??? because i added that explicitly, i have my reasons."*
 *
 * He is right, and the principle is the one this repo already states four times over:
 * READ THE TEMPLATE. `---` is a side break he authored. A rule that decides a side is
 * really part of the previous one is overruling the template from code — the same
 * class of mistake as gating `型` in the resolver instead of in the body (decision 20),
 * and this file is not where that gets decided. If the canvas should share a side with
 * the kanji, that is one deleted `---` in `templates.content` and it is his to delete.
 *
 * The canvas costs one press now, and costs nothing else: it is a widget-only side, so
 * the step that shows it reveals no answer. `src/render/draw.ts` already survives being
 * mounted hidden — `ResizeObserver` is the primary repair and `remeasure()` on stroke
 * start is the second net, both written for the one-pixel canvas this produces.
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
 * The question: the first visible side, and the template's own `---` ends it.
 *
 * Returns display positions — a list of one, or an empty list for a card that
 * renders nothing at all. It stays a list because every caller treats the prompt as
 * a SET of positions, and because the shape is what would change if a template ever
 * earned a two-side question; the rule for that would have to come from him.
 *
 * An empty card yields an empty question rather than throwing — a card that renders
 * nothing is a data problem for the caller to report, not a crash here.
 */
export function promptPositions(sides: readonly BoundarySide[]): number[] {
  const first = visiblePositions(sides)[0];
  return first === undefined ? [] : [first];
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

/**
 * DECISION 57 — THE WORD IS THE HERO. A side that is nothing but a short run of
 * Japanese script (a head word like 東京, a kanji like 慈) is set huge and centred,
 * the way the reference sets its card. Returns the length in code points, 1-12,
 * or 0 for every other side, which keeps its `data-scale` size untouched.
 *
 * SCRIPT, NOT ONLY LENGTH, and that is what keeps decision 35 intact: `protein`
 * and `cook; chef` are short reverse prompts that `sideScale` rightly keeps in
 * `display`, and Latin at hero size would be a poster, not a card. A side holding
 * a cloze is never a hero either — its text carries the `[…]` mask, so the walk
 * cannot reveal a word into a size it was not laid out for.
 *
 * The three steps are the design system's head-word scale: 1-2 characters
 * `headword`, 3-4 `headword-md`, 5-12 `headword-sm` (the CSS keys on the number).
 * The cap is 12 because a Japanese-only run longer than that is a sentence or a
 * long phrase, not a head word, and stays in `display`.
 */
export function heroLength(text: string): number {
  const compact = text.replace(/\s+/g, "");
  if (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆ヶ]+$/u.test(compact)) return 0;
  const length = [...compact].length;
  return length <= 12 ? length : 0;
}
