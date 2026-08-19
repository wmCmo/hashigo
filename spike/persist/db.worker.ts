/**
 * THROWAWAY (spike harness) — `spike/persist/db.worker.ts`.
 *
 * The dedicated Worker. Everything that touches SQLite or a sync access handle
 * happens here and nowhere else, and it deliberately does NOT try to ask for
 * storage persistence: proving that it *cannot* is one of the results.
 *
 * It reaches SQLite only through `src/db/browser.ts` (the production adapter) so
 * that whatever this measures is a fact about the shipping code path, not about
 * a bespoke one.
 */

import {
  applySchema,
  databaseFilesInOpfs,
  deleteDatabaseBrowser,
  importDatabaseBrowser,
  installPool,
  openDatabaseBrowser,
  SCHEMA_VERSION,
  sqlite3,
  sqliteVersion,
  type BrowserDb,
} from "../../src/db/browser.js";
import schemaSql from "../../src/schema/schema.sql?raw";
import viewsSql from "../../src/schema/views.sql?raw";

import { gib, mib, type LogLevel, type PersistMessage, type PersistRequest } from "./protocol.js";

/** The bootstrap database, served by vite.config.ts's middleware. */
const BOOTSTRAP_URL = "/hashigo-bootstrap.db";
/** The card database, in the production pool under the production name. */
const CARD_DB = "/hashigo.db";
/** Mine, and obviously mine, so cleanup is unambiguous. */
const BLOB_DB = "/persist-spike-blobs.db";

const SCHEMA = [
  { name: "schema.sql", sql: schemaSql },
  { name: "views.sql", sql: viewsSql },
];

function post(message: PersistMessage): void {
  (globalThis as unknown as { postMessage(m: unknown): void }).postMessage(message);
}

function log(text: string, level: LogLevel = "info"): void {
  post({ kind: "log", level, text });
}

function stat(key: string, value: string, level?: LogLevel): void {
  post(level === undefined ? { kind: "stat", key, value } : { kind: "stat", key, value, level });
}

function ms(start: number): string {
  return `${(performance.now() - start).toFixed(1)}ms`;
}

/** The one handle. Held across messages so "hold" can mean something. */
let card: BrowserDb | undefined;

async function estimate(): Promise<{ usage: number; quota: number }> {
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

// -- 1. what a worker can and cannot see about storage -----------------------

/**
 * The finding this spike exists for. A Worker can *observe* persistence and
 * *measure* quota, but it cannot *request* persistence: `persist` is defined on
 * `StorageManager` only in a Window context.
 */
async function probe(): Promise<void> {
  log("A. what the WORKER can see about storage", "step");
  const storage = navigator.storage as unknown as Record<string, unknown>;
  const names = ["persist", "persisted", "estimate", "getDirectory"];
  for (const name of names) {
    const type = typeof storage[name];
    log(`  navigator.storage.${name.padEnd(12)} in worker: ${type}`, type === "undefined" ? "bad" : "good");
  }
  // On the prototype too, in case something polyfilled an own property.
  const proto = Object.getPrototypeOf(navigator.storage) as object;
  log(`  StorageManager.prototype has "persist": ${Object.prototype.hasOwnProperty.call(proto, "persist")}`);
  log(`  own+inherited keys: ${[...names].filter((n) => n in (navigator.storage as object)).join(", ")}`);

  // Call it anyway. An agent reading a `typeof` check will not believe it; a
  // pasted TypeError is harder to argue with.
  try {
    await (navigator.storage as unknown as { persist(): Promise<boolean> }).persist();
    log("  !!! persist() SUCCEEDED in the worker — the note is wrong, re-measure", "bad");
  } catch (error) {
    log(`  calling persist() in the worker throws: ${String(error)}`, "good");
  }

  try {
    const persisted = await navigator.storage.persisted();
    log(`  persisted() in the worker: ${persisted}  <- observable, but not requestable`, "warn");
  } catch (error) {
    log(`  persisted() in the worker threw: ${String(error)}`, "bad");
  }

  const { usage, quota } = await estimate();
  log(`  estimate() in the worker: usage ${mib(usage)} / quota ${gib(quota)}`);
  stat("worker can request persistence", "NO — persist is Window-only", "bad");
  log(`  sqlite ${await sqliteVersion()}, schema version ${SCHEMA_VERSION}`);
}

// -- 2. the real database, in the production pool ----------------------------

const ORACLE = {
  cards: 7716,
  reviews: 102020,
  forward: 58937,
  reverse: 43083,
  retention: "96.24",
  decks: 39,
  tags: 19,
  card_links: 8744,
} as const;

/**
 * The same SQL `spike/db.worker.ts` uses, so a mismatch here would be a
 * mismatch there too. `direction` is not a column: forward/reverse is
 * `card_tracks.kind`, and the tag oracle is 19 tags *with cards on them*
 * (`tag_usage.cards_direct > 0`), not 20 `tags` rows.
 */
function verifyOracle(db: BrowserDb): boolean {
  const one = (sql: string): number => Number(db.prepare(sql).pluck().get() ?? -1);
  const totals = db
    .prepare("SELECT cards, reviews, retention FROM study_totals")
    .get() as { cards: number; reviews: number; retention: number };
  const kinds = db
    .prepare(
      "SELECT ct.kind AS kind, count(*) AS n FROM reviews r " +
        "JOIN card_tracks ct ON ct.id = r.track_id GROUP BY ct.kind",
    )
    .all() as { kind: string; n: number }[];
  const got = {
    cards: totals.cards,
    reviews: totals.reviews,
    forward: kinds.find((row) => row.kind === "forward")?.n ?? 0,
    reverse: kinds.find((row) => row.kind === "reverse")?.n ?? 0,
    retention: (totals.retention * 100).toFixed(2),
    decks: one("SELECT count(*) FROM decks"),
    tags: one("SELECT count(*) FROM tag_usage WHERE cards_direct > 0"),
    card_links: one("SELECT count(*) FROM card_links"),
  };
  let ok = true;
  for (const [key, want] of Object.entries(ORACLE)) {
    const have = (got as Record<string, unknown>)[key];
    const match = String(have) === String(want);
    if (!match) ok = false;
    log(`  ${key.padEnd(12)} ${String(have).padStart(8)}  ${match ? "ok" : `EXPECTED ${String(want)}`}`, match ? "good" : "bad");
  }
  return ok;
}

async function open(reimport: boolean): Promise<void> {
  log("B. the real database in the production pool", "step");
  const pool = await installPool();
  log(`  pool "${pool.vfsName}" capacity ${pool.getCapacity()}, files ${pool.getFileCount()}`);
  log(`  files: ${JSON.stringify(await databaseFilesInOpfs())}`);

  const present = (await databaseFilesInOpfs()).includes(CARD_DB);
  if (reimport || !present) {
    const t0 = performance.now();
    const response = await fetch(BOOTSTRAP_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(
        `${BOOTSTRAP_URL} -> HTTP ${response.status}. Run: npm run spike:bootstrap`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    log(`  fetched ${bytes.byteLength.toLocaleString()} bytes in ${ms(t0)}`);
    const t1 = performance.now();
    const written = await importDatabaseBrowser(CARD_DB, bytes);
    log(`  importDb -> OPFS: ${written.toLocaleString()} bytes in ${ms(t1)}`, "good");
  } else {
    log(`  ${CARD_DB} already in OPFS — reattaching, not re-importing`, "good");
  }

  card?.close();
  const t2 = performance.now();
  card = await openDatabaseBrowser({ filename: CARD_DB, schema: SCHEMA, applySchema: false });
  log(`  opened ${CARD_DB} in ${ms(t2)}`);
  const ok = verifyOracle(card);
  stat("oracle from OPFS", ok ? "MATCHES" : "DOES NOT MATCH", ok ? "good" : "bad");

  const { usage, quota } = await estimate();
  stat("OPFS usage", mib(usage));
  stat("quota", gib(quota));
}

// -- 3. ~700 MB, at the real size distribution -------------------------------

/**
 * The real corpus's external blob sizes, read out of the real database. Using
 * the true distribution matters: 10,816 payloads averaging 60 KB is a very
 * different write pattern from one 624 MiB row, and SQLite page allocation
 * behaves differently for each.
 *
 * The *bytes* are synthetic — the mp3s are not reachable from the page — but the
 * count and every individual length are the corpus's own.
 */
function realBlobSizes(db: BrowserDb): number[] {
  return (
    db
      .prepare("SELECT byte_size FROM blobs WHERE bytes IS NULL ORDER BY rowid")
      .pluck()
      .all() as number[]
  ).map(Number);
}

async function fill(limitBytes: number): Promise<void> {
  log("C. ~700 MB of audio-shaped blobs, in one OPFS SQLite file", "step");
  if (card === undefined) throw new Error("open the card database first");
  const sizes = realBlobSizes(card);
  const total = sizes.reduce((a, b) => a + b, 0);
  log(`  ${sizes.length.toLocaleString()} external blobs in the real database, ${mib(total)} total`);
  log(`  largest ${Math.max(...sizes).toLocaleString()} B, mean ${Math.round(total / sizes.length).toLocaleString()} B`);

  const before = await estimate();
  log(`  estimate() BEFORE: usage ${mib(before.usage)} / quota ${gib(before.quota)}`);

  // A second file in the SAME pool, which is the shape src/blobs/ would take.
  const blobs = await openDatabaseBrowser({ filename: BLOB_DB, schema: SCHEMA, applySchema: false });
  blobs.exec("CREATE TABLE IF NOT EXISTS blob_bytes (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL)");
  blobs.exec("DELETE FROM blob_bytes");
  const insert = blobs.prepare("INSERT OR REPLACE INTO blob_bytes (hash, bytes) VALUES (?, ?)");

  // One buffer, sliced. Allocating 10,816 typed arrays is not what we measure.
  const scratch = new Uint8Array(Math.max(...sizes));
  for (let i = 0; i < scratch.length; i += 1) scratch[i] = i & 0xff;

  let written = 0;
  let count = 0;
  let quotaError: string | undefined;
  const t0 = performance.now();
  try {
    blobs.exec("BEGIN");
    for (const [index, size] of sizes.entries()) {
      if (limitBytes > 0 && written >= limitBytes) break;
      insert.run(`spike-${index}`, scratch.subarray(0, size));
      written += size;
      count += 1;
      if (count % 2000 === 0) {
        log(`    … ${count.toLocaleString()}/${sizes.length.toLocaleString()} rows, ${mib(written)}, ${ms(t0)}`);
      }
    }
    blobs.exec("COMMIT");
  } catch (error) {
    quotaError = String(error);
    try {
      blobs.exec("ROLLBACK");
    } catch {
      // A failed rollback must not hide the write failure.
    }
    log(`  WRITE FAILED after ${count.toLocaleString()} rows / ${mib(written)}`, "bad");
    log(`  the error, verbatim: ${quotaError}`, "bad");
  }
  const elapsed = performance.now() - t0;
  if (quotaError === undefined) {
    log(
      `  INSERTED ${count.toLocaleString()} blobs / ${mib(written)} in ${(elapsed / 1000).toFixed(1)}s ` +
        `= ${(written / 1024 / 1024 / (elapsed / 1000)).toFixed(0)} MiB/s, ${(elapsed / count).toFixed(2)} ms/blob`,
      "good",
    );
  }

  const rows = Number(blobs.prepare("SELECT count(*) FROM blob_bytes").pluck().get() ?? 0);
  const bytes = Number(blobs.prepare("SELECT coalesce(sum(length(bytes)),0) FROM blob_bytes").pluck().get() ?? 0);
  log(`  readback: ${rows.toLocaleString()} rows, ${mib(bytes)}`);

  // Random reads, which is what playing a card's audio actually does.
  if (rows > 0) {
    const read = blobs.prepare("SELECT bytes FROM blob_bytes WHERE hash = ?").pluck();
    const t1 = performance.now();
    let got = 0;
    for (let i = 0; i < 50; i += 1) {
      const pick = Math.floor(Math.random() * rows);
      const value = read.get(`spike-${pick}`) as Uint8Array | undefined;
      got += value?.byteLength ?? 0;
    }
    log(`  50 random BLOB reads: avg ${((performance.now() - t1) / 50).toFixed(2)} ms, avg ${Math.round(got / 50).toLocaleString()} B`, "good");
  }

  const after = await estimate();
  log(`  estimate() AFTER : usage ${mib(after.usage)} / quota ${gib(after.quota)}`, "good");
  log(`  usage grew ${mib(after.usage - before.usage)}; quota grew ${mib(after.quota - before.quota)}`);
  log(`  headroom used: ${((after.usage / after.quota) * 100).toFixed(2)}% of quota`);
  stat("OPFS usage", mib(after.usage), "warn");
  stat("quota", gib(after.quota));
  stat("% of quota used", `${((after.usage / after.quota) * 100).toFixed(2)}%`);

  blobs.close();

  // Does deleting a pool file give the space back? Measured, not assumed.
  const removed = await deleteDatabaseBrowser(BLOB_DB);
  const afterUnlink = await estimate();
  log(`  unlink(${BLOB_DB}) = ${removed}; usage now ${mib(afterUnlink.usage)}`, "warn");
  log(
    `  so removing a database from the pool returned ${mib(after.usage - afterUnlink.usage)} of ${mib(after.usage - before.usage)}`,
    afterUnlink.usage <= before.usage + 1024 * 1024 ? "good" : "bad",
  );
  stat("OPFS usage", mib(afterUnlink.usage));
}

/**
 * The write that matters: one row, the size of a graded review. Bulk-fill
 * failures are dramatic but a review is 100 bytes, and whether *that* survives
 * a full origin is the difference between "slow" and "lost a review".
 */
async function probeWrite(): Promise<void> {
  log("F. one small write, the shape of grading a card", "step");
  if (card === undefined) throw new Error("open the card database first");
  card.exec("CREATE TABLE IF NOT EXISTS _persist_probe (at TEXT PRIMARY KEY, note TEXT)");
  const stamp = new Date().toISOString();
  const t0 = performance.now();
  try {
    card.exec("BEGIN");
    card.prepare("INSERT OR REPLACE INTO _persist_probe (at, note) VALUES (?, ?)").run(stamp, "graded");
    card.exec("COMMIT");
    const rows = Number(card.prepare("SELECT count(*) FROM _persist_probe").pluck().get() ?? 0);
    log(`  wrote 1 row in ${ms(t0)}; _persist_probe now has ${rows} row(s)`, "good");
  } catch (error) {
    try {
      card.exec("ROLLBACK");
    } catch {
      // Keep the original failure.
    }
    log(`  THE SMALL WRITE FAILED: ${String(error)}`, "bad");
    log("  a review graded at this moment would be lost unless the app notices this", "bad");
  }
  const survivors = card
    .prepare("SELECT at FROM _persist_probe ORDER BY at DESC LIMIT 3")
    .pluck()
    .all() as string[];
  log(`  most recent probe rows: ${JSON.stringify(survivors)}`);
}

// -- 4. multi-tab: hold, and hand over ---------------------------------------

async function hold(on: boolean): Promise<void> {
  if (on) {
    if (card === undefined) {
      card = await openDatabaseBrowser({ filename: CARD_DB, schema: SCHEMA, applySchema: false });
    }
    const n = Number(card.prepare("SELECT count(*) FROM cards").pluck().get() ?? 0);
    log(`  HOLDING ${CARD_DB} open (${n.toLocaleString()} cards). The pool's sync handles are mine.`, "warn");
  } else {
    card?.close();
    card = undefined;
    log("  closed the database — but the POOL still holds every file's sync handle", "warn");
    log("  (db.close() is not enough to release OPFS; only pauseVfs()/removeVfs() is)", "warn");
  }
}

/**
 * Does `BrowserDb.close()` actually give the OPFS file back?
 *
 * `pauseVfs()` throws SQLITE_MISUSE while ANY file is open at the VFS level, so
 * it is a precise, cheap oracle for "is the handle really released". Three
 * variants, differing only in what they do with prepared statements:
 *
 *   A  exec() only, no prepare()      -> expect pause to succeed
 *   B  prepare(), then finalize()      -> expect pause to succeed
 *   C  prepare(), NO finalize()        -> ?
 *
 * If C fails while A and B pass, then every statement Hashigo prepares and
 * abandons pins an OPFS file open for the lifetime of the page.
 *
 * IT DID FAIL, and that is now fixed. Measured here 2026-08-19: C threw
 * `SQLITE_MISUSE: Cannot pause VFS opfs-sahpool because it has opened files`
 * because `oo1.DB.close()` finalizes nothing (dist/index.mjs:10282 passes
 * forEach's INDEX where it means the statement). `WasmDb` in
 * `src/db/browser.ts` now tracks the statements it hands out and finalizes them
 * in `close()`; re-run afterwards, all three of A, B and C report
 * `pauseVfs() SUCCEEDED`. Keep this probe: it is the oracle for that fix.
 */
async function handles(): Promise<void> {
  log("G. does close() actually release the OPFS file?", "step");
  const pool = await installPool();
  const NAME = "/persist-spike-handles.db";

  const attempt = async (label: string, body: (db: BrowserDb) => void): Promise<void> => {
    const db = await openDatabaseBrowser({ filename: NAME, schema: SCHEMA });
    body(db);
    db.close();
    let verdict: string;
    try {
      pool.pauseVfs();
      verdict = `pauseVfs() SUCCEEDED — the file was released (isPaused=${pool.isPaused()})`;
      await pool.unpauseVfs();
    } catch (error) {
      verdict = `pauseVfs() THREW — the file is STILL OPEN: ${String(error)}`;
    }
    log(`  ${label}`, "info");
    log(`     ${verdict}`, verdict.startsWith("pauseVfs() SUCCEEDED") ? "good" : "bad");
  };

  // Order matters: a variant that leaks poisons every later one, so the
  // suspected-bad case runs last.
  card?.close();
  card = undefined;
  try {
    (await installPool()).pauseVfs();
    await (await installPool()).unpauseVfs();
    log("  baseline: nothing open, pauseVfs() works", "good");
  } catch (error) {
    log(`  baseline FAILED before any test ran: ${String(error)}`, "bad");
    log("  something else in this page still holds a file; the results below are unreliable", "bad");
  }

  await attempt("A  exec() only, never called prepare()", (db) => {
    db.exec("CREATE TABLE IF NOT EXISTS t (x)");
    db.exec("INSERT INTO t (x) VALUES (1)");
  });

  await attempt("B  prepare(), then finalize() every statement", (db) => {
    const statement = db.prepare("SELECT count(*) FROM t");
    statement.pluck().get();
    statement.finalize();
  });

  await attempt("C  prepare(), and DO NOT finalize (close() must clean up)", (db) => {
    db.prepare("SELECT count(*) FROM t").pluck().get();
  });

  // C's leak, if it is one, is permanent for this page: the statement object is
  // unreachable, so nothing can finalize it. Say so rather than pretending the
  // pool is clean.
  log(`  pool after the three attempts: isPaused=${pool.isPaused()}, files ${pool.getFileCount()}`);
  try {
    await deleteDatabaseBrowser(NAME);
    log(`  unlinked ${NAME}`);
  } catch (error) {
    log(`  could not unlink ${NAME}: ${String(error)}`, "warn");
  }
}

/**
 * THE RETRY FINDING.
 *
 * `sqlite3.installOpfsSAHPoolVfs()` memoises its result per VFS name in a
 * module-private `initPromises` map, and on a *failed* install it caches the
 * REJECTION and re-throws it forever — unless the caller passes
 * `forceReinitIfPreviouslyFailed: true` (index.mjs ~15626).
 *
 * `installPool()` in src/db/browser.ts used to clear its own memo on failure
 * without passing that flag, so once a tab had lost the race to another tab it
 * could never take the database, even after the other tab was gone. It now
 * passes `forceReinitIfPreviouslyFailed: true`, and the `multitab` scenario
 * shows a forced open recovering on the very next attempt after the other tab
 * releases. This probe bypasses `installPool()` on purpose and is now expected
 * to report "plain retry SUCCEEDED ... nothing to recover from": that sentence
 * is the fix being visible, not the test failing to fire.
 */
async function retryInstall(): Promise<void> {
  log("H. can a tab that already lost the race ever recover?", "step");
  const api = await sqlite3();
  try {
    const pool = await api.installOpfsSAHPoolVfs({ initialCapacity: 12 });
    log(`  plain retry SUCCEEDED: capacity ${pool.getCapacity()}, files ${pool.getFileCount()}`, "good");
    log("  (so this worker had never failed an install — nothing to recover from)", "info");
    return;
  } catch (error) {
    log(`  plain retry FAILED (cached rejection): ${String(error)}`, "bad");
  }
  try {
    const pool = await api.installOpfsSAHPoolVfs({
      initialCapacity: 12,
      forceReinitIfPreviouslyFailed: true,
    } as Parameters<typeof api.installOpfsSAHPoolVfs>[0]);
    log(
      `  retry WITH forceReinitIfPreviouslyFailed SUCCEEDED: capacity ${pool.getCapacity()}, ` +
        `files ${pool.getFileCount()}, names ${JSON.stringify(pool.getFileNames())}`,
      "good",
    );
    log("  => this is the option src/db/browser.ts's installPool() now passes.", "good");
  } catch (error) {
    log(`  retry WITH the flag ALSO failed: ${String(error)}`, "bad");
    log("  => the handles really are still held by someone; the flag is not the issue", "warn");
  }
}

async function pause(paused: boolean): Promise<void> {
  const pool = await installPool();
  if (paused) {
    card?.close();
    card = undefined;
    pool.pauseVfs();
    log(`  pauseVfs(): isPaused=${pool.isPaused()} — every sync access handle released`, "good");
    log("  another tab can now install the pool. This is the handover mechanism.", "good");
  } else {
    await pool.unpauseVfs();
    log(`  unpauseVfs(): isPaused=${pool.isPaused()}, files ${pool.getFileCount()}`, "good");
    log(`  files: ${JSON.stringify(pool.getFileNames())}`);
  }
}

// -- 5. eviction, simulated exactly: the whole origin, gone ------------------

/**
 * Recursively empty OPFS. This is what an eviction does to a best-effort
 * origin — everything at once, database and audio together.
 */
async function evict(): Promise<void> {
  log("D. simulated eviction — remove EVERYTHING from OPFS", "step");
  const before = await estimate();
  log(`  usage before: ${mib(before.usage)}`);
  card?.close();
  card = undefined;
  // `pauseVfs()` refuses while any file is open, and `close()` does not close
  // (see step G), so the polite route is unavailable. `removeVfs()` releases the
  // handles unconditionally and deletes the pool's directory — the only thing
  // that works from inside the page. It also makes the pool unrevivable, so the
  // page MUST be reloaded afterwards.
  try {
    const pool = await installPool();
    const removed = await pool.removeVfs();
    log(`  removeVfs() -> ${removed}: handles released and the pool directory deleted`, "good");
  } catch (error) {
    log(`  removeVfs() failed: ${String(error)}`, "bad");
  }
  const root = await navigator.storage.getDirectory();
  const names: string[] = [];
  for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
    names.push(name);
  }
  for (const name of names) {
    await root.removeEntry(name, { recursive: true });
    log(`  removed /${name}`);
  }
  const after = await estimate();
  log(`  usage after: ${mib(after.usage)} (was ${mib(before.usage)})`, "good");
  log("  EVERY database and every byte of audio went together. Eviction is not partial.", "bad");
  log("  RELOAD THE PAGE NOW: removeVfs() leaves this worker's pool unrevivable.", "warn");
  stat("OPFS usage", mib(after.usage), "bad");
  stat("oracle from OPFS", "GONE - evicted", "bad");
}

/** The recovery path, timed end to end from an empty OPFS. */
async function recover(): Promise<void> {
  log("E. recovery from an empty OPFS, timed", "step");
  const whole = performance.now();

  const t0 = performance.now();
  const response = await fetch(BOOTSTRAP_URL, { cache: "no-store" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const tFetch = performance.now() - t0;
  log(`  1. fetch ${bytes.byteLength.toLocaleString()} bytes: ${(tFetch / 1000).toFixed(2)}s`);

  const t1 = performance.now();
  await importDatabaseBrowser(CARD_DB, bytes);
  const tImport = performance.now() - t1;
  log(`  2. importDb into OPFS: ${(tImport / 1000).toFixed(2)}s`);

  const t2 = performance.now();
  card = await openDatabaseBrowser({ filename: CARD_DB, schema: SCHEMA, applySchema: false });
  const tOpen = performance.now() - t2;
  log(`  3. open: ${(tOpen / 1000).toFixed(2)}s`);

  const t3 = performance.now();
  const ok = verifyOracle(card);
  const tVerify = performance.now() - t3;
  log(`  4. verify the oracle: ${(tVerify / 1000).toFixed(2)}s -> ${ok ? "MATCHES" : "MISMATCH"}`, ok ? "good" : "bad");

  log(
    `  TOTAL database recovery: ${((performance.now() - whole) / 1000).toFixed(2)}s ` +
      `(does NOT include the ${mib(624.6 * 1024 * 1024)} of audio)`,
    "good",
  );
  stat("oracle from OPFS", ok ? "MATCHES" : "DOES NOT MATCH", ok ? "good" : "bad");
  const { usage } = await estimate();
  stat("OPFS usage", mib(usage));
}

/** A fresh schema straight from src/schema/*.sql — proves the empty-start path. */
async function freshSchema(): Promise<void> {
  const t0 = performance.now();
  const fresh = await openDatabaseBrowser({
    filename: "/persist-spike-fresh.db",
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
  });
  applySchema(fresh, SCHEMA, SCHEMA_VERSION);
  const tables = Number(
    fresh.prepare("SELECT count(*) FROM sqlite_master WHERE type='table'").pluck().get() ?? 0,
  );
  log(`  a schema-only database from src/schema/*.sql: ${tables} tables in ${ms(t0)}`, "good");
  fresh.close();
  await deleteDatabaseBrowser("/persist-spike-fresh.db");
}

// -- dispatch ---------------------------------------------------------------

self.onmessage = async (event: MessageEvent<PersistRequest>): Promise<void> => {
  const request = event.data;
  try {
    switch (request.kind) {
      case "probe":
        await probe();
        break;
      case "open":
        log(
          `  the page's verdict, passed in: persistedBefore=${request.verdict.persistedBefore} ` +
            `granted=${request.verdict.granted} persistedAfter=${request.verdict.persistedAfter}`,
          request.verdict.persistedAfter ? "good" : "bad",
        );
        await open(request.reimport);
        await freshSchema();
        break;
      case "fill":
        await fill(request.limitBytes);
        break;
      case "hold":
        await hold(request.hold);
        break;
      case "pause":
        await pause(request.paused);
        break;
      case "evict":
        await evict();
        break;
      case "recover":
        await recover();
        break;
      case "write":
        await probeWrite();
        break;
      case "handles":
        await handles();
        break;
      case "retry":
        await retryInstall();
        break;
    }
    post({ kind: "done", id: request.id, ok: true });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log(`  FAILED: ${message}`, "bad");
    post({ kind: "done", id: request.id, ok: false, error: message });
  }
};

log(`worker up. inDedicatedWorker via self: ${typeof (self as unknown as object) !== "undefined"}`);
