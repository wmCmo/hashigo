import { loadCard } from "../cards/index.js";
import type { Db } from "../db/index.js";
import { fieldWithRole } from "../fields/roles.js";
import { yomiFieldId } from "../fields/yomi.js";
import { accentKey, readingLooksUnanalysed } from "./key.js";
import { loadMarks, sentenceFor, type AnnotatedLine, type SentenceRow } from "./marks.js";
import { applyOjadAdjudications, cardAccentOverrides } from "./ojad.js";
import { toHiragana } from "./sentence.js";
import { accentFor, accentLabel, loadAccents, type AccentRow } from "./store.js";

export interface FillItem {
  readonly cardId: string;
  readonly key: string;
  readonly labelField: string | null;
  readonly yomiField: string | null;
  readonly ojad: SentenceRow | null;
  readonly sentencePending: boolean;
}

export interface DeriveResult {
  readonly openjtalk: DerivedLine;
  readonly unidic: DerivedLine | null;
  readonly kana: string | null;
  readonly pron: string | null;
}

export interface DerivedLine {
  readonly value: string;
  readonly ok: boolean;
  readonly basis: string;
  readonly type: string | null;
  readonly accent_type: number | null;
  readonly phrases: readonly (readonly [number, number])[];
  readonly reading: string;
  readonly version: string;
  readonly probe: string;
  readonly analyser?: string;
  readonly reason?: string | null;
}

const KANJI = /\p{Script=Han}/u;

const value = (db: Db, cardId: string, fieldId: string): string =>
  ((db.prepare("SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?").get(cardId, fieldId) as
    | { value: string }
    | undefined)?.value ?? "").trim();

function ojadIsEmpty(db: Db, cardId: string): boolean {
  const marks = fieldWithRole(loadCard(db, cardId)?.template?.fields ?? [], "ojad");
  return marks !== null && value(db, cardId, marks.id) === "";
}

export function planAccentFill(db: Db, cardIds?: readonly string[]): FillItem[] {
  const fields = db
    .prepare(
      `SELECT template_id, id, source_field_id FROM template_fields
        WHERE type = 'accent' AND source_field_id IS NOT NULL`,
    )
    .all() as { template_id: string; id: string; source_field_id: string }[];
  const items: FillItem[] = [];
  for (const field of fields) {
    const cards =
      cardIds === undefined
        ? (db
            .prepare("SELECT id FROM cards WHERE template_id = ? AND local = 1 AND archived = 0")
            .all(field.template_id) as { id: string }[])
        : cardIds
            .filter(
              (id) =>
                db.prepare("SELECT 1 FROM cards WHERE id = ? AND template_id = ?").get(id, field.template_id) !==
                undefined,
            )
            .map((id) => ({ id }));
    const yomi = yomiFieldId(db, field.template_id);
    for (const { id } of cards) {
      const head = value(db, id, field.source_field_id);
      const key = head === "" ? "" : accentKey(head);
      if (key === "") continue;
      const labelField = value(db, id, field.id) === "" ? field.id : null;
      const yomiField =
        yomi !== null && KANJI.test(key) && value(db, id, yomi) === "" ? yomi : null;
      const found = sentenceFor(db, id);
      const ojad = found.status === "ok" && value(db, id, found.row.fieldId) === "" ? found.row : null;
      const sentencePending = found.status === "ungenerated" && ojadIsEmpty(db, id);
      if (labelField === null && yomiField === null && ojad === null && !sentencePending) continue;
      items.push({ cardId: id, key, labelField, yomiField, ojad, sentencePending });
    }
  }
  return items;
}

function toRow(line: DerivedLine): AccentRow {
  const bad = line.ok && readingLooksUnanalysed(line.reading);
  const guarded = !line.ok || bad;
  return {
    text: line.value,
    analyser: line.analyser ?? "openjtalk",
    version: line.version,
    probe: line.probe,
    phrases: guarded ? [] : line.phrases,
    type: guarded ? null : (line.type as AccentRow["type"]),
    accentType: guarded ? null : line.accent_type,
    reading: line.reading === "" ? null : line.reading,
    basis: guarded ? "guarded" : (line.basis as AccentRow["basis"]),
    note: bad ? `analyser returned kanji in the reading: ${line.reading}` : (line.reason ?? null),
  };
}

const katakana = (text: string): string =>
  [...text].map((ch) => {
    const code = ch.codePointAt(0) as number;
    return code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : ch;
  }).join("");

export interface FillReport {
  readonly labels: number;
  readonly yomi: number;
  readonly ojad: number;
  readonly unlabelled: number;
}

export function applyAccentFill(
  db: Db,
  items: readonly FillItem[],
  derived: ReadonlyMap<string, DeriveResult>,
  lines: readonly AnnotatedLine[],
): FillReport {
  const rows: AccentRow[] = [];
  for (const result of derived.values()) {
    rows.push(toRow(result.openjtalk));
    if (result.unidic !== null) rows.push(toRow(result.unidic));
  }
  if (rows.length > 0) loadAccents(db, rows);
  applyOjadAdjudications(db);
  const overrides = cardAccentOverrides();

  const write = db.prepare(
    `INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?)
     ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value
       WHERE trim(card_field_values.value) = ''`,
  );
  let labels = 0;
  let yomi = 0;
  let unlabelled = 0;
  db.transaction(() => {
    for (const item of items) {
      if (item.labelField !== null) {
        const accent = overrides.get(item.cardId) ?? accentFor(db, item.key);
        if (accent?.type == null) unlabelled += 1;
        else if (write.run(item.cardId, item.labelField, accentLabel(accent.type, accent.accentType)).changes > 0) {
          labels += 1;
        }
      }
      if (item.yomiField !== null) {
        const result = derived.get(item.key);
        const spoken = result?.openjtalk.reading ?? "";
        if (result?.kana && result.pron && spoken !== "" && katakana(spoken) === katakana(result.pron)) {
          if (write.run(item.cardId, item.yomiField, toHiragana(result.kana)).changes > 0) yomi += 1;
        }
      }
    }
  })();
  const sentences = items.flatMap((item) => (item.ojad === null ? [] : [item.ojad]));
  const marks = sentences.length === 0 ? { written: 0 } : loadMarks(db, lines, sentences);
  return { labels, yomi, ojad: marks.written, unlabelled };
}
