/**
 * What is actually missing from every generated field, per template.
 *
 *     npx vite-node scripts/generation-audit.ts -- --db build/hashigo.db
 *     npx vite-node scripts/generation-audit.ts -- --db build/hashigo.db --field 例文 --list
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * "Generate the missing example sentences" is a question before it is a task,
 * and the answer is not the one the field values suggest. `card_field_values`
 * holds ZERO rows for `例文` on all 3,478 単語 cards — not because they are
 * missing, but because `例文` is an `ai` generator field and Mochi keeps
 * generated content in `component-cache`, keyed by the generator's identity.
 * Counting empty value rows says "3,478 missing" and is wrong by two orders of
 * magnitude.
 *
 * ─── IT USES THE REAL RESOLVER, AND THAT IS THE POINT ───────────────────────
 *
 * The first version of this audit hand-rolled the cache key in SQL and got a
 * different answer from the app. `src/generate/store.ts` already resolves a
 * field against the store and already sorts every miss into four buckets, so
 * this drives THAT rather than a second implementation of the same rule — the
 * whole hazard being that an audit which computes the key differently from the
 * renderer reports on a card the renderer never sees.
 *
 *   exact        the identity Mochi filed — renders today
 *   other-voice  same kind and text, different voice or options — plays today
 *   mismatch     the card HAS a generation of that kind, but NOT for this text.
 *                For `ai` fields this is almost always a PROMPT CHANGE: the
 *                sentence exists, generated under the field's older wording.
 *   missing      nothing of that kind on the card at all — the only bucket that
 *                genuinely needs a new generation
 *
 * `mismatch` versus `missing` is the distinction that decides how much work
 * there is, and it is invisible to a value-row count.
 */
import { openDatabase } from "../src/db/index.js";
import {
  fieldGenerationRequest,
  isGeneratorType,
  resolveFieldGeneration,
  type FieldContext,
  type GeneratorField,
} from "../src/generate/index.js";

process.stdout.write("");

const argv = process.argv;
const arg = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const db = openDatabase(arg("db") ?? "build/hashigo.db", { applySchema: false });
const onlyField = arg("field");
const list = has("list");

interface FieldRow {
  readonly template_id: string;
  readonly template: string;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly options: string | null;
  readonly source_field_id: string | null;
  readonly pos: string | null;
}

const fields = db
  .prepare(
    `SELECT f.template_id, t.name AS template, f.id, f.name, f.type, f.options,
            f.source_field_id, f.pos
       FROM template_fields f JOIN templates t ON t.id = f.template_id
      ORDER BY t.name, f.pos`,
  )
  .all() as FieldRow[];

const generators = fields.filter((f) => isGeneratorType(f.type));

/** Every field on a template, so a prompt's `<<Other>>` reference can resolve. */
const byTemplate = new Map<string, FieldRow[]>();
for (const f of fields) {
  const held = byTemplate.get(f.template_id);
  if (held === undefined) byTemplate.set(f.template_id, [f]);
  else held.push(f);
}

const toGeneratorField = (f: FieldRow): GeneratorField => ({
  id: f.id,
  name: f.name,
  type: f.type as GeneratorField["type"],
  ...(f.options === null ? {} : { options: JSON.parse(f.options) as Record<string, unknown> }),
  sourceFieldId: f.source_field_id,
});

console.log("generated fields, resolved through the app's own resolver\n");
console.log(
  `${"template".padEnd(11)}${"field".padEnd(18)}${"type".padEnd(10)}` +
    `${"cards".padStart(7)}${"exact".padStart(8)}${"voice".padStart(7)}` +
    `${"mismatch".padStart(10)}${"missing".padStart(9)}${"no input".padStart(10)}`,
);
console.log("─".repeat(90));

let grandMissing = 0;
let grandMismatch = 0;

for (const field of generators) {
  if (onlyField !== undefined && field.name !== onlyField) continue;

  const cards = db
    .prepare(`SELECT id, name FROM cards WHERE template_id = ?`)
    .all(field.template_id) as { id: string; name: string }[];

  const templateFields = (byTemplate.get(field.template_id) ?? []).map(toGeneratorField);
  const counts = { exact: 0, "other-voice": 0, mismatch: 0, missing: 0 } as Record<
    string,
    number
  >;
  let noInput = 0;
  const offenders: { card: string; head: string; match: string }[] = [];

  for (const card of cards) {
    const values = db
      .prepare(`SELECT field_id, value FROM card_field_values WHERE card_id = ?`)
      .all(card.id) as { field_id: string; value: string }[];

    const context: FieldContext = {
      values: new Map(values.map((v) => [v.field_id, v.value])),
      fields: templateFields,
    };

    const request = fieldGenerationRequest(toGeneratorField(field), context);
    if (request === null) {
      // No input text — an empty head word, or a prompt whose `<<Other>>` is
      // itself empty. Refusing to build a request is deliberate: a key hashed
      // from empty text could never match anything, so it would report as a
      // miss forever. These must NOT be generated.
      noInput += 1;
      continue;
    }

    const resolved = resolveFieldGeneration(db, request);
    counts[resolved.match] = (counts[resolved.match] ?? 0) + 1;
    if (resolved.match === "missing" || resolved.match === "mismatch") {
      offenders.push({ card: card.id, head: card.name, match: resolved.match });
    }
  }

  grandMissing += counts["missing"] ?? 0;
  grandMismatch += counts["mismatch"] ?? 0;

  console.log(
    `${field.template.padEnd(11)}${field.name.padEnd(18)}${field.type.padEnd(10)}` +
      `${String(cards.length).padStart(7)}${String(counts["exact"] ?? 0).padStart(8)}` +
      `${String(counts["other-voice"] ?? 0).padStart(7)}` +
      `${String(counts["mismatch"] ?? 0).padStart(10)}` +
      `${String(counts["missing"] ?? 0).padStart(9)}${String(noInput).padStart(10)}`,
  );

  if (list && offenders.length > 0) {
    for (const o of offenders) console.log(`      ${o.match.padEnd(9)} ${o.card}  ${o.head}`);
  }
}

console.log("─".repeat(90));
console.log(
  `\n  mismatch ${grandMismatch.toLocaleString()} — a generation of that kind EXISTS on the card ` +
    `under different text.\n` +
    `           For an \`ai\` field that is a prompt change: the content is there, keyed\n` +
    `           on the older wording. Regenerating replaces content he already has.\n` +
    `  missing  ${grandMissing.toLocaleString()} — nothing of that kind on the card. This is the ` +
    `only bucket that\n           needs a new generation.\n`,
);

db.close();
