import type { SqliteHandle } from "../db/browser.js";
import { renderPlainTextParts } from "../text/render.js";

import { fieldGenerationRequest, type FieldContext, type GeneratorField } from "./fields.js";
import { resolveDescriptorText } from "./store.js";

const INDEXED_KINDS: ReadonlySet<string> = new Set(["ai", "translate"]);

const CARD = `SELECT content, template_id FROM cards WHERE id = ?`;

const FIELDS = `
SELECT id, name, type, source_field_id, options
  FROM template_fields WHERE template_id = ? ORDER BY pos`;

const VALUES = `
SELECT v.field_id AS field_id, v.value AS value
  FROM card_field_values v
  JOIN template_fields tf ON tf.id = v.field_id
 WHERE v.card_id = ? AND tf.local = 0
 ORDER BY tf.pos, v.field_id`;

const WRITE = `UPDATE cards SET search_text = ? WHERE id = ? AND search_text IS NOT ?`;

function decode(options: string | null): Record<string, unknown> {
  if (options === null || options === "") return {};
  try {
    return JSON.parse(options) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function cardSearchText(db: SqliteHandle, cardId: string): string | null {
  const card = db.prepare(CARD).get(cardId) as
    | { content: string | null; template_id: string | null }
    | undefined;
  if (card === undefined) return null;

  const fields: GeneratorField[] =
    card.template_id === null
      ? []
      : (
          db.prepare(FIELDS).all(card.template_id) as {
            id: string;
            name: string;
            type: string;
            source_field_id: string | null;
            options: string | null;
          }[]
        ).map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type,
          sourceFieldId: row.source_field_id,
          options: decode(row.options),
        }));

  const values = new Map<string, string>();
  for (const row of db.prepare(VALUES).all(cardId) as { field_id: string; value: string }[]) {
    values.set(row.field_id, row.value);
  }

  const context: FieldContext = {
    fields,
    values,
    resolveGenerated: (request) => resolveDescriptorText(db, request),
  };
  const generated: string[] = [];
  for (const field of fields) {
    const request = fieldGenerationRequest(field, context);
    if (request === null || !INDEXED_KINDS.has(request.kind)) continue;
    const text = resolveDescriptorText(db, request);
    if (text !== null && text.trim() !== "") generated.push(text);
  }

  return renderPlainTextParts([card.content, ...values.values(), ...generated]);
}

export function refreshSearchText(db: SqliteHandle, cardIds: Iterable<string>): number {
  const write = db.prepare(WRITE);
  let changed = 0;
  for (const cardId of new Set(cardIds)) {
    const text = cardSearchText(db, cardId);
    if (text === null) continue;
    changed += write.run(text, cardId, text).changes;
  }
  return changed;
}
