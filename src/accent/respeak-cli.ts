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
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  defaultStoreDatabase,
  openBlobStore,
  openBlobStoreDatabase,
  type BlobStore,
} from "../blobs/index.js";
import type { Db } from "../db/index.js";
import { arg, flag } from "../cli/args.js";
import { NotKanaError, synthesise, VOICE } from "./speech.js";
import {
  adoptVoice,
  collisions,
  moveRefs,
  respeakPlan,
  respeakWord,
  type RespeakReport,
} from "./respeak.js";

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

  // SAID BEFORE THE MONEY, NOT AFTER. The audio is a function of (reading,
  // accent), so homophones are byte-identical and only one of each group can
  // hold a row — `blobs.hash` is a PRIMARY KEY. The first full run learned this
  // the expensive way: 3,850 clips made, zero failures reported, 161 cards mute.
  const clashes = collisions(plan);
  const silenced = [...clashes.values()].reduce((n, ws) => n + ws.length - 1, 0);
  if (silenced > 0) {
    console.log(
      `\n  ${silenced} words in ${clashes.size} groups synthesise to IDENTICAL bytes —`,
    );
    console.log("  same reading, same accent, therefore one sha256 and one row.");
    console.log("  The rest of each group would go SILENT:");
    for (const [key, words] of [...clashes.entries()].slice(0, 5)) {
      console.log(`    ${key.padEnd(14)} ${words.join(" ")}`);
    }
  }

  if (flag("dry")) {
    console.log("\n  --dry: nothing synthesised, nothing written, no voice adopted.");
    for (const word of plain.slice(0, 10)) console.log(`    plain: ${word.text}`);
    return 0;
  }

  // ─── `--only 医療` IS A PREVIEW, AND IT CANNOT HONESTLY BE MORE THAN THAT ───
  //
  // He asked for *"a way to discard/delete the old one and regenerate easily"*,
  // meaning one card. The voice lives on the FIELD, not the card, so a single
  // card cannot be switched: it keeps asking for its Nanami clip whatever else
  // exists. An earlier version of this wrote the blob and moved the reference
  // anyway, which changed nothing audible and left the refcounts lying — the
  // Nanami clip still in use at refcount 0, one `sweepUnreferenced` away from
  // being deleted out from under the card.
  //
  // So this writes a FILE and touches no row. Listen to it, compare it with what
  // the card plays today, and decide about the corpus with your ears.
  const only = arg("only", "");
  if (only !== "") {
    const wanted = plan.find((w) => w.text === only);
    if (wanted === undefined) {
      console.error(`\n  no head word "${only}" on 単語 or 言葉.`);
      return 2;
    }
    const out = arg("out", `build/respeak-${only}.mp3`);
    const bytes = await synthesise(wanted.text, wanted.request, {
      apiKey: apiKey(),
      voice: arg("voice", VOICE),
    });
    writeFileSync(out, bytes);
    const how =
      wanted.request === null
        ? "plain (no derived accent)"
        : `^${wanted.request.reading} accent ${wanted.request.accent}`;
    console.log(`\n  --only ${only}: ${how}`);
    console.log(`  ${bytes.length} bytes -> ${out}`);
    console.log("  NOTHING in the database changed. The card still plays its Nanami clip.");
    return 0;
  }

  // A WHOLE RUN IS REFUSED WHILE ANY GROUP WOULD BE SILENCED. `--only` is
  // unaffected (it adopts no voice, so nothing can go quiet), and `--force`
  // exists for the day the schema can hold many identities per payload.
  if (silenced > 0 && !flag("force")) {
    console.error(
      `\n  refusing: a whole run would silence ${silenced} words. ` +
        `Use --only <word> for one, or --force once the schema can hold them.`,
    );
    return 1;
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
