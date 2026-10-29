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
import { collectGlance, compareDeckPaths, shiftDate, shiftMonth } from "../src/dashboard/index.js";
import { recallOf } from "../src/dashboard/recall.js";

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

describe("a day's % remembered leaves out a new card's first press", () => {
  it("counts the press in the reviews and not in the recall — 2026-10-29", () => {
    // Zach: "for a new card, if you never know what it means, you can't actually
    // forget them right...?" Two tracks reviewed on one day: a NEW one forgotten on
    // its first press, and a learned one remembered. The day is 1 of 2 remembered
    // by the raw count and 1 of 1 by what the chart now shows.
    const db = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO decks (id, name) VALUES ('d', 'D')").run();
      db.prepare("INSERT INTO cards (id, deck_id) VALUES ('new', 'd'), ('old', 'd')").run();
      db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('new', 'forward'), ('old', 'forward')").run();
      const id = (card: string) =>
        (db.prepare("SELECT id FROM card_tracks WHERE card_id = ?").get(card) as { id: number }).id;
      const review = db.prepare(
        `INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown,
                              remembered, elapsed_days, scheduled_days,
                              next_scheduled_days, due_at, source)
         VALUES (?, ?, 540, 0, ?, 1, 1, 2, '2026-10-30T00:00:00+09:00', 'local')`,
      );
      review.run(id("old"), "2026-10-20T09:00:00+09:00", 1); // learned ten days ago
      review.run(id("old"), "2026-10-29T09:00:00+09:00", 1);
      review.run(id("new"), "2026-10-29T09:05:00+09:00", 0); // first press: forgot

      const g = collectGlance(db as never, { today: "2026-10-29" });
      const day = g.recent.at(-1)!;
      expect(day).toMatchObject({ reviews: 2, remembered: 1, firsts: 1, firstsRemembered: 0 });
      expect(recallOf(day)).toBe(1);
      // The earlier day's only review was that track's first press: nothing left to count.
      const first = g.recent.find((d) => d.date === "2026-10-20")!;
      expect(first).toMatchObject({ reviews: 1, firsts: 1 });
      expect(recallOf(first)).toBeNull();
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
      // restatement: 103,110 reviews at 96.24%.
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

/**
 * "How many tracks have I learned" — the headline, the rate, and the per-deck
 * split. Three figures drawn from three different queries, which is exactly why
 * these tests are mostly about them AGREEING: a screen that says 9,010 at the top
 * and sums to 9,085 further down is worse than a screen with one number on it.
 */
describe("learned", () => {
  it("counts `reps > 0`, and is NOT `live - fresh`", () => {
    // The two definitions coincide on the corpus today and are not the same rule.
    // `fresh` is `due_at IS NULL AND reps = 0`; a track seeded with a due date and
    // no reps is neither fresh nor learned, and subtracting would claim it was
    // learned. Built here because the corpus contains no such track — which is the
    // whole hazard, since the subtraction would pass every test until one appeared.
    const db = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO decks (id, name) VALUES ('d', 'D')").run();
      for (const id of ["a", "b", "c"]) {
        db.prepare("INSERT INTO cards (id, deck_id) VALUES (?, 'd')").run(id);
      }
      // a: never touched. b: seeded, due, never reviewed. c: actually reviewed.
      db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('a', 'forward')").run();
      db.prepare(
        `INSERT INTO card_tracks (card_id, kind, due_at, reps)
         VALUES ('b', 'forward', '2026-09-01T00:00:00+09:00', 0)`,
      ).run();
      db.prepare(
        `INSERT INTO card_tracks (card_id, kind, due_at, reps)
         VALUES ('c', 'forward', '2026-09-01T00:00:00+09:00', 4)`,
      ).run();

      const g = collectGlance(db, { today: "2026-08-26" });
      expect(g.collection.live).toBe(3);
      expect(g.collection.learned).toBe(1);
      expect(g.today.fresh).toBe(1);
      // The subtraction everybody reaches for, wrong by the seeded track.
      expect(g.collection.live - g.today.fresh).toBe(2);
    } finally {
      db.close();
    }
  });

  it("agrees with the corpus, and the deck rows sum to the headline", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const g = collectGlance(db as never);

      const direct = db
        .prepare(
          `SELECT count(*) AS live, sum(CASE WHEN t.reps > 0 THEN 1 ELSE 0 END) AS learned
             FROM card_tracks t JOIN cards c ON c.id = t.card_id
            WHERE t.dormant = 0 AND c.archived = 0`,
        )
        .get() as { live: number; learned: number };
      expect(g.collection.live).toBe(direct.live);
      expect(g.collection.learned).toBe(direct.learned);
      expect(g.collection.learned).toBeLessThanOrEqual(g.collection.live);

      // THE ROLLUP INVARIANT. Every deck is its own ancestor at depth 0, so the
      // depth-0 rows partition the collection exactly once — no card is in two
      // root decks and every deck has a root. This is the check that would have
      // caught reusing `metrics.ts`'s `deckProgress`, whose view counts dormant
      // and archived tracks too and sums 75 higher.
      const roots = g.decks.filter((deck) => deck.depth === 0);
      expect(roots.length).toBeGreaterThan(0);
      expect(roots.reduce((sum, deck) => sum + deck.live, 0)).toBe(g.collection.live);
      expect(roots.reduce((sum, deck) => sum + deck.learned, 0)).toBe(g.collection.learned);

      // A deck can never claim more learned than it holds.
      for (const deck of g.decks) {
        expect(deck.learned).toBeLessThanOrEqual(deck.live);
        expect(deck.depth).toBeGreaterThanOrEqual(0);
      }
      // Tree order, so indentation in the UI reads as nesting — and NATURAL order, so
      // 基本情報's 第2章 comes before 第10章 (it used to be a plain `.sort()`, which
      // pinned 第1章, 第10章, 第11章 … as correct).
      const paths = g.decks.map((deck) => deck.path);
      expect([...paths].sort(compareDeckPaths)).toEqual(paths);
    } finally {
      db.close();
    }
  });

  it("carries a cumulative that ends exactly at the headline", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const g = collectGlance(db as never);

      // TWELVE CONTIGUOUS MONTHS ending on this one — the same rule as `recent`,
      // and a month he started nothing in is a gap that must show as one.
      expect(g.learnedByMonth).toHaveLength(12);
      for (let i = 1; i < g.learnedByMonth.length; i += 1) {
        expect(g.learnedByMonth[i]!.month).toBe(shiftMonth(g.learnedByMonth[i - 1]!.month, 1));
      }
      expect(g.learnedByMonth.at(-1)!.month).toBe(g.today.date.slice(0, 7));

      // The cumulative runs from 2022, not from the start of the window — so the
      // last bar's running total IS the tile. This is what makes the chart and the
      // headline the same claim rather than two.
      expect(g.learnedByMonth.at(-1)!.cumulative).toBe(g.collection.learned);
      for (let i = 1; i < g.learnedByMonth.length; i += 1) {
        const previous = g.learnedByMonth[i - 1]!;
        const current = g.learnedByMonth[i]!;
        expect(current.cumulative).toBe(previous.cumulative + current.learned);
      }
    } finally {
      db.close();
    }
  });

  it("is empty-safe, and the months still run", () => {
    const db = openDatabase(":memory:");
    try {
      const g = collectGlance(db, { today: "2026-08-26" });
      expect(g.collection.learned).toBe(0);
      expect(g.decks).toEqual([]);
      expect(g.learnedByMonth).toHaveLength(12);
      expect(g.learnedByMonth.every((month) => month.learned === 0)).toBe(true);
      expect(g.learnedByMonth.every((month) => month.cumulative === 0)).toBe(true);
      expect(g.learnedByMonth.at(-1)!.month).toBe("2026-08");
    } finally {
      db.close();
    }
  });
});

describe("shiftMonth", () => {
  it("does not lose a month when today is the 31st", () => {
    // `new Date(2026, 8, 31)` minus a month is 1 October, not September. The
    // helper works on day 1 for exactly this reason, and this is the regression.
    expect(shiftMonth("2026-08", -1)).toBe("2026-07");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-03", -11)).toBe("2025-04");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-08", 0)).toBe("2026-08");
  });
});

describe("compareDeckPaths", () => {
  it("orders numbered chapters as numbers, the way 基本情報's 21 read", () => {
    const shuffled = ["基本情報/第10章", "基本情報/第2章", "基本情報/第1章", "基本情報/第21章", "基本情報/科目B"];
    const sorted = [...shuffled].sort(compareDeckPaths).filter((path) => path.includes("第"));
    expect(sorted).toEqual([
      "基本情報/第1章",
      "基本情報/第2章",
      "基本情報/第10章",
      "基本情報/第21章",
    ]);
  });

  it("moves NOTHING but the numbers — kanji keep their code-point order", () => {
    // The first cut used a Japanese collator, which reordered these by reading.
    const tree = ["日本語/単語", "日本語/原神", "日本語/数字", "日本語/文法", "日本語/漢字", "日本語/言葉"];
    expect([...tree].reverse().sort(compareDeckPaths)).toEqual(tree);
  });

  it("keeps a parent immediately before its children, whatever the sibling's characters", () => {
    const sorted = ["日本語/単語/ビジネス", "日本語 extra", "日本語/単語", "日本語"].sort(compareDeckPaths);
    expect(sorted.indexOf("日本語")).toBe(sorted.indexOf("日本語/単語") - 1);
    expect(sorted.indexOf("日本語/単語")).toBe(sorted.indexOf("日本語/単語/ビジネス") - 1);
  });
});
