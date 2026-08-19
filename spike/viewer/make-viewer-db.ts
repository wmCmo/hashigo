/**
 * THROWAWAY (spike harness) — the one prerequisite for spike/viewer/.
 *
 *   npx vite-node spike/viewer/make-viewer-db.ts
 *     [--db build/hashigo.db] [--store build/hashigo.db.blobs.db]
 *     [--out spike/viewer] [--speech-bytes 25165824] [--cards id,id,...]
 *
 * WHY IT EXISTS AT ALL. The card database is already served to the browser by
 * vite.config.ts's middleware as `/hashigo-bootstrap.db` (69 MB, made by
 * `npm run spike:bootstrap`), and every TEXT generation — 15,958 ai, 7,749
 * translate, 3,233 furigana, 7 dictionary — is stored INLINE in `blobs.bytes`,
 * so it rides along for free. What does not ride along is audio: 10,791 speech
 * payloads, 647,952,288 bytes, which live in the separate payload store because
 * of locked decision 4. Nobody downloads 618 MiB to look at one card.
 *
 * So this writes ONE file: a real `SqliteBlobStore` (src/blobs/sqlite.ts, the
 * production class — a harness must not hand-roll the store's DDL) holding a
 * BOUNDED SUBSET of the speech payloads, plus the image/file uploads.
 *
 * THE SELECTION RULE, stated because a subset with an unstated rule is a lie:
 *
 *   1. every blob referenced by the pinned demo cards, whatever its kind;
 *   2. every `image` and `file` blob — the only non-audio payloads not inline;
 *   3. `speech` payloads in ASCENDING SIZE ORDER until `--speech-bytes` is spent.
 *
 * Rule 3 is not arbitrary. A speech blob's size tracks the length of the text it
 * says, so smallest-first buys single WORDS — which is exactly the 高低アクセント
 * clip the drill needs — at ~30 KB each instead of sentences at ~120 KB. It also
 * maximises how many distinct cards have playable audio per byte downloaded, and
 * the run prints that coverage rather than implying it.
 *
 * Payloads are re-hashed on the way in, so the browser plays bytes that provably
 * still match the address the card database refers to, and the header is checked:
 * a WAL-mode file cannot be imported into OPFS (measured, spike/README.md).
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import { readBlob } from "../../src/blobs/db.js";
import { SQLITE_STORE_VERSION, SqliteBlobStore } from "../../src/blobs/sqlite.js";
import { contentAddress } from "../../src/import/blobs.js";

/**
 * The pinned cards, and why each one is pinned. Anything here is guaranteed a
 * payload, so the pass condition never depends on the size budget.
 */
const DEMO_CARDS: readonly (readonly [string, string])[] = [
  ["29thh3wW", "単語 · Reading=false · the cloze form of the drill"],
  ["ChtBgqLJ", "単語 · Reading=true  · the same template, scaffolding shown"],
  ["sqgqrYD4", "単語 · a third, for stepping"],
  ["MhjRjdgV", "単語 · 生産 · the adjacent-card-link shape"],
  ["gARDCdEz", "漢字 · <draw> canvas, no audio at all"],
  ["pDN5aJ2O", "敬語 · an INLINE <speech> element: the renderer's own audio mount"],
  ["8wkwRYwG", "Polysemy · inline <speech> plus a speech field"],
  ["FnsfOCqt", "template-less card · cloze on side 1, <speech> on side 2"],
  ["xF0SaehB", "template-less card · three inline generators"],
];

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const cardsFile = resolve(flag("--db", "build/hashigo.db"));
const storeFile = resolve(flag("--store", `${cardsFile}.blobs.db`));
const outDir = resolve(flag("--out", "spike/viewer"));
const outFile = join(outDir, "hashigo-viewer-blobs.db");
const speechBudget = Number(flag("--speech-bytes", String(24 * 1024 * 1024)));
const pinned = flag("--cards", DEMO_CARDS.map(([id]) => id).join(","))
  .split(",")
  .filter((id) => id !== "");

for (const [what, path] of [
  ["the card database", cardsFile],
  ["the payload store", storeFile],
] as const) {
  if (existsSync(path)) continue;
  console.error(
    `spike/viewer/make-viewer-db: ${what} is not at ${path}.\n` +
      "  npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報",
  );
  process.exit(1);
}

const n = (value: number): string => value.toLocaleString("en-US");
const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** Header bytes 18/19: 1 = rollback journal, 2 = WAL. Only 1 imports into OPFS. */
function journalHeader(file: string): { write: number; read: number } {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(20);
    readSync(fd, head, 0, 20, 0);
    return { write: head[18] ?? 0, read: head[19] ?? 0 };
  } finally {
    closeSync(fd);
  }
}

const cards = new Database(cardsFile, { readonly: true, fileMustExist: true });
const source = new SqliteBlobStore(
  new Database(storeFile, { readonly: true, fileMustExist: true }) as never,
  { create: false, digest: contentAddress },
);

console.log(`cards    ${cardsFile}`);
console.log(`payloads ${source.describe}`);
console.log(`budget   ${n(speechBudget)} bytes of speech (${mib(speechBudget)})`);

interface Row {
  hash: string;
  kind: string;
  byte_size: number;
  inline: number;
}

const wanted = new Map<string, Row>();

// -- 1. the pinned demo cards, every kind -------------------------------------
const byCard = cards.prepare<[string], Row>(
  `SELECT DISTINCT b.hash AS hash, b.kind AS kind, b.byte_size AS byte_size,
          (b.bytes IS NOT NULL) AS inline
     FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash
    WHERE r.card_id = ?`,
);
let pinnedMissing = 0;
for (const id of pinned) {
  if (cards.prepare("SELECT 1 FROM cards WHERE id = ?").pluck().get(id) === undefined) {
    console.log(`  PINNED CARD MISSING ${id} — not in this database`);
    pinnedMissing += 1;
    continue;
  }
  for (const row of byCard.all(id)) {
    if (row.inline === 1) continue; // already in the card database
    wanted.set(row.hash, row);
  }
}
const pinnedBytes = [...wanted.values()].reduce((sum, row) => sum + row.byte_size, 0);
console.log(
  `\n1. pinned cards       ${pinned.length - pinnedMissing}/${pinned.length} resolved, ` +
    `${wanted.size} payload(s), ${n(pinnedBytes)} bytes`,
);

// -- 2. every image and file upload -------------------------------------------
let uploads = 0;
let uploadBytes = 0;
for (const row of cards
  .prepare<[], Row>(
    `SELECT hash, kind, byte_size, (bytes IS NOT NULL) AS inline FROM blobs
      WHERE kind IN ('image', 'file') AND bytes IS NULL ORDER BY hash`,
  )
  .all()) {
  if (!wanted.has(row.hash)) {
    uploads += 1;
    uploadBytes += row.byte_size;
  }
  wanted.set(row.hash, row);
}
console.log(`2. image/file uploads ${uploads} payload(s), ${n(uploadBytes)} bytes`);

// -- 3. speech, smallest first, until the budget is spent ---------------------
let speech = 0;
let speechBytes = pinnedBytes;
let skipped = 0;
for (const row of cards
  .prepare<[], Row>(
    `SELECT hash, kind, byte_size, (bytes IS NOT NULL) AS inline FROM blobs
      WHERE kind = 'speech' AND bytes IS NULL ORDER BY byte_size, hash`,
  )
  .all()) {
  if (wanted.has(row.hash)) continue;
  if (speechBytes + row.byte_size > speechBudget) {
    skipped += 1;
    continue;
  }
  wanted.set(row.hash, row);
  speech += 1;
  speechBytes += row.byte_size;
}
console.log(
  `3. speech             ${speech} payload(s) taken, ${skipped} left behind, ` +
    `${n(speechBytes)} bytes of speech in total`,
);

// -- write, re-hashing on the way in ------------------------------------------
mkdirSync(outDir, { recursive: true });
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  if (existsSync(outFile + suffix)) rmSync(outFile + suffix, { force: true });
}
const outDatabase = new Database(outFile);
const out = new SqliteBlobStore(outDatabase as never, { digest: contentAddress });

let written = 0;
let mismatched = 0;
let unreadable = 0;
const writeStart = performance.now();
out.batch(() => {
  for (const row of wanted.values()) {
    let bytes: Uint8Array;
    try {
      bytes = readBlob(cards as never, row.hash, source);
    } catch (error) {
      console.log(`  UNREADABLE ${row.hash.slice(0, 12)} ${row.kind}: ${String(error)}`);
      unreadable += 1;
      continue;
    }
    if (contentAddress(bytes) !== row.hash) {
      console.error(`  ADDRESS MISMATCH ${row.hash} rehashes to ${contentAddress(bytes)}`);
      mismatched += 1;
      continue;
    }
    if (out.write(row.hash, bytes).written) written += 1;
  }
});
const writeMs = performance.now() - writeStart;
if (mismatched > 0) process.exit(2);

// The store's own invariant, checked here so the browser is not the first to try.
let verified = 0;
for (const hash of wanted.keys()) if (out.has(hash) && out.verify(hash)) verified += 1;
const stats = out.stats();
outDatabase.pragma("journal_mode = delete");
outDatabase.close();

const kinds = new Map<string, { n: number; bytes: number }>();
for (const row of wanted.values()) {
  const entry = kinds.get(row.kind) ?? { n: 0, bytes: 0 };
  entry.n += 1;
  entry.bytes += row.byte_size;
  kinds.set(row.kind, entry);
}

// How many cards end up with playable audio, and how many do not: the honest
// version of "a subset" — the number Zach will feel when he hits Random.
const hashList = [...wanted.keys()];
const placeholders = hashList.map(() => "?").join(",");
const covered = cards
  .prepare<string[], { cards: number }>(
    `SELECT count(DISTINCT r.card_id) AS cards FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash
      WHERE b.kind = 'speech' AND r.blob_hash IN (${placeholders})`,
  )
  .get(...hashList);
const withAudio = cards
  .prepare<[], { cards: number }>(
    `SELECT count(DISTINCT r.card_id) AS cards FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash
      WHERE b.kind = 'speech'`,
  )
  .get();
cards.close();

console.log(
  `\nwrote ${written} payload(s) in ${writeMs.toFixed(0)}ms, ` +
    `${verified}/${wanted.size} verified by rehash` +
    `${unreadable > 0 ? `, ${unreadable} unreadable` : ""}`,
);
for (const [kind, entry] of [...kinds].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(
    `  ${kind.padEnd(8)} ${String(entry.n).padStart(5)} payload(s)  ${n(entry.bytes).padStart(12)} bytes`,
  );
}
console.log(
  `  store  ${n(stats.payloads)} rows, ${n(stats.bytes)} payload bytes, ` +
    `page_size ${stats.pageSize}, auto_vacuum ${stats.autoVacuum}, journal ${stats.journalMode}`,
);

const size = statSync(outFile).size;
const header = journalHeader(outFile);
console.log(
  `\n${outFile}\n  ${n(size)} bytes (${mib(size)}), header write=${header.write} read=${header.read}` +
    `${header.write === 1 ? " (rollback journal — importable into OPFS)" : " (WAL — NOT importable)"}`,
);
for (const suffix of ["-wal", "-shm", "-journal"]) {
  if (existsSync(outFile + suffix)) console.log(`  WARNING sidecar ${suffix} exists and cannot be imported`);
}
console.log(`  store user_version must be ${SQLITE_STORE_VERSION}`);
console.log(
  `\ncards with playable audio in this subset: ${n(covered?.cards ?? 0)} of ` +
    `${n(withAudio?.cards ?? 0)} that have any ` +
    `(${(((covered?.cards ?? 0) / (withAudio?.cards ?? 1)) * 100).toFixed(1)}%). ` +
    "Raise --speech-bytes for more.",
);
if (header.write !== 1) process.exit(2);
