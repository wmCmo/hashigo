import type {
  BindingSpec,
  Database,
  PreparedStatement,
  SAHPoolUtil,
  SqlValue,
  Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";

export const DEFAULT_DATABASE = "/hashigo.db";

export const POOL_INITIAL_CAPACITY = 12;

export interface SchemaSource {
  readonly name: string;
  readonly sql: string;
}

export interface BrowserOpenOptions {
  readonly filename?: string;
  readonly readOnly?: boolean;
  readonly schema?: readonly SchemaSource[];
  readonly schemaVersion?: number;
  readonly applySchema?: boolean;
  readonly initialCapacity?: number;
  readonly vfsName?: string;
  readonly directory?: string;
  readonly allowMainThread?: boolean;
}

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  all(...params: readonly unknown[]): unknown[];
  get(...params: readonly unknown[]): unknown;
  run(...params: readonly unknown[]): RunResult;
  iterate(...params: readonly unknown[]): IterableIterator<unknown>;
  pluck(toggle?: boolean): this;
  raw(toggle?: boolean): this;
  columns(): { readonly name: string }[];
}

export interface BrowserStatement extends SqliteStatement {
  finalize(): void;
}

export interface SqliteHandle {
  readonly name: string;
  readonly open: boolean;
  prepare(sql: string): SqliteStatement;
  exec(sql: string): this;
  pragma(source: string, options?: { readonly simple?: boolean }): unknown;
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

export interface BrowserDb extends SqliteHandle {
  prepare(sql: string): BrowserStatement;
  readonly pool: SAHPoolUtil;
  readonly wasm: Database;
  readonly cachedStatements: number;
  readonly openStatements: number;
}

let sqlite3Promise: Promise<Sqlite3Static> | undefined;
let poolPromise: Promise<SAHPoolUtil> | undefined;
let poolKey = "";

export async function sqlite3(): Promise<Sqlite3Static> {
  sqlite3Promise ??= import("@sqlite.org/sqlite-wasm").then((module) => module.default());
  return sqlite3Promise;
}

export async function sqliteVersion(): Promise<string> {
  return (await sqlite3()).version.libVersion;
}

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
    const pool = await api.installOpfsSAHPoolVfs({
      initialCapacity: capacity,
      forceReinitIfPreviouslyFailed: true,
      ...(options.vfsName === undefined ? {} : { name: options.vfsName }),
      ...(options.directory === undefined ? {} : { directory: options.directory }),
    } as Parameters<typeof api.installOpfsSAHPoolVfs>[0]);
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

export async function openDatabaseBrowser(options: BrowserOpenOptions = {}): Promise<BrowserDb> {
  const filename = normaliseFilename(options.filename ?? DEFAULT_DATABASE);
  const readOnly = options.readOnly === true;
  const pool = await installPool(options);
  const api = await sqlite3();

  const wasm = new api.oo1.DB(filename, readOnly ? "r" : "c", pool.vfsName);
  const db = new WasmDb(wasm, pool);

  db.exec("PRAGMA foreign_keys = ON");
  if (Number(db.pragma("foreign_keys", { simple: true })) !== 1) {
    db.close();
    throw new Error("could not enable foreign keys; this schema requires them");
  }
  if (!readOnly) {
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

export { SCHEMA_VERSION } from "../schema/index.js";
import { SCHEMA_VERSION } from "../schema/index.js";

export function schemaVersion(db: SqliteHandle): number {
  return Number(db.pragma("user_version", { simple: true }) ?? 0);
}

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

export async function importDatabaseBrowser(
  filename: string,
  bytes: Uint8Array | ArrayBuffer,
  options: BrowserOpenOptions = {},
): Promise<number> {
  const pool = await installPool(options);
  return pool.importDb(normaliseFilename(filename), bytes);
}

export async function databaseFilesInOpfs(options: BrowserOpenOptions = {}): Promise<string[]> {
  return (await installPool(options)).getFileNames();
}

export async function deleteDatabaseBrowser(
  filename: string,
  options: BrowserOpenOptions = {},
): Promise<boolean> {
  const pool = await installPool(options);
  return pool.unlink(normaliseFilename(filename));
}

class WasmDb implements BrowserDb {
  readonly #db: Database;
  readonly pool: SAHPoolUtil;
  #depth = 0;
  readonly #statements = new Set<WasmStatement>();

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

  get openStatements(): number {
    return this.#statements.size;
  }

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
    this.#db.createFunction(name, (_ctx: number, ...values: SqlValue[]) => fn(...values) as SqlValue, {
      arity: options.varargs === true || fn.length === 0 ? -1 : fn.length,
      deterministic: options.deterministic === true,
    });
    return this;
  }

  close(): void {
    for (const statement of [...this.#statements]) {
      try {
        statement.finalize();
      } catch {
      }
    }
    this.#statements.clear();
    this.#cache.clear();
    this.#db.close();
  }
}

export const STATEMENT_CACHE_LIMIT = 128;

export interface CacheableStatement {
  readonly busy: boolean;
  pluck(toggle: boolean): unknown;
  raw(toggle: boolean): unknown;
  finalize(): void;
}

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

  get(sql: string, make: () => T): T {
    const cached = this.#entries.get(sql);
    if (cached !== undefined && !cached.busy) {
      cached.pluck(false);
      cached.raw(false);
      return cached;
    }
    const made = make();
    if (cached === undefined) {
      this.#evictIfFull();
      this.#entries.set(sql, made);
    }
    return made;
  }

  clear(): void {
    this.#entries.clear();
  }

  #evictIfFull(): void {
    if (this.#entries.size < this.#limit) return;
    for (const [key, entry] of this.#entries) {
      if (entry.busy) continue;
      this.#entries.delete(key);
      entry.finalize();
      return;
    }
  }
}

class WasmStatement implements BrowserStatement {
  readonly #db: Database;
  readonly #stmt: PreparedStatement;
  readonly #owner: Set<WasmStatement> | undefined;
  #pluck = false;
  #raw = false;
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
      stmt.reset(true);
      this.#busy = false;
    }
  }

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
