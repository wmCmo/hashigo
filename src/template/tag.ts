/**
 * `#Mathematics` — the grammar for a tag written inline in card text.
 *
 * Zach, 2026-09-18: *"i want the tag to behave like hyperlink too, but looks
 * different than like hyperlink"*.
 *
 * ─── MEASURED BEFORE THE GRAMMAR WAS CHOSEN ─────────────────────────────────
 *
 * 49 `#` tokens across 44 field values in the real corpus, and **every one of
 * them is a tag**. 38 match a `tags.path` outright; the other 11 are the same
 * names carrying a U+200B ZERO WIDTH SPACE immediately after the `#` — the
 * identical trap `src/import/tags.ts` had to repair on the way in, where five
 * raw tags arrived with one and `Mathematics` and `<ZWSP>Mathematics` read as two
 * different tags nobody could tell apart.
 *
 * So there is no `C#` in this corpus, no `#1`, and no colour literal: `#FF0000`
 * exists only inside a 漢字 template ATTRIBUTE, which the markup parser takes
 * before inline parsing ever runs. The bare `#` characters in template bodies are
 * ATX headings and `<<#Field>>` section sigils — the first is a block, and the
 * second is masked to a private-use marker before this sees the text.
 *
 * ─── AND WHY THE GRAMMAR IS STILL ALLOWED TO BE GENEROUS ────────────────────
 *
 * Because it does not decide anything. Resolution belongs to the RENDERER, which
 * is the only layer that can see the tag table — an unknown path renders as the
 * plain text it was authored as, exactly as an unresolvable `[[wiki link]]` does
 * (SPEC: "unresolved links must render as plain text rather than being dropped").
 * A false positive therefore costs nothing: `https://x.com/#section` in plain
 * text parses as a tag node, fails to resolve, and comes out as the same
 * characters it went in as.
 *
 * Its own module rather than another block inside `parse.ts` because it is three
 * regexes and a paragraph of why, and because a grammar with its own tests is
 * cheaper to be sure of than one buried in a 900-line scanner.
 */

/**
 * What may sit inside a tag path after the `#`.
 *
 * Letters, numbers and combining marks in ANY script — `四字熟語` is a tag — plus
 * the three joiners the corpus uses: `/` for `Dialect/Kansai`, `-` for
 * `Stock-market`, and `_` because a tag may be typed that way. Invisible marks
 * are deliberately allowed THROUGH here and stripped from the path afterwards;
 * rejecting them would refuse exactly the 11 tokens that carry one.
 */
const TAG_CHARACTER = /[\p{L}\p{N}\p{M}_/-]|[​-‏﻿]/u;

/** A word character. `C#` must not become a word plus an empty tag. */
const WORD_BEFORE = /[\p{L}\p{N}_]/u;

/** A joiner may not END a path: `#Dialect/` is a typo, and `Dialect` resolves. */
const TRAILING_JOINER = /[/_-]/;

/**
 * Whether the `#` at `at` opens a tag.
 *
 * The test is what comes BEFORE it. A `#` glued to the end of a word is part of
 * that word — `C#`, `F#` — and a tag is written at a boundary.
 */
export function startsTag(text: string, at: number): boolean {
  if (text[at] !== "#") return false;
  const before = at === 0 ? "" : (text[at - 1] as string);
  return before === "" || !WORD_BEFORE.test(before);
}

/**
 * The index just past the tag body that starts at `from`, or `from` when there
 * is no body — `# heading`, or a `#` at the end of a line.
 */
export function tagEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && TAG_CHARACTER.test(text[i] as string)) i += 1;
  while (i > from && TRAILING_JOINER.test(text[i - 1] as string)) i -= 1;
  return i;
}
