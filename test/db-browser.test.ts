import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION as BROWSER_SCHEMA_VERSION,
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
