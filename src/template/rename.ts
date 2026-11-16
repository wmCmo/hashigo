import { FIELD_TOKEN } from "./parse.js";

export function referencedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(new RegExp(FIELD_TOKEN.source, "g"))) {
    const name = match[2]?.trim();
    if (name !== undefined && name !== "") names.add(name);
  }
  return names;
}

export function countReferences(source: string, field: string): number {
  let n = 0;
  for (const match of source.matchAll(new RegExp(FIELD_TOKEN.source, "g"))) {
    if (match[2]?.trim() === field.trim()) n += 1;
  }
  return n;
}

export function renameFieldInSource(source: string, from: string, to: string): string {
  const wanted = from.trim();
  return source.replace(new RegExp(FIELD_TOKEN.source, "g"), (whole: string) => {
    const parts = new RegExp(`^${FIELD_TOKEN.source}$`).exec(whole);
    if (parts === null) return whole;
    const sigil = parts[1] ?? "";
    const name = parts[2] ?? "";
    if (name.trim() !== wanted) return whole;
    const at = whole.indexOf(name);
    return `${whole.slice(0, at)}${to}${whole.slice(at + name.length)}`;
    void sigil;
  });
}

export interface RenameResult {
  readonly body: string;
  readonly options: readonly { readonly fieldId: string; readonly options: string }[];
  readonly rewrites: number;
}

export function renameFieldEverywhere(
  body: string,
  options: readonly { readonly fieldId: string; readonly options: string }[],
  from: string,
  to: string,
): RenameResult {
  let rewrites = countReferences(body, from);
  const nextBody = renameFieldInSource(body, from, to);
  const nextOptions: { fieldId: string; options: string }[] = [];
  for (const entry of options) {
    const hits = countReferences(entry.options, from);
    if (hits === 0) continue;
    rewrites += hits;
    nextOptions.push({
      fieldId: entry.fieldId,
      options: renameFieldInSource(entry.options, from, to),
    });
  }
  return { body: nextBody, options: nextOptions, rewrites };
}
