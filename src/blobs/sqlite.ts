import type { SqliteHandle, SqliteStatement } from "../db/browser.js";

import { assertAddress } from "./address.js";
import { sha256Hex } from "./sha256.js";
import { BlobConflictError, BlobMissingError, type BlobStore, type BlobWriteResult } from "./store.js";

export const SQLITE_STORE_FORMAT = "hashigo/blob-store/sqlite/1";

export const SQLITE_STORE_VERSION = 1;

export const STORE_PAGE_SIZE = 8192;

export const BATCH_FLUSH_BYTES = 64 * 1024 * 1024;

export type Digest = (bytes: Uint8Array) => string;

export interface SqliteStoreOptions {
  readonly digest?: Digest;
  readonly create?: boolean;
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
  readonly fileBytes: number;
}

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

export class SqliteBlobStore implements BlobStore {
  readonly describe: string;
  readonly #db: SqliteHandle;
  readonly #digest: Digest;
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

    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA temp_store = memory");
  }

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

  *list(): IterableIterator<string> {
    const hashes = this.#stmt(SQL.list).pluck().all() as string[];
    for (const hash of hashes) yield hash;
  }

  verify(hash: string): boolean {
    assertAddress(hash);
    const bytes = this.#stmt(SQL.read).pluck().get(hash);
    return bytes instanceof Uint8Array && this.#digest(bytes) === hash;
  }

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
      }
      throw error;
    } finally {
      this.#depth = 0;
      this.#pending = 0;
    }
  }

  get batchFlushes(): number {
    return this.#flushes;
  }

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

  reclaim(pages = 0): number {
    const before = this.#pragmaNumber("freelist_count");
    if (before === 0) return 0;
    const budget = pages > 0 ? Math.min(pages, before) : before;

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

  vacuum(): void {
    this.#db.exec("VACUUM");
  }

  checkIntegrity(): readonly string[] {
    const rows = this.#db.pragma("integrity_check") as { integrity_check: string }[];
    return rows.map((row) => row.integrity_check).filter((text) => text !== "ok");
  }

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
    this.#db.exec(`PRAGMA page_size = ${STORE_PAGE_SIZE}`);
    this.#db.exec(`PRAGMA auto_vacuum = ${autoVacuum}`);
    this.#db.transaction(() => {
      this.#db.exec(DDL);
      const meta = this.#db.prepare("INSERT INTO blob_store_meta (key, value) VALUES (?, ?)");
      meta.run("format", SQLITE_STORE_FORMAT);
      meta.run("layout", "blob_payloads(hash, byte_size, bytes)");
      meta.run("created", new Date().toISOString());
      this.#db.exec(`PRAGMA user_version = ${SQLITE_STORE_VERSION}`);
    })();
  }

  #hasPayloadTable(): boolean {
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

export function openSqliteBlobStore(
  db: SqliteHandle,
  options: SqliteStoreOptions = {},
): SqliteBlobStore {
  return new SqliteBlobStore(db, options);
}
