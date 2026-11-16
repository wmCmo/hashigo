import { loadCard } from "../cards/index.js";
import type { Db } from "../db/index.js";
import { fieldWithRole, ROLE_KEY, withRole } from "../fields/index.js";
import {
  fieldGenerationRequest,
  resolveDescriptorText,
  storeTextResolver,
  stripThinking,
} from "../generate/index.js";
import { applyReadingOverrides, cleanSentence, MARKS_FIELD, parseAnnotation } from "./sentence.js";

export { MARKS_FIELD } from "./sentence.js";

export const OJAD_SCOPE = {
  templates: ["単語", "言葉"],
  sentenceFields: ["例文", "Example"],
} as const;

const SENTENCE_CARDS_SQL = `
SELECT c.id AS cardId
  FROM cards c
  JOIN template_fields f ON f.template_id = c.template_id
 WHERE json_extract(f.options, '$."${ROLE_KEY}"') = 'ojad'
   AND f.source_field_id IS NOT NULL
   AND c.archived = 0
 ORDER BY c.id`;

export interface SentenceRow {
  readonly cardId: string;
  readonly sentence: string;
  readonly fieldId: string;
}

export interface ExtractReport {
  readonly cards: number;
  readonly clean: SentenceRow[];
  readonly ungenerated: number;
  readonly refused: number;
  readonly overridden: number;
}

export function extractSentences(db: Db): ExtractReport {
  const cards = db.prepare(SENTENCE_CARDS_SQL).all() as { cardId: string }[];
  const clean: SentenceRow[] = [];
  let ungenerated = 0;
  let refused = 0;
  let overridden = 0;

  for (const { cardId } of cards) {
    const found = sentenceFor(db, cardId);
    if (found.status === "ungenerated") ungenerated += 1;
    else if (found.status === "refused") refused += 1;
    else if (found.status === "ok") {
      if (found.overridden) overridden += 1;
      clean.push(found.row);
    }
  }
  return { cards: cards.length, clean, ungenerated, refused, overridden };
}

export function sentenceFor(
  db: Db,
  cardId: string,
):
  | { readonly status: "ok"; readonly row: SentenceRow; readonly overridden: boolean }
  | { readonly status: "none" | "ungenerated" | "refused" } {
  const card = loadCard(db, cardId);
  if (card?.template == null) return { status: "none" };
  const marks = fieldWithRole(card.template.fields, "ojad");
  const sourceId = marks?.sourceFieldId ?? null;
  const field = card.template.fields.find((candidate) => candidate.id === sourceId);
  if (marks === null || field === undefined) return { status: "none" };

  const context = {
    fields: card.template.fields,
    values: card.values,
    resolveGenerated: storeTextResolver(db),
  };
  const request = fieldGenerationRequest(field, context);
  if (request === null) return { status: "ungenerated" };
  const generated = resolveDescriptorText(db, request);
  if (generated === null) return { status: "ungenerated" };
  const cleaned = cleanSentence(stripThinking(generated));
  if (cleaned === null) return { status: "refused" };
  const sentence = applyReadingOverrides(cleaned);
  return { status: "ok", row: { cardId, sentence, fieldId: marks.id }, overridden: sentence !== cleaned };
}

export interface AnnotatedLine {
  readonly text: string;
  readonly ok: boolean;
  readonly marks?: string;
  readonly why?: string;
}

export interface LoadReport {
  written: number;
  skipped: number;
  malformed: number;
  unannotated: number;
}

export function loadMarks(
  db: Db,
  lines: readonly AnnotatedLine[],
  sentences: readonly SentenceRow[],
): LoadReport {
  const report: LoadReport = { written: 0, skipped: 0, malformed: 0, unannotated: 0 };
  const bySentence = new Map<string, string>();
  for (const line of lines) {
    if (!line.ok || line.marks === undefined) continue;
    try {
      parseAnnotation(line.marks);
    } catch {
      report.malformed += 1;
      continue;
    }
    bySentence.set(line.text, line.marks);
  }

  const write = db.prepare(
    `INSERT INTO card_field_values (card_id, field_id, value)
     VALUES (?, ?, ?)
     ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value
       WHERE card_field_values.value IS NOT excluded.value`,
  );
  const run = db.transaction((rows: readonly SentenceRow[]) => {
    for (const row of rows) {
      const marks = bySentence.get(row.sentence);
      if (marks === undefined) {
        report.unannotated += 1;
        continue;
      }
      const result = write.run(row.cardId, row.fieldId, marks);
      if (result.changes > 0) report.written += 1;
      else report.skipped += 1;
    }
  });
  run(sentences);
  return report;
}

export function declareField(db: Db): number {
  const templateMarks = OJAD_SCOPE.templates.map(() => "?").join(", ");
  const fieldMarks = OJAD_SCOPE.sentenceFields.map(() => "?").join(", ");
  const templates = db
    .prepare(
      `SELECT f.template_id AS templateId, f.id AS sentenceId
         FROM template_fields f
         JOIN templates t ON t.id = f.template_id
        WHERE t.name IN (${templateMarks}) AND f.name IN (${fieldMarks}) AND f.type = 'ai'`,
    )
    .all(...OJAD_SCOPE.templates, ...OJAD_SCOPE.sentenceFields) as {
    templateId: string;
    sentenceId: string;
  }[];
  const existing = db.prepare(
    "SELECT options FROM template_fields WHERE template_id = ? AND id = ?",
  );
  const insert = db.prepare(
    `INSERT INTO template_fields
       (template_id, id, name, type, source_field_id, options, pos, local)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const update = db.prepare(
    `UPDATE template_fields
        SET source_field_id = ?, options = ?, local = 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE template_id = ? AND id = ?
        AND (source_field_id IS NOT ? OR options IS NOT ?)`,
  );
  let declared = 0;
  for (const { templateId, sentenceId } of templates) {
    const row = existing.get(templateId, MARKS_FIELD.id) as { options: string | null } | undefined;
    let options: Record<string, unknown> = {};
    try {
      options = JSON.parse(row?.options ?? "{}") as Record<string, unknown>;
    } catch {
      options = {};
    }
    const next = JSON.stringify(withRole(options, "ojad"));
    if (row === undefined) {
      insert.run(templateId, MARKS_FIELD.id, MARKS_FIELD.name, MARKS_FIELD.type, sentenceId, next, "zz-ojad");
    } else {
      update.run(sentenceId, next, templateId, MARKS_FIELD.id, sentenceId, next);
    }
    declared += 1;
  }
  return declared;
}
