/**
 * The accent key — what a derived accent is filed under.
 *
 * 橋 has one accent whichever card it appears on, so `accents` is keyed by TEXT
 * rather than by card. This module owns the one definition of that text.
 *
 * IT IS THE SAME LESSON AS THE AUDIO BINDING, AND IT COST A WRONG DERIVATION
 * BEFORE IT WAS LEARNED HERE TOO. Feeding the analyser a raw
 * `card_field_values.value` mis-read his own vocabulary, because two things in
 * it are invisible:
 *
 *   `[[参考|UQB66cP2]]にする`  the wiki-link's opaque id went to the analyser and
 *                             came back read out as ユーキュービーロク…
 *   `準‎備` (U+200E inside)     OpenJTalk read the halves separately: ジュン +
 *                             ソナエ instead of ジュンビ. Also 面倒 -> メン +
 *                             タオセ, 見送り, 評価, 田植え.
 *
 * Those are not mora-count wobbles, they are wrong readings, and a wrong accent
 * drilled through spaced repetition is worse than no accent. 3,016 U+200E marks
 * sit on 2,504 cards, so this is a large class rather than a curiosity.
 *
 * PLACEHOLDERS ARE NORMALISED, NOT STRIPPED. `～` marks an accent-phrase boundary
 * better than the analyser's own guess — measured: a medial tilde becomes a
 * `pau` and splits breath groups, which is the segmentation Google's notation
 * wants. Stripping it here would throw that away. All five spellings collapse to
 * one `~` so the key is stable: three tilde codepoints and two ellipsis
 * spellings are in use, and a regex for `～〜...` is exactly what missed the
 * ASCII tilde in `~に越したことはない` and counted 20 instead of 21.
 */

import { renderPlainText, stripInvisible } from "../text/index.js";

/**
 * Every placeholder spelling in the corpus, from an exhaustive codepoint census
 * over 3,860 head words — not from a regex guess.
 *
 *     U+FF5E FULLWIDTH TILDE  ～   17
 *     U+301C WAVE DASH        〜    3
 *     U+007E ASCII TILDE      ~     1
 *     ASCII '...'                   3
 *
 * 21 values carry at least one. `…` (U+2026) has zero occurrences and is
 * included anyway: it is one keystroke away from `...` on a Japanese IME.
 */
export const PLACEHOLDER_SPELLINGS = ["～", "〜", "~", "...", "…"] as const;

/** The single spelling every placeholder normalises to. */
export const PLACEHOLDER = "~";

/**
 * A field value -> the string an accent is filed under.
 *
 * Order matters. Links reduce first (so an id cannot survive as text), then
 * invisible marks go (so a compound is one word again), then placeholders
 * normalise, then whitespace collapses. Doing the invisible strip after the
 * link reduction is not incidental: `renderPlainText` already strips invisibles,
 * and the second call is what catches a mark that a link's display text carried.
 */
export function accentKey(value: string): string {
  let text = stripInvisible(renderPlainText(value));
  for (const spelling of PLACEHOLDER_SPELLINGS) {
    text = text.split(spelling).join(PLACEHOLDER);
  }
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** True when the key carries a placeholder, i.e. the notation spans segments. */
export function hasPlaceholder(key: string): boolean {
  return key.includes(PLACEHOLDER);
}

/**
 * A reading the analyser did not actually produce.
 *
 * When OpenJTalk does not know a word it hands the input back inside the
 * "reading", and the failure is otherwise SILENT — the mora count and the accent
 * type both come out plausible. Three shapes appear in this corpus:
 *
 *     嗤う        -> 嗤ウ            kanji straight through
 *     Ｙシャツ    -> Ｙシャツ         full-width Latin straight through
 *     （おす）雄  -> （オス）ユー      brackets kept, and the WRONG reading of 雄
 *
 * So the test is an ALLOWLIST, not a kanji blocklist. A kanji blocklist passes
 * `Ｙシャツ`, which is how the first version of this let it through: a reading is
 * kana, the long mark, and nothing else.
 */
const KANA_ONLY = /^[\p{Script=Katakana}\p{Script=Hiragana}ーゝゞ゛゜・\s]+$/u;

export function readingLooksUnanalysed(reading: string): boolean {
  return reading.trim() === "" || !KANA_ONLY.test(reading);
}
