/**
 * THROWAWAY (spike harness) — but every line of production code it exercises is
 * imported from `src/`, unmodified. That is the point: this file proves that
 * `SqliteBlobStore` is one implementation and not two, by running the very class
 * `test/blobs.test.ts` runs, over `opfs-sahpool` instead of better-sqlite3.
 *
 * WHAT IT SETTLES
 *
 *   1. The full corpus — 10,816 payloads, 654,917,364 bytes of real mp3 — written
 *      into a BLOB table in OPFS, with write throughput measured against
 *      notes/browser-feasibility.md §4's 4.9 s. READ THE README BEFORE QUOTING A
 *      TIME FROM THIS PAGE: the counts repeat exactly on every machine, the
 *      timings spread 3×–8× (insert 2.5–24.8 s, reclaim 6.6–53.9 s across three
 *      environments), and the first version of that README quoted its own fastest
 *      run as the answer. This page reports what one run cost; only the range is
 *      a fact.
 *   2. Random-read latency, against §4's 0.54 ms for BLOB rows and 10.60 ms for
 *      individual OPFS files.
 *   3. Every payload rehashed IN THE BROWSER, by `src/blobs/sha256.ts`, because
 *      `crypto.subtle` is async and `BlobStore.verify` is not.
 *   4. `auditBlobStore` across the two OPFS databases: the real card database and
 *      the payload store, 10,816 present, 0 missing, 0 orphaned.
 *   5. The three things §4 listed as untested at ~700 MB under sahpool:
 *      incremental growth, free-page reuse, and VACUUM.
 *
 * Everything runs in a dedicated Worker because `opfs-sahpool` is built on
 * `createSyncAccessHandle`, which the platform allows nowhere else.
 */

import { auditBlobStore, findLocations } from "../../src/blobs/db.js";
import { sha256Hex } from "../../src/blobs/sha256.js";
import { BATCH_FLUSH_BYTES, SqliteBlobStore, STORE_PAGE_SIZE } from "../../src/blobs/sqlite.js";
import {
  databaseFilesInOpfs,
  importDatabaseBrowser,
  inDedicatedWorker,
  installPool,
  openDatabaseBrowser,
  sqlite3,
  type BrowserDb,
} from "../../src/db/browser.js";

import { readPack } from "./pack.js";
import type { DoneMessage, LogLevel, LogMessage, SpikeRequest } from "./protocol.js";

const STORE_FILE = "/blobs.db";
const CARDS_FILE = "/hashigo.db";

function log(text: string, level: LogLevel = "info"): void {
  const message: LogMessage = { kind: "log", level, text };
  self.postMessage(message);
}

const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
const fmt = (n: number): string => n.toLocaleString("en-US");

self.onmessage = async (event: MessageEvent<SpikeRequest>): Promise<void> => {
  const request = event.data;
  const summary: Record<string, string | number> = {};
  try {
    await run(request, summary);
    const done: DoneMessage = { kind: "done", id: request.id, ok: true, summary };
    self.postMessage(done);
  } catch (error) {
    log(`FAILED: ${String(error)}`, "bad");
    const done: DoneMessage = {
      kind: "done",
      id: request.id,
      ok: false,
      summary,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
    };
    self.postMessage(done);
  }
};

async function run(
  request: SpikeRequest,
  summary: Record<string, string | number>,
): Promise<void> {
  // -- 1. environment -------------------------------------------------------
  log("1. environment", "step");
  log(`  inDedicatedWorker()      ${inDedicatedWorker()}`);
  log(`  isSecureContext          ${self.isSecureContext}`);
  log(`  crossOriginIsolated      ${self.crossOriginIsolated}  <- no COOP/COEP is set`);
  log(`  SharedArrayBuffer        ${typeof SharedArrayBuffer}`);
  log(`  page reported persisted(): ${request.persisted}`);
  const api = await sqlite3();
  log(`  sqlite ${api.version.libVersion}`);

  // -- 2. the pool ----------------------------------------------------------
  log("2. opfs-sahpool", "step");
  const pool = await installPool();
  log(`  capacity ${pool.getCapacity()}, files ${pool.getFileCount()}`);
  log(`  files: ${JSON.stringify(pool.getFileNames())}`);

  if (request.fresh && pool.getFileNames().includes(STORE_FILE)) {
    const started = performance.now();
    await pool.unlink(STORE_FILE);
    log(`  --fresh: unlinked ${STORE_FILE} in ${(performance.now() - started).toFixed(1)}ms`, "info");
  }

  // -- 3. the store ---------------------------------------------------------
  log("3. the blob store, in OPFS", "step");
  const existed = pool.getFileNames().includes(STORE_FILE);
  const storeDb = await openDatabaseBrowser({ filename: STORE_FILE, applySchema: false });
  // THE PRODUCTION CLASS, over a wasm handle. Nothing here is a browser variant.
  const store = new SqliteBlobStore(storeDb);
  log(`  ${existed ? "reattached" : "created"} ${store.describe}`);
  let stats = store.stats();
  log(
    `  payloads ${fmt(stats.payloads)} / ${mib(stats.bytes)} MiB; page_size ${stats.pageSize}; ` +
      `auto_vacuum ${stats.autoVacuum}; journal ${stats.journalMode}`,
  );
  if (stats.pageSize !== STORE_PAGE_SIZE) {
    log(
      `  NOTE page_size is ${stats.pageSize}, not STORE_PAGE_SIZE ${STORE_PAGE_SIZE} — ` +
        `an existing store keeps whatever it was created with`,
      "bad",
    );
  }

  // -- 4. write the corpus --------------------------------------------------
  log("4. the corpus, into the store", "step");
  if (stats.payloads > 0 && !request.fresh) {
    log(`  ${fmt(stats.payloads)} payloads are already here — NOT rewriting (the reload path)`);
    summary["write"] = "skipped (reload path)";
  } else {
    let written = 0;
    let present = 0;
    let insertMs = 0;
    let flushes = 0;
    let pending: { hash: string; bytes: Uint8Array }[] = [];
    let pendingBytes = 0;

    const flush = (): void => {
      if (pending.length === 0) return;
      const batch = pending;
      const started = performance.now();
      store.batch(() => {
        for (const entry of batch) {
          if (store.write(entry.hash, entry.bytes).written) written += 1;
          else present += 1;
        }
      });
      insertMs += performance.now() - started;
      flushes += 1;
      pending = [];
      pendingBytes = 0;
    };

    const wall = performance.now();
    const result = await readPack(request.packUrl, (hash, bytes) => {
      pending.push({ hash, bytes });
      pendingBytes += bytes.length;
      // Same threshold the store commits at, so memory stays bounded at one
      // chunk rather than at the corpus. A phone cannot hold 625 MiB of mp3.
      if (pendingBytes >= BATCH_FLUSH_BYTES) flush();
    });
    flush();
    const wallSeconds = (performance.now() - wall) / 1000;
    const insertSeconds = insertMs / 1000;
    const bytesMib = result.bytes / 1024 / 1024;

    log(`  pack ${result.header.count} entries / ${mib(result.bytes)} MiB`);
    log(
      `  BROWSER INSERT: ${fmt(written)} written, ${fmt(present)} already held, ` +
        `${mib(result.bytes)} MiB in ${insertSeconds.toFixed(1)}s = ` +
        `${(bytesMib / insertSeconds).toFixed(0)} MiB/s, ` +
        `${((insertSeconds * 1000) / result.header.count).toFixed(2)} ms/blob ` +
        `over ${flushes} batches`,
      "good",
    );
    log(
      `  (wall ${wallSeconds.toFixed(1)}s including ${(result.networkMs / 1000).toFixed(1)}s ` +
        `awaiting the 625 MiB fetch; the insert figure excludes it, as §4's 4.9 s does)`,
    );
    summary["insert seconds"] = Number(insertSeconds.toFixed(2));
    summary["insert MiB/s"] = Number((bytesMib / insertSeconds).toFixed(0));
    summary["insert ms/blob"] = Number(((insertSeconds * 1000) / result.header.count).toFixed(3));
    summary["written"] = written;
  }

  stats = store.stats();
  log(
    `  file ${mib(stats.fileBytes)} MiB over ${fmt(stats.pageCount)} pages of ${stats.pageSize}; ` +
      `overhead ${(((stats.fileBytes - stats.bytes) / stats.bytes) * 100).toFixed(2)}%; ` +
      `free pages ${stats.freelistPages}`,
  );
  summary["payloads"] = stats.payloads;
  summary["payload bytes"] = stats.bytes;
  summary["file bytes"] = stats.fileBytes;

  // -- 5. random reads ------------------------------------------------------
  log("5. random reads", "step");
  const hashes = [...store.list()];
  log(`  store.list() -> ${fmt(hashes.length)} addresses`);
  let seed = 20260819;
  const picks: string[] = [];
  for (let i = 0; i < 50; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    picks.push(hashes[seed % hashes.length] as string);
  }
  let readMs = 0;
  let readBytes = 0;
  for (const hash of picks) {
    const started = performance.now();
    const bytes = store.read(hash);
    readMs += performance.now() - started;
    readBytes += bytes.length;
  }
  log(
    `  BROWSER RANDOM READ: ${picks.length} reads, avg ` +
      `${(readMs / picks.length).toFixed(2)} ms/blob (avg ${fmt(Math.round(readBytes / picks.length))} B)`,
    "good",
  );
  summary["random read ms"] = Number((readMs / picks.length).toFixed(3));

  // -- 6. rehash everything, in the browser --------------------------------
  log("6. verify: rehash every payload with src/blobs/sha256.ts", "step");
  const verifyStarted = performance.now();
  let bad = 0;
  let verified = 0;
  let verifiedBytes = 0;
  for (const hash of hashes) {
    const bytes = store.read(hash);
    verifiedBytes += bytes.length;
    if (sha256Hex(bytes) === hash) verified += 1;
    else {
      bad += 1;
      if (bad <= 5) log(`  MISMATCH ${hash}`, "bad");
    }
  }
  const verifySeconds = (performance.now() - verifyStarted) / 1000;
  log(
    `  ${fmt(verified)} of ${fmt(hashes.length)} payloads rehash to their own address ` +
      `(${bad} mismatches) — ${mib(verifiedBytes)} MiB read AND hashed in ` +
      `${verifySeconds.toFixed(1)}s = ${(verifiedBytes / 1024 / 1024 / verifySeconds).toFixed(0)} MiB/s`,
    bad === 0 ? "good" : "bad",
  );
  summary["verified"] = verified;
  summary["verify mismatches"] = bad;

  // -- 7. no location in the store's own file ------------------------------
  log("7. the store file holds no location", "step");
  const sweep = findLocations(storeDb, { exclude: ["blob_payloads.bytes"] });
  log(`  swept ${sweep.columns} columns across ${sweep.tables} tables`);
  log(
    sweep.offenders.length === 0
      ? "  NO location in any addressable column"
      : `  PATHS FOUND: ${JSON.stringify(sweep.offenders)}`,
    sweep.offenders.length === 0 ? "good" : "bad",
  );
  for (const row of sweep.excluded) {
    log(`  not a check (payload bytes, matches are audio): ${row}`);
  }
  summary["store offenders"] = sweep.offenders.length;

  // -- 8. the card database, and the audit across both ---------------------
  log("8. the real card database, and auditBlobStore across the two files", "step");
  const hadCards = (await databaseFilesInOpfs()).includes(CARDS_FILE);
  if (!hadCards) {
    const started = performance.now();
    const response = await fetch(request.bootstrapUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`${request.bootstrapUrl}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    log(`  fetched ${fmt(bytes.length)} bytes in ${(performance.now() - started).toFixed(1)}ms`);
    const at = performance.now();
    const size = await importDatabaseBrowser(CARDS_FILE, bytes);
    log(`  importDb -> OPFS: ${fmt(size)} bytes in ${(performance.now() - at).toFixed(1)}ms`);
  } else {
    log(`  ${CARDS_FILE} is already in OPFS — not re-importing`);
  }
  const cards: BrowserDb = await openDatabaseBrowser({ filename: CARDS_FILE, applySchema: false });
  const one = (sql: string): unknown => cards.prepare(sql).pluck().get();
  log(`  cards        ${fmt(Number(one("SELECT count(*) FROM cards")))}`);
  log(`  reviews      ${fmt(Number(one("SELECT count(*) FROM reviews")))}`);
  log(
    `  retention    ${Number(
      one("SELECT round(100.0 * sum(remembered) / count(*), 2) FROM reviews"),
    ).toFixed(2)}%`,
  );
  log(`  blobs        ${fmt(Number(one("SELECT count(*) FROM blobs")))}`);
  log(`  blobs.path non-NULL  ${Number(one("SELECT count(*) FROM blobs WHERE path IS NOT NULL"))}`);

  const auditStarted = performance.now();
  const audit = auditBlobStore(cards, store);
  const auditSeconds = (performance.now() - auditStarted) / 1000;
  for (const [label, value] of [
    ["blobs", audit.blobs],
    ["  inline", audit.inline],
    ["  present in the store", audit.present],
    ["  MISSING", audit.missing],
    ["orphaned payloads", audit.orphaned],
    ["size mismatches", audit.sizeMismatched],
    ["unreferenced (refcount 0)", audit.unreferenced],
  ] as const) {
    log(`  ${label.padEnd(26)}${fmt(value).padStart(8)}`);
  }
  log(`  audited both files in ${auditSeconds.toFixed(2)}s`, "info");
  const auditOk = audit.present === 10_816 && audit.missing === 0 && audit.orphaned === 0;
  log(
    auditOk
      ? "  10,816 present, 0 missing, 0 orphaned — the two OPFS databases agree"
      : "  AUDIT DISAGREES",
    auditOk ? "good" : "bad",
  );
  summary["audit present"] = audit.present;
  summary["audit missing"] = audit.missing;
  summary["audit orphaned"] = audit.orphaned;

  // -- 9. growth, free-page reuse, incremental_vacuum ----------------------
  // §4 flagged all three as untested at this size under sahpool. Done with
  // SYNTHETIC payloads so the real corpus is never touched and the audit above
  // stays true across a reload.
  log("9. incremental growth, free-page reuse and reclaim at ~660 MB", "step");
  const synthetic = (seed: number): Uint8Array => {
    const bytes = new Uint8Array(60_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + seed * 13) & 0xff;
    return bytes;
  };
  const base = store.stats();
  const firstBatch: string[] = [];
  let grewMs = performance.now();
  store.batch(() => {
    for (let i = 0; i < 300; i += 1) {
      const bytes = synthetic(i);
      const hash = sha256Hex(bytes);
      store.write(hash, bytes);
      firstBatch.push(hash);
    }
  });
  grewMs = performance.now() - grewMs;
  const grown = store.stats();
  log(
    `  +300 payloads (17.2 MiB) in ${grewMs.toFixed(0)}ms: pages ${fmt(base.pageCount)} -> ` +
      `${fmt(grown.pageCount)} (+${fmt(grown.pageCount - base.pageCount)})`,
  );

  store.batch(() => {
    for (const hash of firstBatch) store.remove(hash);
  });
  const emptied = store.stats();
  log(
    `  -300 payloads: pages ${fmt(emptied.pageCount)}, free pages ` +
      `${fmt(emptied.freelistPages)} (the file has not shrunk yet)`,
  );

  const secondBatch: string[] = [];
  store.batch(() => {
    for (let i = 1_000; i < 1_300; i += 1) {
      const bytes = synthetic(i);
      const hash = sha256Hex(bytes);
      store.write(hash, bytes);
      secondBatch.push(hash);
    }
  });
  const reused = store.stats();
  const wouldNeed = Math.ceil((300 * 60_000) / reused.pageSize);
  log(
    `  +300 different payloads: pages ${fmt(reused.pageCount)} ` +
      `(+${fmt(reused.pageCount - emptied.pageCount)} where ${fmt(wouldNeed)} would be needed ` +
      `without reuse) — FREE-PAGE REUSE WORKS on sahpool`,
    reused.pageCount - emptied.pageCount < wouldNeed / 10 ? "good" : "bad",
  );

  store.batch(() => {
    for (const hash of secondBatch) store.remove(hash);
  });
  const beforeReclaim = store.stats();
  const reclaimStarted = performance.now();
  const returned = store.reclaim();
  const reclaimMs = performance.now() - reclaimStarted;
  const afterReclaim = store.stats();
  log(
    `  reclaim(): returned ${fmt(returned)} pages in ${reclaimMs.toFixed(0)}ms; ` +
      `pages ${fmt(beforeReclaim.pageCount)} -> ${fmt(afterReclaim.pageCount)}, ` +
      `free ${fmt(afterReclaim.freelistPages)}; file now ${mib(afterReclaim.fileBytes)} MiB`,
    afterReclaim.freelistPages === 0 ? "good" : "bad",
  );
  const problems = store.checkIntegrity();
  log(
    `  integrity_check after all of that: ${problems.length === 0 ? "ok" : problems.join("; ")}`,
    problems.length === 0 ? "good" : "bad",
  );
  summary["pages after reclaim"] = afterReclaim.pageCount;
  summary["integrity"] = problems.length === 0 ? "ok" : problems.join("; ");

  // -- 10. VACUUM, the last untested thing ---------------------------------
  if (request.vacuum) {
    log("10. VACUUM on the ~660 MB OPFS file — the untested one", "step");
    log(
      "  temp_store is memory for the pool's sake, so VACUUM's temporary copy " +
        "would go into the wasm heap. Switching it to file first, which costs a pool slot.",
    );
    try {
      storeDb.exec("PRAGMA temp_store = file");
      const started = performance.now();
      store.vacuum();
      const seconds = (performance.now() - started) / 1000;
      const after = store.stats();
      log(
        `  VACUUM completed in ${seconds.toFixed(1)}s; pages ${fmt(after.pageCount)}, ` +
          `file ${mib(after.fileBytes)} MiB, auto_vacuum ${after.autoVacuum}`,
        "good",
      );
      summary["vacuum seconds"] = Number(seconds.toFixed(1));
    } catch (error) {
      log(`  VACUUM FAILED: ${String(error)}`, "bad");
      summary["vacuum"] = `failed: ${String(error)}`;
    } finally {
      storeDb.exec("PRAGMA temp_store = memory");
    }
  } else {
    log("10. VACUUM not requested (tick the box to run it)", "step");
  }

  // -- 11. pool and quota ---------------------------------------------------
  log("11. pool and quota", "step");
  log(`  capacity ${pool.getCapacity()}, files ${pool.getFileCount()}`);
  log(`  files: ${JSON.stringify(pool.getFileNames())}`);
  try {
    const estimate = await navigator.storage.estimate();
    log(
      `  navigator.storage.estimate(): usage ${mib(estimate.usage ?? 0)} MiB / quota ` +
        `${((estimate.quota ?? 0) / 1024 / 1024 / 1024).toFixed(2)} GiB`,
    );
  } catch (error) {
    log(`  estimate() threw ${String(error)}`);
  }
  log(`  navigator.storage.persist in WORKER: ${typeof navigator.storage.persist}`);

  cards.close();
  log("ALL STEPS COMPLETED", "step");
}
