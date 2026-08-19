/**
 * THROWAWAY (spike harness). Turns the Node blob store into one file a browser
 * can stream, so the page can WRITE the real corpus rather than a synthetic one.
 *
 *   node spike/blobstore/make-pack.mjs [--store build/hashigo.db.blobs.db]
 *
 * Why a pack at all: the page has to get 624.6 MiB of real mp3 into the browser
 * before it can measure writing them, and 10,816 separate fetches would measure
 * the dev server rather than the store. One streamed response, parsed into
 * payloads as it arrives, keeps peak memory at a chunk rather than at the corpus.
 *
 * Layout, little-endian:
 *
 *   "HSGPACK1"              8 bytes
 *   headerLength            uint32
 *   header                  UTF-8 JSON: { count, totalBytes, entries: [[hash, size], …] }
 *   payloads                concatenated, in `entries` order
 *
 * The hashes are in the header, so the page can verify every payload it writes
 * against the address it was filed under without trusting this script.
 */
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
};

const storeFile = resolve(flag("--store", "build/hashigo.db.blobs.db"));
const outFile = resolve(flag("--out", "build/spike/blob-corpus.pack"));

const db = new Database(storeFile, { readonly: true });
const rows = db.prepare("SELECT hash, byte_size FROM blob_payloads ORDER BY hash").all();
if (rows.length === 0) {
  console.error(
    `${storeFile} holds no payloads. Make it with:\n` +
      `  npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報`,
  );
  process.exit(1);
}

const totalBytes = rows.reduce((sum, row) => sum + row.byte_size, 0);
const header = Buffer.from(
  JSON.stringify({
    count: rows.length,
    totalBytes,
    entries: rows.map((row) => [row.hash, row.byte_size]),
  }),
  "utf8",
);

mkdirSync(dirname(outFile), { recursive: true });
const fd = openSync(outFile, "w");
const started = Date.now();
let written = 0;
try {
  const prefix = Buffer.alloc(12);
  prefix.write("HSGPACK1", 0, "latin1");
  prefix.writeUInt32LE(header.length, 8);
  writeSync(fd, prefix);
  writeSync(fd, header);
  written += prefix.length + header.length;

  const read = db.prepare("SELECT bytes FROM blob_payloads WHERE hash = ?").pluck();
  for (const row of rows) {
    const bytes = read.get(row.hash);
    if (bytes.length !== row.byte_size) {
      throw new Error(`${row.hash}: byte_size ${row.byte_size} but payload ${bytes.length}`);
    }
    writeSync(fd, bytes);
    written += bytes.length;
  }
} finally {
  closeSync(fd);
  db.close();
}

const seconds = (Date.now() - started) / 1000;
console.log(`source ${storeFile}`);
console.log(`  ${rows.length} payloads / ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`);
console.log(`target ${outFile}`);
console.log(
  `  ${written} bytes (${(written / 1024 / 1024).toFixed(1)} MiB), header ${header.length} B, ` +
    `in ${seconds.toFixed(1)}s`,
);
