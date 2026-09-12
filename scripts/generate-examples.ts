/**
 * Generate the example sentences that do not resolve — and ONLY those.
 *
 *     npx vite-node scripts/generation-audit.ts -- --db build/hashigo.db   # look first
 *     npx vite-node scripts/generate-examples.ts -- --db build/hashigo.db            # dry run
 *     npx vite-node scripts/generate-examples.ts -- --db build/hashigo.db --apply
 *
 * Needs a credential: `ANTHROPIC_API_KEY` in the environment, or an `ant auth
 * login` profile. PowerShell: `$env:ANTHROPIC_API_KEY="sk-ant-..."`.
 *
 * ─── IT GENERATES 67 SENTENCES, NOT 3,870, AND THAT IS THE WHOLE POINT ──────
 *
 * `例文` is an `ai` generator field, so `card_field_values` holds ZERO rows for
 * it on all 3,478 単語 cards. Counting empty value rows says "3,478 missing".
 * Resolved through the app's own resolver — the same code the renderer uses —
 * 3,411 of them resolve from Mochi's `component-cache`, which came across in the
 * import. The real figure is **57 on 単語 and 10 on 言葉**.
 *
 * ELEVEN MORE HAVE NO HEAD WORD (empty or "Untitled card") and are skipped on
 * purpose: `fieldGenerationRequest` refuses to build a request from empty text,
 * because a key hashed from nothing could never match and would report as a miss
 * forever. A sentence generated for a card with no word is a sentence about
 * nothing.
 *
 * ─── WHEN TO RUN IT, WHICH IS NOT NECESSARILY NOW ───────────────────────────
 *
 * A generated sentence is a `blobs` row in `build/hashigo.db`. Decision 16's ONE
 * final import from Mochi rebuilds that database from `exports/`, and takes every
 * locally-generated blob with it — the same way a rebuild takes the local fields,
 * which is why `scripts/accent-field-apply.ts` is a documented step of the
 * rebuild chore. This script is another such step.
 *
 * That is Zach's own reasoning for deferring audio regeneration, applied to
 * text: *"i will regenerate my audio after we finished the app, because i have to
 * re import anyway because everyday when i make this app i still review mochi."*
 * Running it before the final import is not wrong — 67 sentences is minutes and
 * pennies — it is just work that will need doing again.
 *
 * ─── WHAT IT DOES NOT TOUCH ─────────────────────────────────────────────────
 *
 * Only `ai` fields. The audit also reports 301 missing generations overall, but
 * most of those are `speech` — audio, which is deferred by a decision repeated to
 * five agents. This script filters to `ai` and will not regenerate a clip.
 */
import { existsSync } from "node:fs";

import Anthropic from "@anthropic-ai/sdk";

import { openDatabase } from "../src/db/index.js";
import { addBlobRef, putBlob } from "../src/import/blobs.js";
import { canonicaliseOptions } from "../src/blobs/generation.js";
import {
  fieldGenerationRequest,
  resolveFieldGeneration,
  type FieldContext,
  type GeneratorField,
} from "../src/generate/index.js";

process.stdout.write("");

// The key lives in `.env` (gitignored). `new Anthropic()` reads the ENVIRONMENT,
// and vite-node does not load `.env` into `process.env` for a script — Vite's own
// `.env` handling is for `import.meta.env` in bundled client code, behind a
// `VITE_` prefix, which is neither of those things. Without this the script fails
// with an auth error while the key sits in a file in the repo root, which is the
// least helpful failure available.
if (existsSync(".env") && process.env["ANTHROPIC_API_KEY"] === undefined) {
  process.loadEnvFile(".env");
}

const argv = process.argv;
const arg = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const apply = argv.includes("--apply");
const limit = Number(arg("limit") ?? "0") || Number.POSITIVE_INFINITY;
const model = arg("model") ?? "claude-opus-5";

const db = openDatabase(arg("db") ?? "build/hashigo.db", { applySchema: false });

interface FieldRow {
  template_id: string;
  template: string;
  id: string;
  name: string;
  type: string;
  options: string | null;
  source_field_id: string | null;
}

const allFields = db
  .prepare(
    `SELECT f.template_id, t.name AS template, f.id, f.name, f.type, f.options, f.source_field_id
       FROM template_fields f JOIN templates t ON t.id = f.template_id ORDER BY t.name, f.pos`,
  )
  .all() as FieldRow[];

const toField = (f: FieldRow): GeneratorField => ({
  id: f.id,
  name: f.name,
  type: f.type as GeneratorField["type"],
  ...(f.options === null ? {} : { options: JSON.parse(f.options) as Record<string, unknown> }),
  sourceFieldId: f.source_field_id,
});

const byTemplate = new Map<string, GeneratorField[]>();
for (const f of allFields) {
  const held = byTemplate.get(f.template_id);
  if (held === undefined) byTemplate.set(f.template_id, [toField(f)]);
  else held.push(toField(f));
}

/** `ai` example fields only — never a `speech` field. See the header. */
const targets = allFields.filter(
  (f) => f.type === "ai" && (f.name.includes("例文") || f.name.includes("Example")),
);

interface Job {
  readonly cardId: string;
  readonly head: string;
  readonly template: string;
  readonly field: string;
  readonly fieldId: string;
  readonly prompt: string;
  /**
   * The identity the RESOLVER will compute. Storing anything else files the blob
   * under a key nothing looks up. Measured: writing `options: "{}"` instead of
   * the field's own option subset put all 67 at `other-voice` rather than
   * `exact` — they rendered, but under a near-miss, and Mochi files these with
   * `{"ai-task":"custom"}`.
   */
  readonly identity: {
    readonly sourceText: string;
    readonly voice: string | null;
    readonly lang: string | null;
    readonly options: string;
  };
}

const jobs: Job[] = [];
let skippedNoInput = 0;

for (const field of targets) {
  const cards = db
    .prepare(`SELECT id, name FROM cards WHERE template_id = ?`)
    .all(field.template_id) as { id: string; name: string }[];

  for (const card of cards) {
    const values = db
      .prepare(`SELECT field_id, value FROM card_field_values WHERE card_id = ?`)
      .all(card.id) as { field_id: string; value: string }[];
    const context: FieldContext = {
      values: new Map(values.map((v) => [v.field_id, v.value])),
      fields: byTemplate.get(field.template_id) ?? [],
    };
    const request = fieldGenerationRequest(toField(field), context);
    if (request === null) {
      skippedNoInput += 1;
      continue;
    }
    const resolved = resolveFieldGeneration(db, request);
    if (resolved.match === "exact" || resolved.match === "other-voice") continue;
    jobs.push({
      cardId: card.id,
      head: card.name,
      template: field.template,
      field: field.name,
      fieldId: field.id,
      // The generator's own resolved prompt — NOT one invented here. It is also
      // the cache key, so the sentence has to be stored under exactly this text
      // or the renderer will not find it.
      prompt: request.text,
      identity: {
        sourceText: request.text,
        voice: request.voice,
        lang: request.lang,
        options: canonicaliseOptions(request.options),
      },
    });
  }
}

console.log(
  `${jobs.length} example sentence(s) to generate · ` +
    `${skippedNoInput} card(s) skipped for having no head word\n`,
);

if (jobs.length === 0) {
  db.close();
  process.exit(0);
}

if (!apply) {
  for (const job of jobs.slice(0, 20)) {
    console.log(`  ${job.template}/${job.field}  ${job.cardId}  ${job.head}`);
    console.log(`      prompt: ${job.prompt}`);
  }
  if (jobs.length > 20) console.log(`  … and ${jobs.length - 20} more`);
  console.log(`\nDRY RUN — nothing written. Re-run with --apply to generate.`);
  db.close();
  process.exit(0);
}

const client = new Anthropic();
let written = 0;
let failed = 0;

for (const job of jobs.slice(0, limit)) {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1000,
      // The prompt IS the field's own `ai-custom-prompt`, already resolved
      // against the card. The system message only constrains the SHAPE, so the
      // sentence matches what four years of cached ones look like: one line of
      // Japanese, no translation, no preamble, no quotes.
      system:
        "You write a single Japanese example sentence for a vocabulary flashcard. " +
        "Reply with the sentence and nothing else — no translation, no romaji, no " +
        "quotation marks, no explanation, no leading or trailing whitespace. One line.",
      messages: [{ role: "user", content: job.prompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (text === "") throw new Error("the model returned no text");

    const bytes = new TextEncoder().encode(text);
    const { hash } = putBlob(db, {
      kind: "ai",
      bytes,
      mime: "text/plain; charset=utf-8",
      // Stored under the field's resolved prompt — the cache key the renderer
      // will compute. Anything else and this is written but never read.
      identity: job.identity,
    });
    // `refKey` is the GENERATION KEY for cached text — see `BlobRef`. The field id
    // is carried too, which the Mochi import never set (all 42,596 rows are NULL).
    addBlobRef(db, { blobHash: hash, cardId: job.cardId, fieldId: job.fieldId, refKey: job.prompt });
    written += 1;
    console.log(`  ${job.head}  →  ${text}`);
  } catch (error) {
    failed += 1;
    console.log(`  ${job.head}  FAILED  ${error instanceof Error ? error.message : error}`);
  }
}

console.log(`\nwrote ${written}, failed ${failed}`);
console.log(
  written > 0
    ? `\nRegenerate the app seed so both devices get them:\n  npx vite-node scripts/app-bootstrap.ts\n`
    : "",
);
db.close();
