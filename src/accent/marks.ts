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
import {
  fieldGenerationRequest,
  resolveDescriptorText,
  storeTextResolver,
} from "../generate/index.js";
import { applyReadingOverrides, cleanSentence, MARKS_FIELD, parseAnnotation } from "./sentence.js";

export { MARKS_FIELD } from "./sentence.js";

/** Cards that could carry one. The sentence itself is NOT in this query. */
const SENTENCE_CARDS_SQL = `
SELECT c.id AS cardId
  FROM cards c
  JOIN templates t ON t.id = c.template_id
  JOIN template_fields f ON f.template_id = c.template_id
 WHERE f.type = 'ai' AND f.name IN ('例文', 'Example')
   AND t.name IN ('単語', '言葉')
   AND c.archived = 0
 ORDER BY c.id`;

export interface SentenceRow {
  readonly cardId: string;
  readonly sentence: string;
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
    const field = card.template.fields.find(
      (candidate) => candidate.type === "ai" && (candidate.name === "例文" || candidate.name === "Example"),
    );
    if (field === undefined) continue;

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
    clean.push({ cardId, sentence });
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

  const write = db.prepare(
    `INSERT INTO card_field_values (card_id, field_id, value)
     VALUES (?, ?, ?)
     ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value`,
  );
  const run = db.transaction((rows: readonly SentenceRow[]) => {
    for (const row of rows) {
      const marks = bySentence.get(row.sentence);
      if (marks === undefined) {
        report.unannotated += 1;
        continue;
      }
      const result = write.run(row.cardId, MARKS_FIELD.id, marks);
      if (result.changes > 0) report.written += 1;
      else report.skipped += 1;
    }
  });
  run(sentences);
  return report;
}

/** Declare the local field on every template that can carry a sentence. */
export function declareField(db: Db): number {
  const templates = db
    .prepare(
      `SELECT DISTINCT t.id AS id FROM templates t
         JOIN template_fields f ON f.template_id = t.id
        WHERE f.name IN ('例文', 'Example') AND t.name IN ('単語', '言葉')`,
    )
    .all() as { id: string }[];
  const declare = db.prepare(
    `INSERT INTO template_fields
       (template_id, id, name, type, source_field_id, options, pos, local)
     VALUES (?, ?, ?, ?, NULL, '{}', ?, 1)
     ON CONFLICT (template_id, id) DO UPDATE SET
       name = excluded.name, type = excluded.type, local = 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  let declared = 0;
  for (const template of templates) {
    declare.run(template.id, MARKS_FIELD.id, MARKS_FIELD.name, MARKS_FIELD.type, "zz-ojad");
    declared += 1;
  }
  return declared;
}
