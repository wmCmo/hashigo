import { asciiLower } from "./query.js";

export type SnippetField = "body" | "name" | "tags";

export interface SearchSnippet {
  readonly text: string;
  readonly field: SnippetField;
  readonly matchStart: number;
  readonly matchLength: number;
}

export const SNIPPET_RADIUS = 40;

const ELLIPSIS = "…";

function flatten(text: string): string {
  return text.replace(/[\r\n\t\v\f]/g, " ");
}

function splitsSurrogate(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const previous = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}

function firstMatch(text: string, terms: readonly string[]): { start: number; length: number } | null {
  const folded = asciiLower(text);
  let best: { start: number; length: number } | null = null;
  for (const term of terms) {
    if (term === "") continue;
    const start = folded.indexOf(asciiLower(term));
    if (start < 0) continue;
    if (best === null || start < best.start) best = { start, length: term.length };
  }
  return best;
}

export interface SnippetSource {
  readonly name: string;
  readonly body: string;
  readonly tags: string;
}

export function makeSnippet(
  source: SnippetSource,
  terms: readonly string[],
  radius: number = SNIPPET_RADIUS,
): SearchSnippet | null {
  if (!Number.isInteger(radius) || radius < 0) {
    throw new RangeError(`snippet radius must be a non-negative integer, got ${radius}`);
  }
  const fields: readonly (readonly [SnippetField, string])[] = [
    ["body", source.body],
    ["name", source.name],
    ["tags", source.tags],
  ];

  for (const [field, raw] of fields) {
    const text = flatten(raw);
    const match = firstMatch(text, terms);
    if (match === null) continue;

    let start = Math.max(0, match.start - radius);
    let end = Math.min(text.length, match.start + match.length + radius);
    if (splitsSurrogate(text, start)) start -= 1;
    if (splitsSurrogate(text, end)) end += 1;

    const head = start > 0 ? ELLIPSIS : "";
    const tail = end < text.length ? ELLIPSIS : "";
    return {
      text: head + text.slice(start, end) + tail,
      field,
      matchStart: head.length + (match.start - start),
      matchLength: match.length,
    };
  }
  return null;
}
