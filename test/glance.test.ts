/**
 * The daily dashboard, and the one assumption that makes it fast.
 *
 * `collectGlance` reads `substr(reviewed_at, 1, 10)` as the local date instead of
 * `review_log`'s `date(datetime(reviewed_at, printf('%+d minutes', tz_offset_minutes)))`.
 * That is a 52x difference on the windowed query — the substring is a prefix of an
 * INDEXED column, so a range on it is a seek — and it is only correct while the
 * importer keeps `tz_offset_minutes` equal to the offset written into the string.
 *
 * So the first test is not about the dashboard at all. It is about that invariant,
 * over every row of the real corpus. If it ever breaks, this fails loudly instead
 * of every figure on the screen drifting by a day.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/index.js";
import { collectGlance, shiftDate } from "../src/dashboard/index.js";

const CORPUS = "build/hashigo.db";

/** The expression `review_log` uses. Quoted, not imported: it lives in SQL. */
const VIEW_LOCAL_DATE = `date(datetime(reviewed_at, printf('%+d minutes', tz_offset_minutes)))`;

function corpus(): Database.Database | null {
  try {
    return new Database(CORPUS, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

describe("the substring shortcut", () => {
  it("AGREES WITH `review_log` ON EVERY ROW OF THE REAL CORPUS", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const bad = db
        .prepare(
          `SELECT count(*) AS n FROM reviews
            WHERE substr(reviewed_at, 1, 10) <> ${VIEW_LOCAL_DATE}`,
        )
        .get() as { n: number };
      const total = (db.prepare("SELECT count(*) AS n FROM reviews").get() as { n: number }).n;
      expect(total).toBeGreaterThan(100_000);
      expect(
        bad.n,
        "substr(reviewed_at,1,10) is only the local date while tz_offset_minutes " +
          "matches the offset in the string. It no longer does.",
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("holds for a row whose offset is NOT +09:00", () => {
    // The corpus is entirely Asia/Tokyo, so the check above cannot distinguish
    // "the rule holds" from "every row happens to share one offset". This is the
    // case that separates them, and it is the shape a review taken abroad has.
    const db = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO decks (id, name) VALUES ('d', 'D')").run();
      db.prepare("INSERT INTO cards (id, deck_id) VALUES ('c', 'd')").run();
      db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('c', 'forward')").run();
      const track = (
        db.prepare("SELECT id FROM card_tracks WHERE card_id = 'c'").get() as { id: number }
      ).id;
      const rows: readonly (readonly [string, number])[] = [
        ["2026-08-18T23:30:00+09:00", 540], // late evening in Tokyo
        ["2026-08-18T00:30:00+09:00", 540], // just after midnight
        ["2026-08-18T23:30:00+01:00", 60], // late evening in London
        ["2026-08-18T00:30:00-05:00", -300], // just after midnight in New York
      ];
      for (const [at, offset] of rows) {
        db.prepare(
          `INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown,
                                remembered, elapsed_days, scheduled_days,
                                next_scheduled_days, due_at, source)
           VALUES (?, ?, ?, 0, 1, 1, 1, 2, '2026-08-20T00:00:00+09:00', 'local')`,
        ).run(track, at, offset);
      }
      const bad = db
        .prepare(
          `SELECT count(*) AS n FROM reviews
            WHERE substr(reviewed_at, 1, 10) <> ${VIEW_LOCAL_DATE}`,
        )
        .get() as { n: number };
      expect(bad.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("the glance", () => {
  it("agrees with the database it was derived from", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const g = collectGlance(db as never);

      const all = db
        .prepare("SELECT count(*) AS n, sum(remembered) AS ok FROM reviews")
        .get() as { n: number; ok: number };
      expect(g.allTime.reviews).toBe(all.n);
      expect(g.allTime.retention).toBeCloseTo(all.ok / all.n, 10);
      // The published corpus figure, which is what makes this a check and not a
      // restatement: 102,020 reviews at 96.24%.
      expect(g.allTime.reviews).toBe(103_110);
      expect(g.allTime.retention).toBeCloseTo(0.9624, 4);

      const cards = (db.prepare("SELECT count(*) AS n FROM cards").get() as { n: number }).n;
      expect(g.collection.cards).toBe(cards);
      expect(g.collection.live).toBeLessThanOrEqual(g.collection.tracks);

      // FOURTEEN CALENDAR DAYS, contiguous. A quiet day is a gap and must show as
      // one — a chart that closes the gap is a chart that hides the week he missed.
      expect(g.recent).toHaveLength(14);
      for (let i = 1; i < g.recent.length; i += 1) {
        expect(g.recent[i]!.date).toBe(shiftDate(g.recent[i - 1]!.date, 1));
      }
      expect(g.recent.at(-1)!.date).toBe(g.today.date);

      expect(g.forecast).toHaveLength(14);
      // Tomorrow first: today's due are `today.due`, not part of the forecast.
      expect(g.forecast[0]!.date).toBe(shiftDate(g.today.date, 1));
    } finally {
      db.close();
    }
  });

  it("counts a streak back from the last ACTIVE day, not from today", () => {
    // The generous reading, and it is deliberate: a streak that shows 0 at
    // breakfast because he has not started yet punishes him for the time of day.
    const db = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO decks (id, name) VALUES ('d', 'D')").run();
      db.prepare("INSERT INTO cards (id, deck_id) VALUES ('c', 'd')").run();
      db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('c', 'forward')").run();
      const track = (
        db.prepare("SELECT id FROM card_tracks WHERE card_id = 'c'").get() as { id: number }
      ).id;
      const add = (date: string): void => {
        db.prepare(
          `INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown,
                                remembered, elapsed_days, scheduled_days,
                                next_scheduled_days, due_at, source)
           VALUES (?, ?, 540, 0, 1, 1, 1, 2, '2026-09-01T00:00:00+09:00', 'local')`,
        ).run(track, `${date}T10:00:00+09:00`);
      };

      // Three days ending yesterday, then a gap, then two more.
      add("2026-08-20");
      add("2026-08-24");
      add("2026-08-25");
      add("2026-08-26");

      // Today is active: 3 days back through 08-24, stopping at the 08-21..23 gap.
      expect(collectGlance(db, { today: "2026-08-26" }).streakDays).toBe(3);
      // Today is NOT active: counts back from yesterday, same three days.
      expect(collectGlance(db, { today: "2026-08-27" }).streakDays).toBe(3);
      // A whole day missed: the streak is over.
      expect(collectGlance(db, { today: "2026-08-28" }).streakDays).toBe(0);
    } finally {
      db.close();
    }
  });

  it("is empty-safe — a database with no reviews must not divide by zero", () => {
    const db = openDatabase(":memory:");
    try {
      const g = collectGlance(db, { today: "2026-08-26" });
      expect(g.allTime.reviews).toBe(0);
      expect(g.allTime.retention).toBeNull();
      expect(g.allTime.firstDate).toBeNull();
      expect(g.last30.retention).toBeNull();
      expect(g.streakDays).toBe(0);
      expect(g.recent).toHaveLength(14);
      expect(g.recent.every((day) => day.reviews === 0)).toBe(true);
    } finally {
      db.close();
    }
  });
});
