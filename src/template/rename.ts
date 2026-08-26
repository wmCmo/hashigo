/**
 * Renaming a field is a BODY EDIT, and that is the whole reason this file exists.
 *
 * `src/template/resolve.ts` resolves `<<Field>>` **by NAME**, falling back to the id
 * only so that the primary field's literal id `"name"` still works. So renaming
 * `Reading` to `読み` in `template_fields` and stopping there does not rename
 * anything the reader can see — it silently unbinds every `<<Reading>>`,
 * `<<#Reading>>` and `<</Reading>>` in the body, and a section whose opener no
 * longer resolves stops gating. On 単語 that is decision 29's `<<#Reading>>` gate:
 * the whole mode split, off, with no error anywhere.
 *
 * It is worse than a broken render, because it is a SILENT one. An unresolved
 * `<<X>>` is not an exception; it is an empty string.
 *
 * ─── AND THE BODY IS NOT THE ONLY PLACE A NAME APPEARS ──────────────────────
 *
 * `template_fields.options` carries generator prompts, and `schema.sql` says
 * exactly why that matters: 例文 is an `ai` field whose `source_field_id` is NULL
 * because its only dependency is named INSIDE its prompt text — *"Example sentence
 * using `<<単語>>` in Japanese"*. Rename 単語 without touching that string and the
 * generator's input silently disappears from its own prompt.
 *
 * ─── WHY IT IS NOT A STRING REPLACE ─────────────────────────────────────────
 *
 * A field can be named `型`, and `型` occurs inside ordinary Japanese prose; a
 * field can be named `a`. So the rewrite runs over `FIELD_TOKEN` — the same lexer
 * `maskFields` uses — and only rewrites a token whose captured NAME matches. Each
 * token keeps its own sigil and its own spacing, because the corpus writes
 * `<<Kanji>>`, `<< Kanji >>`, `<< #Reading>>` and `<< /Reading >>`, twice in one
 * body, and normalising them would produce a diff nobody asked for over a template
 * he wrote by hand.
 */

import { FIELD_TOKEN } from "./parse.js";

/** Every distinct field name a string references, section markers included. */
export function referencedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(new RegExp(FIELD_TOKEN.source, "g"))) {
    const name = match[2]?.trim();
    if (name !== undefined && name !== "") names.add(name);
  }
  return names;
}

/** How many tokens in `source` name `field`. Zero means a rename touches nothing. */
export function countReferences(source: string, field: string): number {
  let n = 0;
  for (const match of source.matchAll(new RegExp(FIELD_TOKEN.source, "g"))) {
    if (match[2]?.trim() === field.trim()) n += 1;
  }
  return n;
}

/**
 * Rewrite every `<<from>>` token to `<<to>>`, preserving each token's own shape.
 *
 * Only the NAME is replaced: the sigil (`#`, `^`, `/`, none) and the interior
 * spacing come back exactly as they were written, so a body that mixes styles
 * survives a rename with a one-word diff.
 */
export function renameFieldInSource(source: string, from: string, to: string): string {
  const wanted = from.trim();
  return source.replace(new RegExp(FIELD_TOKEN.source, "g"), (whole: string) => {
    // Re-run the lexer on the single token so the capture groups are this match's,
    // not a stale `lastIndex` from the outer regex.
    const parts = new RegExp(`^${FIELD_TOKEN.source}$`).exec(whole);
    if (parts === null) return whole;
    const sigil = parts[1] ?? "";
    const name = parts[2] ?? "";
    if (name.trim() !== wanted) return whole;
    // Rebuild from the ORIGINAL token so the author's spacing survives: everything
    // up to the name is kept verbatim, and so is everything after it.
    const at = whole.indexOf(name);
    return `${whole.slice(0, at)}${to}${whole.slice(at + name.length)}`;
    // `sigil` is not consulted beyond documenting that it is inside the kept prefix.
    void sigil;
  });
}

/**
 * A rename applied to a body and to every generator prompt beside it.
 *
 * Returns the rewritten strings and a count, so the caller can report "renamed X
 * to Y and rewrote 6 references" rather than leaving him to check by eye.
 */
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
