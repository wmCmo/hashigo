/**
 * "GENERATE" UNDER AN ENGLISH EXAMPLE SENTENCE — Zach, 2026-10-26.
 *
 * *"for english in the Example Sentence field, i want a button to generate an
 * example sentence, when i can't find example sentence from
 * dictionary.cambridge.org … i would click that button, but if there's one, id
 * fill it myself"*
 *
 * ─── WHAT IT WRITES, AND WHY IT IS NOT AN `<ai>` TAG ────────────────────────
 *
 * In Mochi he typed `<ai>Example sentence of trellis</ai>` into the field
 * itself — 28 of the 1,205 New Vocab values still hold one. That makes the field
 * a prompt, and the spoken `Example` field reads it as one: the clip would be of
 * the instruction. So the button sends his own prompt, word for word, and writes
 * the SENTENCE it gets back. The field stays plain text he can correct.
 *
 * The prompt is exactly his Mochi phrasing on purpose: `Example sentence of X`
 * is what the existing cache entries are keyed on, and it was checked against
 * the Worker's system prompt (which says "Japanese flashcard") before shipping —
 * `substrate` and `skinflint` both came back as one English sentence.
 *
 * ─── WHICH FIELD — BY STRUCTURE, NOT BY NAME ────────────────────────────────
 *
 * `src/fields/roles.ts` records what binding by name costs. The rule here is
 * the shape of the field: a `plain` field that is not the head word and that an
 * ENGLISH `speech` field reads. Over the real templates that is New Vocab's
 * `Example Sentence` and nothing else — 単語 / 言葉's sentences are `ai` fields
 * (already generated), and 文法's spoken `Speech` is Japanese.
 */

/** The shape this needs of a template field. Structural, so `LoadedField` fits. */
export interface SentenceField {
  readonly id: string;
  readonly type: string;
  readonly pos: string;
  readonly sourceFieldId: string | null;
  readonly options: Readonly<Record<string, unknown>>;
}

/** The head word: the template's first field by position. */
function headField<F extends SentenceField>(fields: readonly F[]): F | null {
  let head: F | null = null;
  for (const field of fields) if (head === null || field.pos < head.pos) head = field;
  return head;
}

/** True when `field` is an English example sentence this button may fill. */
export function isEnglishSentenceField(field: SentenceField, fields: readonly SentenceField[]): boolean {
  if (field.type !== "plain") return false;
  const head = headField(fields);
  if (head === null || head.id === field.id) return false;
  return fields.some(
    (other) =>
      other.type === "speech" &&
      other.sourceFieldId === field.id &&
      typeof other.options["lang"] === "string" &&
      other.options["lang"].toLowerCase().startsWith("en"),
  );
}

/**
 * The prompt for one card, or null when there is no word to ask about yet.
 * `values` is keyed by field id — the editor's own map.
 */
export function exampleSentencePrompt(
  fields: readonly SentenceField[],
  values: ReadonlyMap<string, string>,
): string | null {
  const head = headField(fields);
  if (head === null) return null;
  // A head word can carry markup (`[[link|id]]`, a cloze) — ask about the word.
  const word = (values.get(head.id) ?? "")
    .replace(/\[\[([^|\]]*)(?:\|[^\]]*)?\]\]/g, "$1")
    .replace(/\{\{|\}\}/g, "")
    .trim();
  return word === "" ? null : `Example sentence of ${word}`;
}
