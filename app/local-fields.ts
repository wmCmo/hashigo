export interface FieldsStatement {
  all(...params: readonly unknown[]): unknown[];
  get(...params: readonly unknown[]): unknown;
  run(...params: readonly unknown[]): { changes?: number } | unknown;
}
export interface FieldsDb {
  prepare(sql: string): FieldsStatement;
}

export interface LocalFieldRow {
  readonly template_id: string;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly source_field_id: string | null;
  readonly options: string | null;
  readonly pos: number;
}

export interface LocalValueRow {
  readonly card_id: string;
  readonly field_id: string;
  readonly value: string;
}

export interface LocalCorrectionRow {
  readonly card_id: string;
  readonly field_id: string;
  readonly was: string;
  readonly value: string;
}

export interface MergeReport {
  readonly added: number;
  readonly differs: number;
  readonly corrected: number;
  readonly unknownCards: number;
  readonly fields: number;
}

const SELECT_FIELDS = `SELECT template_id, id, name, type, source_field_id, options, pos
                         FROM local_fields`;
const SELECT_VALUES = `SELECT card_id, field_id, value FROM local_values`;
const SELECT_CORRECTIONS = `SELECT card_id, field_id, was, value FROM local_corrections`;
const HAS_CORRECTIONS = `SELECT 1 AS n FROM sqlite_master
                          WHERE type = 'table' AND name = 'local_corrections'`;

export const COUNT_HELD = `SELECT count(*) AS n FROM card_field_values v
                             JOIN cards c ON c.id = v.card_id
                             JOIN template_fields f ON f.template_id = c.template_id
                                                   AND f.id = v.field_id
                            WHERE f.local = 1`;

export function mergeLocalFields(
  db: FieldsDb,
  fields: readonly LocalFieldRow[],
  values: readonly LocalValueRow[],
  corrections: readonly LocalCorrectionRow[] = [],
): MergeReport {
  const putField = db.prepare(
    `INSERT INTO template_fields
       (template_id, id, name, type, source_field_id, options, pos, local)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (template_id, id) DO NOTHING`,
  );
  const putValue = db.prepare(
    `INSERT INTO card_field_values (card_id, field_id, value)
     VALUES (?, ?, ?)
     ON CONFLICT (card_id, field_id) DO NOTHING`,
  );
  const knownCard = db.prepare("SELECT 1 AS n FROM cards WHERE id = ? LIMIT 1");
  const heldValue = db.prepare(
    "SELECT value AS v FROM card_field_values WHERE card_id = ? AND field_id = ?",
  );
  const swap = db.prepare(
    `UPDATE card_field_values SET value = ?
      WHERE card_id = ? AND field_id = ? AND value = ?`,
  );
  const changed = (result: unknown): number => Number((result as { changes?: number }).changes ?? 0);
  const correctionFor = new Map(corrections.map((c) => [`${c.card_id}|${c.field_id}`, c]));

  let fieldCount = 0;
  for (const row of fields) {
    fieldCount += changed(
      putField.run(
        row.template_id,
        row.id,
        row.name,
        row.type,
        row.source_field_id ?? null,
        row.options ?? null,
        row.pos,
      ),
    );
  }

  let added = 0;
  let differs = 0;
  let corrected = 0;
  let unknownCards = 0;
  for (const row of values) {
    if (knownCard.get(row.card_id) === undefined) {
      unknownCards += 1;
      continue;
    }
    if (changed(putValue.run(row.card_id, row.field_id, row.value)) > 0) {
      added += 1;
      continue;
    }
    const held = heldValue.get(row.card_id, row.field_id) as { v: string } | undefined;
    if (held === undefined || held.v === row.value) continue;
    const fix = correctionFor.get(`${row.card_id}|${row.field_id}`);
    if (fix !== undefined && fix.value === row.value && held.v === fix.was) {
      corrected += changed(swap.run(fix.value, row.card_id, row.field_id, fix.was));
      continue;
    }
    differs += 1;
  }
  return { added, differs, corrected, unknownCards, fields: fieldCount };
}

export function reapplyCorrections(db: FieldsDb, corrections: readonly LocalCorrectionRow[]): number {
  if (corrections.length === 0) return 0;
  const swap = db.prepare(
    `UPDATE card_field_values SET value = ?
      WHERE card_id = ? AND field_id = ? AND value = ?`,
  );
  let fixed = 0;
  for (const c of corrections) {
    fixed += Number((swap.run(c.value, c.card_id, c.field_id, c.was) as { changes?: number }).changes ?? 0);
  }
  return fixed;
}

export function readSeedFields(seed: FieldsDb): {
  fields: LocalFieldRow[];
  values: LocalValueRow[];
  corrections: LocalCorrectionRow[];
} {
  return {
    fields: seed.prepare(SELECT_FIELDS).all() as LocalFieldRow[],
    values: seed.prepare(SELECT_VALUES).all() as LocalValueRow[],
    corrections:
      seed.prepare(HAS_CORRECTIONS).get() === undefined
        ? []
        : (seed.prepare(SELECT_CORRECTIONS).all() as LocalCorrectionRow[]),
  };
}
