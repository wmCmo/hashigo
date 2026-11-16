import { renderPlainText, stripInvisible } from "../text/index.js";

export const PLACEHOLDER_SPELLINGS = ["～", "〜", "~", "...", "…"] as const;

export const PLACEHOLDER = "~";

export function accentKey(value: string): string {
  let text = stripInvisible(renderPlainText(value));
  for (const spelling of PLACEHOLDER_SPELLINGS) {
    text = text.split(spelling).join(PLACEHOLDER);
  }
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function hasPlaceholder(key: string): boolean {
  return key.includes(PLACEHOLDER);
}

const KANA_ONLY = /^[\p{Script=Katakana}\p{Script=Hiragana}ーゝゞ゛゜・\s]+$/u;

export function readingLooksUnanalysed(reading: string): boolean {
  return reading.trim() === "" || !KANA_ONLY.test(reading);
}
