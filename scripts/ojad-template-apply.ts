/**
 * Put `<ojad>` into the templates that have an example sentence.
 *
 *     npx vite-node scripts/ojad-template-apply.ts -- --db build/hashigo.db [--apply]
 *
 * ─── WHY THIS IS A SCRIPT AND NOT A MIGRATION ───────────────────────────────
 *
 * `templates.content` is Mochi's column, so decision 9's `local = 1` cannot
 * protect it — that flag protects a field we ADDED, never an EDIT to something
 * Mochi owns. `scripts/accent-field-apply.ts` says the same thing about `型` and
 * lives in the documented rebuild sequence for it. This belongs beside it, and
 * is idempotent and self-erasing for the same reason: run it twice and the
 * second run says ALREADY APPLIED.
 *
 * ─── THE ELEMENT FOLLOWS THE FIELD; IT DOES NOT WRAP IT ────────────────────
 *
 * The sentence side of 単語 is authored as a blockquote:
 *
 *     ><< 例文 >>
 *     << Translate >>
 *     << Audio >>
 *
 * The first version of this script wrapped the reference — `<ojad><< 例文
 * >></ojad>` — and it was WRONG in a way four tests caught at once. `例文` is an
 * `ai` field, so by render time `expandGeneratorFields` has turned the reference
 * into an `<ai>` element: the wrapper's children are a nested generator, not
 * text, and the wrapper also displaced the speech mount that reads the same
 * field. See `src/render/accent-marks.ts`.
 *
 * So `<ojad></ojad>` goes on its OWN LINE, directly after the sentence. It
 * renders only the marked reading, filled from the card's stored annotation, and
 * the sentence above it is untouched — which is where he reads it: *"while
 * reading the example sentence i can see hear how it's pronounced and confirm by
 * looking at the field."*
 *
 * INSIDE THE BLOCKQUOTE when the sentence is in one, because a reading that
 * escapes the quote reads as a separate paragraph about nothing.
 */
import { openDatabase } from "../src/db/index.js";
import { arg, flag } from "../src/cli/args.js";
import { OJAD_SCOPE } from "../src/accent/marks.js";

/**
 * SCOPED BY TEMPLATE, NOT BY FIELD NAME — Zach's call, 2026-09-13.
 *
 * The first version keyed on the field (`例文` / `Example`) and so reached four
 * templates: 単語, 言葉, New Vocab and Polysemy. He asked for the reading line on
 * the accent drill and nowhere else, and the field name cannot express that —
 * 言葉 calls its sentence `Example`, exactly as New Vocab does.
 *
 * These two are also the templates decision 29 scopes `identify` to: the ones
 * declaring an `accent` field. New Vocab's 1,203 cards show the head word
 * unmasked beside its clip, which is a different exercise.
 */
const TEMPLATES = OJAD_SCOPE.templates;

/**
 * The field the sentence lives in, within those templates. Both lists are
 * `OJAD_SCOPE` in `src/accent/marks.ts` — one copy, so the body this script
 * edits and the field `declareField` points at cannot drift into two scopes.
 */
const SENTENCE_FIELDS = OJAD_SCOPE.sentenceFields;

/**
 * The annotation line, carrying the sentence line's own blockquote marker.
 *
 * `><< 例文 >>` is a blockquote; a bare `<ojad></ojad>` under it would close the
 * quote and start a paragraph. Matching the prefix keeps the two together.
 */
function annotationLine(reference: string, line: string): string {
  const quote = line.slice(0, line.indexOf(reference)).trim() === ">" ? ">" : "";
  return `${quote}<ojad></ojad>`;
}

/** Every authored spelling of the field reference, widest first. */
function references(name: string): string[] {
  return [`<< ${name} >>`, `<<${name}>>`, `<< ${name}>>`, `<<${name} >>`];
}

const db = openDatabase(arg("db"), { readOnly: !flag("apply") });
try {
  const templates = db
    .prepare("SELECT id, name, content FROM templates ORDER BY name")
    .all() as { id: string; name: string; content: string }[];

  let changed = 0;
  let already = 0;
  let absent = 0;
  let removed = 0;
  const update = db.prepare(
    `UPDATE templates
        SET content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?`,
  );

  for (const template of templates) {
    if (!TEMPLATES.includes(template.name as (typeof TEMPLATES)[number])) {
      // NOT SILENT. A template that USED to carry the line has to be cleaned up,
      // and saying so is how that gets noticed rather than left behind — this
      // script ran once with a wider scope, so there is real work here.
      if (template.content.includes("<ojad>")) {
        const cleaned = template.content
          .split("\n")
          .filter((line) => !line.includes("<ojad>"))
          .join("\n");
        if (flag("apply")) update.run(cleaned, template.id);
        removed += 1;
        console.log(`  ${template.name.padEnd(12)} REMOVED — out of scope`);
      }
      continue;
    }
    const field = SENTENCE_FIELDS.find((name) =>
      references(name).some((reference) => template.content.includes(reference)),
    );
    if (field === undefined) continue;

    if (template.content.includes(`<ojad>`)) {
      already += 1;
      console.log(`  ${template.name.padEnd(12)} ALREADY APPLIED`);
      continue;
    }

    // The FIRST spelling that occurs, annotated once. A template referencing the
    // sentence twice gets one annotation — the second reference is a different
    // job (単語's `Audio` reads 例文 as its own source, and every reference must
    // stay a bare field reference for that to keep resolving).
    const reference = references(field).find((candidate) => template.content.includes(candidate));
    if (reference === undefined) {
      absent += 1;
      continue;
    }
    const lines = template.content.split("\n");
    const at = lines.findIndex((line) => line.includes(reference));
    if (at < 0) {
      absent += 1;
      continue;
    }
    lines.splice(at + 1, 0, annotationLine(reference, lines[at] ?? ""));
    const content = lines.join("\n");
    if (flag("apply")) update.run(content, template.id);
    changed += 1;
    console.log(`  ${template.name.padEnd(12)} ${reference} + <ojad></ojad> on the next line`);
  }

  console.log(
    `\n${flag("apply") ? "applied" : "would apply"}: ${changed} template(s)` +
      ` · ${already} already · ${absent} with no usable reference` +
      ` · ${removed} removed as out of scope`,
  );
  if (!flag("apply")) console.log("  nothing written — pass --apply");
} finally {
  db.close();
}
