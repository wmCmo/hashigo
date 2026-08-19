/**
 * THROWAWAY (spike harness) — step 2 of 3 for the audio spike.
 *
 *   npx vite-node spike/audio/make-audio-db.ts
 *     [--db build/hashigo.db] [--store build/hashigo.db.blobs]
 *     [--clips build/spike/audio-clips.json] [--out spike/audio]
 *
 * Produces the TWO files the page fetches, and they are two on purpose, because
 * that is the production split:
 *
 *   hashigo-audio-meta.db    the card-database side: `blobs` rows — address,
 *                            sniffed mime, size, provenance — and NO payloads and
 *                            NO locations. Plus one throwaway `spike_clips` table
 *                            carrying what Mochi *declared* the type was, which
 *                            production rightly does not keep anywhere.
 *   hashigo-audio-store.db   a real `SqliteBlobStore` (src/blobs/sqlite.ts),
 *                            created by the production class, holding the real
 *                            mp3 payloads as BLOB rows. This is locked decision 4
 *                            in its actual shape.
 *
 * The payloads are read out of the existing content-addressed directory store by
 * hash and re-hashed on the way in, so the browser is playing bytes that provably
 * still match the address the database refers to. Nothing is copied by path: the
 * only thing that crosses is `hash -> bytes`.
 *
 * Run under vite-node because it uses `src/blobs/sqlite.ts` rather than a second
 * copy of its DDL. A spike that hand-rolls the store's schema would prove the
 * spike works, not that the store does.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import { SQLITE_STORE_VERSION, SqliteBlobStore } from "../../src/blobs/sqlite.js";

interface Clip {
  readonly deck: string;
  readonly file_name: string;
  readonly declared_type: string;
  readonly card_id: string;
  readonly hash: string;
  readonly size: number;
  readonly first4: string;
  readonly note?: string;
}

interface Manifest {
  readonly declaredTypeCounts: Record<string, number>;
  readonly liveAttachments: number;
  readonly clips: readonly Clip[];
}

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const sourceDb = resolve(flag("--db", "build/hashigo.db"));
const storeDir = resolve(flag("--store", `${sourceDb}.blobs`));
const clipsFile = resolve(flag("--clips", "build/spike/audio-clips.json"));
const outDir = resolve(flag("--out", "spike/audio"));
const metaFile = join(outDir, "hashigo-audio-meta.db");
const storeFile = join(outDir, "hashigo-audio-store.db");

for (const [what, path] of [
  ["the card database", sourceDb],
  ["the blob store", storeDir],
  ["the clip manifest", clipsFile],
] as const) {
  if (existsSync(path)) continue;
  console.error(
    `spike/audio/make-audio-db: ${what} is not at ${path}.\n` +
      `  npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報\n` +
      `  PYTHONIOENCODING=utf-8 python spike/audio/pick-clips.py --out build/spike/audio-clips.json ` +
      `exports/日本語 exports/English exports/基本情報`,
  );
  process.exit(1);
}

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

function fresh(file: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(file + suffix)) rmSync(file + suffix, { force: true });
  }
}

const manifest = JSON.parse(readFileSync(clipsFile, "utf8")) as Manifest;
const cards = new Database(sourceDb, { readonly: true, fileMustExist: true });

console.log(`cards    ${sourceDb}`);
console.log(`payloads ${storeDir}`);
console.log(
  `clips    ${clipsFile} — ${manifest.clips.length} clips out of ${manifest.liveAttachments.toLocaleString()} live attachments`,
);

interface Row {
  hash: string;
  kind: string;
  mime: string;
  byte_size: number;
  source_text: string | null;
  voice: string | null;
  lang: string | null;
  refcount: number;
  path: string | null;
}

const select = cards.prepare<[string], Row>(
  `SELECT hash, kind, mime, byte_size, source_text, voice, lang, refcount, path
     FROM blobs WHERE hash = ?`,
);

const kept: { clip: Clip; row: Row; bytes: Buffer }[] = [];
let missingRows = 0;
let missingPayloads = 0;
let pathsInSource = 0;

for (const clip of manifest.clips) {
  const row = select.get(clip.hash);
  if (row === undefined) {
    console.log(`  MISSING ROW      ${clip.file_name} ${clip.hash.slice(0, 12)}`);
    missingRows += 1;
    continue;
  }
  if (row.path !== null) pathsInSource += 1;
  // The store's layout, derived from the hash exactly as src/blobs/address.ts does.
  const file = join(storeDir, clip.hash.slice(0, 2), clip.hash);
  if (!existsSync(file)) {
    console.log(`  MISSING PAYLOAD  ${clip.file_name} ${clip.hash.slice(0, 12)}`);
    missingPayloads += 1;
    continue;
  }
  const bytes = readFileSync(file);
  const rehashed = createHash("sha256").update(bytes).digest("hex");
  if (rehashed !== clip.hash) {
    console.error(`  ADDRESS MISMATCH ${file} hashes to ${rehashed}`);
    process.exit(2);
  }
  if (bytes.length !== row.byte_size) {
    console.error(`  SIZE MISMATCH    ${clip.hash}: row ${row.byte_size}, payload ${bytes.length}`);
    process.exit(2);
  }
  kept.push({ clip, row, bytes });
}

if (kept.length === 0) {
  console.error("nothing to ship: no clip resolved to both a row and a payload");
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });

// ── the payload store, created by the production class ─────────────────────────
fresh(storeFile);
const storeDatabase = new Database(storeFile);
const store = new SqliteBlobStore(storeDatabase as never, {
  digest: (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"),
});
const writeStart = performance.now();
const written = store.batch(() => {
  let count = 0;
  for (const { clip, bytes } of kept) {
    if (store.write(clip.hash, bytes).written) count += 1;
  }
  return count;
});
const writeMs = performance.now() - writeStart;
// The store's own invariant, checked here so the browser is not the first to try.
let verified = 0;
for (const { clip } of kept) {
  if (store.verify(clip.hash)) verified += 1;
}
storeDatabase.close();

// ── the metadata database: production column names, no payloads ────────────────
fresh(metaFile);
const meta = new Database(metaFile);
meta.pragma("journal_mode = delete");
meta.exec(`
  -- The production column names, so the page runs the SQL the app will run:
  -- src/blobs/db.ts's blobRow()/readBlob() are pointed straight at this.
  CREATE TABLE blobs (
    hash        TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    byte_size   INTEGER NOT NULL,
    source_text TEXT,
    voice       TEXT,
    lang        TEXT,
    options     TEXT NOT NULL DEFAULT '{}',
    bytes       BLOB,
    path        TEXT,
    refcount    INTEGER NOT NULL DEFAULT 0
  );
  -- THROWAWAY. What Mochi CLAIMED the type was. Production keeps no such column
  -- and should not — the sniffed mime is the only trustworthy one — so the mime
  -- experiment has to carry its own copy.
  CREATE TABLE spike_clips (
    hash          TEXT PRIMARY KEY REFERENCES blobs(hash),
    declared_type TEXT NOT NULL,
    file_name     TEXT NOT NULL,
    deck          TEXT NOT NULL,
    note          TEXT NOT NULL
  );
`);
const insertBlob = meta.prepare(
  `INSERT INTO blobs (hash, kind, mime, byte_size, source_text, voice, lang, bytes, path, refcount)
   VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
);
const insertClip = meta.prepare(
  `INSERT INTO spike_clips (hash, declared_type, file_name, deck, note) VALUES (?, ?, ?, ?, ?)`,
);
meta.transaction(() => {
  for (const { clip, row } of kept) {
    insertBlob.run(
      row.hash,
      row.kind,
      row.mime,
      row.byte_size,
      row.source_text,
      row.voice,
      row.lang,
      row.refcount,
    );
    insertClip.run(row.hash, clip.declared_type, clip.file_name, clip.deck, clip.note ?? "");
  }
})();

const summary = meta
  .prepare<[], { declared: string; sniffed: string; n: number; bytes: number }>(
    `SELECT c.declared_type AS declared, b.mime AS sniffed, count(*) AS n, sum(b.byte_size) AS bytes
       FROM blobs b JOIN spike_clips c USING (hash)
      GROUP BY 1, 2 ORDER BY n DESC, 1`,
  )
  .all();
const payloadBytes = kept.reduce((sum, entry) => sum + entry.bytes.length, 0);
meta.close();
cards.close();

console.log(
  `\nstore    ${written} payload(s) written in ${writeMs.toFixed(1)}ms, ` +
    `${payloadBytes.toLocaleString()} bytes, ${verified}/${kept.length} verified by rehash`,
);
console.log("declared -> sniffed, in what the page will play:");
for (const line of summary) {
  const flagged = line.declared === line.sniffed ? " " : "!";
  console.log(
    `${flagged} ${(line.declared || "(nothing)").padEnd(26)} -> ${line.sniffed.padEnd(24)} ` +
      `${String(line.n).padStart(2)} clip(s), ${line.bytes.toLocaleString()} B`,
  );
}
const wrong = summary.filter((l) => l.declared !== l.sniffed).reduce((n, l) => n + l.n, 0);
console.log(`  declared type WRONG on ${wrong} of ${kept.length} clips`);

for (const [label, file] of [
  ["meta ", metaFile],
  ["store", storeFile],
] as const) {
  const header = journalHeader(file);
  console.log(
    `\n${label}    ${file}\n` +
      `  ${statSync(file).size.toLocaleString()} bytes, header write=${header.write} read=${header.read}` +
      `${header.write === 1 ? " (rollback journal — importable into OPFS)" : " (WAL — NOT importable)"}`,
  );
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(file + suffix)) console.log(`  WARNING sidecar ${suffix} exists and cannot be imported`);
  }
  if (header.write !== 1) process.exit(2);
}
console.log(
  `\nstore user_version must be ${SQLITE_STORE_VERSION}; ` +
    `blobs.path non-NULL in the source rows: ${pathsInSource}` +
    `${missingRows + missingPayloads > 0 ? `; skipped ${missingRows} rowless, ${missingPayloads} payloadless` : ""}`,
);
