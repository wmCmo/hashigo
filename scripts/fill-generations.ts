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
import { cardGaps } from "../src/review/index.js";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined && !process.argv[index + 1]!.startsWith("--")
    ? process.argv[index + 1]!
    : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

interface Gap {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly cardId: string;
  readonly cardName: string;
}

function sweep(db: Db, kinds: ReadonlySet<string>): Gap[] {
  const cards = db.prepare("SELECT id, name FROM cards WHERE archived = 0").all() as {
    id: string;
    name: string;
  }[];
  const seen = new Set<string>();
  const gaps: Gap[] = [];
  for (const card of cards) {
    for (const gap of cardGaps(db, card.id, kinds)) {
      const key = JSON.stringify(
        generationIdentity({
          kind: gap.kind,
          text: gap.text,
          voice: gap.voice,
          lang: gap.lang,
          options: gap.options,
        }),
      );
      if (seen.has(key)) continue;
      seen.add(key);
      gaps.push({ ...gap, cardId: card.id, cardName: card.name });
    }
  }
  return gaps;
}

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
