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
      identity: job.identity,
    });
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
