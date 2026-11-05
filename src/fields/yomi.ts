/**
 * `読み` — THE ONE PLACE ITS NAME IS WRITTEN.
 *
 * Decision 10's explicit reading is a `local = 1` plain field matched by NAME,
 * and until 2026-10-29 that name was typed into three SQL strings (the furigana
 * fallback, the redo dialog's alias, the accent helper's fill). A rename would
 * have broken all three silently — the failure that moved `ojad` and `出典` onto
 * roles. It stays a name, because the field carries no role in anyone's data and
 * a role would need every device's templates rewritten; what changes is that the
 * name lives here, and `test/field-names.test.ts` refuses it anywhere else.
 *
 * Structural `db` type, so the app's worker, its tests and the scripts all fit.
 */

import { ROLE_KEY } from "./roles.js";

export const YOMI_FIELD = "読み";

interface Reads {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/**
 * THE ROLE FIRST, THE NAME SECOND (2026-11-05). A field carrying
 * `hashigo-role: reading` is the reading whatever it is called — the role is what
 * the field settings screen writes when he picks its kind. A local plain field
 * named `読み` with no role is still the reading, because the devices held it for
 * two months before the role existed and nothing should regress while they catch
 * up. Kept in SQL, not in `./kinds.ts`, because these run in all three runtimes
 * over a raw handle.
 */
const IS_READING = `(json_extract(CASE WHEN json_valid(f.options) THEN f.options END, '$."${ROLE_KEY}"') = 'reading'
   OR (f.type = 'plain' AND trim(f.name) = ?))`;
const READING_FIRST = `CASE WHEN json_extract(CASE WHEN json_valid(f.options) THEN f.options END, '$."${ROLE_KEY}"') = 'reading' THEN 0 ELSE 1 END`;

/** The `読み` field's id on a template, or null when it declares none. */
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

/** The card's non-empty `読み`, trimmed, or null. */
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
