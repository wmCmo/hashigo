import { generationIdentity, lookupGeneration } from "../src/blobs/generation.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { storeDescriptorText } from "../src/generate/index.js";
import { memoryDocument, renderSides } from "../src/render/index.js";
import { alignFurigana, rubyPlainText, toHiragana } from "../src/render/ruby.js";
import { prepareCard } from "../src/review/index.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined && !process.argv[index + 1]!.startsWith("--")
    ? process.argv[index + 1]!
    : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

interface Gap {
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly cardName: string;
}

function sweep(db: Db): Gap[] {
  const cards = db.prepare("SELECT id, name FROM cards WHERE archived = 0").all() as {
    id: string;
    name: string;
  }[];
  const seen = new Set<string>();
  const gaps: Gap[] = [];
  for (const card of cards) {
    const prepared = prepareCard({ db, cardId: card.id, direction: "forward" });
    if (prepared === null) continue;
    const out = renderSides(prepared.sides, { document: memoryDocument() });
    for (const generation of out.generations) {
      const request = generation.request;
      if (request === null || request.kind !== "furigana") continue;
      if (String(request.text).trim() === "") continue;
      const identity = generationIdentity({
        kind: "furigana",
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
        text: request.text,
        lang: request.lang,
        voice: request.voice,
        options: request.options,
        cardName: card.name,
      });
    }
  }
  return gaps;
}

function bracketForm(base: string, reading: string): { text: string; kind: string; reason: string } {
  const alignment = alignFurigana(base, reading);
  if (alignment.kind === "none") return { text: base, kind: "none", reason: "" };
  if (alignment.kind === "whole") return { text: "", kind: "whole", reason: alignment.reason };
  return { text: rubyPlainText(alignment), kind: "segmented", reason: "" };
}

function main(): number {
  const dbFile = arg("db", "build/hashigo.db");
  const db = openDatabase(dbFile, { applySchema: false });
  const readingOf = db.prepare(
    `SELECT reading FROM accents
      WHERE text = ? AND reading IS NOT NULL AND reading <> ''
      ORDER BY CASE analyser WHEN 'unidic' THEN 0 WHEN 'openjtalk' THEN 1 ELSE 2 END
      LIMIT 1`,
  );
  const anyReading = db.prepare(
    "SELECT reading FROM accents WHERE text = ? AND reading IS NOT NULL AND reading <> ''",
  );

  console.log(`  sweeping ${dbFile} for missing furigana …`);
  const gaps = sweep(db);
  console.log(`\n  ${gaps.length} furigana slots unfilled\n`);

  let written = 0;
  let noReading = 0;
  let phonetic = 0;
  const refused: string[] = [];
  const samples: string[] = [];

  for (const gap of gaps) {
    const word = gap.text.trim();
    let row = readingOf.get(word) as { reading: string } | undefined;
    if (row !== undefined && row.reading.includes("ー")) {
      const clean = (anyReading.all(word) as { reading: string }[]).find(
        (candidate) => !candidate.reading.includes("ー"),
      );
      row = clean ?? row;
    }
    if (row === undefined) {
      noReading += 1;
      continue;
    }
    if (row.reading.includes("ー")) {
      phonetic += 1;
      continue;
    }
    const built = bracketForm(gap.text, toHiragana(row.reading));
    if (built.kind === "whole") {
      refused.push(`${gap.text} + ${row.reading}: ${built.reason}`);
      continue;
    }
    if (samples.length < 12) samples.push(`${gap.text.padEnd(12)} ${row.reading.padEnd(14)} -> ${built.text}`);
    if (!flag("dry")) {
      storeDescriptorText(
        db,
        { kind: "furigana", text: gap.text, lang: gap.lang, voice: gap.voice, options: gap.options },
        built.text,
      );
    }
    written += 1;
  }

  console.log("  what it builds:");
  for (const sample of samples) console.log(`    ${sample}`);
  console.log(
    `\n  ${written} ${flag("dry") ? "would be written" : "written"} · ` +
      `${noReading} have no derived reading · ${phonetic} only phonetic (ー) · ` +
      `${refused.length} refused by the aligner`,
  );
  for (const reason of refused.slice(0, 20)) console.log(`    ! ${reason}`);
  db.close();
  return 0;
}

process.exitCode = main();
