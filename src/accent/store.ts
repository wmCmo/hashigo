import type { Db } from "../db/index.js";
import { accentKey } from "./key.js";

export type AccentType = "平板" | "頭高" | "中高" | "尾高";
export type AccentBasis = "probe" | "bare" | "multi-phrase" | "manual" | "guarded";

export interface AccentRow {
  readonly text: string;
  readonly analyser: string;
  readonly version: string;
  readonly probe: string;
  readonly phrases: readonly (readonly [number, number])[];
  readonly type: AccentType | null;
  readonly accentType: number | null;
  readonly reading: string | null;
  readonly basis: AccentBasis;
  readonly note?: string | null;
}

const INSERT = `
  INSERT INTO accents
    (text, analyser, version, probe, phrases, type, accent_type, reading, basis, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (text, analyser, version, probe) DO UPDATE SET
    phrases = excluded.phrases, type = excluded.type,
    accent_type = excluded.accent_type, reading = excluded.reading,
    basis = excluded.basis, note = excluded.note`;

export interface LoadReport {
  readonly inserted: number;
  readonly labelled: number;
  readonly guarded: number;
  readonly byType: Readonly<Record<string, number>>;
}

export function loadAccents(db: Db, rows: readonly AccentRow[]): LoadReport {
  const insert = db.prepare(INSERT);
  const byType: Record<string, number> = {};
  let inserted = 0;
  let labelled = 0;
  let guarded = 0;
  db.transaction(() => {
    for (const row of rows) {
      const isGuarded = row.basis === "guarded" || row.type === null;
      insert.run(
        row.text,
        row.analyser,
        row.version,
        row.probe,
        JSON.stringify(row.phrases),
        isGuarded ? null : row.type,
        isGuarded ? null : row.accentType,
        row.reading ?? null,
        isGuarded ? "guarded" : row.basis,
        row.note ?? null,
      );
      inserted += 1;
      if (isGuarded) guarded += 1;
      else {
        labelled += 1;
        byType[row.type as string] = (byType[row.type as string] ?? 0) + 1;
      }
    }
  })();
  return { inserted, labelled, guarded, byType };
}

export interface ResolvedAccent {
  readonly text: string;
  readonly type: AccentType | null;
  readonly accentType: number | null;
  readonly phrases: readonly (readonly [number, number])[];
  readonly reading: string | null;
  readonly basis: AccentBasis;
  readonly analyser: string;
  readonly note: string | null;
}

const RESOLVE = `
  SELECT text, type, accent_type, phrases, reading, basis, analyser, note
    FROM accent_resolved WHERE text = ?`;

export function accentFor(db: Db, value: string): ResolvedAccent | null {
  const row = db.prepare(RESOLVE).get(accentKey(value)) as
    | {
        text: string;
        type: AccentType | null;
        accent_type: number | null;
        phrases: string;
        reading: string | null;
        basis: AccentBasis;
        analyser: string;
        note: string | null;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    text: row.text,
    type: row.type,
    accentType: row.accent_type,
    phrases: JSON.parse(row.phrases) as (readonly [number, number])[],
    reading: row.reading,
    basis: row.basis,
    analyser: row.analyser,
    note: row.note,
  };
}

export function setManualAccent(
  db: Db,
  value: string,
  accent: { readonly type: AccentType; readonly accentType: number; readonly note?: string },
): void {
  loadAccents(db, [
    {
      text: accentKey(value),
      analyser: "manual",
      version: "",
      probe: "",
      phrases: [],
      type: accent.type,
      accentType: accent.accentType,
      reading: null,
      basis: "manual",
      note: accent.note ?? null,
    },
  ]);
}

export function accentLabel(type: AccentType, accentType: number | null): string {
  return type === "中高" && accentType !== null ? `${type} (${accentType})` : type;
}

export function primaryLabelFor(db: Db, value: string): string | null {
  const row = db
    .prepare(
      `SELECT type, accent_type FROM accents
        WHERE text = ? AND analyser = 'openjtalk' AND type IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(accentKey(value)) as { type: AccentType; accent_type: number } | undefined;
  return row === undefined ? null : accentLabel(row.type, row.accent_type);
}

export interface MaterialiseReport {
  readonly written: number;
  readonly unchanged: number;
  readonly underived: number;
  readonly guarded: number;
  readonly byType: Readonly<Record<string, number>>;
}

export function materialiseAccents(
  db: Db,
  options: {
    readonly dryRun?: boolean;
    readonly cardOverrides?: ReadonlyMap<string, { readonly type: AccentType; readonly accentType: number }>;
  } = {},
): MaterialiseReport {
  const fields = db
    .prepare(
      `SELECT f.template_id, f.id AS field_id, f.source_field_id
         FROM template_fields f WHERE f.type = 'accent'`,
    )
    .all() as { template_id: string; field_id: string; source_field_id: string | null }[];

  const upsert = db.prepare(
    `INSERT INTO card_field_values (card_id, field_id, value)
     VALUES (?, ?, ?)
     ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value`,
  );
  const existing = db.prepare(
    "SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?",
  );

  let written = 0;
  let unchanged = 0;
  let underived = 0;
  let guarded = 0;
  const byType: Record<string, number> = {};

  for (const field of fields) {
    if (field.source_field_id === null) continue;
    const cards = db
      .prepare(
        `SELECT c.id, v.value FROM cards c
           JOIN card_field_values v ON v.card_id = c.id AND v.field_id = ?
          WHERE c.template_id = ? AND v.value <> ''`,
      )
      .all(field.source_field_id, field.template_id) as { id: string; value: string }[];

    for (const card of cards) {
      const accent = options.cardOverrides?.get(card.id) ?? accentFor(db, card.value);
      if (accent === null) {
        underived += 1;
        continue;
      }
      if (accent.type === null) {
        guarded += 1;
        continue;
      }
      byType[accent.type] = (byType[accent.type] ?? 0) + 1;
      const label = accentLabel(accent.type, accent.accentType);
      const current = (existing.get(card.id, field.field_id) as { value: string } | undefined)?.value;
      if (current === label) {
        unchanged += 1;
        continue;
      }
      if (options.dryRun !== true) upsert.run(card.id, field.field_id, label);
      written += 1;
    }
  }

  return { written, unchanged, underived, guarded, byType };
}
