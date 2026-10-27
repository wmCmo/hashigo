/**
 * Stage 0.5 — opening a Hashigo database in a browser, on OPFS.
 *
 * The Node half is `src/db/open.ts` (better-sqlite3). This is the same job over
 * `@sqlite.org/sqlite-wasm` and its `opfs-sahpool` VFS, and it deliberately
 * hands back a handle with the *same synchronous surface* — `prepare().all()`,
 * `exec()`, `pragma()`, `transaction()`, `function()` — so that the 77% of
 * `src/` which is pure TypeScript over a database handle does not have to know
 * which one it got. Only the opening differs, because installing the VFS is
 * asynchronous exactly once.
 *
 *     // in a dedicated Worker, and only there:
 *     import schemaSql from "../schema/schema.sql?raw";
 *     import viewsSql from "../schema/views.sql?raw";
 *     const db = await openDatabaseBrowser({
 *       filename: "/hashigo.db",
 *       schema: [{ name: "schema.sql", sql: schemaSql },
 *                { name: "views.sql", sql: viewsSql }],
 *     });
 *     db.prepare("SELECT count(*) FROM cards").pluck().get();   // synchronous
 *
 * Four things about this file are load-bearing and were each measured, not
 * assumed (see spike/README.md for the pasted output):
 *
 *   1. WORKER ONLY. `opfs-sahpool` is built on `createSyncAccessHandle()`, which
 *      is restricted to dedicated Workers. Calling this from the main thread
 *      throws here rather than failing three frames deep inside wasm. There is
 *      an `allowMainThread` escape hatch so an experiment can measure the real
 *      failure; production code must not set it.
 *   2. NO COOP/COEP. sahpool needs neither SharedArrayBuffer nor cross-origin
 *      isolation, so Hashigo can be served as plain static files over
 *      http://localhost or https://. It does need a *secure context*.
 *   3. NOT WAL. `src/db/open.ts` used to claim WAL "is the mode the OPFS build
 *      will use too". It is not: WAL needs a `-shm` shared-memory file and this
 *      VFS implements no shared memory, so `PRAGMA journal_mode=WAL` does not
 *      take on a sahpool database — it stays on the rollback journal. That is
 *      also why `importDb()` rewrites the header bytes of an imported file to
 *      force WAL off. Two consequences for anything that ships a prebuilt `.db`
 *      into the browser: the file must be checkpointed (a `-wal` sidecar is NOT
 *      imported, so uncheckpointed commits are silently lost), and there is no
 *      point converting its journal mode by hand.
 *   4. THE POOL IS A FIXED NUMBER OF FILES. `installOpfsSAHPoolVfs`'s
 *      `initialCapacity` defaults to **6**, and the VFS cannot grow itself: a
 *      file open beyond capacity fails with SQLITE_FULL at whatever moment
 *      SQLite happened to need a slot. Rollback journals and temp files each
 *      take a slot too. See POOL_INITIAL_CAPACITY.
 *
 * `src/schema/index.ts` cannot be imported here: it reads `schema.sql` with
 * `node:fs` at module load, so importing it in a browser build throws before any
 * of this runs. The schema therefore arrives as text through `options.schema` —
 * from the bundler (`?raw`) at the call site, which is the one place that knows
 * which bundler it is.
 */

import type {
  BindingSpec,
  Database,
  PreparedStatement,
  SAHPoolUtil,
  SqlValue,
  Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";

/** Where the card database lives in the pool. sahpool names are absolute. */
export const DEFAULT_DATABASE = "/hashigo.db";

/**
 * Slots to reserve in the SAH pool. The default is 6 and it is not enough for
 * where this is going.
 *
 * Upstream's own rule of thumb: "at least twice the number of expected database
 * files (to account for journal files) and may need to be even higher than three
 * times the number of databases plus one, depending on TEMP_STORE". Hashigo is
 * heading for two databases — the ~70 MB card database and a separate blob
 * database holding 624.6 MiB of audio as BLOB rows — so 3n+1 is 7. Twelve leaves
 * room for a third file (a scratch import database, a sync staging file) without
 * a capacity change, and the cost of a slot is one empty OPFS file plus one held
 * sync-access handle, not disk.
 *
 * `initialCapacity` is ignored once a pool exists on the origin, so a pool
 * created by an earlier build at 6 would stay at 6 forever. `installPool` always
 * follows the install with `reserveMinimumCapacity()` for that reason.
 */
export const POOL_INITIAL_CAPACITY = 12;

/** One `{ name, sql }` per file, applied in order. Mirrors SCHEMA_SOURCES. */
export interface SchemaSource {
  readonly name: string;
  readonly sql: string;
}

export interface BrowserOpenOptions {
  /** Absolute name inside the pool. Default `/hashigo.db`. */
  readonly filename?: string;
  /** Open read-only. Implies no schema application. */
  readonly readOnly?: boolean;
  /** The DDL, as text. Required to create a database; ignored once stamped. */
  readonly schema?: readonly SchemaSource[];
  /** Value for `PRAGMA user_version`. Must match `SCHEMA_VERSION`. */
  readonly schemaVersion?: number;
  /** Apply `schema` to a fresh database. Default true. */
  readonly applySchema?: boolean;
  /** Slots to reserve. Default POOL_INITIAL_CAPACITY. */
  readonly initialCapacity?: number;
  /** VFS registration name. Change only together with `directory`. */
  readonly vfsName?: string;
  /** OPFS directory holding the pool. One pool per directory, per origin. */
  readonly directory?: string;
  /**
   * Let this run on the main thread. For measurement only: sahpool needs
   * `createSyncAccessHandle`, which the platform restricts to dedicated
   * Workers, so this exists to observe the failure rather than to survive it.
   */
  readonly allowMainThread?: boolean;
}

/** What better-sqlite3's `Statement.run()` reports, so callers do not branch. */
export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/**
 * THE CONTRACT. Every member of the surface that both halves of `src/db`
 * provide, and the only surface portable code may use.
 *
 * better-sqlite3's `Database` satisfies this structurally — `build/spike-*` runs
 * the assignment `const check: SqliteStatement = betterSqlite3Statement` and
 * `const check: SqliteHandle = betterSqlite3Database` through tsc, so this is
 * checked rather than asserted. Portable code should be typed against
 * `SqliteHandle`, not against `Database` from better-sqlite3 and not against
 * `BrowserDb`; then the same function body runs in Node and in the Worker.
 */
export interface SqliteStatement {
  all(...params: readonly unknown[]): unknown[];
  get(...params: readonly unknown[]): unknown;
  run(...params: readonly unknown[]): RunResult;
  iterate(...params: readonly unknown[]): IterableIterator<unknown>;
  /** Return the first column instead of a row object. Chainable, like Node. */
  pluck(toggle?: boolean): this;
  /** Return rows as arrays instead of objects. */
  raw(toggle?: boolean): this;
  columns(): { readonly name: string }[];
}

/** As above, plus the one thing better-sqlite3 does not need. */
export interface BrowserStatement extends SqliteStatement {
  /** better-sqlite3 collects statements; wasm handles must be released. */
  finalize(): void;
}

/** The subset of better-sqlite3's `Database` this project actually uses. */
export interface SqliteHandle {
  readonly name: string;
  readonly open: boolean;
  prepare(sql: string): SqliteStatement;
  exec(sql: string): this;
  pragma(source: string, options?: { readonly simple?: boolean }): unknown;
  /**
   * Returns a callable, as better-sqlite3 does. Two overloads because that is
   * what makes both implementations satisfy one type: the nullary form (which is
   * every call site in this repo) keeps its return type; the variadic form
   * exists so a caller with arguments still typechecks.
   */
  transaction<R>(fn: () => R): () => R;
  transaction(fn: (...args: never[]) => unknown): (...params: never[]) => unknown;
  function(name: string, fn: (...args: never[]) => unknown): this;
  function(
    name: string,
    options: { readonly deterministic?: boolean; readonly varargs?: boolean },
    fn: (...args: never[]) => unknown,
  ): this;
  close(): void;
}

/** The OPFS handle: the shared contract plus the browser-only extras. */
export interface BrowserDb extends SqliteHandle {
  prepare(sql: string): BrowserStatement;
  /** The pool this database lives in — capacity, import, export. */
  readonly pool: SAHPoolUtil;
  /** Escape hatch to the sqlite-wasm handle. */
  readonly wasm: Database;
  /**
   * Distinct SQL strings this handle holds a cached statement for. Diagnostics
   * only; see `WasmDb.#cache` for why the cache exists and what makes reuse safe.
   */
  readonly cachedStatements: number;
  /**
   * Statements prepared through this handle and not yet finalized. Zero after
   * `close()`. Exposed because "did close() actually release the OPFS file" is
   * otherwise only answerable by watching `pauseVfs()` fail.
   */
  readonly openStatements: number;
}

// -- the wasm module and the pool: installed once per Worker -----------------

let sqlite3Promise: Promise<Sqlite3Static> | undefined;
let poolPromise: Promise<SAHPoolUtil> | undefined;
let poolKey = "";

/** The sqlite3 wasm module, loaded and initialised once. */
export async function sqlite3(): Promise<Sqlite3Static> {
  sqlite3Promise ??= import("@sqlite.org/sqlite-wasm").then((module) => module.default());
  return sqlite3Promise;
}

/** `3.53.0`. Cheap, and worth printing in any diagnostic. */
export async function sqliteVersion(): Promise<string> {
  return (await sqlite3()).version.libVersion;
}

/**
 * Install (or reattach) the OPFS SAH pool. Idempotent per Worker: the second
 * call returns the same pool. Refuses a second call that asks for a *different*
 * pool, because two pools over one directory is documented as unsupported and
 * the failure is data corruption rather than an exception.
 */
export async function installPool(options: BrowserOpenOptions = {}): Promise<SAHPoolUtil> {
  assertUsable(options);
  const capacity = options.initialCapacity ?? POOL_INITIAL_CAPACITY;
  const key = `${options.vfsName ?? ""}|${options.directory ?? ""}`;
  if (poolPromise !== undefined) {
    if (key !== poolKey) {
      throw new Error(
        `an OPFS SAH pool is already installed in this worker as ${JSON.stringify(poolKey)}; ` +
          `refusing to install ${JSON.stringify(key)} as well. One pool per worker: put a ` +
          `second database in the same pool as another file, not in a second pool.`,
      );
    }
    return poolPromise;
  }
  poolKey = key;
  poolPromise = (async () => {
    const api = await sqlite3();
    // forceReinitIfPreviouslyFailed: upstream memoises installOpfsSAHPoolVfs per
    // VFS name in a module-private `initPromises` and caches REJECTIONS as well
    // as successes (node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs:15626-15632,
    // read directly at 3.53.0-build1). Without the flag, a tab that lost the
    // single-connection race keeps re-throwing the original
    // NoModificationAllowedError forever — indistinguishable from a live
    // conflict — even after the other tab has released every handle. Measured
    // 2026-08-19 in real Chrome 151: a plain retry fails on a freed pool, and a
    // retry with the flag succeeds at the same instant. Clearing this module's
    // own `poolPromise` is not enough, because the cache is upstream's, not ours.
    // The option is absent from the package's .d.ts, hence the cast; it has been
    // honoured since 3.47 and is checked before anything else in that function.
    const pool = await api.installOpfsSAHPoolVfs({
      initialCapacity: capacity,
      forceReinitIfPreviouslyFailed: true,
      ...(options.vfsName === undefined ? {} : { name: options.vfsName }),
      ...(options.directory === undefined ? {} : { directory: options.directory }),
    } as Parameters<typeof api.installOpfsSAHPoolVfs>[0]);
    // initialCapacity is ignored when the pool already exists, so an origin that
    // first saw a 6-slot pool keeps one until something asks for more.
    if (Number(pool.getCapacity()) < capacity) await pool.reserveMinimumCapacity(capacity);
    return pool;
  })();
  try {
    return await poolPromise;
  } catch (cause) {
    poolPromise = undefined;
    poolKey = "";
    throw new Error(`could not install the opfs-sahpool VFS: ${explainPoolFailure(cause)}`, {
      cause,
    });
  }
}

/**
 * Turn the one sahpool failure a USER can actually cause into an instruction.
 *
 * ONE TAB PER ORIGIN, AND THE BROWSER SAYS SO IN THE WRONG VOCABULARY. The pool
 * holds a `SyncAccessHandle` on every slot file for as long as the page lives,
 * and those handles are exclusive per file across the whole origin — so a second
 * tab on the same site cannot open the database while the first still has it.
 * What the browser throws is:
 *
 *   Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle':
 *   Access Handles cannot be created if there is another open Access Handle or
 *   Writable stream associated with the same file.
 *
 * Which is accurate and tells the reader nothing about what to do. Zach hit it on
 * his phone on 2026-09-08 with seven tabs open, one of them an older Hashigo, and
 * the screen was a raw DOMException — on a device where there is no console to
 * check and no obvious link between "Access Handle" and "you have this page open
 * twice".
 *
 * The pool is not corrupt when this happens and nothing was written, so the honest
 * message is a two-step instruction rather than an error. Detection is on the
 * `createSyncAccessHandle` name plus the "another open" phrasing rather than on the
 * exact sentence, because that wording is Chromium's and not a specification.
 */
function explainPoolFailure(cause: unknown): string {
  const message = (cause as Error | undefined)?.message ?? String(cause);
  const contended =
    message.includes("createSyncAccessHandle") &&
    /another open|already open|NoModificationAllowed/i.test(message);
  if (!contended) return message;
  return (
    "this page is already open in another tab. The database can only be held by " +
    "one tab at a time, so close the other Hashigo tabs and reload. " +
    `Nothing was written and nothing is damaged. (${message})`
  );
}

/**
 * Open (creating if needed) a Hashigo database in OPFS.
 *
 * Async only because the VFS install is. Everything on the returned handle is
 * synchronous, which is why this must run in a Worker.
 */
export async function openDatabaseBrowser(options: BrowserOpenOptions = {}): Promise<BrowserDb> {
  const filename = normaliseFilename(options.filename ?? DEFAULT_DATABASE);
  const readOnly = options.readOnly === true;
  const pool = await installPool(options);
  const api = await sqlite3();

  const wasm = new api.oo1.DB(filename, readOnly ? "r" : "c", pool.vfsName);
  const db = new WasmDb(wasm, pool);

  // Foreign keys are OFF by default in SQLite and this schema leans on them —
  // the tag tree's every-prefix-exists guarantee and "a referenced blob cannot
  // be deleted" are both foreign keys.
  db.exec("PRAGMA foreign_keys = ON");
  if (Number(db.pragma("foreign_keys", { simple: true })) !== 1) {
    db.close();
    throw new Error("could not enable foreign keys; this schema requires them");
  }
  if (!readOnly) {
    // Temp files would each consume a pool slot; memory avoids that entirely.
    db.exec("PRAGMA temp_store = memory");
    db.exec("PRAGMA synchronous = NORMAL");
  }

  if (!readOnly && options.applySchema !== false && schemaVersion(db) === 0) {
    if (options.schema === undefined || options.schema.length === 0) {
      db.close();
      throw new Error(
        `openDatabaseBrowser(${JSON.stringify(filename)}): the database is empty and no schema ` +
          `sources were supplied. Pass them as text — in a Vite build that is\n` +
          `  import schemaSql from "../schema/schema.sql?raw";\n` +
          `  import viewsSql from "../schema/views.sql?raw";\n` +
          `  schema: [{ name: "schema.sql", sql: schemaSql }, { name: "views.sql", sql: viewsSql }]\n` +
          `src/schema/index.ts cannot be imported in a browser: it reads the SQL with node:fs at ` +
          `module load. Pass { applySchema: false } if you are about to import a prebuilt file.`,
      );
    }
    applySchema(db, options.schema, options.schemaVersion);
  }

  return db;
}

/**
 * The schema version this adapter stamps and accepts.
 *
 * NO LONGER DUPLICATED, as of 2026-08-22. It was a hardcoded `2` against a real
 * `SCHEMA_VERSION` of 7 -- five versions of drift -- and the comment here claimed
 * the drift was "caught by a build rather than by a corrupt database". It was
 * not: `vite.config.ts:106` does inject the Node-side value and
 * `spike/db.worker.ts:202-207` does compare all three, but it only PRINTS
 * `<- DRIFT` to a page a human has to be looking at. Nothing failed. The old `spike:check`
 * gate was `tsc` over a type-only file and never evaluated it.
 *
 * Live only because both spikes open an existing database with
 * `applySchema: false`; it would have corrupted the first database the shell
 * created from DDL, by stamping `user_version = 2` on a version-7 schema and
 * then refusing to open it.
 *
 * The reason it was duplicated is gone: `src/schema/index.ts` no longer imports
 * `node:fs` (the DDL text moved to `src/schema/sources.ts`), so this module can
 * import the real constant and cannot disagree with it. `test/browser-portable.test.ts`
 * pins that the schema module stays importable here.
 */
export { SCHEMA_VERSION } from "../schema/index.js";
import { SCHEMA_VERSION } from "../schema/index.js";

/** `PRAGMA user_version`: 0 on a database this code has never touched. */
export function schemaVersion(db: SqliteHandle): number {
  return Number(db.pragma("user_version", { simple: true }) ?? 0);
}

/**
 * Create every table, index, trigger and view, then stamp the version. Applies
 * nothing when the database is already at `version`. Mirrors `applySchema` in
 * src/db/open.ts, including its refusal to half-migrate.
 */
export function applySchema(
  db: SqliteHandle,
  sources: readonly SchemaSource[],
  version: number = SCHEMA_VERSION,
): void {
  const current = schemaVersion(db);
  if (current === version) return;
  if (current !== 0) {
    throw new Error(
      `database is at schema version ${current}, this build ships ${version} ` +
        `and has no migration path`,
    );
  }
  db.transaction(() => {
    for (const source of sources) {
      try {
        db.exec(source.sql);
      } catch (cause) {
        throw new Error(`failed to apply ${source.name}: ${(cause as Error).message}`, { cause });
      }
    }
    db.exec(`PRAGMA user_version = ${Number(version)}`);
  })();
}

/** `PRAGMA integrity_check` plus `PRAGMA foreign_key_check`. Empty = healthy. */
export function checkIntegrity(db: SqliteHandle): readonly string[] {
  const problems: string[] = [];
  for (const row of db.pragma("integrity_check") as { integrity_check: string }[]) {
    if (row.integrity_check !== "ok") problems.push(row.integrity_check);
  }
  for (const row of db.prepare("PRAGMA foreign_key_check").all() as Record<string, unknown>[]) {
    problems.push(`foreign key violation: ${JSON.stringify(row)}`);
  }
  return problems;
}

// -- bootstrap: getting a prebuilt database into OPFS ------------------------

/**
 * Import a prebuilt `.db` into the pool under `filename`, replacing whatever is
 * there. Returns the byte count written.
 *
 * The bytes must be a *checkpointed* database file. A `-wal` sidecar is not
 * imported and cannot be: sahpool holds one file per name. `importDb` rewrites
 * the header to disable WAL, so a WAL-mode file opens — but any commit still
 * living only in the sidecar is gone, silently. Whatever produces the file must
 * checkpoint (or `VACUUM INTO`) first.
 */
export async function importDatabaseBrowser(
  filename: string,
  bytes: Uint8Array | ArrayBuffer,
  options: BrowserOpenOptions = {},
): Promise<number> {
  const pool = await installPool(options);
  return pool.importDb(normaliseFilename(filename), bytes);
}

/** Every database file currently in the pool. */
export async function databaseFilesInOpfs(options: BrowserOpenOptions = {}): Promise<string[]> {
  return (await installPool(options)).getFileNames();
}

/** Remove a database from the pool, freeing its slot. True if it existed. */
export async function deleteDatabaseBrowser(
  filename: string,
  options: BrowserOpenOptions = {},
): Promise<boolean> {
  const pool = await installPool(options);
  return pool.unlink(normaliseFilename(filename));
}

// -- the adapter ------------------------------------------------------------

class WasmDb implements BrowserDb {
  readonly #db: Database;
  readonly pool: SAHPoolUtil;
  #depth = 0;
  /**
   * Every statement this handle has handed out and that has not been finalized.
   *
   * It exists because `oo1.DB.close()` does NOT finalize them, despite looking
   * like it does. Upstream at 3.53.0-build1 (dist/index.mjs:10282) is
   *
   *   Object.keys(__stmtMap.get(this)).forEach((k, s) => { if (s && s.pointer) … })
   *
   * where `forEach`'s second argument is the ARRAY INDEX, so `s.pointer` is
   * always undefined and nothing is ever finalized. One statement left
   * unfinalized keeps the underlying sqlite3 handle open, which keeps the pool's
   * sync access handle open, which means `pauseVfs()` throws
   * `SQLITE_MISUSE: Cannot pause VFS opfs-sahpool because it has opened files`
   * and a long-lived worker leaks a pool slot per open/close cycle until it hits
   * SQLITE_CANTOPEN. Measured 2026-08-19 in real Chrome 151: with a prepared and
   * abandoned statement, `pauseVfs()` threw; with this set drained first, it did
   * not. better-sqlite3 needs none of this, which is why the leak is invisible
   * in Node and in the whole test suite.
   *
   * **As of 2026-08-23 this set no longer GROWS**, because `#cache` hands one
   * statement back per distinct SQL string. Measured in the running app, which is
   * the only place it is observable: **12.07 per graded card before, 0 after** —
   * flat at 16 open / 16 cached over 19 consecutive grades, with the per-grade
   * write time unchanged (p50 35.0 ms against 37.3). The old estimate of ~6 per
   * grade was half the real figure.
   */
  readonly #statements = new Set<WasmStatement>();

  /**
   * ONE STATEMENT PER DISTINCT SQL STRING — P2, and the fix is here rather than
   * in every caller.
   *
   * **Measured in the running app on 2026-08-23, which is the only place it is
   * observable: 12.07 statements per graded card**, not the ~6 this class used to
   * estimate. Thirty grades left 365 open; a 443-card day would leave about
   * **5,350**, each one pinning the OPFS file and so making `pauseVfs()` throw.
   *
   * The alternative was `try/finally { stmt.finalize() }` at every one of the
   * dozens of `db.prepare(...)` sites in `src/`, and it is the wrong alternative:
   * `SqliteHandle` is shared with better-sqlite3, where a statement needs no
   * finalizing at all, so the ceremony would exist to serve a platform half the
   * callers never run on. `SqliteBlobStore` already solved the same problem one
   * level up ("PREPARED ONCE, NOT PER CALL") — this generalises it.
   *
   * THREE THINGS MAKE REUSE SAFE, and each of them is a real hazard rather than a
   * hypothetical:
   *
   *   1. **`pluck()` / `raw()` are per-statement flags**, and 30 call sites in
   *      `src/` set them. A cached statement handed to a plucking caller and then
   *      to a non-plucking one would return the wrong SHAPE. So a cache hit
   *      resets both flags before handing the statement back.
   *   2. **`iterate()` holds a live cursor.** Re-preparing the same SQL while a
   *      generator is mid-flight would reset the statement under it. A busy
   *      statement is therefore never handed out — the caller gets a fresh,
   *      UNCACHED one, which it may leak, which is strictly better than a wrong
   *      answer. (`src/` calls `iterate()` zero times today; the contract allows
   *      it, so it is handled rather than assumed away.)
   *   3. **The cache is CAPPED.** SQL text is a fixed set in a program, but
   *      `src/scheduler/queue.ts` and `src/blobs/db.ts` build a few strings from
   *      fragments, and an unbounded cache would itself be the leak it replaces.
   *      At the cap the oldest entry is finalized and dropped.
   */
  readonly #cache = new StatementCache<WasmStatement>(STATEMENT_CACHE_LIMIT);

  constructor(db: Database, pool: SAHPoolUtil) {
    this.#db = db;
    this.pool = pool;
  }

  get wasm(): Database {
    return this.#db;
  }

  get name(): string {
    return this.#db.filename;
  }

  get open(): boolean {
    return this.#db.isOpen();
  }

  prepare(sql: string): BrowserStatement {
    return this.#cache.get(sql, () => {
      const statement = new WasmStatement(this.#db, this.#db.prepare(sql), this.#statements);
      this.#statements.add(statement);
      return statement;
    });
  }

  /** How many statements this handle is still holding open. Diagnostics only. */
  get openStatements(): number {
    return this.#statements.size;
  }

  /** Distinct SQL strings currently cached. Diagnostics only. */
  get cachedStatements(): number {
    return this.#cache.size;
  }

  exec(sql: string): this {
    this.#db.exec(sql);
    return this;
  }

  pragma(source: string, options?: { readonly simple?: boolean }): unknown {
    const rows = this.#db.exec({
      sql: `PRAGMA ${source}`,
      rowMode: "object",
      returnValue: "resultRows",
    });
    if (options?.simple !== true) return rows;
    const first = rows[0];
    if (first === undefined) return undefined;
    const values = Object.values(first);
    return values.length === 0 ? undefined : values[0];
  }

  /**
   * better-sqlite3's shape: returns a callable. Nesting uses savepoints, so an
   * inner transaction inside an outer one behaves as it does in Node.
   */
  transaction<R>(fn: () => R): () => R;
  transaction(fn: (...args: never[]) => unknown): (...params: never[]) => unknown;
  transaction(fn: (...args: never[]) => unknown): (...params: never[]) => unknown {
    return (...args: never[]): unknown => {
      const level = this.#depth;
      const savepoint = `hashigo_sp_${level}`;
      this.#db.exec(level === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
      this.#depth = level + 1;
      try {
        const result: unknown = fn(...args);
        this.#db.exec(level === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.#db.exec(
            level === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
          );
        } catch {
          // A failed rollback must not replace the error that caused it.
        }
        throw error;
      } finally {
        this.#depth = level;
      }
    };
  }

  function(name: string, fn: (...args: never[]) => unknown): this;
  function(
    name: string,
    options: { readonly deterministic?: boolean; readonly varargs?: boolean },
    fn: (...args: never[]) => unknown,
  ): this;
  function(name: string, second: unknown, third?: unknown): this {
    const fn = (typeof second === "function" ? second : third) as (...args: unknown[]) => unknown;
    const options = (typeof second === "function" ? {} : second) as {
      deterministic?: boolean;
      varargs?: boolean;
    };
    if (typeof fn !== "function") {
      throw new TypeError(`db.function(${name}): no implementation given`);
    }
    // sqlite-wasm hands the function a context pointer first; better-sqlite3
    // does not. Strip it, or every argument is off by one.
    this.#db.createFunction(name, (_ctx: number, ...values: SqlValue[]) => fn(...values) as SqlValue, {
      arity: options.varargs === true || fn.length === 0 ? -1 : fn.length,
      deterministic: options.deterministic === true,
    });
    return this;
  }

  /**
   * Finalize every statement, THEN close. See `#statements`: upstream's close
   * finalizes nothing, and an unfinalized statement pins the OPFS file.
   */
  close(): void {
    for (const statement of [...this.#statements]) {
      try {
        statement.finalize();
      } catch {
        // A statement that will not finalize must not stop the others, and must
        // not stop the close: leaking one handle beats leaking all of them.
      }
    }
    this.#statements.clear();
    this.#cache.clear();
    this.#db.close();
  }
}

/**
 * Distinct SQL strings `WasmDb` will hold statements for.
 *
 * Generous rather than tight: the whole of `src/` runs well under this, and the
 * point of the cap is only to stop a caller that builds SQL from unbounded input
 * turning the cache into the leak it exists to remove.
 */
export const STATEMENT_CACHE_LIMIT = 128;

/** The slice of a statement the cache touches. `WasmStatement` satisfies it. */
export interface CacheableStatement {
  /** True while an `iterate()` cursor is live over it. */
  readonly busy: boolean;
  pluck(toggle: boolean): unknown;
  raw(toggle: boolean): unknown;
  finalize(): void;
}

/**
 * One statement per distinct SQL string — P2's fix, extracted so that the part
 * that can be WRONG is testable without sqlite-wasm.
 *
 * The COUNT is easy to check in a browser and hard to get wrong. What is easy to
 * get wrong is `pluck()`/`raw()` surviving a cache hit, which returns the wrong
 * SHAPE with no error anywhere — and that logic needs no wasm, so it should not
 * be trapped behind it. `test/db-browser.test.ts` drives this class directly with
 * a recording stub.
 */
export class StatementCache<T extends CacheableStatement> {
  readonly #entries = new Map<string, T>();
  readonly #limit: number;

  constructor(limit: number = STATEMENT_CACHE_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`StatementCache limit must be a positive integer, got ${String(limit)}`);
    }
    this.#limit = limit;
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * The statement for `sql`, making one with `make` if there is none.
   *
   * A hit RESETS the shape flags, because they are per-statement and 30 call
   * sites in `src/` set them. A hit on a BUSY statement is not a hit: the caller
   * gets a fresh, uncached statement, which it may leak — strictly better than
   * resetting a live cursor under a generator and returning the wrong rows.
   */
  get(sql: string, make: () => T): T {
    const cached = this.#entries.get(sql);
    if (cached !== undefined && !cached.busy) {
      cached.pluck(false);
      cached.raw(false);
      return cached;
    }
    const made = make();
    // Only claim the key when it is free. A busy incumbent keeps its slot, so the
    // next caller after the cursor closes gets the cached one back rather than a
    // second permanent copy.
    if (cached === undefined) {
      this.#evictIfFull();
      this.#entries.set(sql, made);
    }
    return made;
  }

  /** Drop every entry WITHOUT finalizing: `WasmDb.close()` drains them itself. */
  clear(): void {
    this.#entries.clear();
  }

  #evictIfFull(): void {
    if (this.#entries.size < this.#limit) return;
    // Insertion order: the oldest distinct SQL goes. FINALIZED, not merely
    // forgotten — a dropped-but-open statement is the leak this class replaces.
    for (const [key, entry] of this.#entries) {
      if (entry.busy) continue;
      this.#entries.delete(key);
      entry.finalize();
      return;
    }
    // Every entry is busy, which cannot happen with synchronous callers. Leave
    // the cache over its limit rather than finalizing a live cursor.
  }
}

class WasmStatement implements BrowserStatement {
  readonly #db: Database;
  readonly #stmt: PreparedStatement;
  readonly #owner: Set<WasmStatement> | undefined;
  #pluck = false;
  #raw = false;
  /**
   * True while an `iterate()` generator is mid-flight over this statement.
   *
   * `WasmDb.prepare` refuses to hand out a busy statement, because re-preparing
   * the same SQL would `reset()` the cursor under a live generator and the caller
   * would silently see the wrong rows. Nothing in `src/` calls `iterate()` today;
   * the contract allows it, so this is handled rather than assumed away.
   */
  #busy = false;

  constructor(db: Database, stmt: PreparedStatement, owner?: Set<WasmStatement>) {
    this.#db = db;
    this.#stmt = stmt;
    this.#owner = owner;
  }

  get busy(): boolean {
    return this.#busy;
  }

  pluck(toggle = true): this {
    this.#pluck = toggle;
    return this;
  }

  raw(toggle = true): this {
    this.#raw = toggle;
    return this;
  }

  columns(): { readonly name: string }[] {
    return this.#stmt.getColumnNames().map((name) => ({ name }));
  }

  all(...params: readonly unknown[]): unknown[] {
    const stmt = this.#start(params);
    const rows: unknown[] = [];
    try {
      while (stmt.step()) rows.push(this.#shape(stmt));
    } finally {
      stmt.reset(true);
    }
    return rows;
  }

  get(...params: readonly unknown[]): unknown {
    const stmt = this.#start(params);
    try {
      return stmt.step() ? this.#shape(stmt) : undefined;
    } finally {
      stmt.reset(true);
    }
  }

  run(...params: readonly unknown[]): RunResult {
    const stmt = this.#start(params);
    try {
      while (stmt.step()) {
        // A statement passed to run() may still return rows; drain them.
      }
    } finally {
      stmt.reset(true);
    }
    const changes = Number(this.#db.changes());
    const rowid = Number(this.#db.selectValue("SELECT last_insert_rowid()") ?? 0);
    return { changes, lastInsertRowid: rowid };
  }

  *iterate(...params: readonly unknown[]): IterableIterator<unknown> {
    const stmt = this.#start(params);
    this.#busy = true;
    try {
      while (stmt.step()) yield this.#shape(stmt);
    } finally {
      // Both, and in this order: the cursor closes and only then does the
      // statement become reusable. A `return` out of a `for…of` runs this too.
      stmt.reset(true);
      this.#busy = false;
    }
  }

  /** Idempotent: it deregisters first, so `close()` after an explicit finalize
   * does not step on a freed pointer. */
  finalize(): void {
    this.#owner?.delete(this);
    this.#busy = false;
    this.#stmt.finalize();
  }

  #start(params: readonly unknown[]): PreparedStatement {
    const stmt = this.#stmt;
    stmt.reset(true);
    bindParameters(stmt, params);
    return stmt;
  }

  #shape(stmt: PreparedStatement): unknown {
    if (this.#pluck) return stmt.get(0);
    if (this.#raw) return stmt.get([]);
    return stmt.get({});
  }
}

/**
 * better-sqlite3 takes positional parameters as varargs and named ones as a
 * single object with bare keys; sqlite-wasm wants an array, or an object keyed by
 * the parameter *including* its `:`/`@`/`$` sigil. Bridge both, so a query
 * written for Node binds identically here.
 */
function bindParameters(stmt: PreparedStatement, params: readonly unknown[]): void {
  if (params.length === 0) return;
  const first = params[0];
  if (params.length === 1 && isNamedParameterObject(first)) {
    for (const [key, value] of Object.entries(first)) {
      stmt.bind(parameterIndex(stmt, key), bindable(value));
    }
    return;
  }
  stmt.bind(params.map(bindable) as unknown as BindingSpec);
}

function parameterIndex(stmt: PreparedStatement, key: string): number {
  const candidates = /^[:@$]/.test(key) ? [key] : [`:${key}`, `@${key}`, `$${key}`];
  for (const candidate of candidates) {
    const index = stmt.getParamIndex(candidate);
    if (index !== undefined && index > 0) return index;
  }
  throw new RangeError(
    `no bind parameter named ${JSON.stringify(key)} in this statement ` +
      `(tried ${candidates.join(", ")})`,
  );
}

function isNamedParameterObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function bindable(value: unknown): SqlValue {
  if (value === undefined) {
    throw new TypeError("cannot bind undefined; use null for SQL NULL, as better-sqlite3 does");
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SqlValue;
}

// -- environment checks -----------------------------------------------------

/** True in a Worker — the only place a sync access handle is allowed. */
export function inDedicatedWorker(): boolean {
  const scope = globalThis as { DedicatedWorkerGlobalScope?: unknown; WorkerGlobalScope?: unknown };
  return (
    typeof scope.DedicatedWorkerGlobalScope !== "undefined" ||
    typeof scope.WorkerGlobalScope !== "undefined"
  );
}

function assertUsable(options: BrowserOpenOptions): void {
  const scope = globalThis as { isSecureContext?: boolean; navigator?: { storage?: unknown } };
  if (scope.isSecureContext !== true) {
    throw new Error(
      "OPFS requires a secure context. Serve over https:// or http://localhost — no " +
        "COOP/COEP headers are needed, but a plain http:// LAN address will not do.",
    );
  }
  if (scope.navigator?.storage === undefined) {
    throw new Error("navigator.storage is unavailable; this build cannot use OPFS.");
  }
  if (!inDedicatedWorker() && options.allowMainThread !== true) {
    throw new Error(
      "openDatabaseBrowser must run inside a dedicated Worker: opfs-sahpool is built on " +
        "createSyncAccessHandle(), which the platform does not allow on the main thread. " +
        "Move the database into a worker and message it. (allowMainThread is for " +
        "measurement only.)",
    );
  }
}

/** sahpool file names are absolute paths inside the pool, not OPFS paths. */
function normaliseFilename(filename: string): string {
  const trimmed = filename.trim();
  if (trimmed === "") throw new Error("database filename must not be empty");
  if (trimmed === ":memory:" || trimmed.startsWith("file:")) {
    throw new Error(
      `${JSON.stringify(filename)} is not a pool file name. This adapter is for persistent ` +
        `OPFS databases; use sqlite3.oo1.DB(":memory:") directly for a scratch one.`,
    );
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
