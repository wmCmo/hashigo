import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION as BROWSER_SCHEMA_VERSION,
  STATEMENT_CACHE_LIMIT,
  StatementCache,
  applySchema as applySchemaBrowser,
  checkIntegrity as checkIntegrityBrowser,
  schemaVersion as schemaVersionBrowser,
  type SqliteHandle,
} from "../src/db/browser.js";
import { MEMORY, openDatabase } from "../src/db/index.js";
import { SCHEMA_VERSION } from "../src/schema/index.js";
import { SCHEMA_SOURCES } from "../src/schema/sources.js";

function handle(): { db: SqliteHandle; close: () => void } {
  const db = openDatabase(MEMORY, { applySchema: false });
  return { db: db as unknown as SqliteHandle, close: () => db.close() };
}

describe("the browser database port, over a Node handle", () => {
  it("ships ONE schema version, not a copy that can drift", () => {
    expect(BROWSER_SCHEMA_VERSION).toBe(SCHEMA_VERSION);

    const source = readFileSync(
      new URL("../src/db/browser.ts", import.meta.url),
      "utf8",
    );
    expect(source, "browser.ts must not declare its own SCHEMA_VERSION value").not.toMatch(
      /^\s*export const SCHEMA_VERSION\s*=\s*\d/m,
    );
    expect(source).toMatch(/export \{ SCHEMA_VERSION \} from "\.\.\/schema\/index\.js"/);
  });

  it("stamps user_version and reports it back", () => {
    const { db, close } = handle();
    try {
      expect(schemaVersionBrowser(db)).toBe(0);
      applySchemaBrowser(db, SCHEMA_SOURCES);
      expect(schemaVersionBrowser(db)).toBe(SCHEMA_VERSION);
    } finally {
      close();
    }
  });

  it("is idempotent at the shipped version, and does no work", () => {
    const { db, close } = handle();
    try {
      applySchemaBrowser(db, SCHEMA_SOURCES);
      expect(() => applySchemaBrowser(db, SCHEMA_SOURCES)).not.toThrow();
      expect(schemaVersionBrowser(db)).toBe(SCHEMA_VERSION);
    } finally {
      close();
    }
  });

  it("REFUSES a database at any other version rather than half-migrating", () => {
    const { db, close } = handle();
    try {
      applySchemaBrowser(db, SCHEMA_SOURCES, 3);
      expect(schemaVersionBrowser(db)).toBe(3);
      expect(() => applySchemaBrowser(db, SCHEMA_SOURCES, SCHEMA_VERSION)).toThrow(
        /schema version 3, this build ships/,
      );
      expect(schemaVersionBrowser(db)).toBe(3);
    } finally {
      close();
    }
  });

  it("rolls back the whole DDL when one source fails, leaving version 0", () => {
    const { db, close } = handle();
    try {
      expect(() =>
        applySchemaBrowser(db, [
          ...SCHEMA_SOURCES,
          { name: "broken.sql", sql: "CREATE TABLE ;" },
        ]),
      ).toThrow(/failed to apply broken\.sql/);
      expect(schemaVersionBrowser(db)).toBe(0);
      const tables = db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
        .get() as { n: number };
      expect(tables.n).toBe(0);
    } finally {
      close();
    }
  });

  it("names the file that failed, not just the SQL error", () => {
    const { db, close } = handle();
    try {
      expect(() =>
        applySchemaBrowser(db, [
          { name: "first.sql", sql: "CREATE TABLE ok (id TEXT);" },
          { name: "second.sql", sql: "SELECT nonexistent_function();" },
        ]),
      ).toThrow(/failed to apply second\.sql/);
    } finally {
      close();
    }
  });

  it("reports a healthy database as having no problems", () => {
    const { db, close } = handle();
    try {
      applySchemaBrowser(db, SCHEMA_SOURCES);
      expect(checkIntegrityBrowser(db)).toEqual([]);
    } finally {
      close();
    }
  });

  it("catches a foreign-key violation, which integrity_check alone does not", () => {
    const { db, close } = handle();
    try {
      applySchemaBrowser(db, SCHEMA_SOURCES);
      db.pragma("foreign_keys = OFF");
      db.prepare(
        "INSERT INTO cards (id, deck_id, name) VALUES ('orphan', 'no-such-deck', 'x')",
      ).run();
      const problems = checkIntegrityBrowser(db);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.some((p) => p.startsWith("foreign key violation"))).toBe(true);
      expect(problems.join(" ")).toContain("cards");
    } finally {
      close();
    }
  });

  it("applies the same DDL the Node path applies, to the same version", () => {
    const browser = handle();
    const node = openDatabase(MEMORY);
    try {
      applySchemaBrowser(browser.db, SCHEMA_SOURCES);
      const names = (db: { prepare: (sql: string) => { all: () => unknown[] } }) =>
        (
          db
            .prepare(
              "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
            )
            .all() as { type: string; name: string }[]
        ).map((r) => `${r.type}:${r.name}`);
      expect(names(browser.db)).toEqual(names(node));
      expect(schemaVersionBrowser(browser.db)).toBe(SCHEMA_VERSION);
    } finally {
      browser.close();
      node.close();
    }
  });
});

describe("StatementCache — P2", () => {
  interface Stub {
    readonly sql: string;
    busy: boolean;
    plucked: boolean;
    rawed: boolean;
    finalized: number;
    pluck(toggle: boolean): unknown;
    raw(toggle: boolean): unknown;
    finalize(): void;
  }

  const made: Stub[] = [];

  function stub(sql: string): Stub {
    const entry: Stub = {
      sql,
      busy: false,
      plucked: false,
      rawed: false,
      finalized: 0,
      pluck(toggle) {
        entry.plucked = toggle;
        return entry;
      },
      raw(toggle) {
        entry.rawed = toggle;
        return entry;
      },
      finalize() {
        entry.finalized += 1;
      },
    };
    made.push(entry);
    return entry;
  }

  it("hands the SAME statement back for the same SQL", () => {
    made.length = 0;
    const cache = new StatementCache<Stub>();
    const a = cache.get("SELECT 1", () => stub("SELECT 1"));
    const b = cache.get("SELECT 1", () => stub("SELECT 1"));
    const c = cache.get("SELECT 2", () => stub("SELECT 2"));
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(made).toHaveLength(2);
    expect(cache.size).toBe(2);
  });

  it("RESETS pluck and raw on a hit — the hazard that returns a wrong shape", () => {
    made.length = 0;
    const cache = new StatementCache<Stub>();
    const first = cache.get("SELECT hash FROM blobs", () => stub("q"));
    first.pluck(true);
    first.raw(true);
    expect(first.plucked).toBe(true);

    const second = cache.get("SELECT hash FROM blobs", () => stub("q"));
    expect(second).toBe(first);
    expect(second.plucked, "pluck survived a cache hit").toBe(false);
    expect(second.rawed, "raw survived a cache hit").toBe(false);
  });

  it("never hands out a BUSY statement, and does not displace it either", () => {
    made.length = 0;
    const cache = new StatementCache<Stub>();
    const held = cache.get("SELECT * FROM cards", () => stub("held"));
    held.busy = true;

    const fresh = cache.get("SELECT * FROM cards", () => stub("fresh"));
    expect(fresh).not.toBe(held);
    expect(made).toHaveLength(2);
    expect(cache.size).toBe(1);
    held.busy = false;
    expect(cache.get("SELECT * FROM cards", () => stub("third"))).toBe(held);
    expect(made).toHaveLength(2);
  });

  it("at the cap it FINALIZES what it evicts, rather than forgetting it", () => {
    made.length = 0;
    const cache = new StatementCache<Stub>(3);
    for (const sql of ["a", "b", "c"]) cache.get(sql, () => stub(sql));
    expect(cache.size).toBe(3);
    cache.get("d", () => stub("d"));
    expect(cache.size).toBe(3);
    const first = made[0]!;
    expect(first.sql).toBe("a");
    expect(first.finalized, "the evicted statement was not finalized").toBe(1);
    cache.get("a", () => stub("a2"));
    expect(made.at(-1)?.sql).toBe("a2");
  });

  it("will not evict a busy statement — it goes over the cap instead", () => {
    made.length = 0;
    const cache = new StatementCache<Stub>(2);
    const busy = cache.get("a", () => stub("a"));
    busy.busy = true;
    cache.get("b", () => stub("b"));
    cache.get("c", () => stub("c"));
    expect(busy.finalized).toBe(0);
    expect(made.find((entry) => entry.sql === "b")?.finalized).toBe(1);
  });

  it("defaults to the limit the source declares, and it is generous", () => {
    expect(STATEMENT_CACHE_LIMIT).toBe(128);
    made.length = 0;
    const cache = new StatementCache<Stub>();
    for (let i = 0; i < STATEMENT_CACHE_LIMIT; i += 1) {
      cache.get(`SELECT ${i}`, () => stub(String(i)));
    }
    expect(cache.size).toBe(STATEMENT_CACHE_LIMIT);
    expect(made.filter((entry) => entry.finalized > 0)).toEqual([]);
    cache.get("one more", () => stub("one more"));
    expect(cache.size).toBe(STATEMENT_CACHE_LIMIT);
    expect(made.filter((entry) => entry.finalized > 0)).toHaveLength(1);
  });

  it("refuses a nonsense limit rather than behaving oddly at one", () => {
    expect(() => new StatementCache(0)).toThrow(/positive integer/);
    expect(() => new StatementCache(-1)).toThrow(/positive integer/);
    expect(() => new StatementCache(1.5)).toThrow(/positive integer/);
  });

  it("clear() does NOT finalize — WasmDb.close() drains the set itself", () => {
    made.length = 0;
    const cache = new StatementCache<Stub>();
    const one = cache.get("a", () => stub("a"));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(one.finalized).toBe(0);
  });
});
