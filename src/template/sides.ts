import { FIELD_TOKEN, markerFor, maskFields, splitMaskedSides } from "./parse.js";

export function sidesReferencing(body: string, field: string): number[] {
  const wanted = field.trim();
  if (wanted === "") return [];
  const masked = maskFields(body);
  const named = new Set<string>();
  masked.tokens.forEach((token, index) => {
    if (token.name.trim() === wanted) named.add(markerFor(index));
  });
  if (named.size === 0) return [];

  const sides: number[] = [];
  splitMaskedSides(masked.text).forEach((side, index) => {
    for (const marker of named) {
      if (side.includes(marker)) {
        sides.push(index + 1);
        return;
      }
    }
  });
  return sides;
}

export function sideIndex(body: string): Map<string, number[]> {
  const masked = maskFields(body);
  const sides = splitMaskedSides(masked.text);
  const out = new Map<string, number[]>();
  sides.forEach((side, index) => {
    for (const match of side.matchAll(/(\d+)/g)) {
      const token = masked.tokens[Number(match[1])];
      const name = token?.name.trim();
      if (name === undefined || name === "") continue;
      const list = out.get(name) ?? [];
      if (list[list.length - 1] !== index + 1) list.push(index + 1);
      out.set(name, list);
    }
  });
  return out;
}

export function promptDependencies(prompt: string): string[] {
  const names: string[] = [];
  for (const match of prompt.matchAll(new RegExp(FIELD_TOKEN.source, "g"))) {
    const name = match[2]?.trim();
    if (name !== undefined && name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}
