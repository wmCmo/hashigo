/**
 * The three files `app/` fetches on first run.
 *
 *   npx vite-node scripts/app-bootstrap.ts
 *     [--db build/hashigo.db] [--store build/hashigo.db.blobs.db]
 *     [--out build/app] [--speech-bytes 209715200]
 *
 * Writes `build/app/hashigo-app.db` (the cards), `build/app/hashigo-app-gen.db`
 * (every text generation, ~9 MB) and `build/app/hashigo-app-blobs.db` (a BOUNDED
 * subset of the audio), which `vite.app.config.ts` serves under those names.
 *
 * ─── WHY THIS IS NOT `spike/make-bootstrap.mjs` OR `make-viewer-db.ts` ──────
 *
 * Both of those do the mechanism correctly and both are labelled THROWAWAY. The
 * app is not, and an asset pipeline that a shipping page depends on should not
 * live in a directory whose README tells you to delete it. `notes/archive/next-history.md` says it
 * plainly: reuse the mechanism, not the code. So the two hard-won facts are
 * reused explicitly and named:
 *
 * **1. `VACUUM INTO`, not a file copy.** `build/hashigo.db` is in WAL mode
 * (header bytes 18 and 19 are both 2) with `-wal` / `-shm` sidecars, and
 * `opfs-sahpool` stores one file per name — so a sidecar cannot be imported and
 * anything still living only in the WAL would be **silently missing in the
 * browser**. `VACUUM INTO` reads through the WAL and writes one self-contained,
 * checkpointed, delete-journal file. The source is opened READ-ONLY on purpose:
 * other work in this repo uses it at the same time, and a bootstrap step must not
 * checkpoint or relocate it.
 *
 * **2. The audio subset is BOUNDED, and the selection rule is stated** — a subset
 * with an unstated rule is a lie. The full store is 617.9 MiB / 10,816 payloads
 * and nobody downloads that to review ten cards. So:
 *
 *   a. every `image` and `file` payload — few, and the only non-audio blobs that
 *      are not already inline in the card database;
 *   b. **each card's CHEAPEST speech clip first**, in ascending size order, so no
 *      card gets a second clip before every card has a first; then the remaining
 *      clips by size, until `--speech-bytes` is spent.
 *
 * ─── RULE (b) WAS "ALL SPEECH, SMALLEST FIRST", AND THAT WAS SUBTLY WRONG ───
 *
 * The old rule ordered every distinct blob by size globally. The reasoning was
 * sound as far as it went — a clip's size tracks the length of what it says, so
 * smallest-first buys single WORDS at ~35 KB instead of sentences at ~120 KB — and
 * the figure it printed, 90.0% of speech-bearing cards at 200 MiB, was true.
 *
 * **It was also the average of 100% and almost nothing.** Zach found it by opening a
 * 数字 card that played silence. Measured per deck, at the same 200 MiB:
 *
 * ```
 * deck                 playable   median clip     under the new rule
 * 日本語/単語               100%        36 KB          100%
 * English/Vocabulary      100%        38 KB          100%
 * 日本語/言葉                100%        41 KB          100%
 * 日本語/数字                 26%        96 KB          100%
 * 日本語/文法                 73%        68 KB          100%
 * 基本情報/第11章               7%       124 KB           78%
 * 基本情報/第9章                0%       110 KB           86%
 * ```
 *
 * Size is a proxy for "short utterance" and short utterance is a proxy for "single
 * word" — so global smallest-first covered the vocabulary decks completely and spent
 * nothing on the decks whose clips are inherently long. A 数字 card SAYS a nine-digit
 * number; there is no cheap version of it.
 *
 * Taking each card's cheapest clip first optimises the metric this script actually
 * reports — cards that can play something — instead of a proxy for it. Same budget,
 * measured over the real store:
 *
 * ```
 *  budget   smallest-first   cheapest-per-card
 *  128 MiB   4,537 (79.5%)      4,654 (81.5%)
 *  200 MiB   5,136 (90.0%)      5,607 (98.2%)
 *  300 MiB   5,158 (90.4%)      5,708 (100.0%)
 * ```
 *
 * **Why it matters more than the eight points suggest:** the cards it was starving
 * are the ones where the clip is the QUESTION. `src/review/mode.ts` prompts on entry
 * whenever a side carries a widget — a 数字 card's `<input>` means "produce your
 * answer here" — so a missing clip there is not a missing extra, it is the card
 * asking nothing at all. 89 of 90 数字 cards were in that state.
 *
 * ─── TEXT GENERATIONS USED TO "RIDE ALONG FOR FREE". THEY DID NOT ──────────
 *
 * This header said so until 2026-09-16: ai, translate, furigana and dictionary
 * outputs are stored INLINE in the card database's `blobs.bytes`, "so they
 * arrive with file 1". True of the FILE and false of the DEVICE, which is the
 * distinction that matters.
 *
 * File 1 is only re-fetched when `seedReviews` differs, and filling a generation
 * moves that number by exactly zero — so 1,631 generations filled on 2026-09-15
 * could not reach his phone by any rebuild. Identical in shape to the audio bug
 * of 2026-09-12, which is the one this script's own `storeCreated` exists for.
 *
 * They now ship as file 3 on the audio's terms: content-addressed, read-only, no
 * grade or card in it, therefore free to replace — and **1.60 MiB of content for
 * all 28,676 of them** (~9 MB as a SQLite file, against 627 MiB of audio).
 *
 * Payloads are RE-HASHED on the way in, so the browser plays bytes that provably
 * still match the address the card database refers to.
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import { SqliteBlobStore } from "../src/blobs/sqlite.js";
import { primaryLabelFor } from "../src/accent/store.js";
import { contentAddress } from "../src/import/blobs.js";
import { measureAudio, mib } from "./audio-gc-core.js";

process.stdout.setDefaultEncoding("utf8");

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : argv[at + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
};

const cardSource = resolve(flag("db", "build/hashigo.db"));
const storeSource = resolve(flag("store", `${flag("db", "build/hashigo.db")}.blobs.db`));
const outDir = resolve(flag("out", "build/app"));

/**
 * 種を作る前に、どこからも届かない音声が残っていないかを見る — 2026-09-28。
 *
 * 片付けは `scripts/audio-gc.ts` で、ここは測るだけ（同じ `measureAudio`）。残っていれば
 * 種を作らずに止まる: 種はノートPCの行を全部運ぶので、ここを通った孤児は全端末に
 * 広がる。2026-09-28 に見つかったのは 834 行と行のない中身 3,692 件、合わせて 66.7 MiB
 * で、どれも誰も気付かないまま溜まっていた。
 *
 * 全端末の同期 payload を読むので mailbox に届く必要がある。オフラインで種を
 * 作るときは `--allow-orphans` で飛ばせる（そう言って飛ばす）。
 */
if (argv.includes("--allow-orphans")) {
  console.log("audio check SKIPPED (--allow-orphans) — unreached clips may ship to every device");
} else {
  const audit = await measureAudio({ db: cardSource, storeDb: storeSource, graceDays: 14 });
  const left = audit.plan.doomed.length + audit.rowless.length;
  if (left > 0) {
    console.error(
      `refusing to build a seed: ${audit.plan.doomed.length} unreached clip(s) and ` +
        `${audit.rowless.length} payload(s) with no row (${mib(audit.doomedBytes + audit.rowlessBytes)}).\n` +
        `  npx vite-node scripts/audio-gc.ts             # see them\n` +
        `  npx vite-node scripts/audio-gc.ts -- --apply  # archive and remove, then run this again`,
    );
    process.exit(1);
  }
  console.log(
    `audio check: nothing unreached across ${audit.sources.length} device payload(s) · ` +
      `${audit.plan.kept.recent} recent clip(s) kept for unsynced devices`,
  );
}
/**
 * 200 MiB — and the number is a measurement, not a round figure.
 *
 * It was 32 MiB, chosen for "a first run over a tunnel" when the tunnel was ngrok
 * or a Cloudflare quick tunnel: metered, or a new origin every session that pays
 * the download again. **`tailscale serve` is neither** — tailnet transfer is
 * direct and uncapped, and the origin is fixed, so the download happens once.
 *
 * Coverage against `--speech-bytes`, measured over the real store (10,791 distinct
 * speech blobs, 618 MiB), smallest-first as rule (b) takes them:
 *
 * ```
 *    32 MiB ->  1,358 of 5,708 cards (23.8%)   <- the old default
 *    64 MiB ->  2,510                 (44.0%)
 *   128 MiB ->  4,537                 (79.5%)
 *   200 MiB ->  5,136                 (90.0%)  <- here
 *   400 MiB ->  5,232                 (91.7%)
 *   618 MiB ->  5,708                (100.0%)
 * ```
 *
 * **200 is where the curve turns.** The next 200 MiB buys 1.7 points, because what
 * is left is the long example-sentence clips; the last 10% costs 418 MiB.
 *
 * The reason coverage matters more on the phone than the figure suggests: decision
 * 29's mode 2 covers **3,177 cards where the audio IS the question**. A missing clip
 * there is not a missing extra, it is the prompt going missing.
 */
const speechBudget = Number(flag("speech-bytes", String(200 * 1024 * 1024)));

const cardOut = resolve(outDir, "hashigo-app.db");
const storeOut = resolve(outDir, "hashigo-app-blobs.db");
const genOut = resolve(outDir, "hashigo-app-gen.db");
const fieldsOut = resolve(outDir, "hashigo-app-fields.db");
let genRows = 0;
let genBytes = 0;
let fieldRows = 0;
let fieldValueRows = 0;
let fieldCorrectionRows = 0;

/** Header bytes 18 and 19: 1 = rollback journal, 2 = WAL. */
function journalMode(file: string): { write: number; read: number } {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(20);
    readSync(fd, head, 0, 20, 0);
    return { write: head[18] ?? 0, read: head[19] ?? 0 };
  } finally {
    closeSync(fd);
  }
}

function need(file: string, how: string): void {
  if (existsSync(file)) return;
  process.stdout.write(`app-bootstrap: ${file} does not exist.\n  ${how}\n`);
  process.exit(1);
}

need(
  cardSource,
  "npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報",
);
need(storeSource, "the blob store is written by the same import; check --store");

mkdirSync(outDir, { recursive: true });

// ─── 1. the card database ────────────────────────────────────────────────────

for (const stale of [cardOut, `${cardOut}-wal`, `${cardOut}-shm`]) {
  if (existsSync(stale)) rmSync(stale);
}

const source = new Database(cardSource, { readonly: true, fileMustExist: true });
try {
  const cards = Number(
    (source.prepare("SELECT count(*) AS n FROM cards").get() as { n: number }).n,
  );
  const reviews = Number(
    (source.prepare("SELECT count(*) AS n FROM reviews").get() as { n: number }).n,
  );
  source.prepare("VACUUM INTO ?").run(cardOut);
  const mode = journalMode(cardOut);
  if (mode.write === 2 || mode.read === 2) {
    process.stdout.write(
      `app-bootstrap: ${cardOut} came out in WAL mode (${mode.write}/${mode.read}). ` +
        `opfs-sahpool cannot import that — it stores one file per name and the -wal ` +
        `sidecar would be lost silently. Refusing to ship it.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `cards   ${cardOut}\n` +
      `        ${statSync(cardOut).size.toLocaleString()} bytes · ` +
      `${cards.toLocaleString()} cards · ${reviews.toLocaleString()} reviews · ` +
      `journal ${mode.write}/${mode.read}\n`,
  );
} finally {
  source.close();
}

// ─── 2. the bounded audio subset ─────────────────────────────────────────────

/**
 * 前回の音声ファイルの同一性。中身が同じなら `created` を引き継ぐ。
 *
 * `blob_store_meta.created` は端末が音声を取り直すかどうかの唯一の判断材料で
 * (`audioIsStale`)、DDL は毎回それを新しく書く。つまり `型` を一つ直すための再実行
 * でも、彼の電話は 640 MB を取り直していた — 2026-09-25、電車の中で。同一性は中身が
 * 変わったときにだけ変わるべきなので、収めたハッシュの集合が前回と同じなら前回の
 * 値に戻す。予算を変えれば集合が変わり、従来どおり取り直しになる。
 */
const previousAudio = ((): { created: string; hashes: string } | null => {
  if (!existsSync(storeOut)) return null;
  const old = new Database(storeOut, { readonly: true });
  try {
    const created = old.prepare("SELECT value FROM blob_store_meta WHERE key = 'created'").pluck().get();
    if (typeof created !== "string") return null;
    const hashes = (old.prepare("SELECT hash FROM blob_payloads ORDER BY hash").pluck().all() as string[]).join(",");
    return { created, hashes };
  } catch {
    return null;
  } finally {
    old.close();
  }
})();

for (const stale of [storeOut, `${storeOut}-wal`, `${storeOut}-shm`]) {
  if (existsSync(stale)) rmSync(stale);
}

/**
 * KINDS LIVE IN THE CARD DATABASE, NOT IN THE STORE. `blob_payloads` is
 * deliberately `(hash, byte_size, bytes)` and nothing else — "there is no third
 * thing, and in particular there is no location" (decision 4). So the selection
 * has to join the store's sizes against the card database's `blobs.kind`, and a
 * payload with no `blobs` row at all is an orphan the subset simply skips.
 */
interface Candidate {
  readonly hash: string;
  readonly kind: string;
  readonly bytes: number;
}

const from = new Database(storeSource, { readonly: true, fileMustExist: true });
const target = new Database(storeOut);
const cardDb = new Database(cardOut, { readonly: true, fileMustExist: true });
try {
  target.pragma("journal_mode = delete");
  const store = new SqliteBlobStore(target as never);

  const kindByHash = new Map(
    (cardDb.prepare("SELECT hash, kind FROM blobs").all() as {
      hash: string;
      kind: string;
    }[]).map((row) => [row.hash, row.kind]),
  );

  /**
   * `hash` -> how cheap it is to give SOME card its first clip.
   *
   * Rule (b): a speech blob that is the cheapest clip of at least one card goes in
   * the first wave, ordered by size; everything else follows. This is what turns
   * "90% overall, 26% on 数字" into "98.2% overall, 100% on 数字" at the same budget
   * — see the header for the measurement and for why 数字 was the deck it starved.
   *
   * Read from the CARD database's `blob_refs`, because the store deliberately knows
   * nothing but `(hash, byte_size, bytes)` — decision 4, no third thing.
   */
  const speechByCard = new Map<string, string[]>();
  for (const row of cardDb
    .prepare(
      `SELECT r.card_id AS card, b.hash AS hash
         FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash
        WHERE b.kind = 'speech'`,
    )
    .all() as { card: string; hash: string }[]) {
    speechByCard.set(row.card, [...(speechByCard.get(row.card) ?? []), row.hash]);
  }
  const storeSize = new Map(
    (from.prepare("SELECT hash, byte_size FROM blob_payloads").all() as {
      hash: string;
      byte_size: number;
    }[]).map((row) => [row.hash, row.byte_size]),
  );
  const firstWave = new Set<string>();
  for (const hashes of speechByCard.values()) {
    // A card whose clips are all absent from the store contributes nothing.
    const present = hashes.filter((hash) => storeSize.has(hash));
    if (present.length === 0) continue;
    let cheapest = present[0] as string;
    for (const hash of present) {
      if ((storeSize.get(hash) as number) < (storeSize.get(cheapest) as number)) cheapest = hash;
    }
    firstWave.add(cheapest);
  }

  const candidates = (
    from
      .prepare("SELECT hash, byte_size AS bytes FROM blob_payloads ORDER BY byte_size ASC")
      .all() as { hash: string; bytes: number }[]
  ).map<Candidate>((row) => ({
    hash: row.hash,
    kind: kindByHash.get(row.hash) ?? "orphan",
    bytes: row.bytes,
  }));

  let written = 0;
  let bytes = 0;
  let speechBytes = 0;
  let skipped = 0;
  const kinds = new Map<string, number>();
  const readBytes = from.prepare("SELECT bytes FROM blob_payloads WHERE hash = ?").pluck();

  /**
   * TWO WAVES, and the order between them is rule (b).
   *
   * Wave 1 is every clip that is some card's cheapest, ascending. Wave 2 is the
   * rest, ascending. `candidates` is already size-ordered, so partitioning it
   * preserves that within each wave — and a non-speech candidate belongs to rule
   * (a), which has no budget, so it can sit in wave 1 and be taken unconditionally.
   *
   * `continue` rather than `break` on the budget was already right and stays right:
   * a clip too big for the remaining budget must not stop a later, smaller one from
   * being taken. With one global pass that only mattered at the boundary; with two
   * waves it is what lets wave 2 keep filling the tail.
   */
  const waves = [
    candidates.filter((c) => c.kind !== "speech" || firstWave.has(c.hash)),
    candidates.filter((c) => c.kind === "speech" && !firstWave.has(c.hash)),
  ];
  for (const candidate of waves.flat()) {
    // Rule (a) takes everything; rule (b) stops at the budget.
    const isSpeech = candidate.kind === "speech";
    if (isSpeech && speechBytes + candidate.bytes > speechBudget) {
      skipped += 1;
      continue;
    }
    if (candidate.kind === "orphan") {
      skipped += 1;
      continue;
    }
    const payload = readBytes.get(candidate.hash) as Uint8Array | undefined;
    if (payload === undefined) {
      skipped += 1;
      continue;
    }
    // Re-hash: the browser must play bytes that still match the address the card
    // database refers to. A mismatch here is a corrupt store, not a warning.
    const address = contentAddress(payload);
    if (address !== candidate.hash) {
      process.stdout.write(
        `app-bootstrap: ${candidate.hash} re-hashes to ${address}. ` +
          `The source store is corrupt; refusing to ship it.\n`,
      );
      process.exit(1);
    }
    store.write(candidate.hash, payload);
    written += 1;
    bytes += candidate.bytes;
    if (isSpeech) speechBytes += candidate.bytes;
    kinds.set(candidate.kind, (kinds.get(candidate.kind) ?? 0) + 1);
  }

  // Coverage, printed rather than implied: how many CARDS can actually make a
  // sound with this subset. That is the number the subset exists to buy, and an
  // unstated one is how a bounded subset turns into a claim about the whole.
  const shipped = new Set(
    (target.prepare("SELECT hash FROM blob_payloads").all() as { hash: string }[]).map(
      (row) => row.hash,
    ),
  );
  const rows = cardDb
    .prepare(
      `SELECT r.card_id AS card, b.hash AS hash
         FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash
        WHERE b.kind = 'speech'`,
    )
    .all() as { card: string; hash: string }[];
  const byCard = new Map<string, string[]>();
  for (const row of rows) byCard.set(row.card, [...(byCard.get(row.card) ?? []), row.hash]);
  let reachable = 0;
  for (const [, list] of byCard) if (list.some((hash) => shipped.has(hash))) reachable += 1;
  const total = byCard.size;

  if (previousAudio !== null && previousAudio.hashes === [...shipped].sort().join(",")) {
    target.prepare("UPDATE blob_store_meta SET value = ? WHERE key = 'created'").run(previousAudio.created);
    process.stdout.write(`audio   unchanged since ${previousAudio.created} — devices will not re-fetch it\n`);
  }

  // ── THE TEXT GENERATIONS, AS THEIR OWN FILE ─────────────────────────────
  //
  // Zach, 2026-09-16, after a rebuild that delivered new audio and none of the
  // new text: *"do i have to run npx vite-node scripts/app-bootstrap.ts --
  // --speech-bytes 650000000"*. He did, for the audio — and it could never have
  // brought him the 1,631 emoji, translations and furigana filled the night
  // before, for the SAME reason the audio needed its own check in the first
  // place:
  //
  //   · a text generation is a `blobs` row in the CARD database;
  //   · the card database is only re-fetched when `seedReviews` differs;
  //   · filling 1,631 generations moves `seedReviews` by exactly zero.
  //
  // So `ensureFile` says "already in OPFS — not re-fetching", in green, for ever.
  // That is the 2026-09-12 audio bug one layer up, and it would have been silent
  // in the same way.
  //
  // **Re-fetching the card database is not the answer and must not become it.**
  // It is 74 MB and it holds his grades; the worker refuses that outright while
  // any local review exists, which is correct. But the CONTENT he is missing is
  // **1.60 MiB for all 28,676 text generations in the corpus** — ai 1.14,
  // translate 0.39, furigana 0.06 — against 627 MiB of audio. So it ships as its
  // own file, on the audio's terms rather than the card database's: content
  // addressed, read-only, no grade or card in it, therefore free to replace.
  //
  // `bytes` is carried INLINE here, which is why this is small at all: the text
  // kinds are the ones `readBlob` finds in the row itself (measured in
  // `src/cards/audio.ts` — ai/translate/furigana/dictionary are 100% inline,
  // speech 0%). Nothing in this file needs the payload store.
  {
    const genDb = new Database(genOut);
    genDb.exec("PRAGMA journal_mode = DELETE");
    genDb.exec(`
      DROP TABLE IF EXISTS generations;
      DROP TABLE IF EXISTS gen_meta;
      CREATE TABLE generations (
        hash        TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        mime        TEXT NOT NULL,
        byte_size   INTEGER NOT NULL,
        source_text TEXT,
        voice       TEXT,
        lang        TEXT,
        options     TEXT NOT NULL,
        bytes       BLOB NOT NULL,
        refcount    INTEGER NOT NULL
      );
      CREATE TABLE gen_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const insert = genDb.prepare(
      `INSERT INTO generations
         (hash, kind, mime, byte_size, source_text, voice, lang, options, bytes, refcount)
       VALUES (@hash, @kind, @mime, @byte_size, @source_text, @voice, @lang, @options, @bytes, @refcount)`,
    );
    const rows = cardDb
      .prepare(
        `SELECT hash, kind, mime, byte_size, source_text, voice, lang, options, bytes, refcount
           FROM blobs
          WHERE kind IN ('ai', 'translate', 'furigana', 'dictionary')
            AND bytes IS NOT NULL AND byte_size > 0`,
      )
      .all() as Record<string, unknown>[];
    genDb.transaction(() => {
      for (const row of rows) insert.run(row);
      // ITS OWN IDENTITY, the same shape as `blob_store_meta.created`. Written
      // fresh on every bootstrap so it changes exactly when the file does — a
      // COUNT would be wrong here for the same reason `seedReviews` is right
      // there: he fills generations on the device from the card button, so a
      // local count stops matching the server's and never recovers.
      genDb
        .prepare("INSERT INTO gen_meta (key, value) VALUES ('created', ?)")
        .run(new Date().toISOString());
    })();
    // 28,676 small rows leave a lot of half-used pages — 9.2 MB on disk for
    // 1.6 MiB of content before this. It is a phone download; the seconds here
    // are free and the megabytes are not.
    genDb.exec("VACUUM");
    genDb.close();
    genRows = rows.length;
    genBytes = rows.reduce((n, row) => n + Number(row["byte_size"] ?? 0), 0);
  }

  // ── FILE 4: THE LOCALLY-AUTHORED FIELDS ────────────────────────────
  //
  // Zach, 2026-09-17, over a 風潮 card: *"somehow ojad field is not here..."*.
  // It was fixed the same hour, in `build/hashigo.db` — and it could not reach
  // his phone, because **the card database is re-fetched only when `seedReviews`
  // differs**, and authoring a field value moves that by zero.
  //
  // That is the audio bug of 2026-09-12 one file over: a seed that changed for a
  // reason the freshness check cannot see, skipped in green, for ever. The repair
  // there was to give the audio its own identity; this gives the local fields
  // theirs.
  //
  // WHAT RIDES HERE: `template_fields.local = 1` and their values — `ojad`
  // (3,719), `型` (3,830), `読み` (12), `かな主流` (6). 320 KB of text. Every one of
  // them is authored or derived HERE and exists in no Mochi export, which is
  // decision 9's definition of the flag and exactly the set with no way across.
  //
  // WHAT DOES NOT: `templates.content`. A body edit would have to overwrite a
  // body he may have edited on the device (the template editor writes one), and
  // `templates.updated_at` exists precisely so that merge can be done with a
  // clock rather than by last-writer. Half-solving it here is worse than the gap.
  {
    const fieldsDb = new Database(fieldsOut);
    fieldsDb.exec("PRAGMA journal_mode = DELETE");
    fieldsDb.exec(`
      DROP TABLE IF EXISTS local_fields;
      DROP TABLE IF EXISTS local_values;
      DROP TABLE IF EXISTS field_meta;
      CREATE TABLE local_fields (
        template_id     TEXT NOT NULL,
        id              TEXT NOT NULL,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL,
        source_field_id TEXT,
        options         TEXT,
        pos             INTEGER NOT NULL,
        PRIMARY KEY (template_id, id)
      );
      CREATE TABLE local_values (
        card_id  TEXT NOT NULL,
        field_id TEXT NOT NULL,
        value    TEXT NOT NULL,
        PRIMARY KEY (card_id, field_id)
      );
      CREATE TABLE field_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- 端末の値が was のままなら value に置き換える。app/local-fields.ts の見出し
      -- 「ひとつだけの例外」を参照。
      DROP TABLE IF EXISTS local_corrections;
      CREATE TABLE local_corrections (
        card_id  TEXT NOT NULL,
        field_id TEXT NOT NULL,
        was      TEXT NOT NULL,
        value    TEXT NOT NULL,
        PRIMARY KEY (card_id, field_id)
      );
    `);
    const fieldDefs = cardDb
      .prepare(
        `SELECT template_id, id, name, type, source_field_id, options, pos
           FROM template_fields WHERE local = 1`,
      )
      .all() as Record<string, unknown>[];
    // JOINED THROUGH THE CARD'S OWN TEMPLATE, never on `field_id` alone.
    // `card_field_values` is deliberately not foreign-keyed to `template_fields`
    // (losing four years of authored text is worse than an orphan row), so two
    // templates declaring the same field id would double-count a value here.
    const values = cardDb
      .prepare(
        `SELECT v.card_id, v.field_id, v.value
           FROM card_field_values v
           JOIN cards c ON c.id = v.card_id
           JOIN template_fields f ON f.template_id = c.template_id AND f.id = v.field_id
          WHERE f.local = 1`,
      )
      .all() as Record<string, unknown>[];
    const putField = fieldsDb.prepare(
      `INSERT INTO local_fields (template_id, id, name, type, source_field_id, options, pos)
       VALUES (@template_id, @id, @name, @type, @source_field_id, @options, @pos)`,
    );
    const putValue = fieldsDb.prepare(
      `INSERT INTO local_values (card_id, field_id, value) VALUES (@card_id, @field_id, @value)`,
    );
    // `型` のうち、OpenJTalk だけなら別のラベルになっていたもの — つまり人の裁定
    // (語の単位か、カードの単位か) が変えた値。端末がまだ OpenJTalk のラベルを
    // 持っていれば、それは彼の編集ではないので置き換えてよい。
    const accentValues = cardDb
      .prepare(
        `SELECT v.card_id, v.field_id, v.value, head.value AS head
           FROM card_field_values v
           JOIN cards c ON c.id = v.card_id
           JOIN template_fields f ON f.template_id = c.template_id AND f.id = v.field_id
           JOIN card_field_values head ON head.card_id = v.card_id AND head.field_id = f.source_field_id
          WHERE f.local = 1 AND f.type = 'accent'`,
      )
      .all() as { card_id: string; field_id: string; value: string; head: string }[];
    const corrections = accentValues.flatMap((row) => {
      const was = primaryLabelFor(cardDb, row.head);
      return was === null || was === row.value
        ? []
        : [{ card_id: row.card_id, field_id: row.field_id, was, value: row.value }];
    });
    const putCorrection = fieldsDb.prepare(
      `INSERT INTO local_corrections (card_id, field_id, was, value)
       VALUES (@card_id, @field_id, @was, @value)`,
    );
    fieldsDb.transaction(() => {
      for (const row of fieldDefs) putField.run(row);
      for (const row of values) putValue.run(row);
      for (const row of corrections) putCorrection.run(row);
      // Its own identity, the same shape as `blob_store_meta.created` and
      // `gen_meta.created`, and for the same reason a COUNT would be wrong: he
      // authors values ON the device (`setField`, and decision 29's `Reading`
      // flip), so a local count stops matching the server's and never recovers.
      fieldsDb
        .prepare("INSERT INTO field_meta (key, value) VALUES ('created', ?)")
        .run(new Date().toISOString());
    })();
    fieldsDb.exec("VACUUM");
    fieldsDb.close();
    fieldRows = fieldDefs.length;
    fieldValueRows = values.length;
    fieldCorrectionRows = corrections.length;
  }

  // ── THE SEED MANIFEST ───────────────────────────────────────────────────
  //
  // A tiny sidecar naming what this bootstrap produced, so a browser that
  // ALREADY holds a database can tell whether it is the current one without
  // downloading 73 MB to find out.
  //
  // WHY IT EXISTS, measured 2026-09-08: `app/db.worker.ts` opens with
  // `reimport: false` and skips the fetch whenever OPFS already has the file, so
  // after the 2026-09-05 re-import the page went on reporting "102,020 reviews"
  // from the August seed with no way to notice. On a phone that is a full review
  // session against stale due dates. Decision 16's final import would do it again.
  //
  // `seedReviews` counts rows that are NOT locally graded, which is the one
  // number local grading can never move — so comparing it is safe once he has
  // started reviewing here, where comparing `count(*)` would not be.
  const seedReviews = Number(
    (
      cardDb
        .prepare("SELECT count(*) AS n FROM reviews WHERE source <> 'local'")
        .get() as { n: number }
    ).n,
  );
  const manifestPath = resolve(dirname(cardOut), "hashigo-app.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        schemaVersion: Number(cardDb.pragma("user_version", { simple: true })),
        cards: Number(
          (cardDb.prepare("SELECT count(*) AS n FROM cards").get() as { n: number }).n,
        ),
        seedReviews,
        payloads: written,
        /**
         * THE AUDIO FILE'S OWN IDENTITY, AND IT IS A SEPARATE QUESTION FROM
         * `seedReviews`.
         *
         * Zach, 2026-09-12, for the third time: *"the example sentence audio is
         * not there"*. It was not there because the clip is not in the shipped
         * subset — and **re-running this script with a bigger `--speech-bytes`
         * would not have fixed it either**, because nothing could tell that the
         * blob store had changed. `seedReviews` is deliberately a property of the
         * CARD database (it is the one number local grading cannot move), so it
         * does not move when only the audio does; `ensureFile` then skips the
         * fetch because OPFS already holds a file by that name, and both devices
         * go on playing the old subset for ever.
         *
         * `blob_store_meta.created` is written fresh by `SqliteBlobStore`'s DDL on
         * every bootstrap, so it changes exactly when the file does. One row, one
         * string — `count(*)` over `blob_payloads` would walk every overflow page
         * of a 560 MB file to answer the same question.
         */
        generations: genRows,
        /** The text file's own identity. Same argument as `storeCreated`. */
        genCreated: String(
          (
            new Database(genOut, { readonly: true })
              .prepare("SELECT value FROM gen_meta WHERE key = 'created'")
              .get() as { value: string } | undefined
          )?.value ?? "",
        ),
        fieldValues: fieldValueRows,
        /** File 4's own identity. Same argument as `storeCreated`. */
        fieldsCreated: String(
          (
            new Database(fieldsOut, { readonly: true })
              .prepare("SELECT value FROM field_meta WHERE key = 'created'")
              .get() as { value: string } | undefined
          )?.value ?? "",
        ),
        storeCreated: String(
          (
            new Database(storeOut, { readonly: true })
              .prepare("SELECT value FROM blob_store_meta WHERE key = 'created'")
              .get() as { value: string } | undefined
          )?.value ?? "",
        ),
      },
      null,
      2,
    )}
`,
    "utf8",
  );

  process.stdout.write(
    `fields  ${fieldsOut}
` +
      `        ${statSync(fieldsOut).size.toLocaleString()} bytes on disk · ` +
      `${fieldRows} local field(s) · ${fieldValueRows.toLocaleString()} value(s) · ${fieldCorrectionRows} correction(s)
` +
      `        ojad / 型 / 読み / かな主流 — authored here, in no Mochi export
`,
  );

  process.stdout.write(
    `text    ${genOut}\n` +
      `        ${statSync(genOut).size.toLocaleString()} bytes on disk · ` +
      `${genRows.toLocaleString()} generations · ${genBytes.toLocaleString()} payload bytes\n` +
      `        every ai / translate / furigana / dictionary row — no budget, it is 1.6 MiB\n`,
  );

  const mode = journalMode(storeOut);
  process.stdout.write(
    `audio   ${storeOut}\n` +
      `        ${statSync(storeOut).size.toLocaleString()} bytes on disk · ` +
      `${written.toLocaleString()} payloads · ${bytes.toLocaleString()} payload bytes\n` +
      `        kinds ${JSON.stringify(Object.fromEntries(kinds))} · ` +
      `${skipped.toLocaleString()} left out (speech budget ${speechBudget.toLocaleString()})\n` +
      `        journal ${mode.write}/${mode.read}\n` +
      `coverage ${reachable.toLocaleString()} of ${total.toLocaleString()} cards with speech ` +
      `can play something (${((100 * reachable) / Math.max(total, 1)).toFixed(1)}%)\n` +
      `\nServe them: npm run app:dev -- --host ::\n`,
  );
} finally {
  cardDb.close();
  target.close();
  from.close();
}
