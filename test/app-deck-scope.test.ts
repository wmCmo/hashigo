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
  subtreeDeckIds,
  type ScopedDb,
} from "../app/deck-scope.js";

/**
 * THE MOST DESTRUCTIVE WRITE IN THE APP, TESTED FOR THE FIRST TIME.
 *
 * Archiving a deck used to touch the deck's OWN cards only — `WHERE deck_id = ?` —
 * while reporting "archived <name> and its cards". And its undo recorded the INVERSE
 * operation, so one ctrl+Z ran `archived = 0` across the whole deck and erased every
 * per-card archive decision inside it.
 *
 * Both shipped because the code lived in `app/db.worker.ts`, which `test/` cannot
 * import: the file opens with a `webworker` reference and touches `self` at load. So
 * `app/deck-scope.ts` holds the rules over a structural `ScopedDb` — three methods that
 * `BrowserDb` and `better-sqlite3` both already have — and the worker and this file run
 * the same code against OPFS and against the real 74 MB corpus respectively.
 *
 * Everything here runs on a COPY. `build/hashigo.db` is his, and a test that archives
 * 5,947 cards must not be one keystroke away from doing it for real.
 */

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

/** `better-sqlite3` satisfies `ScopedDb` structurally; this names that. */
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
    // The measurement that made this a bug rather than a preference: 日本語 owns
    // almost nothing directly, and the sidebar has always shown the subtree total.
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
    // Clicking a parent deck opened an EMPTY gallery: English owns 0 of its 1,258.
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
    expect(alreadyArchived).toBeGreaterThan(0); // 234 in the corpus as measured

    const { deckIds, changed } = archiveSubtree(scoped(), ja, 1);
    expect(deckIds.length).toBeGreaterThan(1);
    // Every card under 日本語 is now archived...
    const marks = deckIds.map(() => "?").join(", ");
    const live = (
      db
        .prepare(`SELECT count(*) AS n FROM cards WHERE deck_id IN (${marks}) AND archived = 0`)
        .get(...deckIds) as { n: number }
    ).n;
    expect(live).toBe(0);
    // ...and `changed` excludes the ones that were already archived, which is what
    // makes the undo lossless.
    expect(changed.length).toBeLessThan(5947);
    expect(changed.length).toBeGreaterThan(5000);

    restoreArchive(scoped(), ja, changed);
  });

  it("RESTORES rather than inverting — a hand-archived card stays archived", () => {
    // The data-loss bug, stated as a test. Pick a card that is archived on its own,
    // archive its whole ancestor deck, undo, and require that the card is still
    // archived. The old undo ran `archived = 0` over the deck and lost it.
    const suuji = deckIdNamed("数字");
    const handArchived = db
      .prepare("SELECT id FROM cards WHERE deck_id = ? AND archived = 1")
      .all(suuji) as { id: string }[];
    expect(handArchived.length).toBe(12); // his 数字 deck, measured

    const { changed } = archiveSubtree(scoped(), suuji, 1);
    // The 12 were already archived, so the operation did not change them.
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
    // The strong form: archive a big subtree, undo, and require the archived-card set
    // to be byte-for-byte what it was. Counting is not enough — the old bug preserved
    // no count either, but a fix that archived the wrong 234 would pass a count check.
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

// ── the two walks that must agree ────────────────────────────────────────────

/**
 * "WHAT IS UNDER THIS DECK" IS IMPLEMENTED TWICE, ON PURPOSE, AND NOTHING PINNED IT.
 *
 * `app/deck-tree.ts` walks `parentId` over an in-memory array, because the PAGE has a
 * flat list of `DeckBrief` and no database. `app/deck-scope.ts` walks `parent_id` in a
 * recursive CTE, because the WORKER has SQLite and no array. Neither can call the
 * other: they are on opposite sides of a `postMessage` boundary with different data
 * shapes, so this is one of the few duplications that cannot be removed.
 *
 * They can still DISAGREE, and they already guard cycles differently — a `seen` set in
 * one, `UNION` in the other. A disagreement is not cosmetic: the sidebar's badge comes
 * from one and the gallery's contents and the archive operation come from the other,
 * so a divergence is a number that does not match what clicking it does. That was a
 * real bug two commits ago, from the same mismatch.
 *
 * What cannot be deduplicated gets pinned instead.
 */
describe.skipIf(!haveCorpus)("the page walk and the worker walk agree", () => {
  /** `app/deck-tree.ts`'s shape, from the same rows the worker would send. */
  function pageDecks(): { id: string; parentId: string | null; cards: number; due: number }[] {
    return (
      db.prepare("SELECT id, parent_id FROM decks").all() as {
        id: string;
        parent_id: string | null;
      }[]
    ).map((row) => ({ id: row.id, parentId: row.parent_id, cards: 0, due: 0 }));
  }

  /** The page's subtree, by walking children the way `subtreeTotals` does. */
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
    // The failure this pins, stated as the two numbers a reader compares: the badge
    // beside a deck, and what opening it lists.
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
