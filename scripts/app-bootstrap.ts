/**
 * The two files `app/` fetches on first run.
 *
 *   npx vite-node scripts/app-bootstrap.ts
 *     [--db build/hashigo.db] [--store build/hashigo.db.blobs.db]
 *     [--out build/app] [--speech-bytes 209715200]
 *
 * Writes `build/app/hashigo-app.db` (the cards) and
 * `build/app/hashigo-app-blobs.db` (a BOUNDED subset of the audio), which
 * `vite.app.config.ts` serves as `/hashigo-app.db` and `/hashigo-app-blobs.db`.
 *
 * ─── WHY THIS IS NOT `spike/make-bootstrap.mjs` OR `make-viewer-db.ts` ──────
 *
 * Both of those do the mechanism correctly and both are labelled THROWAWAY. The
 * app is not, and an asset pipeline that a shipping page depends on should not
 * live in a directory whose README tells you to delete it. `NEXT.md` says it
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
 *   b. `speech` payloads in ASCENDING SIZE ORDER until `--speech-bytes` is spent.
 *
 * Rule (b) is not arbitrary. A speech blob's size tracks the length of the text
 * it says, so smallest-first buys single WORDS — exactly the 高低アクセント clip the
 * drill needs — at ~30 KB each instead of sentences at ~120 KB, and it maximises
 * how many distinct cards have playable audio per byte downloaded. The run prints
 * the coverage it achieved rather than implying it.
 *
 * **Every TEXT generation rides along for free** and is not counted here: ai,
 * translate, furigana and dictionary outputs are stored INLINE in the card
 * database's `blobs.bytes`, so they arrive with file 1.
 *
 * Payloads are RE-HASHED on the way in, so the browser plays bytes that provably
 * still match the address the card database refers to.
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";

import { SqliteBlobStore } from "../src/blobs/sqlite.js";
import { contentAddress } from "../src/import/blobs.js";

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

  for (const candidate of candidates) {
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
