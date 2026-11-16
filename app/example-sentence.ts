export interface SentenceField {
  readonly id: string;
  readonly type: string;
  readonly pos: string;
  readonly sourceFieldId: string | null;
  readonly options: Readonly<Record<string, unknown>>;
}

function headField<F extends SentenceField>(fields: readonly F[]): F | null {
  let head: F | null = null;
  for (const field of fields) if (head === null || field.pos < head.pos) head = field;
  return head;
}

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

export function exampleSentencePrompt(
  fields: readonly SentenceField[],
  values: ReadonlyMap<string, string>,
): string | null {
  const head = headField(fields);
  if (head === null) return null;
  const word = (values.get(head.id) ?? "")
    .replace(/\[\[([^|\]]*)(?:\|[^\]]*)?\]\]/g, "$1")
    .replace(/\{\{|\}\}/g, "")
    .trim();
  return word === "" ? null : `Example sentence using ${word} in English`;
}
