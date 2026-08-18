/**
 * Regenerate `manifest.json` — the 11 real template rows, lifted verbatim out of
 * the three exports.
 *
 *   npx vite-node test/fixtures/templates/extract.ts
 *
 * `exports/` is 657 MB and gitignored, so the manifest is what lets
 * `test/template.test.ts` golden-test the real templates on a clean clone. It is
 * generated, never hand-edited: the corpus check in that test re-reads the
 * exports and fails if the two have drifted.
 *
 * ELEVEN ROWS, TEN TEMPLATES. `oiaISYb2` (単語) is defined in both 日本語 and
 * 基本情報, byte-identically, so both rows are kept — SPEC's surface-2 counts
 * (19 `---`, 73 `<<Field>>`, 8 clozes) are totals over all eleven.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { asRecord, asRecords, asText, isRecord, loadExport } from "../../../src/import/transit.js";
import { sideCount } from "../../../src/template/parse.js";

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const OUT = resolve(import.meta.dirname, "manifest.json");

interface FixtureField {
  readonly id: string;
  readonly name: string;
  readonly type: string | null;
  readonly source: string | null;
  readonly options: unknown;
  readonly pos: string;
}

interface FixtureTemplate {
  readonly export: string;
  readonly id: string;
  readonly name: string;
  readonly pos: string;
  readonly sides: number;
  readonly content: string;
  readonly fields: readonly FixtureField[];
}

export interface TemplateManifest {
  readonly generatedFrom: readonly string[];
  readonly rows: number;
  readonly distinctIds: number;
  readonly templates: readonly FixtureTemplate[];
}

export function buildManifest(): TemplateManifest {
  const templates: FixtureTemplate[] = [];
  for (const name of EXPORT_NAMES) {
    const root = loadExport(resolve(ROOT, "exports", name));
    for (const template of asRecords(root["templates"])) {
      const content = asText(template["content"]);
      templates.push({
        export: name,
        id: asText(template["id"]),
        name: asText(template["name"]),
        pos: asText(template["pos"]),
        sides: sideCount(content),
        content,
        // Mochi keys `fields` by id; `pos` is the authored order and is what the
        // editor shows, so sort by it to keep the fixture deterministic.
        fields: Object.entries(asRecord(template["fields"]))
          .flatMap(([key, raw]) => (isRecord(raw) ? [[key, raw] as const] : []))
          .map(([key, raw]) => ({
            id: asText(raw["id"]) || key,
            name: asText(raw["name"]),
            type: asText(raw["type"]) || null,
            source: asText(raw["source"]) || null,
            options: raw["options"] ?? null,
            pos: asText(raw["pos"]),
          }))
          .sort((a, b) => a.pos.localeCompare(b.pos) || a.id.localeCompare(b.id)),
      });
    }
  }
  return {
    generatedFrom: [...EXPORT_NAMES],
    rows: templates.length,
    distinctIds: new Set(templates.map((template) => template.id)).size,
    templates,
  };
}

function main(): void {
  const manifest = buildManifest();
  mkdirSync(import.meta.dirname, { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(
    `wrote ${OUT}\n  ${manifest.rows} rows, ${manifest.distinctIds} distinct ids\n` +
      manifest.templates
        .map((t) => `  ${t.export.padEnd(8)} ${t.id} ${t.name} — ${t.sides} sides, ${t.fields.length} fields`)
        .join("\n") +
      "\n",
  );
}

// Only when run as the entry point. `test/template.test.ts` imports
// `buildManifest` to check the committed manifest has not drifted, and a module
// that rewrote the fixture on import would make that check vacuous.
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) main();
