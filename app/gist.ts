/**
 * A GALLERY TILE'S SECOND LINE — what the card MEANS, so a deck listing can be
 * read rather than only clicked through.
 *
 * Before this a tile carried the head word and the deck path, and every other
 * line was buttons: 300 tiles of `〜ったとしても` with no way to tell from the
 * grid which one you were after. The meaning is what you scan a vocabulary deck
 * for, so it is the one thing added.
 *
 * ─── WHICH FIELD, AND WHY ONLY THESE ────────────────────────────────────────
 *
 * `意味` (単語, 言葉) and `Meaning` (漢字, New Vocab), and only as `plain` — measured
 * 2026-10-16 over the real corpus: 6,689 of 7,348 cards carry one non-empty.
 * Polysemy's `Meaning` is a `translate` generator and so has no stored value
 * (decision 7's corpus measurement: generator fields hold ""), which is why the
 * type is part of the rule and not only the name. Templates without one — 基本情報,
 * 数字, 敬語, 文法 — get no second line rather than a guessed one: the first plain
 * field there is the head word again, or a `Hide`, or a number.
 */

import { speakableText } from "../src/text/index.js";

/** The fields a gist is read from, in preference order. */
export const GIST_FIELDS: readonly string[] = ["意味", "Meaning"];

/**
 * Authored field value -> one readable line, or null when there is nothing to show.
 *
 * The FIRST line, because `意味` is very often a numbered list (`1. even if …\n2.
 * also as …`) and the first sense is the one a tile has room for. Its list marker
 * goes; links reduce to their display text and emphasis to its words, which is
 * `speakableText`'s transform — the right one here for the same reason it is for a
 * voice: this is text to be read, not markup to be searched.
 */
export function gistOf(value: string): string | null {
  for (const line of value.split(/\r?\n/)) {
    const text = speakableText(line)
      .replace(/^\d+[.)]\s*/, "")
      .replace(/^[-*•]\s+/, "")
      .trim();
    if (text !== "") return text;
  }
  return null;
}
