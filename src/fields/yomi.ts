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

export const YOMI_FIELD = "読み";

interface Reads {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/** The `読み` field's id on a template, or null when it declares none. */
export function yomiFieldId(db: Reads, templateId: string): string | null {
  const row = db
    .prepare("SELECT id FROM template_fields WHERE template_id = ? AND trim(name) = ?")
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
        WHERE v.card_id = ? AND trim(f.name) = ? AND trim(v.value) <> '' LIMIT 1`,
    )
    .all(cardId, YOMI_FIELD)[0] as { value: string } | undefined;
  return row === undefined ? null : row.value.trim();
}
