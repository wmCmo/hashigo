import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import { SCHEMA_VERSION } from "../schema/index.js";
import { SCHEMA_SOURCES } from "../schema/sources.js";

export type Db = Database.Database;

export const MEMORY = ":memory:";

export interface OpenOptions {
  readonly readOnly?: boolean;
  readonly applySchema?: boolean;
  readonly verbose?: (message?: unknown, ...rest: unknown[]) => void;
}

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

export function schemaVersion(db: Db): number {
  return pragmaNumber(db, "user_version");
}

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
