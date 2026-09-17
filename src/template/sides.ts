/**
 * WHICH SIDES A FIELD IS REFERENCED ON.
 *
 * Zach, 2026-09-17, describing what a field even is: *"the field name that will
 * be used in the body below"*. The editor answered that with a count —
 * `3 reference(s) in the body` — which says how many and never says WHERE. On a
 * template whose sides ARE the exercise (decision 29's `<<#Reading>>` gate, the
 * `---` he authors deliberately, decision 44) the side is the interesting half.
 *
 * It also makes one documented trap visible instead of merely written down:
 * `かな主流` renders on ZERO cards because the flag is on 言葉 and the marker was
 * authored into 単語. A field that says `no side` is that bug, on screen.
 *
 * ─── WHY IT GOES THROUGH THE MASK ───────────────────────────────────────────
 *
 * `splitMaskedSides` takes MASKED text on purpose — sides are a property of the
 * authored body, decided before interpolation. Counting on the raw body would
 * work almost always and then not: `FIELD_TOKEN`'s name group is `[^>]+?`, which
 * can span a line, so a token containing a newline would let a `---` inside a
 * marker read as a side break. Masking first removes that class of question
 * entirely, and the token list it hands back is already the answer to "which
 * field is this".
 */

import { FIELD_TOKEN, markerFor, maskFields, splitMaskedSides } from "./parse.js";

/** 1-based side numbers a field is named on, ascending. Empty means nowhere. */
export function sidesReferencing(body: string, field: string): number[] {
  const wanted = field.trim();
  if (wanted === "") return [];
  const masked = maskFields(body);
  const named = new Set<string>();
  masked.tokens.forEach((token, index) => {
    if (token.name.trim() === wanted) named.add(markerFor(index));
  });
  if (named.size === 0) return [];

  const sides: number[] = [];
  splitMaskedSides(masked.text).forEach((side, index) => {
    for (const marker of named) {
      if (side.includes(marker)) {
        sides.push(index + 1);
        return;
      }
    }
  });
  return sides;
}

/**
 * Every field name the body references, and the sides each appears on.
 *
 * One pass, because the editor asks this for every field of the template at once
 * and masking the same body eleven times is eleven times the work for one answer.
 */
export function sideIndex(body: string): Map<string, number[]> {
  const masked = maskFields(body);
  const sides = splitMaskedSides(masked.text);
  const out = new Map<string, number[]>();
  sides.forEach((side, index) => {
    for (const match of side.matchAll(/(\d+)/g)) {
      const token = masked.tokens[Number(match[1])];
      const name = token?.name.trim();
      if (name === undefined || name === "") continue;
      const list = out.get(name) ?? [];
      if (list[list.length - 1] !== index + 1) list.push(index + 1);
      out.set(name, list);
    }
  });
  return out;
}

/**
 * The field names an `ai` generator's prompt depends on.
 *
 * `src/generate/fields.ts` resolves an `ai` field's input by substituting
 * `<<Field>>` markers inside `ai-custom-prompt` — so the dependency is real, is
 * named by NAME, and appears in no column. The editor's "feeds X" line was built
 * from `source_field_id` alone and therefore never showed it: 単語's `例文` feeds
 * `Audio` and `Translate`, but nothing said that `単語` feeds `例文`.
 *
 * Same lexer as the resolver, so the two cannot disagree about what a marker is.
 */
export function promptDependencies(prompt: string): string[] {
  const names: string[] = [];
  for (const match of prompt.matchAll(new RegExp(FIELD_TOKEN.source, "g"))) {
    const name = match[2]?.trim();
    if (name !== undefined && name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}
