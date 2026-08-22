/**
 * Zach's parenthesis workaround, parsed — decision 10.
 *
 * Thirteen head words in the corpus carry a bracket: `器（うつわ）`, `めす（雌）`,
 * `はたち (as in 20 years old)`. They are not a display choice. They are a TTS
 * workaround: Mochi read 器 as キ, 革 as カク, 的 as テキ, so he wrote the reading
 * into the head word to force the pronunciation — and then the provider spoke
 * the brackets. Measured: **12 of the 13 have a speech clip filed under the
 * bracketed text**, which is 12 clips that say "utsuwa kakko utsuwa kakko-toji".
 *
 * THE RULE READS SCRIPT, NOT BRACKET POSITION, and that distinction is the whole
 * reason this is a module rather than four lines at a call site:
 *
 *     kanji outside, kana inside    the bracket holds a READING      読み
 *     kana outside, kanji inside    the bracket holds the KANJI      かな主流
 *     Latin inside                  the bracket holds a GLOSS        意味
 *
 * Keying on POSITION instead — "inside is the kanji for かな主流" — is wrong the
 * moment a row is overridden, and one is: `（おす）雄` puts the bracket on the
 * other side from its twin `めす（雌）`. Position-keying emitted head=おす,
 * 読み=雄, which is a kana head word with a kanji reading — backwards, and it
 * would have been written to his cards.
 *
 * The two verdicts are MIRRORS, and applying one to the other's rows reproduces
 * the exact failure the workaround was hiding.
 */

const KANJI = /[一-鿿㐀-䶿]/;
const KANA = /[ぁ-ゖァ-ヺー々]/;
const LATIN = /[A-Za-z]/;

/**
 * Both widths of both brackets. A full-width space is a real separator here —
 * `日向　(ひなた)` — so "outside" is whatever remains once the match is removed.
 */
export const PARENTHESIS = /[（(]([^）)]*)[）)]/;

export type ReadingVerdict = "読み" | "かな主流" | "意味" | "?";

/**
 * THE ONE OVERRIDE, RATIFIED BY ZACH 2026-08-22.
 *
 * The rule stays decidable for every other row; this card is listed by id so it
 * can never silently generalise. `（おす）雄` and `めす（雌）` are one pair —
 * "male (animal, plant)" / "female (animal, plant)" — authored together and
 * split only by which side the bracket landed on. Asked, he ruled おす
 * kana-primary like its twin. The head word (`雄`) and the reading (`おす`) come
 * out identical either way; only the かな label differs.
 */
export const READING_OVERRIDES: ReadonlyMap<string, ReadingVerdict> = new Map([
  ["Ufs9lMJR", "かな主流"],
]);

/** What one head word becomes. `head` is what stays in the `name` field. */
export interface ParsedReading {
  readonly cardId: string;
  readonly before: string;
  readonly verdict: ReadingVerdict;
  /** What the rule alone said, before any override. */
  readonly ruled: ReadingVerdict;
  readonly overridden: boolean;
  /** The head word after the fix. */
  readonly head: string;
  /** The `読み` value, or "" when the verdict is 意味. */
  readonly yomi: string;
  /** 1 when `かな主流` should be set. */
  readonly kanaPrimary: 0 | 1;
}

export function classifyParenthesis(inside: string, outside: string): ReadingVerdict {
  if (LATIN.test(inside)) return "意味";
  const insideKanji = KANJI.test(inside);
  const outsideKanji = KANJI.test(outside);
  if (outsideKanji && !insideKanji && KANA.test(inside)) return "読み";
  if (insideKanji && !outsideKanji) return "かな主流";
  return "?";
}

/** True when a head word carries the workaround at all. */
export function hasParenthesis(value: string): boolean {
  return PARENTHESIS.test(value);
}

/**
 * Parse one head word. Returns null when it carries no bracket.
 *
 * A `?` verdict is returned rather than thrown: the caller decides whether an
 * undecidable row is a reason to write nothing at all, and every writer in this
 * repo does exactly that.
 */
export function parseReading(cardId: string, value: string): ParsedReading | null {
  const match = PARENTHESIS.exec(value);
  if (match === null) return null;
  const inside = (match[1] ?? "").trim();
  const outside = value.replace(PARENTHESIS, "").trim();
  const ruled = classifyParenthesis(inside, outside);
  const override = READING_OVERRIDES.get(cardId);
  const verdict = override ?? ruled;

  // Keyed on SCRIPT. See the header — position-keying wrote a kana head word
  // with a kanji reading on the one overridden row.
  const kanjiSide = KANJI.test(inside) ? inside : outside;
  const kanaSide = KANJI.test(inside) ? outside : inside;
  return {
    cardId,
    before: value,
    verdict,
    ruled,
    overridden: override !== undefined,
    head: verdict === "意味" ? outside : kanjiSide,
    yomi: verdict === "意味" ? "" : kanaSide,
    kanaPrimary: verdict === "かな主流" ? 1 : 0,
  };
}
