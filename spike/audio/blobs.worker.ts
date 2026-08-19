/**
 * THROWAWAY (spike harness). The dedicated Worker for the audio spike: both
 * SQLite databases live here and nothing else touches them.
 *
 * The path it walks is the production path, module for module:
 *
 *   src/db/browser.ts        opens /spike-audio-meta.db and /spike-audio-store.db
 *                            in OPFS through `opfs-sahpool`
 *   src/blobs/sqlite.ts      SqliteBlobStore over the store database — locked
 *                            decision 4, BLOB rows and not one file per payload
 *   src/blobs/db.ts          readBlob(metaDb, hash, store): the join between an
 *                            address in `blobs` and the bytes in the store
 *   src/blobs/sha256.ts      re-hashes what came back, in the browser, so the
 *                            claim "these are the corpus's bytes" is checked
 *                            rather than asserted
 *
 * Then the payload is handed to the page, because that is where the `<audio>`
 * element and therefore the object URL belong. `workerUrl` deliberately does it
 * the other way round once, to find out whether a URL minted in a worker is even
 * usable in the document.
 */

import metaDatabaseUrl from "./hashigo-audio-meta.db?url";
import storeDatabaseUrl from "./hashigo-audio-store.db?url";

import { auditBlobStore, blobRow, findLocations, readBlob } from "../../src/blobs/db.js";
import { sha256Hex } from "../../src/blobs/sha256.js";
import { SQLITE_STORE_VERSION, SqliteBlobStore } from "../../src/blobs/sqlite.js";
import {
  databaseFilesInOpfs,
  importDatabaseBrowser,
  inDedicatedWorker,
  openDatabaseBrowser,
  sqliteVersion,
  type BrowserDb,
} from "../../src/db/browser.js";

import type {
  AudioSpikeRequest,
  ClipPayload,
  FailMessage,
  LogMessage,
  OpenedMessage,
  WorkerUrlMessage,
} from "./protocol.js";

const META_FILE = "/spike-audio-meta.db";
const STORE_FILE = "/spike-audio-store.db";

const post = (message: LogMessage | OpenedMessage | WorkerUrlMessage | FailMessage): void => {
  self.postMessage(message);
};
const log = (text: string): void => post({ kind: "log", level: "info", text });
const step = (text: string): void => post({ kind: "log", level: "step", text });
const good = (text: string): void => post({ kind: "log", level: "good", text });
const bad = (text: string): void => post({ kind: "log", level: "bad", text });
const ms = (from: number): string => `${(performance.now() - from).toFixed(1)}ms`;
const n = (value: unknown): string => Number(value).toLocaleString("en-US");

let metaDb: BrowserDb | null = null;
let storeDb: BrowserDb | null = null;
let store: SqliteBlobStore | null = null;

self.onmessage = (event: MessageEvent<AudioSpikeRequest>): void => {
  const request = event.data;
  if (request.kind === "workerUrl") {
    mintInWorker(request.id, request.hash);
    return;
  }
  void open(request.id, request.reimport).catch((error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    bad(`FAILED: ${message}`);
    post({ kind: "fail", id: request.id, error: message });
  });
};

/** Fetch a prebuilt database and put it in OPFS, unless it is already there. */
async function ensureInOpfs(name: string, url: string, reimport: boolean): Promise<void> {
  const present = (await databaseFilesInOpfs()).includes(name);
  if (present && !reimport) {
    log(`  ${name} is already in OPFS — not re-importing`);
    return;
  }
  const fetchStart = performance.now();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `GET ${url} -> ${response.status}. Build it first:\n` +
        `  npx vite-node spike/audio/make-audio-db.ts`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  log(`  fetched ${n(bytes.byteLength)} bytes for ${name} in ${ms(fetchStart)}`);
  const importStart = performance.now();
  const written = await importDatabaseBrowser(name, bytes);
  log(`  importDb -> OPFS: ${n(written)} bytes in ${ms(importStart)}`);
}

async function open(id: number, reimport: boolean): Promise<void> {
  const facts: [string, string][] = [];

  step("1. environment");
  facts.push(["inDedicatedWorker()", String(inDedicatedWorker())]);
  facts.push(["isSecureContext", String(self.isSecureContext)]);
  facts.push(["crossOriginIsolated", String(self.crossOriginIsolated)]);
  facts.push(["sqlite", await sqliteVersion()]);
  facts.push([
    "URL.createObjectURL in WORKER",
    typeof (URL as { createObjectURL?: unknown }).createObjectURL,
  ]);
  for (const [term, value] of facts) log(`  ${term.padEnd(30)} ${value}`);

  step("2. the two prebuilt databases -> OPFS");
  await ensureInOpfs(META_FILE, metaDatabaseUrl, reimport);
  await ensureInOpfs(STORE_FILE, storeDatabaseUrl, reimport);
  log(`  pool holds ${JSON.stringify(await databaseFilesInOpfs())}`);

  step("3. open both, and put the production store over the payload database");
  const openStart = performance.now();
  metaDb ??= await openDatabaseBrowser({ filename: META_FILE, applySchema: false });
  storeDb ??= await openDatabaseBrowser({ filename: STORE_FILE, applySchema: false });
  log(`  opened both in ${ms(openStart)}`);
  store ??= new SqliteBlobStore(storeDb, { create: false });
  log(`  store ${store.describe}`);
  log(
    `  store user_version ${String(storeDb.pragma("user_version", { simple: true }))} ` +
      `(src/blobs/sqlite.ts ships ${SQLITE_STORE_VERSION})`,
  );
  const payloads = storeDb
    .prepare("SELECT count(*) AS n, sum(byte_size) AS bytes FROM blob_payloads")
    .get() as { n: number; bytes: number };
  log(`  blob_payloads ${n(payloads.n)} rows, ${n(payloads.bytes)} bytes`);
  const metaRows = metaDb.prepare("SELECT count(*) FROM blobs").pluck().get();
  log(`  blobs rows ${n(metaRows)}, of which inline (bytes NOT NULL): ` +
    `${n(metaDb.prepare("SELECT count(*) FROM blobs WHERE bytes IS NOT NULL").pluck().get())}`);

  step("4. the acceptance checks, run in the browser");
  const audit = auditBlobStore(metaDb, store);
  log(
    `  audit: blobs ${audit.blobs} | present ${audit.present} | inline ${audit.inline} | ` +
      `missing ${audit.missing} | orphaned ${audit.orphaned} | size mismatched ${audit.sizeMismatched}`,
  );
  if (audit.missing === 0 && audit.present === audit.blobs) {
    good("  every address in `blobs` resolves to a payload in the store");
  } else {
    bad(`  ${audit.missing} address(es) do not resolve — the join is broken`);
  }
  const withPath = metaDb.prepare("SELECT count(*) FROM blobs WHERE path IS NOT NULL").pluck().get();
  log(`  blobs.path non-NULL: ${String(withPath)}`);
  try {
    const sweep = findLocations(metaDb);
    log(
      `  findLocations swept ${sweep.columns} column(s) across ${sweep.tables} table(s): ` +
        `${sweep.offenders.length === 0 ? "NO location anywhere" : sweep.offenders.join(" | ")}`,
    );
  } catch (error) {
    bad(`  findLocations threw in the browser: ${(error as Error).message}`);
  }

  step("5. read every payload through the store, and re-hash it here");
  const clips: ClipPayload[] = [];
  const transfer: ArrayBuffer[] = [];
  const rows = metaDb
    .prepare(
      `SELECT b.hash AS hash, c.declared_type AS declared, c.file_name AS file_name,
              c.deck AS deck, c.note AS note
         FROM blobs b JOIN spike_clips c USING (hash)
        ORDER BY (b.mime = 'audio/mpeg') DESC, b.byte_size`,
    )
    .all() as { hash: string; declared: string; file_name: string; deck: string; note: string }[];

  let readTotal = 0;
  for (const row of rows) {
    const meta = blobRow(metaDb, row.hash);
    if (meta === null) {
      bad(`  no blobs row for ${row.hash}`);
      continue;
    }
    const readStart = performance.now();
    const bytes = readBlob(metaDb, row.hash, store);
    const readMs = performance.now() - readStart;
    readTotal += readMs;
    // Copied out of the wasm heap once so the buffer can be transferred to the
    // page without the page ever holding a view onto SQLite's memory.
    const owned = new Uint8Array(bytes);
    const addressOk = sha256Hex(owned) === row.hash;
    if (!addressOk) bad(`  ADDRESS MISMATCH in the browser for ${row.hash}`);
    clips.push({
      hash: meta.hash,
      blobKind: meta.kind,
      mime: meta.mime,
      byteSize: meta.byteSize,
      sourceText: meta.sourceText,
      voice: meta.voice,
      lang: meta.lang,
      declaredType: row.declared,
      fileName: row.file_name,
      deck: row.deck,
      note: row.note,
      bytes: owned,
      readMs,
      addressOk,
    });
    transfer.push(owned.buffer as ArrayBuffer);
  }
  const bytesRead = clips.reduce((sum, clip) => sum + clip.byteSize, 0);
  log(
    `  ${clips.length} payload(s), ${n(bytesRead)} bytes, ${readTotal.toFixed(1)}ms total ` +
      `(${(readTotal / Math.max(clips.length, 1)).toFixed(2)}ms per payload)`,
  );
  const verified = clips.filter((clip) => clip.addressOk).length;
  if (verified === clips.length) {
    good(`  all ${clips.length} payload(s) re-hash to their address, computed in the browser`);
  } else {
    bad(`  only ${verified}/${clips.length} payloads re-hash to their address`);
  }

  step("6. handing the bytes to the page (the object URL is minted there)");
  self.postMessage({ kind: "opened", id, facts, clips } satisfies OpenedMessage, transfer);
}

/**
 * Mint an object URL in the WORKER and hand the string over. The page then tries
 * to play it. This is the arrangement `src/blobs/url.ts` advises against; the
 * spike exists to find out whether it merely smells or actually fails.
 */
function mintInWorker(id: number, hash: string): void {
  try {
    if (metaDb === null || store === null) throw new Error("open the databases first");
    const bytes = readBlob(metaDb, hash, store);
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }));
    log(`  worker minted ${url}`);
    post({ kind: "workerUrl", id, url });
  } catch (error) {
    post({
      kind: "workerUrl",
      id,
      url: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
}
