const KANJI = /[一-鿿㐀-䶿]/;
const KANA = /[ぁ-ゖァ-ヺー々]/;
const LATIN = /[A-Za-z]/;

export const PARENTHESIS = /[（(]([^）)]*)[）)]/;

export type ReadingVerdict = "読み" | "かな主流" | "意味" | "?";

export const READING_OVERRIDES: ReadonlyMap<string, ReadingVerdict> = new Map([
  ["Ufs9lMJR", "かな主流"],
]);

export interface ParsedReading {
  readonly cardId: string;
  readonly before: string;
  readonly verdict: ReadingVerdict;
  readonly ruled: ReadingVerdict;
  readonly overridden: boolean;
  readonly head: string;
  readonly yomi: string;
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

export function hasParenthesis(value: string): boolean {
  return PARENTHESIS.test(value);
}

export function parseReading(cardId: string, value: string): ParsedReading | null {
  const match = PARENTHESIS.exec(value);
  if (match === null) return null;
  const inside = (match[1] ?? "").trim();
  const outside = value.replace(PARENTHESIS, "").trim();
  const ruled = classifyParenthesis(inside, outside);
  const override = READING_OVERRIDES.get(cardId);
  const verdict = override ?? ruled;

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
