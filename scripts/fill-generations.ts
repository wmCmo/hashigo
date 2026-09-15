/**
 * FILL EVERY GENERATION MOCHI NEVER MADE.
 *
 * ─── WHY THERE ARE ANY ──────────────────────────────────────────────────────
 *
 * Mochi generated LAZILY, on render. A card whose side he rarely reached never
 * had its content made, and the import carried the hole across. Measured over
 * the whole corpus on 2026-09-15:
 *
 *     kind         slots   missing      %   cards
 *     ai          10,322     1,182  11.5%   1,182     every one an EMOJI LINE
 *     speech      10,461       785   7.5%     627     576 sentences, 209 words
 *     furigana     3,377       350  10.4%     350     NOT FILLED HERE — see below
 *     translate    3,760       129   3.4%     129
 *     image             8         0   0.0%       0
 *     dictionary        0         —      —       —     no template declares one
 *
 * The lazy-render theory is supported rather than assumed: cards carrying a gap
 * average **7.5 reviews against 15.8** for cards with none. Exposure, not
 * corruption.
 *
 * **178 of the missing speech are head words on mode-2 cards**, where decision 29
 * makes the clip the QUESTION. Those cards currently ask nothing at all, and they
 * are the reason this script exists rather than waiting for him to tap 627 times.
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT FILL ───────────────────────────────────
 *
 * **`furigana`.** 336 of the 340 with real input already have a reading derived
 * by the accent pipeline — OpenJTalk plus the UniDic cross-check, 33 adjudicated
 * against OJAD by hand, and 57 left disputed ON PURPOSE. A reading is the thing
 * being drilled on a `Reading = true` card, so asking a language model to guess
 * one where a measurement exists is exactly the trade decision 8 refuses: *a
 * wrong accent drilled is worse than no accent*. That fill is a different script
 * reading `accents.reading`, and it needs no network at all.
 *
 * `image` has no gaps. `dictionary` has no field.
 *
 * ─── A GENERATION IS PERMANENT, SO THE MODEL IS CHOSEN BEFORE THE RUN ───────
 *
 * There is no "regenerate anyway": the schema holds ONE payload per generation
 * identity, so overruling a cached answer means deleting a row that may be
 * referenced — a foreign key refuses, which is how that was found. Whatever runs
 * here is what those cards say from now on.
 *
 * Measured on his machine before choosing, on real corpus words:
 *
 *     word          qwen3:8b            gpt-oss:20b
 *     あれこれ       timed out / 💭×10   🗂️🔀🤷‍♂️
 *     のみならず     📘✨                 🌟➕💫
 *     舐める         👅👄💋              👅🍭
 *
 * qwen3:8b degenerates into repeated emoji on abstract words. **gpt-oss:20b is
 * the default here**, at ~8.2 s a call warm — about three hours for 1,311 text
 * gaps, free, on his own GPU.
 *
 * ─── IT IS RESUMABLE BY CONSTRUCTION, NOT BY BOOKKEEPING ────────────────────
 *
 * Every item is looked up again immediately before it is filled, so a run that is
 * interrupted — or run twice, or run while he fills one by hand from the phone —
 * simply skips what is already there. There is no progress file to go stale.
 *
 * SEQUENTIAL, deliberately, both halves. `respeak-cli` settled it for TTS (a 429
 * mid-run costs more than the wall clock saved) and the local model is one GPU:
 * parallel requests queue inside Ollama and return no faster.
 *
 *     npx vite-node scripts/fill-generations.ts -- --dry
 *     npx vite-node scripts/fill-generations.ts -- --kind ai --limit 5
 *     npx vite-node scripts/fill-generations.ts --
 *
 * NOTE FOR AN AGENT: the Bash tool here is network-sandboxed and cannot reach
 * `127.0.0.1:11434`. Run this from PowerShell.
 */
import { existsSync } from "node:fs";

import { synthesise } from "../src/accent/speech.js";
import { generationIdentity, lookupGeneration } from "../src/blobs/generation.js";
import { defaultStoreDatabase, openBlobStoreDatabase } from "../src/blobs/index.js";
import { openDatabase, type Db } from "../src/db/index.js";
import type { BlobKind } from "../src/schema/index.js";
import {
  FILL_VOICE,
  generateText,
  OLLAMA_HOST,
  ollamaReachable,
  storeDescriptorText,
  storeGeneratedSpeech,
} from "../src/generate/index.js";
import { resolveAudioHash } from "../src/cards/index.js";
import { memoryDocument, renderSides } from "../src/render/index.js";
import { prepareCard } from "../src/review/index.js";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined && !process.argv[index + 1]!.startsWith("--")
    ? process.argv[index + 1]!
    : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** One thing to make, with everything its identity is keyed on. */
interface Gap {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly cardId: string;
  readonly cardName: string;
}

/**
 * Every unresolved generation, by identity.
 *
 * DEDUPED, because the identity is the unit of work and not the card: two cards
 * sharing a sentence share one generation, and filling it twice would be one
 * wasted call and — for speech — one wasted payment.
 */
function sweep(db: Db, kinds: ReadonlySet<string>): Gap[] {
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
      if (request === null) continue;
      if (!kinds.has(request.kind)) continue;
      if (String(request.text).trim() === "") continue;
      const key = JSON.stringify(
        generationIdentity({
          kind: request.kind,
          text: request.text,
          voice: request.voice,
          lang: request.lang,
          options: request.options,
        }),
      );
      if (seen.has(key)) continue;
      seen.add(key);
      if (present(db, request)) continue;
      gaps.push({
        kind: request.kind,
        text: request.text,
        lang: request.lang,
        voice: request.voice,
        options: request.options,
        cardId: card.id,
        cardName: card.name,
      });
    }
  }
  return gaps;
}

/**
 * IS IT ALREADY THERE? ASKED THROUGH THE SHIPPING RESOLVER, NOT A COPY OF IT.
 *
 * ─── THE FIRST DRAFT GOT THIS WRONG AND THE DRY RUN CAUGHT IT ───────────────
 *
 * It looked speech up under `FILL_VOICE`, reasoning that this is where a filled
 * clip is stored. True, and useless as a presence test: **all 10,461 existing
 * clips are filed under Nanami**, so every one of them read as absent and the dry
 * run offered to synthesise 10,428 of them for $2.65 instead of 785 for $0.40.
 *
 * The rule that is actually wanted — ask under the voice the CARD requests, and
 * fall back to the fill voice — already exists, in `resolveAudioHash`, and is the
 * rule the review screen plays by. So this calls it rather than restating it. A
 * second copy of a fallback is how the batch and the screen come to disagree
 * about which cards are silent.
 *
 * `cardId` is a placeholder: it is read only for `attachment` addresses, and
 * every gap here is a generator slot.
 */
function present(
  db: Db,
  request: { kind: BlobKind; text: string; voice: string | null; lang: string | null; options: Readonly<Record<string, string>> },
): boolean {
  if (request.kind === "speech") {
    return resolveAudioHash(db, "", { origin: "generator", request }) !== null;
  }
  return (
    lookupGeneration(
      db,
      generationIdentity({
        kind: request.kind,
        text: request.text,
        voice: request.voice,
        lang: request.lang,
        options: request.options,
      }),
    ) !== null
  );
}

function apiKey(name: string): string {
  if (existsSync(".env") && process.env[name] === undefined) process.loadEnvFile(".env");
  const key = process.env[name];
  if (key === undefined || key === "") throw new Error(`no ${name} in .env`);
  return key;
}

async function main(): Promise<number> {
  const dbFile = arg("db", "build/hashigo.db");
  const kinds = new Set(arg("kind", "ai,translate,speech").split(",").map((k) => k.trim()));
  const model = arg("model", process.env["HASHIGO_OLLAMA_MODEL"] ?? "gpt-oss:20b");
  const host = arg("host", process.env["OLLAMA_HOST"] ?? OLLAMA_HOST);
  const limit = Number(arg("limit", "0")) || Number.POSITIVE_INFINITY;

  const db = openDatabase(dbFile, { applySchema: false });
  console.log(`  sweeping ${dbFile} for ${[...kinds].join(", ")} …`);
  const all = sweep(db, kinds);
  const byKind = new Map<string, number>();
  for (const gap of all) byKind.set(gap.kind, (byKind.get(gap.kind) ?? 0) + 1);

  console.log(`\n  ${all.length} generations missing`);
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${kind.padEnd(10)} ${String(n).padStart(5)}`);
  }
  const speechChars = all.filter((g) => g.kind === "speech").reduce((n, g) => n + g.text.length, 0);
  if (speechChars > 0) {
    // SAID BEFORE THE MONEY, NOT AFTER — `respeak-cli`'s rule.
    console.log(
      `\n    speech: ${speechChars.toLocaleString()} characters ` +
        `· about $${((speechChars * 16) / 1e6).toFixed(2)} at Neural2 rates`,
    );
  }
  const textGaps = all.filter((g) => g.kind !== "speech").length;
  if (textGaps > 0) console.log(`    text:   ${textGaps} calls to ${model} — free, on this machine`);

  if (flag("dry")) {
    console.log("\n  --dry: nothing generated, nothing written.");
    for (const gap of all.slice(0, 8)) {
      console.log(`    ${gap.kind.padEnd(10)} ${gap.cardName.padEnd(10)} ${gap.text.slice(0, 46)}`);
    }
    db.close();
    return 0;
  }

  if (textGaps > 0 && !(await ollamaReachable(host))) {
    console.error(`\n  ${host} is not answering. Start Ollama, or --kind speech.`);
    db.close();
    return 1;
  }

  const store = openBlobStoreDatabase(defaultStoreDatabase(dbFile), {
    mustExist: true,
    create: false,
  });
  const todo = all.slice(0, limit === Number.POSITIVE_INFINITY ? all.length : limit);
  let made = 0;
  let skipped = 0;
  const failures: string[] = [];
  const started = Date.now();

  try {
    for (const [index, gap] of todo.entries()) {
      // RE-ASKED, every time. This is the whole resumability story: a run that
      // was interrupted, run twice, or overlapped with him tapping the button on
      // his phone simply finds the answer already there.
      if (present(db, gap)) {
        skipped += 1;
        continue;
      }
      try {
        if (gap.kind === "speech") {
          const bytes = await synthesise(gap.text, null, {
            apiKey: apiKey("GOOGLE_TTS_SECRET"),
            voice: FILL_VOICE,
          });
          storeGeneratedSpeech(db, store.store, { text: gap.text, lang: gap.lang, options: gap.options }, bytes);
        } else {
          const text = await generateText(
            { kind: gap.kind, text: gap.text, options: gap.options },
            { provider: "ollama", model, host, maxTokens: 256 },
          );
          if (text === "") throw new Error(`${model} returned nothing`);
          storeDescriptorText(db, gap, text);
        }
        made += 1;
      } catch (cause) {
        failures.push(`${gap.kind} ${gap.cardName}: ${(cause as Error).message}`);
      }
      if ((index + 1) % 25 === 0) {
        const per = (Date.now() - started) / (index + 1) / 1000;
        const left = ((todo.length - index - 1) * per) / 60;
        console.log(
          `    ${index + 1}/${todo.length} · ${made} made · ${failures.length} failed ` +
            `· ${per.toFixed(1)}s each · ~${left.toFixed(0)} min left`,
        );
      }
    }
  } finally {
    store.close();
  }

  console.log(
    `\n  ${made} made · ${skipped} already present · ${failures.length} failed ` +
      `· ${((Date.now() - started) / 60000).toFixed(1)} min`,
  );
  for (const failure of failures.slice(0, 20)) console.log(`    ! ${failure}`);
  db.close();
  return failures.length > 0 ? 1 : 0;
}

process.exitCode = await main();
