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
      const fresh = db.transaction(() => {
        const written = storeGeneratedSpeech(db, store, descriptor, bytes);
        if (written === row.hash) return false;
        db.prepare("UPDATE blobs SET refcount = 0 WHERE hash = ?").run(row.hash);
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
