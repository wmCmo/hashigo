/**
 * REMAKE EVERY CLIP THAT WAS SPOKEN IN THE WRONG LANGUAGE'S VOICE.
 *
 * Zach, 2026-09-20, on an English card: *"the example sentence is in Japanese
 * voice 😭 … i need a way to 1. delete the current audio 2. regenerate a correct
 * voice"*. This is both halves, for the whole corpus at once, because the per-card
 * button would be **130 visits**.
 *
 * ─── WHAT IT SELECTS, AND WHY IT IS NOT "ALL ENGLISH" ───────────────────────
 *
 * A row is wrong when the voice's own language prefix disagrees with the clip's
 * `lang`: `ja-JP-Neural2-C` speaking `en-US`. That is a fact each row states
 * about ITSELF, so the query needs no list of languages and finds the next such
 * case for free — if a Korean card ever gets filled by the Japanese voice, this
 * finds it the same day.
 *
 * Measured on the real corpus 2026-09-20: **130 rows, 5.7 MiB, every one
 * `ja-JP-Neural2-C` speaking `en-US`**, created 2026-09-15 to 2026-09-17 by the
 * fill path before `fillVoiceFor` existed. **None of the 130 has a correct-voice
 * clip of the same text**, which is why they are audible rather than dormant —
 * the resolver has nothing else to find.
 *
 * Rows whose voice is NULL are left alone: 999 of them exist and "no recorded
 * voice" is not the same claim as "the wrong voice".
 *
 * ─── DELETE NEEDS THE REFCOUNT DANCE, AND THE SCHEMA ENFORCES IT ────────────
 *
 * `blobs` carries a trigger — *"blob is still referenced: delete only at refcount
 * 0"* — and `storeGeneratedSpeech` writes 1, because a generator mount has no
 * `blob_refs` row to count it. So a delete here is `refcount = 0` then `DELETE`,
 * which is exactly what `sweepUnreferenced` does, plus the payload in the second
 * database. Anything with a real `blob_refs` row is REFUSED rather than force-
 * deleted: that would be an attachment, and this script has no business there.
 *
 * ─── IT IS A DRY RUN UNLESS TOLD OTHERWISE ──────────────────────────────────
 *
 * `--apply` writes. Without it nothing is deleted, nothing is synthesised and
 * nothing is billed — it prints what it would do. The same shape as
 * `scripts/reading-apply.ts` and `src/backup/cli.ts`, for the same reason: this
 * one spends money and destroys audio, and both are worth seeing first.
 *
 * Idempotent. A second run finds nothing, because the remade clips carry the
 * right voice and no longer match.
 *
 *   npx vite-node scripts/voice-refill.ts                  # what would change
 *   npx vite-node scripts/voice-refill.ts -- --apply       # do it
 *   npx vite-node scripts/voice-refill.ts -- --apply --limit 5
 *
 * AFTER IT RUNS, THE PHONE STILL HAS THE OLD BYTES. The device's store is a copy
 * made by `scripts/app-bootstrap.ts`; rebuild the seed or the card keeps playing
 * what it already downloaded. The script says so at the end rather than leaving
 * it to be discovered on the train.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { synthesise } from "../src/accent/speech.js";
import { defaultStoreDatabase, openBlobStoreDatabase } from "../src/blobs/index.js";
import { readBlob } from "../src/blobs/db.js";
import { openDatabase } from "../src/db/index.js";
import { fillVoiceFor, storeGeneratedSpeech } from "../src/generate/index.js";
import { speakableText } from "../src/text/index.js";

// Japanese in a Windows console is cp932 without this. CLAUDE.md: the script sets
// its own encoding, never the caller's environment.
process.stdout.setDefaultEncoding("utf8");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const limitAt = args.indexOf("--limit");
const LIMIT = limitAt === -1 ? Infinity : Number(args[limitAt + 1] ?? "0");
const dbAt = args.indexOf("--db");
const CARD_DB = resolve(dbAt === -1 ? "build/hashigo.db" : (args[dbAt + 1] as string));

/**
 * The rows where the voice disagrees with the text's own language.
 *
 * `substr(voice, 1, 2) <> substr(lang, 1, 2)` is the whole rule. Google names
 * every voice `<lang>-<region>-<family>`, which is the same property
 * `src/accent/speech.ts` relies on to derive `languageCode` from the voice — so
 * this compares two things that are both BCP-47 prefixes by construction.
 */
const WRONG = `
SELECT hash, source_text, voice, lang, options, byte_size
  FROM blobs
 WHERE kind = 'speech'
   AND voice IS NOT NULL AND lang IS NOT NULL
   AND substr(voice, 1, 2) <> substr(lang, 1, 2)
 ORDER BY created_at`;

/**
 * `--lang en` — every clip of one language that is not at its CURRENT fill voice.
 *
 * THE DEFAULT SELECTION CANNOT FIND A CLIP THIS SCRIPT ALREADY FIXED, and that is
 * the point of this mode. Once a clip is remade, its voice agrees with its
 * language and `WRONG` stops matching it — correct, and useless the day Zach
 * listens to `en-US-Neural2-D` and prefers another. This re-selects by language
 * so changing `FILL_VOICES.en` and re-running is one command rather than a
 * restore from `build/voice-refill-old/`.
 *
 * It is opt-in and takes a language on purpose: run over `ja` it would try to
 * replace all **7,409** of Mochi's Nanami clips, which is exactly the wholesale
 * regeneration Zach has deferred five times.
 */
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
  // Only where a DIFFERENT voice would now be chosen. A row already at its
  // language's fill voice is not something this script can improve.
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
  // WHAT WILL BE SPOKEN, not what is stored — they differ on 106 of the 130 and
  // the difference is the whole second half of this repair. A preview that
  // printed `source_text` would show the markup and hide the fix.
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
  // Read here rather than at import, so a run with no key fails with a sentence
  // instead of at the first synthesis, 40 clips in.
  try {
    process.loadEnvFile(resolve(".env"));
  } catch {
    /* no .env is fine if the variable is already in the environment */
  }
  const found = process.env["GOOGLE_TTS_SECRET"];
  if (found === undefined || found === "") {
    console.error("\nno GOOGLE_TTS_SECRET — put it in .env on the laptop.");
    process.exit(1);
  }
  return found;
})();

/** Exactly `sweepUnreferenced`'s two steps, plus the payload. */
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

/** Made once. The replaced bytes go here so a wrong voice choice is undoable. */
const BACKUP_DIR = resolve("build/voice-refill-old");
mkdirSync(BACKUP_DIR, { recursive: true });

let remade = 0;
let failed = 0;
/** Rows whose text is an unfilled generator: nothing to say, so nothing is billed. */
let unspeakable = 0;
const failures: string[] = [];

for (const row of rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT)) {
  const voice = fillVoiceFor(row.lang);
  const label = row.source_text.slice(0, 48).replace(/\s+/g, " ");
  // NOT `row.source_text` — see the endpoint. 76 of these read markdown asterisks
  // aloud and 30 recite an unfilled `<ai>` prompt; re-voicing those in English
  // would buy a better accent for the same nonsense.
  const spoken = speakableText(row.source_text);
  if (spoken === "") {
    unspeakable += 1;
    console.log(`  SKIP  nothing to speak (the field is an unfilled generator)  ${label}`);
    continue;
  }
  try {
    // SYNTHESISE FIRST, DELETE SECOND. The other order leaves him with silence on
    // a card whenever Google answers 503 — and these 130 have no correct-voice
    // alternative to fall back to, so the old clip is all there is until the new
    // one exists.
    const bytes = await synthesise(spoken, null, { apiKey: key, voice });
    // Keep a copy of the bytes we are about to destroy, so a bad voice choice is
    // recoverable without a second bill. Gitignored, like everything in build/.
    try {
      const old = readBlob(db, row.hash, opened.store);
      writeFileSync(resolve(BACKUP_DIR, `${row.hash.slice(0, 16)}.mp3`), old);
    } catch {
      /* a row whose payload was already gone — nothing to keep */
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
