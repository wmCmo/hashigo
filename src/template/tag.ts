const TAG_CHARACTER = /[\p{L}\p{N}\p{M}_/-]|[​-‏﻿]/u;

const WORD_BEFORE = /[\p{L}\p{N}_]/u;

const TRAILING_JOINER = /[/_-]/;

export function startsTag(text: string, at: number): boolean {
  if (text[at] !== "#") return false;
  const before = at === 0 ? "" : (text[at - 1] as string);
  return before === "" || !WORD_BEFORE.test(before);
}

export function tagEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && TAG_CHARACTER.test(text[i] as string)) i += 1;
  while (i > from && TRAILING_JOINER.test(text[i - 1] as string)) i -= 1;
  return i;
}
