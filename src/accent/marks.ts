/**
 * Stage 12's database half — getting example sentences OUT and annotations IN.
 *
 * `./sentence.ts` owns the text rules and `tools/accent_sentence.py` owns the
 * analyser. This owns the two ends that touch SQL, and it is separate from
 * `./cli.ts` for the same reason `./respeak.ts` is: the reasoning wants room,
 * and the command wants to stay a command.
 *
 * ─── THE SENTENCE IS A GENERATION, NOT A STORED VALUE ───────────────────────
 *
 * `例文` is an `ai` field with **zero** rows in `card_field_values` — the text
 * lives in `blobs`, keyed by generation identity, exactly as decision 7 requires
 * (*"a generator's input is the RENDERED text, never the stored value"*). So
 * this reads the blob, not the field, and the prompt shape is the join:
 *
 *     3,977  "Example sentence using X in Japanese (Don't translate)"
 *     1,321  "Funny or weird sentence using X in Japanese (Don't translate)"
 *       409  "Example funny or weird sentence using X in Japanese"
 *       160  "Example sentence using X in Japanese"
 *
 * ─── WHY THE ANNOTATION IS STORED PER CARD AND KEYED BY TEXT ────────────────
 *
 * Per card, because `card_field_values` is the column that already exists and a
 * new table is a schema bump (decision 41). Keyed by text at RENDER time,
 * because the renderer hands `<ojad>` its base string and nothing else — the
 * same contract `furiganaSupport.annotate(readings)` has, and for the same
 * reason: a resolved field is TEXT by the time anything downstream sees it.
 */
import { loadCard } from "../cards/index.js";
import type { Db } from "../db/index.js";
import { fieldWithRole, ROLE_KEY, withRole } from "../fields/index.js";
import {
  fieldGenerationRequest,
  resolveDescriptorText,
  storeTextResolver,
} from "../generate/index.js";
import { applyReadingOverrides, cleanSentence, MARKS_FIELD, parseAnnotation } from "./sentence.js";

export { MARKS_FIELD } from "./sentence.js";

/**
 * WHERE THE ANNOTATION IS DECLARED — the one place a name still decides anything.
 *
 * Zach's call, 2026-09-13: the reading line belongs on the accent drill and
 * nowhere else. A field name cannot express that (言葉 calls its sentence
 * `Example`, exactly as New Vocab does), so the SCOPE is these two templates and
 * the sentence field is found inside them by name — ONCE, when the field is
 * declared. `scripts/ojad-template-apply.ts` imports this rather than keeping a
 * second copy.
 *
 * ─── AND WHY THAT IS NOT THE NAME-BINDING FIELDS-AS-MODULES REMOVES ─────────
 *
 * The defect was that the PIPELINE found its input by name, in three independent
 * copies here, so renaming `例文` made `marks` report `0 written` — silence that
 * read as success. Since stage F the declaration writes what it found into the
 * data: the ojad field carries `hashigo-role: ojad` and `source_field_id` → the
 * sentence field. Everything after that — which cards, which sentence, which
 * field to write — follows the role and the pointer, the way `型` has always
 * followed `type = 'accent'`. Rename `例文` after declaring and nothing moves.
 */
export const OJAD_SCOPE = {
  templates: ["単語", "言葉"],
  sentenceFields: ["例文", "Example"],
} as const;

/**
 * Cards that could carry one: every live card on a template that declares an
 * ojad-ROLE field with a source. The sentence itself is NOT in this query.
 */
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
  /** The ojad-role field on this card's template — where its annotation goes. */
  readonly fieldId: string;
}

export interface ExtractReport {
  readonly cards: number;
  readonly clean: SentenceRow[];
  /** No generation in the store for this card's prompt. Nothing to annotate. */
  readonly ungenerated: number;
  /** Generations whose Japanese could not be isolated — see `cleanSentence`. */
  readonly refused: number;
  /** Sentences a hand-entered reading override rewrote. See `READING_OVERRIDES`. */
  readonly overridden: number;
}

/**
 * Every card's example sentence, resolved the way the SCREEN resolves it.
 *
 * ─── WHY NOT A `LIKE` OVER `blobs.source_text` ──────────────────────────────
 *
 * Because I tried that first and it was wrong in a way that looked right. The
 * prompt embeds the head word, so matching `source_text LIKE '%' || word || '%'`
 * pulls in every generation whose prompt CONTAINS the word — the "Funny or
 * weird" variant as well as the plain one, plus every longer head word that
 * contains a shorter one as a substring. It reported **17,499 sentences for
 * ~5,700 cards**, roughly three each, and a card has one.
 *
 * Decision 7 already names the right answer: *"a generator's input is the
 * RENDERED text, never the stored value."* `fieldGenerationRequest` builds the
 * same identity the renderer builds, `resolveDescriptorText` reads back exactly
 * what the card displays, and a card with two candidate generations is no longer
 * a thing this can even express.
 */
export function extractSentences(db: Db): ExtractReport {
  const cards = db.prepare(SENTENCE_CARDS_SQL).all() as { cardId: string }[];
  const clean: SentenceRow[] = [];
  let ungenerated = 0;
  let refused = 0;
  let overridden = 0;

  for (const { cardId } of cards) {
    const card = loadCard(db, cardId);
    if (card?.template == null) continue;
    // BY ROLE, then by pointer — see `OJAD_SCOPE`. No name is read here.
    const marks = fieldWithRole(card.template.fields, "ojad");
    const sourceId = marks?.sourceFieldId ?? null;
    const field = card.template.fields.find((candidate) => candidate.id === sourceId);
    if (marks === null || field === undefined) continue;

    const context = {
      fields: card.template.fields,
      values: card.values,
      resolveGenerated: storeTextResolver(db),
    };
    const request = fieldGenerationRequest(field, context);
    if (request === null) {
      ungenerated += 1;
      continue;
    }
    const generated = resolveDescriptorText(db, request);
    if (generated === null) {
      ungenerated += 1;
      continue;
    }
    const cleaned = cleanSentence(generated);
    if (cleaned === null) {
      refused += 1;
      continue;
    }
    // OVERRIDES APPLIED HERE AND NOWHERE ELSE, so the string written to the
    // analyser's input file and the string `loadMarks` looks the annotation up
    // by are the SAME string. Applying them on only one side would key every
    // overridden sentence under a text no card reports, and those cards would
    // silently end up with no annotation at all.
    const sentence = applyReadingOverrides(cleaned);
    if (sentence !== cleaned) overridden += 1;
    clean.push({ cardId, sentence, fieldId: marks.id });
  }
  return { cards: cards.length, clean, ungenerated, refused, overridden };
}

/** One line of `tools/accent_sentence.py`'s output. */
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
  /** Cards whose sentence the analyser refused. They get NO value, not a wrong one. */
  unannotated: number;
}

/**
 * Materialise the annotations onto the cards whose sentence they describe.
 *
 * **A REFUSED SENTENCE WRITES NOTHING, and that is decision 8 applied.** *"A
 * wrong accent drilled is worse than no accent."* An empty value renders as
 * nothing at all (measured for `型`: a declared field with no value substitutes
 * the empty string and shows no literal marker), so a card whose sentence could
 * not be analysed simply has no annotation line — which is honest, and visibly
 * different from one that came out 平板 throughout.
 */
export function loadMarks(
  db: Db,
  lines: readonly AnnotatedLine[],
  sentences: readonly SentenceRow[],
): LoadReport {
  const report: LoadReport = { written: 0, skipped: 0, malformed: 0, unannotated: 0 };
  const bySentence = new Map<string, string>();
  for (const line of lines) {
    if (!line.ok || line.marks === undefined) continue;
    // PARSED BEFORE IT IS STORED. The renderer is strict and runs on his phone;
    // a value that cannot be read there would be a blank field with no
    // explanation, days after the run that produced it.
    try {
      parseAnnotation(line.marks);
    } catch {
      report.malformed += 1;
      continue;
    }
    bySentence.set(line.text, line.marks);
  }

  // `WHERE value IS NOT excluded.value` IS WHAT MAKES `skipped` MEAN ANYTHING.
  //
  // Without it SQLite counts an UPDATE that writes the identical string as a
  // change, so `written` was the whole corpus on every run and `skipped` was
  // structurally zero — a line reading "3,719 written · 0 unchanged" that could
  // not distinguish a no-op re-run from the analyser having changed its mind.
  //
  // That distinction is not academic: on 2026-09-17 a re-run said exactly that,
  // and the only way to know nothing had drifted was to diff 3,710 values
  // against the last shipped seed by hand. It came back 0 — but the report
  // should have been able to say so. `IS NOT` rather than `<>` because it is
  // null-safe, and a row with a NULL value must count as different.
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

/**
 * Declare the local field on every template in `OJAD_SCOPE`, AND record in the
 * data what it is for and what it reads — the role and the source pointer.
 *
 * Idempotent, and quiet when nothing changes: the UPDATE fires only when the row
 * differs, so a re-run does not move `updated_at` and hand a sync a false "newer"
 * row (decision 33's field merge is LWW on that clock since stage C). An existing
 * row keeps its NAME — he may have renamed OJAD in the editor, and a declaration
 * is not the place to take that back.
 */
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
