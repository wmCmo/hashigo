import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { childrenOf } from "../app/deck-tree.js";
import {
  archiveSubtree,
  restoreArchive,
  scopeToSubtree,
  scopeToTag,
  subtreeDeckIds,
  type ScopedDb,
} from "../app/deck-scope.js";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = join(ROOT, "build/hashigo.db");
const haveCorpus = existsSync(SOURCE);

let dir = "";
let db: Database.Database;

beforeAll(() => {
  if (!haveCorpus) return;
  dir = mkdtempSync(join(tmpdir(), "hashigo-deck-scope-"));
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

function deckIdNamed(name: string): string {
  const row = db.prepare("SELECT id FROM decks WHERE name = ?").get(name) as { id: string };
  return row.id;
}

function cardsUnder(deckId: string): number {
  const ids = subtreeDeckIds(scoped(), deckId);
  const marks = ids.map(() => "?").join(", ");
  return (
    db.prepare(`SELECT count(*) AS n FROM cards WHERE deck_id IN (${marks})`).get(...ids) as {
      n: number;
    }
  ).n;
}

describe.skipIf(!haveCorpus)("a deck means its subtree, over the real corpus", () => {
  it("walks the whole subtree, not just the deck's own cards", () => {
    const ja = deckIdNamed("日本語");
    const own = (
      db.prepare("SELECT count(*) AS n FROM cards WHERE deck_id = ?").get(ja) as { n: number }
    ).n;
    expect(own).toBe(3);
    expect(cardsUnder(ja)).toBe(5948);
    expect(subtreeDeckIds(scoped(), ja).length).toBeGreaterThan(1);
  });

  it("includes the deck itself, so a leaf is its own subtree", () => {
    const suuji = deckIdNamed("数字");
    expect(subtreeDeckIds(scoped(), suuji)).toEqual([suuji]);
    expect(cardsUnder(suuji)).toBe(90);
  });

  it("scopes a card query to the subtree, which is what the gallery reads", () => {
    const english = deckIdNamed("English");
    const own = (
      db.prepare("SELECT count(*) AS n FROM cards WHERE deck_id = ?").get(english) as { n: number }
    ).n;
    expect(own).toBe(0);

    const { sql, args } = scopeToSubtree(scoped(), english);
    const scopedCount = (
      db.prepare(`SELECT count(*) AS n FROM cards c WHERE ${sql}`).get(...args) as { n: number }
    ).n;
    expect(scopedCount).toBe(1258);
  });

  it("scopes to everything when the deck is null", () => {
    const { sql, args } = scopeToSubtree(scoped(), null);
    const all = (
      db.prepare(`SELECT count(*) AS n FROM cards c WHERE ${sql}`).get(...args) as { n: number }
    ).n;
    expect(all).toBe(7716);
  });
});

describe.skipIf(!haveCorpus)("archiving a deck, and undoing it without losing anything", () => {
  it("archives the whole subtree and reports the real number", () => {
    const ja = deckIdNamed("日本語");
    const alreadyArchived = (
      db.prepare("SELECT count(*) AS n FROM cards WHERE archived = 1").get() as { n: number }
    ).n;
    expect(alreadyArchived).toBeGreaterThan(0);

    const { deckIds, changed } = archiveSubtree(scoped(), ja, 1);
    expect(deckIds.length).toBeGreaterThan(1);
    const marks = deckIds.map(() => "?").join(", ");
    const live = (
      db
        .prepare(`SELECT count(*) AS n FROM cards WHERE deck_id IN (${marks}) AND archived = 0`)
        .get(...deckIds) as { n: number }
    ).n;
    expect(live).toBe(0);
    expect(changed.length).toBeLessThan(5947);
    expect(changed.length).toBeGreaterThan(5000);

    restoreArchive(scoped(), ja, changed);
  });

  it("RESTORES rather than inverting — a hand-archived card stays archived", () => {
    const suuji = deckIdNamed("数字");
    const handArchived = db
      .prepare("SELECT id FROM cards WHERE deck_id = ? AND archived = 1")
      .all(suuji) as { id: string }[];
    expect(handArchived.length).toBe(12);

    const { changed } = archiveSubtree(scoped(), suuji, 1);
    expect(changed).toHaveLength(90 - 12);
    for (const card of handArchived) expect(changed).not.toContain(card.id);

    restoreArchive(scoped(), suuji, changed);

    const stillArchived = (
      db
        .prepare("SELECT count(*) AS n FROM cards WHERE deck_id = ? AND archived = 1")
        .get(suuji) as { n: number }
    ).n;
    expect(stillArchived, "the hand-archived cards must survive the undo").toBe(12);

    const live = (
      db
        .prepare("SELECT count(*) AS n FROM cards WHERE deck_id = ? AND archived = 0")
        .get(suuji) as { n: number }
    ).n;
    expect(live, "and everything else must come back").toBe(90 - 12);
  });

  it("round-trips the whole corpus's archive state exactly", () => {
    const before = (
      db.prepare("SELECT id FROM cards WHERE archived = 1 ORDER BY id").all() as { id: string }[]
    ).map((r) => r.id);

    const ja = deckIdNamed("日本語");
    const { changed } = archiveSubtree(scoped(), ja, 1);
    restoreArchive(scoped(), ja, changed);

    const after = (
      db.prepare("SELECT id FROM cards WHERE archived = 1 ORDER BY id").all() as { id: string }[]
    ).map((r) => r.id);
    expect(after).toEqual(before);
  });

  it("restores the deck rows too, not only the cards", () => {
    const suuji = deckIdNamed("数字");
    const wasArchived = (
      db.prepare("SELECT archived FROM decks WHERE id = ?").get(suuji) as { archived: number }
    ).archived;

    const { changed } = archiveSubtree(scoped(), suuji, 1);
    expect(
      (db.prepare("SELECT archived FROM decks WHERE id = ?").get(suuji) as { archived: number })
        .archived,
    ).toBe(1);

    restoreArchive(scoped(), suuji, changed);
    expect(
      (db.prepare("SELECT archived FROM decks WHERE id = ?").get(suuji) as { archived: number })
        .archived,
    ).toBe(wasArchived);
  });
});

describe.skipIf(!haveCorpus)("the page walk and the worker walk agree", () => {
  function pageDecks(): { id: string; parentId: string | null; cards: number; due: number }[] {
    return (
      db.prepare("SELECT id, parent_id FROM decks").all() as {
        id: string;
        parent_id: string | null;
      }[]
    ).map((row) => ({ id: row.id, parentId: row.parent_id, cards: 0, due: 0 }));
  }

  function pageSubtree(rootId: string): Set<string> {
    const decks = pageDecks();
    const out = new Set<string>();
    const walk = (id: string): void => {
      if (out.has(id)) return;
      out.add(id);
      for (const child of childrenOf(decks, id)) walk(child.id);
    };
    walk(rootId);
    return out;
  }

  it("returns the same set of decks for EVERY deck in the corpus", () => {
    const all = (db.prepare("SELECT id FROM decks").all() as { id: string }[]).map((r) => r.id);
    expect(all.length).toBeGreaterThan(30);

    const disagreements: string[] = [];
    for (const id of all) {
      const fromSql = [...subtreeDeckIds(scoped(), id)].sort();
      const fromPage = [...pageSubtree(id)].sort();
      if (JSON.stringify(fromSql) !== JSON.stringify(fromPage)) {
        disagreements.push(`${id}: SQL ${fromSql.length} decks, page ${fromPage.length}`);
      }
    }
    expect(disagreements, `the two subtree walks disagree:\n  ${disagreements.join("\n  ")}`)
      .toEqual([]);
  });

  it("agrees that a deck is in its own subtree", () => {
    const ja = deckIdNamed("日本語");
    expect(subtreeDeckIds(scoped(), ja)).toContain(ja);
    expect(pageSubtree(ja).has(ja)).toBe(true);
  });

  it("agrees on the card total the sidebar shows and the gallery lists", () => {
    for (const name of ["日本語", "単語", "English", "数字"]) {
      const id = deckIdNamed(name);
      const sqlIds = subtreeDeckIds(scoped(), id);
      const pageIds = [...pageSubtree(id)];
      const count = (ids: readonly string[]): number =>
        (
          db
            .prepare(
              `SELECT count(*) AS n FROM cards WHERE deck_id IN (${ids.map(() => "?").join(", ")})`,
            )
            .get(...ids) as { n: number }
        ).n;
      expect(count(sqlIds), `${name} disagrees`).toBe(count(pageIds));
    }
  });
});

describe("a tag scope lists the tag's cards, and its children's", () => {
  function cardsTagged(tagPath: string): number {
    const { sql, args } = scopeToTag(tagPath);
    return (
      db.prepare(`SELECT count(*) AS n FROM cards c WHERE ${sql}`).get(...args) as { n: number }
    ).n;
  }

  it("counts exactly the cards carrying the tag", () => {
    if (!haveCorpus) return;
    for (const [path, expected] of [
      ["Mathematics", 9],
      ["Buddhism", 8],
      ["Law", 5],
    ] as const) {
      const direct = (
        db.prepare("SELECT count(*) AS n FROM card_tags WHERE tag_path = ?").get(path) as {
          n: number;
        }
      ).n;
      expect(direct, `${path} moved in the corpus`).toBe(expected);
      expect(cardsTagged(path), path).toBe(expected);
    }
  });

  it("reaches a child tag's cards from the parent — Dialect has none of its own", () => {
    if (!haveCorpus) return;
    const own = (
      db.prepare("SELECT count(*) AS n FROM card_tags WHERE tag_path = 'Dialect'").get() as {
        n: number;
      }
    ).n;
    expect(own).toBe(0);
    expect(cardsTagged("Dialect")).toBe(cardsTagged("Dialect/Kansai"));
    expect(cardsTagged("Dialect/Kansai")).toBe(2);
  });

  it("does not match a SIBLING whose name merely starts the same way", () => {
    if (!haveCorpus) return;
    db.prepare("INSERT INTO tags (path, parent_path, name) VALUES ('Dialectic', NULL, 'Dialectic')").run();
    const victim = db.prepare("SELECT id FROM cards LIMIT 1").get() as { id: string };
    db.prepare("INSERT INTO card_tags (card_id, tag_path) VALUES (?, 'Dialectic')").run(victim.id);
    try {
      expect(cardsTagged("Dialect")).toBe(2);
      expect(cardsTagged("Dialectic")).toBe(1);
    } finally {
      db.prepare("DELETE FROM card_tags WHERE tag_path = 'Dialectic'").run();
      db.prepare("DELETE FROM tags WHERE path = 'Dialectic'").run();
    }
  });

  it("finds nothing for a tag nobody uses, rather than everything", () => {
    if (!haveCorpus) return;
    expect(cardsTagged("NoSuchTag")).toBe(0);
    expect(cardsTagged("")).toBe(0);
  });
});
