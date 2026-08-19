/**
 * THROWAWAY (spike harness). Not part of the suite; run by hand.
 *
 *   npx vite-node spike/blobstore/measure.ts
 *
 * Answers three things the report needs and the test suite should not spend time
 * on: what incremental auto_vacuum costs in file size and insert time, what the
 * legacy directory store costs on NTFS for the same corpus, and what a random
 * read costs from each backing in Node.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openBlobStore, openBlobStoreDatabase, type BlobStore } from "../../src/blobs/index.js";

const SOURCE = "build/hashigo.db.blobs.db";
const scratch: string[] = [];
function dir(label: string): string {
  const made = mkdtempSync(join(tmpdir(), `hashigo-measure-${label}-`));
  scratch.push(made);
  return made;
}
const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

const source = openBlobStoreDatabase(SOURCE, { mustExist: true, create: false });
const hashes = [...source.store.list()];
const total = source.store.stats().bytes;
console.log(`source ${SOURCE}: ${hashes.length} payloads / ${mib(total)} MiB`);

function copyInto(store: BlobStore, label: string): void {
  let readNs = 0n;
  const wall = process.hrtime.bigint();
  const run = (): void => {
    for (const hash of hashes) {
      const started = process.hrtime.bigint();
      const bytes = source.store.read(hash);
      readNs += process.hrtime.bigint() - started;
      store.write(hash, bytes);
    }
  };
  if (store.batch === undefined) run();
  else store.batch(run);
  const writeSeconds = Number(process.hrtime.bigint() - wall - readNs) / 1e9;
  console.log(
    `${label.padEnd(34)} ${writeSeconds.toFixed(1)}s  ` +
      `${(total / 1024 / 1024 / writeSeconds).toFixed(0)} MiB/s  ` +
      `${((writeSeconds * 1000) / hashes.length).toFixed(2)} ms/payload`,
  );
}

function randomReads(store: BlobStore, label: string): void {
  let seed = 20260819;
  let ns = 0n;
  let bytes = 0;
  for (let i = 0; i < 50; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const hash = hashes[seed % hashes.length] as string;
    const started = process.hrtime.bigint();
    const payload = store.read(hash);
    ns += process.hrtime.bigint() - started;
    bytes += payload.length;
  }
  console.log(
    `${label.padEnd(34)} ${(Number(ns) / 1e6 / 50).toFixed(2)} ms/read  ` +
      `(avg ${Math.round(bytes / 50)} B)`,
  );
}

// -- 1. auto_vacuum: incremental (the default) versus none -------------------
for (const mode of ["incremental", "none"] as const) {
  const file = join(dir(mode), `s-${mode}.blobs.db`);
  const target = openBlobStoreDatabase(file, { autoVacuum: mode });
  try {
    copyInto(target.store, `insert, auto_vacuum=${mode}`);
    const stats = target.store.stats();
    console.log(
      `  file ${mib(stats.fileBytes)} MiB / ${stats.pageCount} pages; ` +
        `overhead ${(((stats.fileBytes - stats.bytes) / stats.bytes) * 100).toFixed(2)}%`,
    );
    randomReads(target.store, `  random read, ${mode}`);
  } finally {
    target.close();
  }
}

// -- 2. the legacy directory store, on NTFS, same corpus ---------------------
const root = join(dir("files"), "blobs");
const files = openBlobStore(root);
copyInto(files, "insert, 10,816 files on NTFS");
console.log(`  store root ${statSync(root).isDirectory() ? "is a directory" : "?"}`);
randomReads(files, "  random read, NTFS files");

randomReads(source.store, "random read, the populated store");
source.close();
for (const made of scratch) rmSync(made, { recursive: true, force: true });
console.log("scratch removed");
