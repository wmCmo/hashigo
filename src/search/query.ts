import { stripInvisible } from "../text/index.js";

export const FTS_MIN_QUERY_CHARS = 3;

export const MAX_TERMS = 16;

export type SearchMode = "fts" | "like";

export interface SearchQuery {
  readonly raw: string;
  readonly normalised: string;
  readonly terms: readonly string[];
  readonly mode: SearchMode;
  readonly shortestTermChars: number;
  readonly termsDropped: number;
}

export function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

export function normaliseQuery(raw: string): string {
  return stripInvisible(raw.normalize("NFC")).replace(/\s+/gu, " ").trim();
}

export function parseSearchQuery(raw: string): SearchQuery | null {
  const normalised = normaliseQuery(raw);
  if (normalised === "") return null;

  const all = normalised.split(" ");
  const terms = all.slice(0, MAX_TERMS);
  let shortest = Number.POSITIVE_INFINITY;
  for (const term of terms) shortest = Math.min(shortest, charCount(term));

  return {
    raw,
    normalised,
    terms,
    mode: shortest >= FTS_MIN_QUERY_CHARS ? "fts" : "like",
    shortestTermChars: shortest,
    termsDropped: all.length - terms.length,
  };
}

export const LIKE_ESCAPE = String.fromCharCode(92);

export const LIKE_ESCAPE_CLAUSE = ` ESCAPE '${LIKE_ESCAPE}'`;

export function escapeLike(value: string): string {
  let out = "";
  for (const character of value) {
    if (character === LIKE_ESCAPE || character === "%" || character === "_") out += LIKE_ESCAPE;
    out += character;
  }
  return out;
}

export function likeContains(value: string): string {
  return `%${escapeLike(value)}%`;
}

export function likePrefix(value: string): string {
  return `${escapeLike(value)}%`;
}

export function ftsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function ftsMatchExpression(terms: readonly string[]): string {
  if (terms.length === 0) throw new RangeError("no terms to match");
  for (const term of terms) {
    const chars = charCount(term);
    if (chars < FTS_MIN_QUERY_CHARS) {
      throw new RangeError(
        `term ${JSON.stringify(term)} is ${chars} character(s); the trigram index ` +
          `cannot serve fewer than ${FTS_MIN_QUERY_CHARS} and would silently return ` +
          `nothing. Route this query to the scan path instead.`,
      );
    }
  }
  return terms.map(ftsPhrase).join(" AND ");
}

export function asciiLower(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    out += code >= 0x41 && code <= 0x5a ? String.fromCodePoint(code + 0x20) : character;
  }
  return out;
}

const KANJI_RANGE = "\u4E00-\u9FFF\u3400-\u4DBF";
const HIRAGANA_TAIL = new RegExp(`^(.*[${KANJI_RANGE}])[\u3040-\u309F]{1,2}$`, "u");

export function okuriganaStem(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return null;
  const match = HIRAGANA_TAIL.exec(trimmed);
  if (match === null) return null;
  const stem = match[1] as string;
  return stem.length === 0 ? null : stem;
}
