import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/index.js";
import { gradeTrack, snapshotTrack } from "../src/scheduler/index.js";

/**
 * THE FOUR ACID PROPERTIES, ASSERTED RATHER THAN ASSUMED.
 *
 * Everything here was already true. That is exactly why it is worth pinning: each one
 * is a PRAGMA or a convention that goes on working silently until the day it does not,
 * and every failure mode below is silent.
 *
 * **Foreign keys are OFF by default in SQLite.** `src/db/open.ts` and
 * `src/db/browser.ts` both enable them AND verify the pragma read back — good practice
 * that nothing was checking. If it ever regressed, `ON DELETE CASCADE` would become
 * decoration: deleting a card would leave its tracks and reviews behind as orphans,
 * `cards.deck_id`'s `ON DELETE RESTRICT` would stop refusing, and the first symptom
 * would be a scheduler queue containing tracks whose cards do not exist.
 *
 * **A transaction that throws must leave nothing behind.** `gradeTrack` writes a
 * `reviews` row and then advances `card_tracks`; a half-applied grade is a card whose
 * history and whose schedule disagree, and no later arithmetic recovers.
 *
 * The corpus checks at the bottom are the ones that would catch damage that already
 * happened — `PRAGMA foreign_key_check` over the real database, which nothing in the
 * suite ran.
 */

const ROOT = resolve(import.meta.dirname, "..");
const CORPUS = join(ROOT, "build/hashigo.db");
const MEMORY = ":memory:";

/** One deck, one card, one track, with a graded review on it. */
function fixture() {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name) VALUES ('d', '日本語')").run();
  db.prepare("INSERT INTO cards (id, deck_id, name) VALUES ('c', 'd', '橋')").run();
  const track = db
    .prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('c', 'forward') RETURNING id")
    .get() as { id: number };
  return { db, trackId: track.id };
}

const count = (db: ReturnType<typeof openDatabase>, sql: string, ...a: unknown[]): number =>
  (db.prepare(sql).get(...a) as { n: number }).n;

// ── C: consistency ───────────────────────────────────────────────────────────

describe("Consistency — the constraints are actually enforced", () => {
  it("has foreign keys ON, which SQLite does not do by default", () => {
    const db = openDatabase(MEMORY);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("REFUSES a row pointing at a card that does not exist", () => {
    const { db } = fixture();
    expect(() =>
      db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('ghost', 'forward')").run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it("CASCADES a card delete into its tracks and reviews", () => {
    // The app relies on this: `cardOp delete` removes the card and expects the
    // schedule to go with it. `ReviewSession.skipCurrent` exists because it does.
    const { db, trackId } = fixture();
    gradeTrack(db, { trackId, remembered: 1 });
    expect(count(db, "SELECT count(*) AS n FROM card_tracks WHERE card_id = 'c'")).toBe(1);
    expect(count(db, "SELECT count(*) AS n FROM reviews WHERE track_id = ?", trackId)).toBe(1);

    db.prepare("DELETE FROM cards WHERE id = 'c'").run();

    expect(count(db, "SELECT count(*) AS n FROM card_tracks WHERE card_id = 'c'")).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM reviews WHERE track_id = ?", trackId)).toBe(0);
    db.close();
  });

  it("RESTRICTS deleting a deck that still holds cards", () => {
    // Deliberate, and the app's `deckOp delete` reports the count rather than
    // cascading: deleting a deck must never silently take its cards.
    const { db } = fixture();
    expect(() => db.prepare("DELETE FROM decks WHERE id = 'd'").run()).toThrow(/FOREIGN KEY/i);
    expect(count(db, "SELECT count(*) AS n FROM cards WHERE deck_id = 'd'")).toBe(1);
    db.close();
  });

  it("leaves no orphan behind after a cascade — foreign_key_check agrees", () => {
    const { db, trackId } = fixture();
    gradeTrack(db, { trackId, remembered: 1 });
    db.prepare("DELETE FROM cards WHERE id = 'c'").run();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});

// ── A: atomicity ─────────────────────────────────────────────────────────────

describe("Atomicity — a failed transaction leaves nothing behind", () => {
  it("rolls back both writes when the second one throws", () => {
    const { db, trackId } = fixture();
    const before = count(db, "SELECT count(*) AS n FROM reviews");

    const boom = db.transaction(() => {
      db.prepare(
        `INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, remembered, source)
         VALUES (?, '2026-08-26T00:00:00+09:00', 540, 1, 'local')`,
      ).run(trackId);
      throw new Error("boom");
    });

    expect(() => boom()).toThrow("boom");
    expect(count(db, "SELECT count(*) AS n FROM reviews")).toBe(before);
    db.close();
  });

  it("grades atomically: the review row and the advanced track arrive together", () => {
    const { db, trackId } = fixture();
    const before = snapshotTrack(db, trackId);
    gradeTrack(db, { trackId, remembered: 1 });
    const after = snapshotTrack(db, trackId);

    // Both halves moved, or neither would have.
    expect(after.reps).toBe(before.reps + 1);
    expect(count(db, "SELECT count(*) AS n FROM reviews WHERE track_id = ?", trackId)).toBe(1);
    db.close();
  });

  it("nests: an inner failure rolls the whole outer transaction back", () => {
    // `archiveSubtree` and `ungradeTrack` are both called INSIDE a caller's
    // transaction in the app. If nesting did not roll back as one unit, a failure
    // deep in a deck archive would leave it half applied across thousands of rows.
    const { db } = fixture();
    const before = count(db, "SELECT count(*) AS n FROM cards");
    const outer = db.transaction(() => {
      db.prepare("INSERT INTO cards (id, deck_id, name) VALUES ('c2', 'd', '箸')").run();
      const inner = db.transaction(() => {
        db.prepare("INSERT INTO cards (id, deck_id, name) VALUES ('c3', 'd', '端')").run();
        throw new Error("inner");
      });
      inner();
    });
    expect(() => outer()).toThrow("inner");
    expect(count(db, "SELECT count(*) AS n FROM cards")).toBe(before);
    db.close();
  });
});

// ── I / D: isolation and durability, as far as a test can reach ──────────────

describe("Isolation and Durability — the settings that make them true", () => {
  it("uses WAL and a busy timeout on a real file, so a second reader is not refused", () => {
    // `:memory:` cannot be WAL, which is why this needs a file. `busy_timeout` is the
    // difference between a concurrent reader waiting and getting SQLITE_BUSY.
    const dir = resolve(ROOT, "build");
    if (!existsSync(dir)) return;
    const path = join(dir, `acid-check-${process.pid}.db`);
    const db = openDatabase(path);
    try {
      expect(String(db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
      expect(Number(db.pragma("busy_timeout", { simple: true }))).toBeGreaterThan(0);
      // NORMAL, not FULL: with WAL that is durable against a process crash and trades
      // only power-loss durability for the write rate a per-grade OPFS write needs.
      expect(Number(db.pragma("synchronous", { simple: true }))).toBe(1);
    } finally {
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        const f = `${path}${suffix}`;
        if (existsSync(f)) rmSync(f);
      }
    }
  });
});

// ── the real database, which is the one that matters ─────────────────────────

describe.skipIf(!existsSync(CORPUS))("the real corpus is internally consistent", () => {
  it("has no foreign key violations and passes integrity_check", () => {
    const db = openDatabase(CORPUS, { readOnly: true });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const integrity = (db.pragma("integrity_check") as { integrity_check: string }[]).map(
      (r) => r.integrity_check,
    );
    expect(integrity).toEqual(["ok"]);
    db.close();
  });

  it("has no track whose card is missing, and no review whose track is missing", () => {
    // The shape a broken cascade would leave. Stated separately from
    // `foreign_key_check` because it reads as the thing a person would worry about.
    const db = openDatabase(CORPUS, { readOnly: true });
    expect(
      count(
        db,
        "SELECT count(*) AS n FROM card_tracks t LEFT JOIN cards c ON c.id = t.card_id WHERE c.id IS NULL",
      ),
    ).toBe(0);
    expect(
      count(
        db,
        "SELECT count(*) AS n FROM reviews r LEFT JOIN card_tracks t ON t.id = r.track_id WHERE t.id IS NULL",
      ),
    ).toBe(0);
    db.close();
  });
});
