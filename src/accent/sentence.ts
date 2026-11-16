export const MARKS_FIELD = {
  id: "ojad",
  name: "OJAD",
  type: "plain",
} as const;

export interface Mora {
  readonly kana: string;
  readonly head: boolean;
  readonly devoiced: boolean;
}

export interface Phrase {
  readonly morae: readonly Mora[];
}

export class AnnotationError extends Error {
  constructor(value: string, why: string) {
    super(`not a usable accent annotation: ${JSON.stringify(value.slice(0, 40))} — ${why}`);
    this.name = "AnnotationError";
  }
}

const PHRASE = "|";
const HEAD = "*";
const DEVOICED = "_";
const SMALL = "ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ";
const READING_CHAR = /^[ぁ-ゖァ-ヺー]$/;

export function toHiragana(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
  }
  return out;
}

export function splitMorae(reading: string): string[] {
  const out: string[] = [];
  for (const ch of reading) {
    if (SMALL.includes(ch) && out.length > 0) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

export function cleanSentence(generated: string): string | null {
  const line = generated
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => /[぀-ヿ㐀-鿿]/.test(candidate));
  if (line === undefined) return null;

  let text = line.replace(/[（(][^）)]*[A-Za-z][^）)]*[）)]/g, "");
  const wrapped = /^[「『"'](.*)[」』"']$/s.exec(text.trim());
  if (wrapped?.[1] !== undefined) text = wrapped[1];
  text = text.trim();

  if (text === "") return null;
  return text;
}

export function formatAnnotation(phrases: readonly Phrase[]): string {
  return phrases
    .map((phrase) =>
      phrase.morae
        .map((mora) => mora.kana + (mora.head ? HEAD : "") + (mora.devoiced ? DEVOICED : ""))
        .join(""),
    )
    .join(PHRASE);
}

export function parseAnnotation(value: string): Phrase[] {
  if (value === "") return [];
  const phrases: Phrase[] = [];
  for (const chunk of value.split(PHRASE)) {
    const morae: Mora[] = [];
    for (const ch of chunk) {
      if (ch === HEAD || ch === DEVOICED) {
        const last = morae[morae.length - 1];
        if (last === undefined) throw new AnnotationError(value, `${ch} before any mora`);
        if (ch === HEAD) {
          if (last.head) throw new AnnotationError(value, "the same mora marked twice");
          morae[morae.length - 1] = { ...last, head: true };
        } else {
          if (last.devoiced) throw new AnnotationError(value, "devoiced marked twice");
          morae[morae.length - 1] = { ...last, devoiced: true };
        }
        continue;
      }
      if (SMALL.includes(ch) && morae.length > 0) {
        const last = morae[morae.length - 1]!;
        if (last.head || last.devoiced) {
          throw new AnnotationError(value, "a small kana follows a mark");
        }
        morae[morae.length - 1] = { ...last, kana: last.kana + ch };
        continue;
      }
      if (!READING_CHAR.test(ch)) throw new AnnotationError(value, `${JSON.stringify(ch)} is not kana`);
      morae.push({ kana: ch, head: false, devoiced: false });
    }
    if (morae.length === 0) throw new AnnotationError(value, "an empty accent phrase");
    if (morae.filter((mora) => mora.head).length > 1) {
      throw new AnnotationError(value, "two drops in one accent phrase");
    }
    phrases.push({ morae });
  }
  return phrases;
}

export function flatten(phrases: readonly Phrase[]): Mora[] {
  return phrases.flatMap((phrase) => [...phrase.morae]);
}

export const READING_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ["至れり尽くせり", "いたれりつくせり"],
  ["毎正時", "まいしょうじ"],

  ["怒りは", "いかりは"],
  ["怒りに任せて", "いかりに任せて"],
  ["か否か", "かいなか"],
  ["助けよう", "たすけよう"],
  ["数日", "すうじつ"],
  ["数日で", "スージツで"],
  ["数日後", "スージツ後"],
]);

export function applyReadingOverrides(sentence: string): string {
  let text = sentence;
  const phrases = [...READING_OVERRIDES.keys()].sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    text = text.split(phrase).join(READING_OVERRIDES.get(phrase) ?? phrase);
  }
  return text;
}
