import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generationIdentity, lookupGeneration } from "../src/blobs/generation.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { storeDescriptorText } from "../src/generate/index.js";
import { memoryDocument, renderSides } from "../src/render/index.js";
import { prepareCard } from "../src/review/index.js";
import type { BlobKind } from "../src/schema/index.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined && !process.argv[index + 1]!.startsWith("--")
    ? process.argv[index + 1]!
    : fallback;
}

interface Gap {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
}

function identityOf(gap: Gap): ReturnType<typeof generationIdentity> {
  return generationIdentity({
    kind: gap.kind,
    text: gap.text,
    voice: gap.voice,
    lang: gap.lang,
    options: gap.options,
  });
}

function sweep(db: Db): Gap[] {
  const cards = db.prepare("SELECT id FROM cards WHERE archived = 0").all() as { id: string }[];
  const seen = new Set<string>();
  const gaps: Gap[] = [];
  for (const card of cards) {
    const prepared = prepareCard({ db, cardId: card.id, direction: "forward" });
    if (prepared === null) continue;
    const out = renderSides(prepared.sides, { document: memoryDocument() });
    for (const generation of out.generations) {
      const request = generation.request;
      if (request === null) continue;
      if (request.kind !== "ai" && request.kind !== "translate") continue;
      if (String(request.text).trim() === "") continue;
      const identity = generationIdentity({
        kind: request.kind,
        text: request.text,
        voice: request.voice,
        lang: request.lang,
        options: request.options,
      });
      const key = JSON.stringify(identity);
      if (seen.has(key)) continue;
      seen.add(key);
      if (lookupGeneration(db, identity) !== null) continue;
      gaps.push({
        kind: request.kind,
        text: request.text,
        lang: request.lang,
        voice: request.voice,
        options: request.options,
      });
    }
  }
  return gaps;
}

function doExport(db: Db, dir: string, chunk: number): void {
  const gaps = sweep(db);
  mkdirSync(dir, { recursive: true });
  const byKind = new Map<string, Gap[]>();
  for (const gap of gaps) byKind.set(gap.kind, [...(byKind.get(gap.kind) ?? []), gap]);

  let files = 0;
  for (const [kind, list] of byKind) {
    for (let start = 0; start < list.length; start += chunk) {
      const part = list.slice(start, start + chunk);
      const name = `${kind}-${String(files + 1).padStart(2, "0")}.json`;
      writeFileSync(join(dir, name), `${JSON.stringify({ kind, items: part }, null, 1)}\n`, "utf8");
      files += 1;
      console.log(`  ${name.padEnd(16)} ${part.length} items`);
    }
  }
  console.log(`\n  ${gaps.length} text gaps in ${files} file(s) under ${dir}`);
}

function emojiOnly(out: string): boolean {
  const withoutKeycaps = out.replace(/[0-9#*]️?⃣/g, "");
  return !/[A-Za-z]/.test(withoutKeycaps) && !/[0-9]/.test(withoutKeycaps);
}

function doImport(db: Db, file: string): number {
  const open = new Map<string, Gap>();
  for (const gap of sweep(db)) open.set(gap.text, gap);

  let written = 0;
  let unknown = 0;
  let malformed = 0;
  let empty = 0;
  let notEmoji = 0;
  let collided = 0;
  const strays: string[] = [];
  const prose: string[] = [];
  const clashes: string[] = [];

  for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
    if (line.trim() === "") continue;
    let row: { text?: unknown; out?: unknown };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      malformed += 1;
      continue;
    }
    if (typeof row.text !== "string" || typeof row.out !== "string") {
      malformed += 1;
      continue;
    }
    const gap = open.get(row.text);
    if (gap === undefined) {
      unknown += 1;
      if (strays.length < 10) strays.push(`line ${index + 1}: ${row.text.slice(0, 40)}`);
      continue;
    }
    const out = row.out.trim();
    if (out === "") {
      empty += 1;
      continue;
    }
    if (gap.kind === "ai" && !emojiOnly(out)) {
      notEmoji += 1;
      if (prose.length < 10) prose.push(`${row.text.slice(0, 34)} -> ${out.slice(0, 40)}`);
      continue;
    }
    storeDescriptorText(db, gap, out);
    if (lookupGeneration(db, identityOf(gap)) === null) {
      collided += 1;
      if (clashes.length < 10) clashes.push(`${row.text.slice(0, 34)} -> ${out}`);
      continue;
    }
    open.delete(row.text);
    written += 1;
  }
  console.log(
    `  ${file}: ${written} written · ${unknown} not an open gap · ` +
      `${malformed} malformed · ${empty} empty · ${notEmoji} not emoji · ` +
      `${collided} lost to a hash collision`,
  );
  for (const line of prose) console.log(`    x ${line}`);
  for (const line of clashes) console.log(`    = ${line}`);
  for (const stray of strays) console.log(`    ? ${stray}`);
  return written;
}

function main(): number {
  const db = openDatabase(arg("db", "build/hashigo.db"), { applySchema: false });
  try {
    const exportDir = arg("export", "");
    if (exportDir !== "") {
      doExport(db, exportDir, Number(arg("chunk", "120")));
      return 0;
    }
    const target = arg("import", "");
    if (target === "") {
      console.error("  --export <dir> or --import <file|dir>");
      return 2;
    }
    let total = 0;
    const files = target.endsWith(".jsonl")
      ? [target]
      : readdirSync(target)
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => join(target, name));
    for (const file of files) total += doImport(db, file);
    console.log(`\n  ${total} generations written from ${files.length} file(s)`);
    return 0;
  } finally {
    db.close();
  }
}

process.exitCode = main();
