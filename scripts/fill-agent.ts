/**
 * HAND THE TEXT GAPS TO AGENTS, AND TAKE THE ANSWERS BACK SAFELY.
 *
 * ─── ZACH, 2026-09-15 ───────────────────────────────────────────────────────
 *
 * *"do you think me asking you to spawn sub agents to fill those cards would be
 * faster? because i have tokens left, it's resetting in 5 hrs, and im using only
 * 72%"*
 *
 * Faster, yes — but not for the reason the question assumes, and the distinction
 * decides the design.
 *
 * **Parallel callers do not speed up Ollama.** One daemon, one GPU: concurrent
 * requests queue, and at 8.0 s a call the 967 remaining text gaps are ~129
 * minutes however many processes ask for them.
 *
 * What actually changes is the RESOURCE and the BATCH SIZE. An agent answers out
 * of a subscription that is otherwise idle, and — the real win — **one agent
 * emits a hundred emoji lines in a single response**. 853 words stop being 853
 * calls and become about nine.
 *
 * **Speech cannot come this way at all.** A clip is bytes from Google's
 * synthesiser; an agent cannot produce one, so that half stays on
 * `fill-generations.ts --kind speech` where it is ~13 minutes anyway.
 *
 * ─── THE RISK IS ALIGNMENT, AND IT IS THE WHOLE OF THE IMPORT SIDE ──────────
 *
 * A model handed 120 words and asked for 120 answers can drop one, merge two, or
 * quietly reorder. Positional trust would then write the wrong emoji onto the
 * wrong card — and a generation is PERMANENT here (one payload per identity;
 * overruling it means deleting a row a foreign key protects).
 *
 * So nothing is positional. Every answer names its own `text`, that text must
 * match a gap that is still open, and anything else is counted and printed
 * rather than written. The exported file and the imported file are joined on the
 * generator's own input — which is the identity's `source_text`, the one string
 * that already has to be exact for the cache to work at all (decision 7).
 *
 *     npx vite-node scripts/fill-agent.ts -- --export build/agent --chunk 120
 *     npx vite-node scripts/fill-agent.ts -- --import build/agent/answers-01.jsonl
 *
 * The answer file is JSONL — one `{"text": …, "out": …}` per line — chosen over
 * one big JSON object because a single malformed line loses one field instead of
 * a hundred.
 */
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

/** The identity a gap is filed under. One place, so a write and its check agree. */
function identityOf(gap: Gap): ReturnType<typeof generationIdentity> {
  return generationIdentity({
    kind: gap.kind,
    text: gap.text,
    voice: gap.voice,
    lang: gap.lang,
    options: gap.options,
  });
}

/** Every unresolved TEXT generation, by identity. Speech is not this script's. */
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

/**
 * AN `ai` ANSWER MUST BE EMOJI, AND A KEYCAP IS EMOJI.
 *
 * The failure this guards is the one qwen3:8b produced locally — a field that
 * comes back as prose, or as an emoji line with an "Explanation:" paragraph
 * after it. Mochi's own corpus has such a row, so it is not hypothetical.
 *
 * **KEYCAPS ARE THE TRAP IN THE OTHER DIRECTION.** `1️⃣` is `U+0031 U+FE0F
 * U+20E3` — an ASCII digit inside a legitimate emoji sequence. A naive
 * `/[A-Za-z0-9]/` flags 最初 → 1️⃣🔰 and 一晩 → 🌙1️⃣ as broken when they are
 * two of the better answers in the set. So the sequences are removed first and
 * only what survives is judged.
 *
 * Letters are rejected outright: every letter-like emoji (🅰️ ℹ️ 🆗) lives in its
 * own code point and never as ASCII.
 */
function emojiOnly(out: string): boolean {
  const withoutKeycaps = out.replace(/[0-9#*]️?⃣/g, "");
  return !/[A-Za-z]/.test(withoutKeycaps) && !/[0-9]/.test(withoutKeycaps);
}

function doImport(db: Db, file: string): number {
  // The gaps are re-swept, so an answer for something already filled — by the
  // phone, by another chunk, by a second run of this file — is a skip and not a
  // write. Nothing here trusts the export to still be current.
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
    // A generation is PERMANENT — one payload per identity, and overruling it
    // means deleting a row a foreign key protects. So a suspect answer is
    // refused here rather than repaired later.
    if (gap.kind === "ai" && !emojiOnly(out)) {
      notEmoji += 1;
      if (prose.length < 10) prose.push(`${row.text.slice(0, 34)} -> ${out.slice(0, 40)}`);
      continue;
    }
    storeDescriptorText(db, gap, out);
    // ─── DID IT ACTUALLY LAND? ──────────────────────────────────────────────
    //
    // `blobs.hash` is the PRIMARY KEY and it is the sha256 of the GENERATED
    // TEXT — while the identity (kind, source_text, …) lives in the same row.
    // So two words with the same answer cannot both have a row, and
    // `ON CONFLICT DO NOTHING` drops the second in silence.
    //
    // That is not hypothetical and it is not rare: 955 answers produced 892
    // distinct outputs, so **63 collided** — 席 椅子 座る all came back 🪑, and
    // 回る 換える 回す all came back 🔄. `respeak-cli` records the same trap for
    // audio and learned it the expensive way ("3,850 clips made, zero failures
    // reported, 161 cards mute"). Writing without checking reproduces it here.
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
  // NAMED, because the repair is to give that word a DIFFERENT answer — 席 and
  // 椅子 and 座る should not have shared one gloss in the first place.
  for (const line of clashes) console.log(`    = ${line}`);
  // PRINTED. An answer whose `text` matches nothing is the alignment failure
  // this script exists to catch, and a count alone cannot tell a stale export
  // from a model that invented a word.
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
