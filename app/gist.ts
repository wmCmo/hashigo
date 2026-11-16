import { speakableText } from "../src/text/index.js";

export const GIST_FIELDS: readonly string[] = ["意味", "Meaning"];

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
