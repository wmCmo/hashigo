/**
 * The blob store, backed by BLOB rows in a SQLite database. THE PRODUCTION
 * BACKING, in Node and in the browser, from this one file.
 *
 * WHY THIS REPLACED ONE-FILE-PER-BLOB. `notes/browser-feasibility.md` §4 stored
 * the identical 624.6 MiB of the corpus's audio both ways, in a real browser,
 * back to back:
 *
 *              write 624.6 MiB   per item   random read
 *   10,816 OPFS files    322.1 s   29.78 ms      10.60 ms
 *   BLOB rows, 1 file      4.9 s    0.46 ms       0.54 ms
 *
 * 65× to write, 20× to read ON THAT MACHINE, THAT AFTERNOON. Those two
 * multipliers are the ones this project quotes, so here is what happened when
 * they were re-measured. Absolute timings on Windows spread 3×–8× between
 * machines and even between two runs of the same page: the same insert has been
 * observed at 2.5 s, 5.6 s, 6.5 s, 12.7 s and 24.8 s (`spike/blobstore/README.md`
 * has the matrix). And in one session, minutes apart on one machine, the
 * integrator measured 1,000 individual OPFS files at 19.30 ms to write and
 * 14.31 ms to read against this store's 0.52–0.60 ms and 0.15–0.25 ms — 32×–37×
 * to write, 57×–95× to read. So neither multiplier reproduces exactly, the write
 * gap is smaller than §4 found and the read gap is larger, and the DECISION is
 * unaffected: every measurement anyone has taken puts one-file-per-payload more
 * than an order of magnitude behind, in both directions. Do not quote 65× or 20×
 * as a constant; the honest claim is "tens of times, measured repeatedly".
 *
 * Per-file OPFS overhead — create, open a sync access handle, write, close —
 * dominates completely; inside SQLite the same bytes are one sequential write.
 * Minutes of uninterruptible writing on first run versus seconds is the
 * difference between an app that works on a phone and one that looks broken on
 * it. `src/blobs/node.ts` (the directory store) is kept for export and interop
 * and is no longer the default anywhere.
 *
 * ONE IMPLEMENTATION, TWO PLATFORMS — deliberately, because two would drift and
 * the thing Zach tests has to be the thing that ships. This class is typed
 * against `SqliteHandle` from `src/db/browser.ts`: the synchronous surface that
 * better-sqlite3's `Database` satisfies structurally (proved by tsc in
 * `spike/contract-compat.ts`) and that `openDatabaseBrowser()` returns over
 * `opfs-sahpool`. The import of that type is `import type`, so this file pulls in
 * nothing at runtime — no `node:*`, no `better-sqlite3`, no wasm. The browser
 * build imports it unchanged, and `test/blobs.test.ts` runs the same class the
 * browser runs.
 *
 * A SEPARATE DATABASE, NOT A TABLE IN THE CARD DATABASE. Three reasons, and the
 * note recommended it:
 *
 *   1. The card database stays ~70 MB. It is the file stage 11 sync moves and the
 *      one a reimport rebuilds in 15 s; welding 625 MB of mp3 to it makes every
 *      operation on the cards pay for the audio.
 *   2. Blast radius. A corrupt payload page cannot take 102,020 reviews with it,
 *      and `blobs.db` is the one file that is *always* rebuildable — every row in
 *      it is regenerable from provenance or re-importable from the export.
 *   3. It changes nothing about the architecture. `blobs` rows (address, mime,
 *      size, provenance, refcount) stay in the card database; the payloads live
 *      in a store; the store is a runtime argument. That was already the split —
 *      this store just happens to be a database file instead of a directory.
 *
 * `src/db/browser.ts`'s `POOL_INITIAL_CAPACITY` is already sized for exactly this
 * ("two databases — the ~70 MB card database and a separate blob database
 * holding 624.6 MiB of audio as BLOB rows"), so the pool needs no change.
 *
 * NO LOCATION, STILL. The store holds `hash` and `bytes`. `hash` is CHECK-ed to
 * 64 lowercase hex characters, so the only column in the file that *could* hold a
 * path is the payload itself — which is the payload by definition. The card
 * database is unchanged and `blobs.path` is still never written.
 *
 * THE CONTRACT IS UNCHANGED AND STILL SYNCHRONOUS. `read(hash): Uint8Array`, not
 * a Promise — see store.ts and FIXES.md §3.1. That forecloses a main-thread store
 * forever, which is fine because `opfs-sahpool` is worker-only anyway. One thing
 * is ADDED, visibly rather than silently: the optional `batch()` on `BlobStore`.
 * Without it every `write()` is its own transaction, and 10,816 transactions is
 * where the 4.9 s goes. See `batch` below.
 */

import type { SqliteHandle, SqliteStatement } from "../db/browser.js";

import { assertAddress } from "./address.js";
import { sha256Hex } from "./sha256.js";
import { BlobConflictError, BlobMissingError, type BlobStore, type BlobWriteResult } from "./store.js";

/** What `blob_store_meta.format` says. Bumped only by a layout change. */
export const SQLITE_STORE_FORMAT = "hashigo/blob-store/sqlite/1";

/** `PRAGMA user_version` of a blob-store database. Not the card schema version. */
export const SQLITE_STORE_VERSION = 1;

/**
 * Page size, set explicitly so Node and the browser measure the same thing.
 *
 * better-sqlite3 defaults to 4096 and the wasm build to 8192 (its
 * `DEFAULT_PAGE_SIZE` compile option), which would have made every Node/browser
 * comparison in this file a comparison of two different databases. 8192 also
 * halves the overflow-page chain for a 60 KB average payload. It must be set
 * before the first table exists; on an existing store it is whatever the store
 * was created with, and `stats()` reports it.
 */
export const STORE_PAGE_SIZE = 8192;

/**
 * Bytes accumulated inside a `batch()` before it commits and starts a new
 * transaction.
 *
 * One transaction around all 625 MB is fastest and is what the note measured,
 * but it is also all-or-nothing: interrupt it and a 10-minute first import has
 * written nothing. 64 MiB is ~10 commits over the corpus — the throughput cost is
 * in the noise (measured, see the report) and the worst case becomes "re-copy at
 * most 64 MiB", which is what makes `IDEMPOTENT WRITE` in store.ts actually
 * usable rather than theoretical.
 */
export const BATCH_FLUSH_BYTES = 64 * 1024 * 1024;

/** Injected digest, so this file needs neither `node:crypto` nor `crypto.subtle`. */
export type Digest = (bytes: Uint8Array) => string;

export interface SqliteStoreOptions {
  /**
   * Hash function for `verify()`. Defaults to the pure-TS `sha256Hex`, which is
   * the only thing that works in both halves. Node callers rehashing the whole
   * corpus should pass `contentAddress` (OpenSSL): ~2 GiB/s against ~170 MiB/s.
   */
  readonly digest?: Digest;
  /** Create the store schema if the database is empty. Default true. */
  readonly create?: boolean;
  /**
   * `PRAGMA auto_vacuum` for a NEWLY created store.
   *
   * `incremental` is the default and it is a decision, not a habit: with
   * `none`, the file only ever grows, so deleting a swept 3 MB mp3 on a phone
   * leaves a 3 MB hole that only a full `VACUUM` reclaims — and a full VACUUM of
   * a 660 MB store means rewriting the whole file, which on OPFS also needs a
   * second pool slot's worth of space. `incremental` lets `reclaim()` return
   * pages to the filesystem in bounded chunks with no rewrite. The cost is
   * pointer-map pages; both are measured over the real corpus in the report.
   * Ignored for an existing store — auto_vacuum cannot be changed afterwards
   * except by a VACUUM.
   */
  readonly autoVacuum?: "none" | "full" | "incremental";
}

interface PayloadStats {
  readonly payloads: number;
  readonly bytes: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freelistPages: number;
  readonly autoVacuum: number;
  readonly journalMode: string;
  /** `page_size * page_count`. The file is this big, plus any journal. */
  readonly fileBytes: number;
}

/** Every statement this store runs, so the cache is a fixed, readable set. */
const SQL = {
  size: "SELECT byte_size FROM blob_payloads WHERE hash = ?",
  read: "SELECT bytes FROM blob_payloads WHERE hash = ?",
  insert: "INSERT INTO blob_payloads (hash, byte_size, bytes) VALUES (?, ?, ?)",
  remove: "DELETE FROM blob_payloads WHERE hash = ?",
  list: "SELECT hash FROM blob_payloads ORDER BY hash",
  totals: "SELECT count(*) AS n, coalesce(sum(byte_size), 0) AS b FROM blob_payloads",
} as const;

const DDL = `
-- The payload table. hash is the address; bytes is the payload; there is no
-- third thing, and in particular there is no location.
CREATE TABLE blob_payloads (
  hash      TEXT NOT NULL PRIMARY KEY
              CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  byte_size INTEGER NOT NULL CHECK (byte_size = length(bytes)),
  bytes     BLOB NOT NULL
);

-- Covering, so has()/size()/list() and the 10,816-row audit never touch a
-- payload page. Without it every size() call loads the first page of an mp3.
CREATE INDEX blob_payloads_size ON blob_payloads (hash, byte_size);

CREATE TABLE blob_store_meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * A content-addressed blob store over `blob_payloads` in `db`.
 *
 * `db` should be a handle to a database used for nothing else — see the header on
 * why the payloads do not live in the card database. The store does not close the
 * handle; whoever opened it owns it.
 */
export class SqliteBlobStore implements BlobStore {
  readonly describe: string;
  readonly #db: SqliteHandle;
  readonly #digest: Digest;
  /**
   * PREPARED ONCE, NOT PER CALL. This matters much more in the browser than in
   * Node: `src/db/browser.ts`'s `prepare()` returns a wasm statement that must be
   * `finalize()`d, and nothing on the shared `SqliteHandle` contract finalizes for
   * you. A 10,816-payload import calls `write()` (two statements) once per
   * payload, so preparing per call would leak ~22,000 wasm statements into a
   * heap that has 625 MB of audio going through it. better-sqlite3 would have
   * survived it; the worker would not.
   */
  readonly #statements = new Map<string, SqliteStatement>();
  #depth = 0;
  #pending = 0;
  #flushes = 0;

  constructor(db: SqliteHandle, options: SqliteStoreOptions = {}) {
    this.#db = db;
    this.#digest = options.digest ?? sha256Hex;
    this.describe = `sqlite:${db.name}`;

    const version = this.#pragmaNumber("user_version");
    const hasTable = this.#hasPayloadTable();

    if (!hasTable) {
      if (options.create === false) {
        throw new Error(
          `${this.describe} is not a blob store (no blob_payloads table) and create:false ` +
            `was requested`,
        );
      }
      // A marker check with teeth: refuse to scribble a payload table into
      // something that is already a database. Pointing --store at the CARD
      // database is the mistake this catches.
      const tables = this.#tableNames();
      if (tables.length > 0) {
        throw new Error(
          `${this.describe} already holds tables (${tables.slice(0, 5).join(", ")}) but no ` +
            `blob_payloads. Refusing to add a blob store to an existing database — name a ` +
            `separate file. The card database is not the payload store.`,
        );
      }
      this.#create(options.autoVacuum ?? "incremental");
    } else if (version !== SQLITE_STORE_VERSION) {
      throw new Error(
        `${this.describe} has a blob_payloads table but PRAGMA user_version = ${version}, ` +
          `not ${SQLITE_STORE_VERSION}. This build has no migration path for a blob store.`,
      );
    }

    // Set on every open, not just at creation: they are connection state.
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA temp_store = memory");
  }

  // -- BlobStore --------------------------------------------------------------

  has(hash: string): boolean {
    return this.size(hash) !== null;
  }

  size(hash: string): number | null {
    const row = this.#stmt(SQL.size).pluck().get(assertAddress(hash));
    return typeof row === "number" ? row : null;
  }

  read(hash: string): Uint8Array {
    const bytes = this.#stmt(SQL.read).pluck().get(assertAddress(hash));
    if (!(bytes instanceof Uint8Array)) throw new BlobMissingError(hash, this.describe);
    return bytes;
  }

  /**
   * Idempotent, and immutable: an address holds one payload forever, so a second
   * write of the same bytes reports `written: false` and a write of *different*
   * bytes under a held address throws rather than rewriting.
   *
   * The length comparison is the same one `NodeBlobStore` makes (a `stat` there,
   * an index-only lookup here) and for the same reason: same address, different
   * length is a collision or a corrupt store, and silently continuing is the
   * worse answer. It is one index probe per write, which is why the size index
   * exists.
   */
  write(hash: string, bytes: Uint8Array): BlobWriteResult {
    assertAddress(hash);
    const held = this.size(hash);
    if (held !== null) {
      if (held !== bytes.length) throw new BlobConflictError(hash, held, bytes.length);
      return { hash, written: false, bytes: held };
    }
    this.#stmt(SQL.insert).run(hash, bytes.length, bytes);
    if (this.#depth > 0) {
      this.#pending += bytes.length;
      if (this.#pending >= BATCH_FLUSH_BYTES) this.#flush();
    }
    return { hash, written: true, bytes: bytes.length };
  }

  remove(hash: string): boolean {
    return this.#stmt(SQL.remove).run(assertAddress(hash)).changes > 0;
  }

  /**
   * Every address the store holds.
   *
   * Materialised rather than streamed on purpose: a cursor held open across the
   * caller's loop would sit inside `auditBlobStore`'s own reads on one connection,
   * and 10,816 addresses is 700 KB. If this store ever holds millions of blobs
   * that trade changes; it does not today, and pretending otherwise would add a
   * statement-lifetime bug to a store that has none.
   */
  *list(): IterableIterator<string> {
    const hashes = this.#stmt(SQL.list).pluck().all() as string[];
    for (const hash of hashes) yield hash;
  }

  verify(hash: string): boolean {
    assertAddress(hash);
    const bytes = this.#stmt(SQL.read).pluck().get(hash);
    return bytes instanceof Uint8Array && this.#digest(bytes) === hash;
  }

  /**
   * Run `fn` with writes batched into transactions. THE REASON THE IMPORT IS 4.9 s
   * RATHER THAN MINUTES: outside a batch every `write()` is its own transaction,
   * and on 10,816 payloads the commits cost more than the bytes.
   *
   * Not one transaction — a *sequence* of them. `write()` commits and reopens
   * every `BATCH_FLUSH_BYTES`, so an interrupted 625 MB import loses at most that
   * much work and the next run resumes on the idempotent-write path. A throw
   * rolls back only the current chunk; already-flushed payloads stay, which is
   * exactly the "wasted disk, never a dangling reference" failure direction the
   * rest of this module is built around. Reentrant: a nested `batch()` joins the
   * outer one.
   */
  batch<T>(fn: () => T): T {
    if (this.#depth > 0) {
      this.#depth += 1;
      try {
        return fn();
      } finally {
        this.#depth -= 1;
      }
    }
    this.#db.exec("BEGIN");
    this.#depth = 1;
    this.#pending = 0;
    this.#flushes = 0;
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // A failed rollback must not replace the error that caused it.
      }
      throw error;
    } finally {
      this.#depth = 0;
      this.#pending = 0;
    }
  }

  /** Intermediate commits the last `batch()` made. Diagnostics; 0 or more. */
  get batchFlushes(): number {
    return this.#flushes;
  }

  // -- store-specific ---------------------------------------------------------

  /** Rows, bytes, and the page accounting behind them. */
  stats(): PayloadStats {
    const row = this.#stmt(SQL.totals).get() as { n: number; b: number };
    const pageSize = this.#pragmaNumber("page_size");
    const pageCount = this.#pragmaNumber("page_count");
    return {
      payloads: row.n,
      bytes: row.b,
      pageSize,
      pageCount,
      freelistPages: this.#pragmaNumber("freelist_count"),
      autoVacuum: this.#pragmaNumber("auto_vacuum"),
      journalMode: String(this.#db.pragma("journal_mode", { simple: true }) ?? "?"),
      fileBytes: pageSize * pageCount,
    };
  }

  /**
   * Return free pages to the filesystem without rewriting the file. Needs
   * `auto_vacuum = incremental` (the default for a new store); a no-op otherwise,
   * which `stats().freelistPages` makes visible rather than silent.
   *
   * `pages = 0` reclaims everything on the freelist. This is what a sweep should
   * call on a phone, where a full `VACUUM` of a 660 MB store means rewriting 660 MB
   * and, on OPFS, finding room for a second copy first.
   */
  reclaim(pages = 0): number {
    const before = this.#pragmaNumber("freelist_count");
    if (before === 0) return 0;
    const budget = pages > 0 ? Math.min(pages, before) : before;

    // A LOOP, AND NOT BECAUSE SQLITE NEEDS ONE. `PRAGMA incremental_vacuum` frees
    // ONE page per `sqlite3_step()`, and the two handles this store runs on step
    // it a different number of times. Measured on the 660 MB corpus store with
    // 1,920 free pages, from this exact call:
    //
    //   better-sqlite3 exec()          1,920 -> 0      (drains the statement)
    //   sqlite-wasm oo1 exec()         1,920 -> 1,919  (steps it once)
    //   better-sqlite3 prepare().run() 1,502 -> 1,501  (also steps it once)
    //
    // Neither is wrong. Depending on either is: the browser silently reclaimed
    // one page of 1,920 and reported success. So the loop lives here, once, in
    // the implementation both halves share, and it stops on no progress rather
    // than trusting a count.
    //
    // COST, measured on the same 1,920 pages: Node finishes in one iteration and
    // a few ms; Chromium needs one statement per page and takes 35-54 s. (An
    // earlier comment here said 6.8 s: that was the single fastest run seen, and
    // an adversarial re-measurement got 35.0/50.6/50.9/53.9 s across four Chrome
    // 151 environments, warm and cold profiles alike. A phone will be worse than
    // any of them. The bound below matters MORE than the old number implied.) That is
    // the price of reclaiming ~15 MB without rewriting 660 MB, and it is why
    // `reclaim(pages)` takes a bound — a sweep on a phone should hand back a
    // budget's worth per session rather than block on the whole freelist.
    let free = before;
    for (let guard = 0; guard < budget; guard += 1) {
      const want = budget - (before - free);
      if (want <= 0) break;
      this.#db.exec(`PRAGMA incremental_vacuum(${want})`);
      const now = this.#pragmaNumber("freelist_count");
      if (now >= free) break;
      free = now;
    }
    return before - free;
  }

  /** Full rewrite. Reclaims everything and defragments; costs the whole file. */
  vacuum(): void {
    this.#db.exec("VACUUM");
  }

  /** `PRAGMA integrity_check` on the store itself. Empty means healthy. */
  checkIntegrity(): readonly string[] {
    const rows = this.#db.pragma("integrity_check") as { integrity_check: string }[];
    return rows.map((row) => row.integrity_check).filter((text) => text !== "ok");
  }

  // -- internals --------------------------------------------------------------

  /** Prepared statements, cached by SQL text. See #statements. */
  #stmt(sql: string): SqliteStatement {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #flush(): void {
    this.#db.exec("COMMIT");
    this.#db.exec("BEGIN");
    this.#pending = 0;
    this.#flushes += 1;
  }

  #create(autoVacuum: "none" | "full" | "incremental"): void {
    // Both of these are ignored once a table exists, so they go first and they
    // are not inside the transaction the DDL runs in.
    this.#db.exec(`PRAGMA page_size = ${STORE_PAGE_SIZE}`);
    this.#db.exec(`PRAGMA auto_vacuum = ${autoVacuum}`);
    this.#db.transaction(() => {
      this.#db.exec(DDL);
      const meta = this.#db.prepare("INSERT INTO blob_store_meta (key, value) VALUES (?, ?)");
      meta.run("format", SQLITE_STORE_FORMAT);
      meta.run("layout", "blob_payloads(hash, byte_size, bytes)");
      // A timestamp, not a path: nothing in this file records where anything is.
      meta.run("created", new Date().toISOString());
      this.#db.exec(`PRAGMA user_version = ${SQLITE_STORE_VERSION}`);
    })();
  }

  #hasPayloadTable(): boolean {
    // Not cached: called before the schema exists, and exactly once per store.
    return (
      this.#db
        .prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?")
        .pluck()
        .get("blob_payloads") === 1
    );
  }

  #tableNames(): string[] {
    return this.#db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .pluck()
      .all() as string[];
  }

  #pragmaNumber(name: string): number {
    return Number(this.#db.pragma(name, { simple: true }) ?? 0);
  }
}

/** Open a blob store over an already-open handle. */
export function openSqliteBlobStore(
  db: SqliteHandle,
  options: SqliteStoreOptions = {},
): SqliteBlobStore {
  return new SqliteBlobStore(db, options);
}
