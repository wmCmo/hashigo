/**
 * FILL `型`, `読み` AND `OJAD` ON A CARD MADE IN THE APP — from the laptop's helper.
 *
 * Zach, 2026-10-26, over 包帯 with no reading and no 型: *"i have to fill them
 * myself?"* — and then *"can't it just use my laptop automatically?"*. The
 * analysers only run in Python (`tools/accent_helper.py`); this is the database
 * half, run in the app's worker with the helper's answers.
 *
 * ─── THE SAME RULES AS THE BATCH RUN, NOT NEW ONES ──────────────────────────
 *
 *   · `型`: the helper's rows go through `loadAccents` exactly as `cli.ts load`
 *     does (including its "reading came back unanalysed" refusal), the hand
 *     adjudications are applied, and the label is `accentFor` → `accentLabel`:
 *     a manual answer first, else OpenJTalk's. UniDic is stored for the
 *     disagreement view and never decides (decision 8). A guarded word gets no
 *     label, never a guess.
 *   · `OJAD`: `sentenceFor` (the batch run's own per-card path) and `loadMarks`.
 *   · `読み`: NEW here, so its rule is stated: only on a head word with kanji, and
 *     only when OpenJTalk's reading and UniDic's pronunciation of the word as ONE
 *     token agree. Then UniDic's written kana (`ホウタイ`, not the spoken `ホータイ`)
 *     goes in, as hiragana. Disagreement leaves it empty — a wrong reading is the
 *     answer on a `Reading = true` card.
 *
 * ─── NEVER OVER ANYTHING HE WROTE ───────────────────────────────────────────
 *
 * Only EMPTY values are filled. `型` and `読み` are fields he edits, and this
 * runs on every boot; a value present is his, or an earlier fill's, and either
 * way is not this function's to change.
 *
 * `読み` does not move a generation: in the app it feeds the furigana fallback and
 * the redo dialog's alias, never a generator's identity — checked before this was
 * written, because changing an identity after the clip exists orphans the clip.
 */
import type { Db } from "../db/index.js";
import { yomiFieldId } from "../fields/yomi.js";
import { accentKey, readingLooksUnanalysed } from "./key.js";
import { loadMarks, sentenceFor, type AnnotatedLine, type SentenceRow } from "./marks.js";
import { applyOjadAdjudications, cardAccentOverrides } from "./ojad.js";
import { toHiragana } from "./sentence.js";
import { accentFor, accentLabel, loadAccents, type AccentRow } from "./store.js";

/** What one card is missing, and where each answer goes. */
export interface FillItem {
  readonly cardId: string;
  /** `accentKey` of the head word — what the helper is asked about. */
  readonly key: string;
  /** The `型` field to fill, or null when it already has a value. */
  readonly labelField: string | null;
  /** The `読み` field to fill, or null. */
  readonly yomiField: string | null;
  /** The sentence to annotate, or null (filled already, or not generated yet). */
  readonly ojad: SentenceRow | null;
}

/** One line of `tools/accent_helper.py`'s `/derive` reply. */
export interface DeriveResult {
  readonly openjtalk: DerivedLine;
  readonly unidic: DerivedLine | null;
  /** UniDic's written kana for the word as one token (`ホウタイ`), else null. */
  readonly kana: string | null;
  /** UniDic's spoken form (`ホータイ`), to compare with OpenJTalk's reading. */
  readonly pron: string | null;
}

/** The shape `accent_derive.py` / `accent_crosscheck.py` write, one per line. */
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

/**
 * What needs filling. With `cardIds`, those cards; without, every live card made
 * in the app (`local = 1`) — the imported ones were filled by the batch run.
 */
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
      if (labelField === null && yomiField === null && ojad === null) continue;
      items.push({ cardId: id, key, labelField, yomiField, ojad });
    }
  }
  return items;
}

/** The `AccentRow` `cli.ts load` would build from one line — the same refusals. */
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
  /** Cards whose 型 stayed empty: the rule refused, or nothing was derived. */
  readonly unlabelled: number;
}

/**
 * Write what the helper answered. `derived` is keyed by `FillItem.key`, `lines`
 * by sentence text — the helper's replies, unaltered.
 */
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
  // The hand adjudications may postdate this device's seed; idempotent, 75 rows.
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
