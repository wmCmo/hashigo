/**
 * `型` IS PICKED, NOT TYPED. Zach, 2026-10-24, a yes to: *"keep it editable but
 * switch it to a picker (平板 / 頭高 / 中高(n) / 尾高)"*. He had asked why the
 * field was editable at all; it stays editable because it is the one place he
 * can overrule a wrong accent (decision 8), and a picker keeps the override
 * while ruling out the typo — a free-text `平坂` renders as a label nobody can
 * read as a pattern, on the cards where `型` is the only carrier of the fact
 * (decision 27).
 *
 * The label is `accentLabel`'s, the same function the pipeline writes with, so a
 * hand-picked `中高 (3)` and a derived one are the same string.
 */
import { accentLabel, type AccentType } from "../src/accent/store.js";

export const ACCENT_TYPES: readonly AccentType[] = ["平板", "頭高", "中高", "尾高"];

export interface ParsedAccent {
  readonly type: AccentType;
  /** The downstep mora — only meaningful, and only kept, for 中高. */
  readonly mora: number | null;
}

/**
 * A stored value as a choice, or null when it is not one of the four labels.
 * Null is not "empty": the editor keeps an unrecognised value as its own option
 * rather than silently replacing it with the first choice.
 */
export function parseAccent(value: string): ParsedAccent | null {
  const match = /^(平板|頭高|中高|尾高)(?:\s*\((\d+)\))?$/.exec(value.trim());
  if (match === null) return null;
  const type = match[1] as AccentType;
  return { type, mora: type === "中高" && match[2] !== undefined ? Number(match[2]) : null };
}

/** The value to store. 中高 without a mora is stored bare, as the pipeline does. */
export function formatAccent(type: AccentType, mora: number | null): string {
  return accentLabel(type, type === "中高" ? mora : null);
}
