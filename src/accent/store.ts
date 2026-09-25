/**
 * The `accents` table: loading derivations in, resolving them out, and
 * materialising `<<型>>`.
 *
 * `<<型>>` is Zach's idea, and it is now also the error-detection mechanism for
 * the whole pipeline: **a wrong LABEL is visible where a wrong CONTOUR is
 * silently absorbed.** He can hear that 橋 sounds off; he can SEE that it says
 * 平板 when he expects 尾高. That is the only cheap check on 3,850 derivations,
 * which is why the label is worth materialising even though the audio is not.
 *
 * MATERIALISED, unlike audio, and the asymmetry is deliberate. Audio changes
 * when the provider changes and is large, so it resolves on demand. A label is
 * four bytes, changes only when the analyser or a human says so, and needs to be
 * searchable — `search_text` cannot index something computed at render time.
 *
 * THE OVERRIDE NEVER LIVES IN `card_field_values`. That table is authored text,
 * verbatim, and re-running the materialiser must not be able to destroy a human
 * correction. So corrections are `analyser = 'manual'` rows here, which
 * `accent_resolved` prefers outright, and the materialiser only ever writes the
 * resolved answer into the render cache.
 */

import type { Db } from "../db/index.js";
import { accentKey } from "./key.js";

export type AccentType = "平板" | "頭高" | "中高" | "尾高";
export type AccentBasis = "probe" | "bare" | "multi-phrase" | "manual" | "guarded";

export interface AccentRow {
  readonly text: string;
  readonly analyser: string;
  readonly version: string;
  readonly probe: string;
  /** One `[morae, accentPosition]` per accent phrase. */
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

/**
 * Load derivations. Idempotent on (text, analyser, version, probe), so
 * re-deriving with the same analyser version overwrites rather than accumulating
 * — and re-deriving with a NEW version adds a row the view will prefer, leaving
 * the old answer auditable instead of destroyed.
 */
export function loadAccents(db: Db, rows: readonly AccentRow[]): LoadReport {
  const insert = db.prepare(INSERT);
  const byType: Record<string, number> = {};
  let inserted = 0;
  let labelled = 0;
  let guarded = 0;
  db.transaction(() => {
    for (const row of rows) {
      // The CHECK constraints refuse a refusal that carries a type, and vice
      // versa. Normalising here rather than letting SQLite raise means a bad
      // input row is reported as guarded, not as a crashed load of 3,850.
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

/**
 * The accent for a string, or null when nothing has been derived for it.
 *
 * A `guarded` row is RETURNED, not treated as absent. "The rule refused" and
 * "nobody has looked" are different states and the caller must be able to tell
 * them apart — collapsing them is the miss-as-silence defect again.
 */
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

/** Record a human correction. It beats every analyser, in the view, outright. */
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
      // A human states the type, not a phrase decomposition. Recording an empty
      // list is honest; inventing morae counts to fill the column would put a
      // guess where the schema promises a measurement.
      phrases: [],
      type: accent.type,
      accentType: accent.accentType,
      reading: null,
      basis: "manual",
      note: accent.note ?? null,
    },
  ]);
}

// ─── the label ───────────────────────────────────────────────────────────────

/**
 * What `<<型>>` actually says on the card.
 *
 * ZACH'S RULE, and it is right for a reason worth stating: the number is only
 * information for 中高. Everywhere else it is derivable from the label itself, so
 * printing it is noise on the one screen where noise costs the most.
 *
 *     平板   accent is always 0 by definition
 *     頭高   always 1
 *     尾高   always the LAST mora, so the number just restates the word length
 *     中高   2 .. n-1, and WHICH one is the whole question
 *
 * So 中高 renders `中高 (3)` and the other three render bare. On this corpus that
 * is 910 cards carrying a number and 2,906 not.
 */
export function accentLabel(type: AccentType, accentType: number | null): string {
  return type === "中高" && accentType !== null ? `${type} (${accentType})` : type;
}

/**
 * 一次解析 (OpenJTalk) だけが言うラベル。人の裁定を無視した値。
 *
 * 端末に既にある `型` が「裁定より前にパイプラインが書いたもの」かどうかを見分ける
 * ために要る — `app/local-fields.ts` の compare-and-swap の `was` がこれ。refused なら
 * null (その語にラベルは書かれていなかった)。
 */
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

// ─── materialising <<型>> ────────────────────────────────────────────────────

export interface MaterialiseReport {
  /** Cards whose 型 value was written or updated. */
  readonly written: number;
  /** Already correct, so nothing was written. */
  readonly unchanged: number;
  /** No accent derived for the head word at all — nobody has looked yet. */
  readonly underived: number;
  /** Derived, but the rule refused. Left EMPTY rather than guessed. */
  readonly guarded: number;
  readonly byType: Readonly<Record<string, number>>;
}

/**
 * Write the resolved label into `card_field_values` for every card whose
 * template has an `accent`-typed field.
 *
 * A guarded word writes NOTHING and is counted. Writing 不明 or an empty label
 * would be indistinguishable from "not yet derived" on screen, and the whole
 * value of `<<型>>` is that it is visibly wrong when the pipeline is wrong.
 */
export function materialiseAccents(
  db: Db,
  options: {
    readonly dryRun?: boolean;
    /**
     * カード単位の裁定 (`CARD_ADJUDICATIONS`)。語の解決より先に見る。決定 22 の
     * 同形語は文字列に一つのラベルが正しくないので、語の単位ではなくここで来る。
     */
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
    // The head word is whatever the accent field points at. No source pointer
    // means nothing to derive from, which is a template defect rather than a
    // card one — counted, not guessed at.
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
