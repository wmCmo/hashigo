import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scopeToSubtree, type ScopedDb } from "../app/deck-scope.js";
import { suggestCards } from "../app/recent.js";
import { readingOverride } from "../app/reading-override.js";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = join(ROOT, "build/hashigo.db");
const haveCorpus = existsSync(SOURCE);

let dir = "";
let db: Database.Database;

beforeAll(() => {
  if (!haveCorpus) return;
  dir = mkdtempSync(join(tmpdir(), "hashigo-recent-"));
  const copy = join(dir, "corpus.db");
  copyFileSync(SOURCE, copy);
  db = new Database(copy);
});

afterAll(() => {
  db?.close();
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

function scoped(): ScopedDb {
  return db as unknown as ScopedDb;
}

function whole(visited: readonly string[], limit = 40): ReturnType<typeof suggestCards> {
  const { sql, args } = scopeToSubtree(scoped(), null);
  return suggestCards(scoped(), { scopeSql: sql, scopeArgs: args, visited, limit });
}

describe.skipIf(!haveCorpus)("the measurements this ranking rests on", () => {
  it("shows why the alphabet was the wrong default: the top of it is opaque ids", () => {
    const names = (
      db.prepare("SELECT name FROM cards ORDER BY name LIMIT 10").all() as { name: string }[]
    ).map((row) => row.name);
    const numeric = names.filter((name) => /^\d+$/.test(name));
    expect(numeric.length).toBe(8);
  });

  it("shows why `last_reviewed_at` cannot order this: every import is time_unknown", () => {
    const unknown = db
      .prepare("SELECT count(*) AS n FROM reviews WHERE time_unknown = 0")
      .get() as { n: number };
    expect(unknown.n).toBe(0);

    const distinct = db
      .prepare("SELECT count(DISTINCT last_reviewed_at) AS n FROM card_tracks")
      .get() as { n: number };
    expect(distinct.n).toBeLessThan(400);

    const top = db
      .prepare(
        `SELECT count(*) AS n FROM card_tracks
          WHERE last_reviewed_at = (SELECT max(last_reviewed_at) FROM card_tracks)`,
      )
      .get() as { n: number };
    expect(top.n).toBeGreaterThan(1);
  });

  it("shows why `updated_at` is usable: real timestamps, and they survived the import", () => {
    const days = db
      .prepare("SELECT count(DISTINCT date(updated_at)) AS n FROM cards")
      .get() as { n: number };
    expect(days.n).toBeGreaterThan(500);

    const midnight = db
      .prepare("SELECT count(*) AS n FROM cards WHERE updated_at LIKE '%T00:00:00%'")
      .get() as { n: number };
    expect(midnight.n).toBeLessThan(100);
  });
});

describe.skipIf(!haveCorpus)("suggestCards over the real corpus", () => {
  it("falls back to recently edited when nothing has been opened on this device", () => {
    const rows = whole([]);
    expect(rows.length).toBe(40);

    const stamps = (
      db
        .prepare(
          `SELECT updated_at AS at FROM cards WHERE id IN (${rows.map(() => "?").join(", ")})`,
        )
        .all(...rows.map((row) => row.id)) as { at: string }[]
    ).map((row) => row.at);
    const newest = (
      db.prepare("SELECT max(updated_at) AS at FROM cards").get() as { at: string }
    ).at;
    expect(stamps).toContain(newest);

    const expected = (
      db
        .prepare("SELECT id FROM cards WHERE archived = 0 ORDER BY updated_at DESC LIMIT 40")
        .all() as { id: string }[]
    ).map((row) => row.id);
    expect(rows.map((row) => row.id)).toEqual(expected);
    expect(rows.filter((row) => row.archived === 1)).toEqual([]);
  });

  it("survives a decision-17 restore, which stamps every archived card with `now`", () => {
    const restored = join(dir, "restored.db");
    copyFileSync(SOURCE, restored);
    const after = new Database(restored);
    try {
      const touched = after
        .prepare(
          `UPDATE cards SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE archived = 1`,
        )
        .run().changes;
      expect(touched).toBe(244);

      const { sql, args } = scopeToSubtree(after as unknown as ScopedDb, null);
      const rows = suggestCards(after as unknown as ScopedDb, {
        scopeSql: sql,
        scopeArgs: args,
        visited: [],
        limit: 40,
      });
      expect(rows.filter((row) => row.archived === 1)).toEqual([]);
      expect(rows.length).toBe(40);
      expect(rows[0]?.id).toBe(
        (
          after
            .prepare("SELECT id FROM cards WHERE archived = 0 ORDER BY updated_at DESC LIMIT 1")
            .get() as { id: string }
        ).id,
      );
    } finally {
      after.close();
    }
  });

  it("puts what he opened above what he edited, in the log's own order", () => {
    const old = (
      db.prepare("SELECT id FROM cards ORDER BY updated_at ASC LIMIT 3").all() as { id: string }[]
    ).map((row) => row.id);
    const rows = whole(old);
    expect(rows.slice(0, 3).map((row) => row.id)).toEqual(old);
    const reversed = [...old].reverse();
    expect(whole(reversed).slice(0, 3).map((row) => row.id)).toEqual(reversed);
  });

  it("never repeats a card that is both opened and recently edited", () => {
    const newest = (
      db.prepare("SELECT id FROM cards ORDER BY updated_at DESC LIMIT 2").all() as {
        id: string;
      }[]
    ).map((row) => row.id);
    const rows = whole(newest);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.slice(0, 2).map((row) => row.id)).toEqual(newest);
  });

  it("drops a visited id that is not in this database, rather than going short", () => {
    const rows = whole(["no-such-card", "another-ghost"]);
    expect(rows.length).toBe(40);
    expect(rows.map((row) => row.id)).not.toContain("no-such-card");
  });

  it("keeps the card menu's promise: a pinned card is near the top before any query", () => {
    const victim = (
      db.prepare("SELECT id FROM cards ORDER BY updated_at ASC LIMIT 1").get() as { id: string }
    ).id;
    db.prepare("UPDATE cards SET pinned = 1 WHERE id = ?").run(victim);
    try {
      expect(whole([])[0]?.id).toBe(victim);
      const other = (
        db.prepare("SELECT id FROM cards WHERE id <> ? ORDER BY updated_at ASC LIMIT 1").get(
          victim,
        ) as { id: string }
      ).id;
      expect(whole([other])[0]?.id).toBe(victim);
    } finally {
      db.prepare("UPDATE cards SET pinned = 0 WHERE id = ?").run(victim);
    }
  });

  it("scopes to a deck subtree, so the suggestions agree with where he is", () => {
    const kanji = (
      db.prepare("SELECT id FROM decks WHERE name = '漢字'").get() as { id: string }
    ).id;
    const { sql, args } = scopeToSubtree(scoped(), kanji);
    const rows = suggestCards(scoped(), {
      scopeSql: sql,
      scopeArgs: args,
      visited: (
        db.prepare("SELECT id FROM cards WHERE deck_id <> ? LIMIT 1").get(kanji) as { id: string }
      ).id
        ? [(db.prepare("SELECT id FROM cards WHERE deck_id <> ? LIMIT 1").get(kanji) as { id: string }).id]
        : [],
      limit: 20,
    });
    expect(rows.length).toBe(20);
    for (const row of rows) expect(row.deck).toContain("漢字");
  });

  it("answers fast enough to run on every open of the palette", () => {
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) whole([]);
    const per = (performance.now() - started) / 20;
    expect(per).toBeLessThan(25);
  });
});

describe.skipIf(!haveCorpus)("readingOverride", () => {
  it("returns a card's explicit 読み — 主語's しゅご, one of the 13 rows decision 10 wrote", () => {
    expect(readingOverride(db, "3giJ9apN")).toBe("しゅご");
  });

  it("is null for a card with no 読み, so the furigana stays pending as before", () => {
    expect(readingOverride(db, "OpKBNv1d")).toBeNull();
    expect(readingOverride(db, "no-such-card")).toBeNull();
  });
});
