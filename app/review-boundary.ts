export interface BoundarySide {
  readonly position: number;
  readonly index: number;
  readonly empty: boolean;
  readonly text: string;
}

export function visiblePositions(sides: readonly BoundarySide[]): number[] {
  return sides.filter((side) => !side.empty).map((side) => side.position);
}

export function promptPositions(sides: readonly BoundarySide[]): number[] {
  const first = visiblePositions(sides)[0];
  return first === undefined ? [] : [first];
}

export type SideScale = "display" | "mid" | "body";

export function sideScale(text: string): SideScale {
  const length = graphemes(text.trim().replace(/\s+/g, " "));
  if (length <= 28) return "display";
  if (length <= 64) return "mid";
  return "body";
}

function graphemes(text: string): number {
  if (typeof Intl.Segmenter !== "function") return [...text].length;
  let count = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) count += 1;
  return count;
}

export function heroLength(text: string): number {
  const compact = text.replace(/\s+/g, "");
  if (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆ヶ]+$/u.test(compact)) return 0;
  const length = [...compact].length;
  return length <= 12 ? length : 0;
}
