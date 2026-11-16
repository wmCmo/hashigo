import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { synthesise } from "../src/accent/speech.js";
import { defaultStoreDatabase, openBlobStoreDatabase } from "../src/blobs/index.js";
import { readBlob } from "../src/blobs/db.js";
import { openDatabase } from "../src/db/index.js";
import { fillVoiceFor, storeGeneratedSpeech } from "../src/generate/index.js";
import { speakableText } from "../src/text/index.js";

process.stdout.setDefaultEncoding("utf8");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const limitAt = args.indexOf("--limit");
const LIMIT = limitAt === -1 ? Infinity : Number(args[limitAt + 1] ?? "0");
const dbAt = args.indexOf("--db");
const CARD_DB = resolve(dbAt === -1 ? "build/hashigo.db" : (args[dbAt + 1] as string));

const WRONG = `
SELECT hash, source_text, voice, lang, options, byte_size
  FROM blobs
 WHERE kind = 'speech'
   AND voice IS NOT NULL AND lang IS NOT NULL
   AND substr(voice, 1, 2) <> substr(lang, 1, 2)
 ORDER BY created_at`;

const BY_LANG = `
SELECT hash, source_text, voice, lang, options, byte_size
  FROM blobs
 WHERE kind = 'speech'
   AND voice IS NOT NULL AND lang IS NOT NULL
   AND lower(substr(lang, 1, 2)) = ?
 ORDER BY created_at`;

interface Row {
  hash: string;
  source_text: string;
  voice: string;
  lang: string;
  options: string;
  byte_size: number;
}

const db = openDatabase(CARD_DB, { applySchema: false });
const opened = openBlobStoreDatabase(defaultStoreDatabase(CARD_DB), {
  mustExist: true,
  create: false,
});

const langAt = args.indexOf("--lang");
const ONLY_LANG = langAt === -1 ? null : (args[langAt + 1] ?? "").slice(0, 2).toLowerCase();

const rows = (
  ONLY_LANG === null
    ? (db.prepare(WRONG).all() as Row[])
    : (db.prepare(BY_LANG).all(ONLY_LANG) as Row[])
).filter(
  (row) => fillVoiceFor(row.lang) !== row.voice,
);

console.log(`${CARD_DB}`);
console.log(`clips whose voice language disagrees with the text: ${rows.length}`);
const byPair = new Map<string, number>();
for (const row of rows) {
  const key = `${row.voice} speaking ${row.lang}  ->  ${fillVoiceFor(row.lang)}`;
  byPair.set(key, (byPair.get(key) ?? 0) + 1);
}
for (const [pair, n] of byPair) console.log(`  ${pair}   ${n}`);

if (rows.length === 0) {
  console.log("\nnothing to do.");
  opened.close();
  db.close();
  process.exit(0);
}

if (!APPLY) {
  const skipped = rows.filter((row) => speakableText(row.source_text) === "");
  console.log(`\nof these, ${skipped.length} have NOTHING to speak and will be skipped:`);
  console.log("  (the field is still an unfilled generator — the sentence has to be");
  console.log("   generated before it can be voiced; re-voicing recites the prompt)");
  for (const row of skipped.slice(0, 4)) console.log(`    ${row.source_text.slice(0, 62)}`);
  if (skipped.length > 4) console.log(`    … and ${skipped.length - 4} more`);

  console.log("\nDRY RUN — nothing written, nothing billed. Re-run with --apply.");
  console.log("stored text  ->  what would actually be spoken:");
  for (const row of rows.filter((r) => speakableText(r.source_text) !== "").slice(0, 6)) {
    console.log(`  ${row.source_text.slice(0, 58)}`);
    console.log(`    -> ${speakableText(row.source_text).slice(0, 58)}`);
  }
  opened.close();
  db.close();
  process.exit(0);
}

const key = (() => {
  try {
    process.loadEnvFile(resolve(".env"));
  } catch {
  }
  const found = process.env["GOOGLE_TTS_SECRET"];
  if (found === undefined || found === "") {
    console.error("\nno GOOGLE_TTS_SECRET — put it in .env on the laptop.");
    process.exit(1);
  }
  return found;
})();

function removeClip(hash: string): void {
  const refs = db.prepare("SELECT count(*) AS n FROM blob_refs WHERE blob_hash = ?").get(hash) as {
    n: number;
  };
  if (refs.n !== 0) {
    throw new Error(`${hash.slice(0, 10)} has ${refs.n} blob_refs row(s) — that is an attachment, not a generation`);
  }
  db.prepare("UPDATE blobs SET refcount = 0 WHERE hash = ?").run(hash);
  db.prepare("DELETE FROM blobs WHERE hash = ?").run(hash);
  opened.store.remove(hash);
}

const BACKUP_DIR = resolve("build/voice-refill-old");
mkdirSync(BACKUP_DIR, { recursive: true });

let remade = 0;
let failed = 0;
let unspeakable = 0;
const failures: string[] = [];

for (const row of rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT)) {
  const voice = fillVoiceFor(row.lang);
  const label = row.source_text.slice(0, 48).replace(/\s+/g, " ");
  const spoken = speakableText(row.source_text);
  if (spoken === "") {
    unspeakable += 1;
    console.log(`  SKIP  nothing to speak (the field is an unfilled generator)  ${label}`);
    continue;
  }
  try {
    const bytes = await synthesise(spoken, null, { apiKey: key, voice });
    try {
      const old = readBlob(db, row.hash, opened.store);
      writeFileSync(resolve(BACKUP_DIR, `${row.hash.slice(0, 16)}.mp3`), old);
    } catch {
    }
    removeClip(row.hash);
    const made = storeGeneratedSpeech(
      db,
      opened.store,
      {
        text: row.source_text,
        lang: row.lang,
        voice,
        options: JSON.parse(row.options === "" ? "{}" : row.options) as Record<string, string>,
      },
      bytes,
    );
    remade += 1;
    console.log(`  ${String(remade).padStart(3)}/${rows.length}  ${made.slice(0, 8)}  ${voice}  ${label}`);
  } catch (cause) {
    failed += 1;
    failures.push(`${label}: ${(cause as Error).message}`);
    console.error(`  FAILED  ${label}  — ${(cause as Error).message.slice(0, 100)}`);
  }
}

opened.close();
db.close();

console.log(
  `\nremade ${remade}, failed ${failed}, skipped ${unspeakable} with nothing to speak`,
);
for (const failure of failures) console.log(`  ${failure}`);
if (remade > 0) {
  console.log(
    "\nTHE PHONE STILL HAS THE OLD BYTES until the seed is rebuilt:\n" +
      "  npx vite-node scripts/app-bootstrap.ts -- --speech-bytes 650000000\n" +
      "then restart the server so it serves the new store:\n" +
      "  npx kill-port 4274 ; npm run phone\n" +
      "\nThe replaced clips are kept in build/voice-refill-old/ in case the voice is wrong.",
  );
}
