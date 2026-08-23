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

/**
 * `src/db/browser.ts` IS 733 LINES WITH NO AUTOMATED COVERAGE — the largest
 * unmeasured surface on the critical path, and nothing in the suite imported it.
 * An audit flagged it; this closes the half that can be closed here.
 *
 * WHAT THIS CAN AND CANNOT TEST, said plainly rather than implied.
 *
 * The async half — `installPool`, `openDatabaseBrowser`, `importDatabaseBrowser`,
 * `databaseFilesInOpfs`, `deleteDatabaseBrowser` — needs sqlite-wasm and OPFS,
 * which exist in a browser and not in vitest. Those stay exercised only by
 * `spike/persist` on the real device, and that gap is real.
 *
 * The SYNCHRONOUS half is a different matter, and it is the dangerous half: it is
 * the code that stamps `user_version` and refuses to half-migrate. It is written
 * against the `SqliteHandle` INTERFACE rather than against sqlite-wasm, and
 * better-sqlite3's handle satisfies that interface — which is the entire point of
 * the port existing. So it can be tested here, over the real DDL, and the two
 * implementations of `applySchema` (this one and `src/db/open.ts`'s) can be held
 * to the same behaviour instead of merely claiming to "mirror" each other.
 *
 * The bug this would have caught, and did not, because nothing called it:
 * `browser.ts` hardcoded `SCHEMA_VERSION = 2` against a real 7 for five schema
 * versions. It would have stamped `user_version = 2` on a v7 schema and then
 * refused to open its own database. The first test below is that assertion.
 */

/** better-sqlite3's Database, viewed through the browser port's interface. */
function handle(): { db: SqliteHandle; close: () => void } {
  const db = openDatabase(MEMORY, { applySchema: false });
  return { db: db as unknown as SqliteHandle, close: () => db.close() };
}

describe("the browser database port, over a Node handle", () => {
  it("ships ONE schema version, not a copy that can drift", () => {
    expect(BROWSER_SCHEMA_VERSION).toBe(SCHEMA_VERSION);

    // Equality is not enough, and this is the interesting half. Two literals that
    // happen to agree today pass the line above — that is precisely the state this
    // module was in for five schema versions, `2` against a real `7`, with a
    // comment claiming a build would catch it. So assert the SOURCE declares no
    // literal: the only permitted form is the re-export, which cannot disagree.
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
      // A second call must not re-exec the DDL: `CREATE TABLE` without IF NOT
      // EXISTS would throw, so a passing second call IS the proof it returned
      // early rather than the proof that re-running is harmless.
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
      // This is the behaviour that made the hardcoded `2` a real bug rather than
      // a cosmetic one: a mismatch is fatal, so a wrong constant bricks the file.
      expect(() => applySchemaBrowser(db, SCHEMA_SOURCES, SCHEMA_VERSION)).toThrow(
        /schema version 3, this build ships/,
      );
      // And it did not partially apply anything on the way out.
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
      // The transaction is what makes "no migration path" safe: a failed apply
      // must leave a database that still reports 0, not one with half a schema
      // and no version stamp.
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
      // Two sources, the SECOND broken: the message must identify which one, or
      // a failed apply over `schema.sql` + `views.sql` says nothing useful.
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
      // `checkIntegrity` runs integrity_check AND foreign_key_check, and only the
      // second sees this. Inserted with enforcement off, which is exactly how a
      // synced or imported file can arrive.
      db.pragma("foreign_keys = OFF");
      db.prepare(
        "INSERT INTO cards (id, deck_id, name) VALUES ('orphan', 'no-such-deck', 'x')",
      ).run();
      const problems = checkIntegrityBrowser(db);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.some((p) => p.startsWith("foreign key violation"))).toBe(true);
      // And it says WHICH row, so the report is actionable rather than a boolean.
      expect(problems.join(" ")).toContain("cards");
    } finally {
      close();
    }
  });

  it("applies the same DDL the Node path applies, to the same version", () => {
    // The two `applySchema` implementations claim to mirror each other. Held to
    // it: same sources, same resulting table set, same stamp. A divergence here
    // means a browser database and a Node database are not the same file format,
    // which stage 11 would discover the hard way.
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

// ─── P2: the statement cache ─────────────────────────────────────────────────

/**
 * The COUNT is easy to check in a browser and hard to get wrong. What is easy to
 * get wrong is `pluck()`/`raw()` state surviving a cache hit — which returns the
 * wrong SHAPE with no error anywhere — and a live `iterate()` cursor being reset
 * under a generator. Neither needs sqlite-wasm, so neither is tested only there.
 *
 * MEASURED FIRST, in the running app, because that is the only place `WasmDb` is
 * observable: **12.07 statements per graded card**, not the ~6 `src/db/browser.ts`
 * used to estimate. 30 grades left 365 open; a 443-card day would leave ~5,350,
 * each one pinning the OPFS file so that `pauseVfs()` throws.
 */
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
    // The point: two calls, ONE statement. That is the whole of P2.
    expect(made).toHaveLength(2);
    expect(cache.size).toBe(2);
  });

  it("RESETS pluck and raw on a hit — the hazard that returns a wrong shape", () => {
    // 30 call sites in `src/` set these. A statement handed to a plucking caller
    // and then to a non-plucking one would silently return scalars where the
    // caller expects rows, and nothing would raise.
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
    // A live `iterate()` cursor. Re-preparing the same SQL would reset it under
    // the generator, so the caller gets a fresh uncached statement — which it may
    // leak, and that is strictly better than the wrong rows.
    made.length = 0;
    const cache = new StatementCache<Stub>();
    const held = cache.get("SELECT * FROM cards", () => stub("held"));
    held.busy = true;

    const fresh = cache.get("SELECT * FROM cards", () => stub("fresh"));
    expect(fresh).not.toBe(held);
    expect(made).toHaveLength(2);
    // The incumbent KEEPS its slot, so once the cursor closes the next caller
    // gets it back rather than a second permanent copy accumulating.
    expect(cache.size).toBe(1);
    held.busy = false;
    expect(cache.get("SELECT * FROM cards", () => stub("third"))).toBe(held);
    expect(made).toHaveLength(2);
  });

  it("at the cap it FINALIZES what it evicts, rather than forgetting it", () => {
    // A dropped-but-open statement is exactly the leak this class replaces, so
    // eviction has to close the file handle and not merely lose the reference.
    made.length = 0;
    const cache = new StatementCache<Stub>(3);
    for (const sql of ["a", "b", "c"]) cache.get(sql, () => stub(sql));
    expect(cache.size).toBe(3);
    cache.get("d", () => stub("d"));
    expect(cache.size).toBe(3);
    const first = made[0]!;
    expect(first.sql).toBe("a");
    expect(first.finalized, "the evicted statement was not finalized").toBe(1);
    // And it really is gone: asking for it again builds a new one.
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
    // `b` went, `a` stayed, and nothing finalized a live cursor.
    expect(busy.finalized).toBe(0);
    expect(made.find((entry) => entry.sql === "b")?.finalized).toBe(1);
  });

  it("defaults to the limit the source declares, and it is generous", () => {
    // Generous rather than tight on purpose: the whole of `src/` runs well under
    // it, and the cap exists only so a caller building SQL from unbounded input
    // cannot turn the cache into the leak it removes.
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
    // Two owners of the same statements would double-finalize, which steps on a
    // freed pointer. The cache is an index; the Set is the owner.
    made.length = 0;
    const cache = new StatementCache<Stub>();
    const one = cache.get("a", () => stub("a"));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(one.finalized).toBe(0);
  });
});
