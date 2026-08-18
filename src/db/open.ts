/**
 * Stage 1 — opening a Hashigo database.
 *
 * One entry point, `openDatabase`, which applies the schema, turns foreign keys
 * on and puts the journal in WAL. All three matter:
 *
 *   * foreign keys are OFF by default in SQLite, and this schema leans on them
 *     hard — the tag tree's every-prefix-exists guarantee and the "a referenced
 *     blob cannot be deleted" guarantee are both foreign keys.
 *   * WAL keeps a long import from blocking readers, and is the mode the
 *     OPFS build will use too.
 *   * the schema is applied inside a transaction, so a half-created database is
 *     not a state this code can produce.
 *
 * Node only (better-sqlite3): the importer, the backtest and the tests. The
 * browser/OPFS half of src/db is a later stage and is not attempted here.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import { SCHEMA_SOURCES, SCHEMA_VERSION } from "../schema/index.js";

export type Db = Database.Database;

/** In-memory database name, for tests and dry runs. */
export const MEMORY = ":memory:";

export interface OpenOptions {
  /** Open read-only. Implies no schema application. */
  readonly readOnly?: boolean;
  /** Apply the schema to a fresh database. Default true. */
  readonly applySchema?: boolean;
  /** Statement logger, passed straight to better-sqlite3. */
  readonly verbose?: (message?: unknown, ...rest: unknown[]) => void;
}

/**
 * Open (creating if needed) a Hashigo database at `file`, or in memory.
 *
 * Idempotent: opening an already-populated database applies nothing and returns
 * it with the same pragmas set.
 */
export function openDatabase(file: string = MEMORY, options: OpenOptions = {}): Db {
  const readOnly = options.readOnly === true;
  const inMemory = file === MEMORY || file === "" || file.startsWith("file::memory:");

  if (!readOnly && !inMemory) {
    mkdirSync(dirname(resolve(file)), { recursive: true });
  }

  const db = new Database(file, {
    readonly: readOnly,
    ...(options.verbose ? { verbose: options.verbose } : {}),
  });

  // WAL is unavailable in memory (the pragma reports "memory" there, which is
  // correct and not an error) and is a no-op on a read-only handle.
  if (!readOnly && !inMemory) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  if (pragmaNumber(db, "foreign_keys") !== 1) {
    db.close();
    throw new Error("could not enable foreign keys; this schema requires them");
  }

  if (!readOnly && options.applySchema !== false) {
    applySchema(db);
  }

  return db;
}

/** `PRAGMA user_version`: 0 on a database this code has never touched. */
export function schemaVersion(db: Db): number {
  return pragmaNumber(db, "user_version");
}

/**
 * Create every table, index, trigger and view, then stamp the version. Applies
 * nothing when the database is already at `SCHEMA_VERSION`.
 *
 * Stage 1 ships version 1, so there is no migration path yet — an intermediate
 * version can only mean a database written by code newer or stranger than this,
 * and refusing is better than half-migrating 102,020 reviews.
 */
export function applySchema(db: Db): void {
  const current = schemaVersion(db);
  if (current === SCHEMA_VERSION) return;
  if (current !== 0) {
    throw new Error(
      `database is at schema version ${current}, this build ships ${SCHEMA_VERSION} ` +
        `and has no migration path`,
    );
  }

  db.transaction(() => {
    for (const source of SCHEMA_SOURCES) {
      try {
        db.exec(source.sql);
      } catch (cause) {
        throw new Error(`failed to apply ${source.name}: ${(cause as Error).message}`, { cause });
      }
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

/** `PRAGMA integrity_check` plus `PRAGMA foreign_key_check`. Empty = healthy. */
export function checkIntegrity(db: Db): readonly string[] {
  const problems: string[] = [];
  const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
  for (const row of integrity) {
    if (row.integrity_check !== "ok") problems.push(row.integrity_check);
  }
  const orphans = db.prepare("PRAGMA foreign_key_check").all() as Record<string, unknown>[];
  for (const row of orphans) {
    problems.push(`foreign key violation: ${JSON.stringify(row)}`);
  }
  return problems;
}

function pragmaNumber(db: Db, name: string): number {
  const value = db.pragma(name, { simple: true });
  return typeof value === "number" ? value : Number(value);
}
