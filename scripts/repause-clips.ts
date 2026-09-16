/**
 * RE-SPEAK THE CLIPS THIS PROJECT MADE BEFORE IT KNEW ABOUT `、`.
 *
 * Zach, 2026-09-16: *"i think the generated audio was speaking without pausing
 * on comma or natural pausing section"*. `src/accent/speech.ts` now spells a
 * sentence's written pauses as `<break>` — measured there — but the clips the
 * 2026-09-16 fill already made were synthesised straight through. This replaces
 * exactly those.
 *
 *     npx vite-node scripts/repause-clips.ts -- --dry      # says what it would do
 *     npx vite-node scripts/repause-clips.ts -- --apply    # does it
 *
 * ─── WHY THIS IS A REPLACE AND NOT AN INSERT ────────────────────────────────
 *
 * The identity is `(kind, sourceText, voice, lang, options)` and none of those
 * change — the text is the same text and Neural2-C is still the voice. Only the
 * BYTES change, and `blobs.hash` is the sha256 of the bytes and the primary key.
 * So a plain re-synthesis writes a SECOND row under the same identity, and
 * `lookupGeneration` then has two answers to one question.
 *
 * That is the trap `respeak-cli` and the 2026-09-16 fill both hit from the other
 * side (63 generations lost to a hash collision, "3,850 clips made, zero
 * failures reported, 161 cards mute"). So the old row and its payload go, in the
 * same transaction that writes the new ones — and the `--dry` run does the real
 * synthesis accounting without touching the database.
 *
 * ─── WHAT IT WILL NOT TOUCH ─────────────────────────────────────────────────
 *
 * Anything Mochi made. Every clip in the export is Azure — `ja-JP-NanamiNeural`,
 * `en-US-AIGenerate1Neural` — and this selects on `voice = FILL_VOICE`, which
 * only this project ever writes. Zach has deferred regenerating the CORPUS five
 * times and that decision is untouched: the 136 clips this selects were made
 * TODAY, by us, and are the only ones that were ever spoken straight through.
 *
 * It also skips anything `pausedSsml` declines, so a word that merely happens to
 * be filed under the fill voice is left exactly as it is.
 */
import { existsSync } from "node:fs";

import { pausedSsml, synthesise } from "../src/accent/speech.js";
import { defaultStoreDatabase, openBlobStoreDatabase } from "../src/blobs/index.js";
import { FILL_VOICE, storeGeneratedSpeech } from "../src/generate/index.js";
import { openDatabase } from "../src/db/index.js";

function arg(name: string, fallback: string): string {
  const flag = `--${name}`;
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function apiKey(name: string): string {
  if (existsSync(".env") && process.env[name] === undefined) process.loadEnvFile(".env");
  const key = process.env[name];
  if (key === undefined || key === "") throw new Error(`no ${name} in .env`);
  return key;
}

interface Clip {
  readonly hash: string;
  readonly source_text: string;
  readonly lang: string | null;
  readonly options: string;
  readonly byte_size: number;
}

async function main(): Promise<number> {
  const dbFile = arg("db", "build/hashigo.db");
  const apply = has("apply");
  const limit = Number(arg("limit", "0")) || Number.POSITIVE_INFINITY;
  if (!apply && !has("dry")) {
    console.log("  pass --dry to see the cost, or --apply to spend it");
    return 2;
  }

  const db = openDatabase(dbFile, { applySchema: false });
  const opened = openBlobStoreDatabase(defaultStoreDatabase(dbFile));
  const store = opened.store;

  const rows = db
    .prepare(
      `SELECT hash, source_text, lang, options, byte_size
         FROM blobs
        WHERE kind = 'speech' AND voice = ?
        ORDER BY source_text`,
    )
    .all(FILL_VOICE) as Clip[];

  // The selection is `pausedSsml`'s own answer, not a second regex — a rule
  // stated twice is a rule that drifts, and this one decides what gets re-spoken.
  const targets = rows.filter((row) => pausedSsml(row.source_text) !== null).slice(0, limit);

  const characters = targets.reduce((n, row) => n + row.source_text.length, 0);
  console.log(`  ${rows.length} clips under ${FILL_VOICE}`);
  console.log(`  ${targets.length} carry a written pause and were spoken straight through`);
  console.log(`  ${characters.toLocaleString()} characters ≈ $${((characters / 1e6) * 16).toFixed(2)} at Neural2 pricing`);
  if (!apply) {
    for (const row of targets.slice(0, 5)) console.log(`    ${row.source_text.slice(0, 44)}`);
    console.log(`\n  --dry — nothing written`);
    opened.close();
    db.close();
    return 0;
  }

  const key = apiKey("GOOGLE_TTS_SECRET");
  let done = 0;
  let unchanged = 0;
  let failed = 0;
  for (const row of targets) {
    try {
      const bytes = await synthesise(row.source_text, null, { apiKey: key, voice: FILL_VOICE });
      const descriptor = {
        text: row.source_text,
        lang: row.lang,
        options: JSON.parse(row.options) as Record<string, string>,
      };
      // THE OLD ROW GOES FIRST, or the identity briefly has two answers and a
      // crash in between leaves it that way. The payload goes with it: nothing
      // else can reference a generation blob (no `blob_refs` row, refcount 1),
      // so leaving it is an orphan the sweep would collect anyway.
      const fresh = db.transaction(() => {
        const written = storeGeneratedSpeech(db, store, descriptor, bytes);
        if (written === row.hash) return false;
        db.prepare("DELETE FROM blobs WHERE hash = ?").run(row.hash);
        return true;
      })();
      if (fresh) {
        store.remove(row.hash);
        done += 1;
      } else {
        unchanged += 1;
      }
    } catch (cause) {
      failed += 1;
      console.log(`  ! ${row.source_text.slice(0, 30)} — ${(cause as Error).message}`);
    }
    if ((done + unchanged + failed) % 25 === 0) {
      console.log(`  … ${done + unchanged + failed} of ${targets.length}`);
    }
  }
  console.log(`\n  ${done} replaced · ${unchanged} already identical · ${failed} failed`);
  console.log(`  rebuild the device seed to deliver them: npm run app:bootstrap -- --speech-bytes 650000000`);
  opened.close();
  db.close();
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();
