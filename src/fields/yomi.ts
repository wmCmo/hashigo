import { ROLE_KEY } from "./roles.js";

export const YOMI_FIELD = "読み";

interface Reads {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

const IS_READING = `(json_extract(CASE WHEN json_valid(f.options) THEN f.options END, '$."${ROLE_KEY}"') = 'reading'
   OR (f.type = 'plain' AND trim(f.name) = ?))`;
const READING_FIRST = `CASE WHEN json_extract(CASE WHEN json_valid(f.options) THEN f.options END, '$."${ROLE_KEY}"') = 'reading' THEN 0 ELSE 1 END`;

export function yomiFieldId(db: Reads, templateId: string): string | null {
  const row = db
    .prepare(
      `SELECT f.id AS id FROM template_fields f
        WHERE f.template_id = ? AND ${IS_READING}
        ORDER BY ${READING_FIRST}, f.pos LIMIT 1`,
    )
    .all(templateId, YOMI_FIELD)[0] as { id: string } | undefined;
  return row?.id ?? null;
}

export function yomiOf(db: Reads, cardId: string): string | null {
  const row = db
    .prepare(
      `SELECT v.value AS value FROM card_field_values v
         JOIN cards c ON c.id = v.card_id
         JOIN template_fields f ON f.template_id = c.template_id AND f.id = v.field_id
        WHERE v.card_id = ? AND ${IS_READING} AND trim(v.value) <> ''
        ORDER BY ${READING_FIRST}, f.pos LIMIT 1`,
    )
    .all(cardId, YOMI_FIELD)[0] as { value: string } | undefined;
  return row === undefined ? null : row.value.trim();
}
