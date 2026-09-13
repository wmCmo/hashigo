/**
 * `npx vite-node src/accent/cli.ts -- respeak --db build/hashigo.db [--dry]`
 *
 * The command half of `./respeak.ts`. That file carries the reasoning; this one
 * owns the key, the progress and the order.
 *
 * ─── `--dry` COSTS NOTHING AND IS THE DEFAULT THING TO RUN FIRST ────────────
 *
 * It opens the database READ-ONLY, asks Google for nothing, and prints exactly
 * what a real run would synthesise and what it would leave plain. Four years of
 * audio are about to change voice; the shape of that should be readable before
 * a single call is billed.
 */
import { existsSync, readFileSync } from "node:fs";

import {
  defaultStoreDatabase,
  openBlobStore,
  openBlobStoreDatabase,
  type BlobStore,
} from "../blobs/index.js";
import type { Db } from "../db/index.js";
import { arg, flag } from "../cli/args.js";
import { NotKanaError, VOICE } from "./speech.js";
import { adoptVoice, moveRefs, respeakPlan, respeakWord, type RespeakReport } from "./respeak.js";

/**
 * The key, from `.env`, read here rather than taken from the environment.
 *
 * Decision 18 is about the CLIENT, and this is a CLI — but the same reasoning
 * about WHERE a secret is allowed to appear applies to a shell: a key passed as
 * `--key` lands in history and in the process list. `.env` is gitignored.
 */
function apiKey(): string {
  const fromEnv = process.env["GOOGLE_TTS_SECRET"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (!existsSync(".env")) throw new Error("no .env and no GOOGLE_TTS_SECRET in the environment");
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("GOOGLE_TTS_SECRET=")) continue;
    const value = trimmed.slice("GOOGLE_TTS_SECRET=".length).trim().replace(/^["']|["']$/g, "");
    if (value !== "") return value;
  }
  throw new Error("GOOGLE_TTS_SECRET is not in .env");
}

/**
 * The PRODUCTION store, which is `<db>.blobs.db` and not `<db>.blobs`.
 *
 * BOTH EXIST IN THIS REPO and the difference is silent: `build/hashigo.db.blobs`
 * is the legacy one-file-per-payload directory (10,819 files from an earlier
 * format) and `build/hashigo.db.blobs.db` is the SQLite store everything reads
 * today. Defaulting to the directory — which the first version of this did —
 * writes the new clip somewhere real, somewhere addressable, and somewhere the
 * app will never look. Nothing errors. `src/blobs/cli.ts` settled this
 * convention; this follows it, `--store-dir` and all.
 */
function openStore(dbFile: string): BlobStore {
  const dir = arg("store-dir", "");
  if (dir !== "") return openBlobStore(dir);
  const file = arg("store", "") || defaultStoreDatabase(dbFile);
  return openBlobStoreDatabase(file, { mustExist: true, create: false }).store;
}

export async function respeakCommand(db: Db): Promise<number> {
  const plan = respeakPlan(db);
  const annotated = plan.filter((w) => w.request !== null);
  const plain = plan.filter((w) => w.request === null);
  const characters = plan.reduce((sum, w) => sum + w.text.length, 0);

  console.log(`  ${plan.length} distinct head words on 単語 + 言葉`);
  console.log(`    ${annotated.length} with a derived accent — synthesised WITH notation`);
  console.log(`    ${plain.length} without — synthesised plain (a guess is worse than none)`);
  console.log(`    ${characters.toLocaleString()} characters · about $${((characters * 16) / 1e6).toFixed(2)} at Neural2 rates`);
  console.log(`    voice: ${arg("voice", VOICE)}`);

  if (flag("dry")) {
    console.log("\n  --dry: nothing synthesised, nothing written, no voice adopted.");
    for (const word of plain.slice(0, 10)) console.log(`    plain: ${word.text}`);
    return 0;
  }

  // `--only 医療` — one word, which is what he asked for first: *"i need a way
  // to discard/delete the old one and regenerate easily"*. It never adopts the
  // voice, so the card keeps asking for its Nanami clip and the new one sits
  // beside it until a whole run switches over. That makes it a safe way to LISTEN
  // to a regenerated word before committing the corpus to it.
  const only = arg("only", "");
  if (only !== "") {
    const wanted = plan.filter((w) => w.text === only);
    if (wanted.length === 0) {
      console.error(`\n  no head word "${only}" on 単語 or 言葉.`);
      return 2;
    }
    const store = openStore(arg("db"));
    const one: RespeakReport = {
      made: 0, cached: 0, failed: 0, annotated: 0, plain: 0, refsMoved: 0, failures: [],
    };
    console.log(`\n  --only ${only}: the voice is NOT adopted, so nothing else changes.`);
    return await runAll(db, wanted, store, one, false);
  }

  const limit = Number(arg("limit", String(plan.length)));
  const store = openStore(arg("db"));
  const report: RespeakReport = {
    made: 0, cached: 0, failed: 0, annotated: 0, plain: 0, refsMoved: 0, failures: [],
  };

  return await runAll(db, plan.slice(0, limit), store, report, limit >= plan.length);
}

async function runAll(
  db: Db,
  words: ReturnType<typeof respeakPlan>,
  store: BlobStore,
  report: RespeakReport,
  whole: boolean,
): Promise<number> {
  const key = apiKey();
  // Sequential on purpose. The quota is per minute, a 429 mid-run costs more
  // than the wall clock saved, and this is resumable — so a slow correct run
  // beats a fast one that has to be reasoned about afterwards.
  for (const [index, word] of words.entries()) {
    try {
      const { hash, made } = await respeakWord(db, word, { apiKey: key, store });
      if (made) report.made += 1;
      else report.cached += 1;
      if (word.request === null) report.plain += 1;
      else report.annotated += 1;
      report.refsMoved += moveRefs(db, word, hash);
    } catch (cause) {
      report.failed += 1;
      const why = cause instanceof NotKanaError ? "reading is not kana" : String(cause);
      report.failures.push(`${word.text}: ${why}`);
    }
    if ((index + 1) % 100 === 0) {
      console.log(`    ${index + 1}/${words.length} · ${report.made} made · ${report.failed} failed`);
    }
  }

  console.log(
    `\n  ${report.made} synthesised · ${report.cached} already present · ` +
      `${report.failed} failed · ${report.refsMoved} references moved`,
  );
  for (const failure of report.failures.slice(0, 20)) console.log(`    ! ${failure}`);

  // THE VOICE IS ADOPTED LAST, AND ONLY ON A CLEAN WHOLE RUN. Adopting it while
  // any word is missing its clip makes those cards silent — see `respeak.ts`.
  if (!whole) {
    console.log("\n  --limit was set, so the voice was NOT adopted. Re-run without it.");
    return 0;
  }
  if (report.failed > 0) {
    console.log(
      `\n  ${report.failed} words failed, so the voice was NOT adopted — adopting it now ` +
        `would leave those cards silent. Fix them and run again.`,
    );
    return 1;
  }
  const voice = arg("voice", VOICE);
  console.log(`\n  adopted ${voice} on ${adoptVoice(db, voice)} field(s).`);
  console.log("  The Nanami clips are UNREFERENCED, not deleted — flip the fields back to undo.");
  return 0;
}
