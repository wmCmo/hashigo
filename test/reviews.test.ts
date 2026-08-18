import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MEMORY, checkIntegrity, openDatabase, type Db } from "../src/db/index.js";
import {
  JST_OFFSET_MINUTES,
  assertNoOrphanedReverseHistory,
  buildDeckReverseMap,
  formatInstant,
  importReviews,
  mochiCardReverse,
  mochiDeckReverse,
  planCardTracks,
  resolveCardReverse,
  type MochiCard,
  type MochiDeck,
} from "../src/import/reviews.js";
import { loadExport, walkCards, walkDecks } from "../src/import/transit.js";

/**
 * Stage 1 acceptance for the review-history import — the one part of the corpus
 * that cannot be regenerated. The synthetic blocks pin each rule the real export
 * taught us; the last block replays all three real exports and asserts the
 * oracle: 102,020 reviews, 58,937 forward, 43,083 reverse, 96.24% retention.
 */

let db: Db;

beforeEach(() => {
  db = openDatabase(MEMORY);
});

afterEach(() => {
  db.close();
});

// ─── fixtures ────────────────────────────────────────────────────────────────

/** 2022-06-27T15:00:00Z — the oldest review in the corpus, i.e. JST midnight. */
const T0 = Date.UTC(2022, 5, 27, 15, 0, 0);
const DAY = 86_400_000;

function seedDeck(id: string, options: { parent?: string; reverse?: string } = {}): void {
  db.prepare("INSERT INTO decks (id, parent_id, name, reverse) VALUES (?, ?, ?, ?)").run(
    id,
    options.parent ?? null,
    id,
    options.reverse ?? "inherit",
  );
}

function seedCard(id: string, deckId: string, reverse = "inherit"): void {
  db.prepare("INSERT INTO cards (id, deck_id, reverse) VALUES (?, ?, ?)").run(id, deckId, reverse);
}

function tracksOf(cardId: string): { kind: string; reps: number; dormant: number }[] {
  return db
    .prepare(
      "SELECT kind, reps, dormant FROM card_tracks WHERE card_id = ? ORDER BY kind",
    )
    .all(cardId) as { kind: string; reps: number; dormant: number }[];
}

function reviewsOf(cardId: string, kind: string): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT r.* FROM reviews r JOIN card_tracks t ON t.id = r.track_id
        WHERE t.card_id = ? AND t.kind = ? ORDER BY r.reviewed_at, r.id`,
    )
    .all(cardId, kind) as Record<string, unknown>[];
}

// ─── array -> track mapping ──────────────────────────────────────────────────

describe("Mochi's three arrays map onto three track kinds", () => {
  it("routes reviews / reverse-reviews / cloze-reviews to forward / reverse / cloze:0", () => {
    seedDeck("d");
    seedCard("c1", "d", "on");
    const card: MochiCard = {
      id: "c1",
      "deck-id": "d",
      reviews: [{ date: T0, due: T0, "remembered?": true }],
      "reverse-reviews": [
        { date: T0, due: T0, "remembered?": true },
        { date: T0 + DAY, due: T0 + 4 * DAY, interval: 3, duration: 12, "remembered?": false },
      ],
      "cloze/reviews": [{ date: T0, due: T0, "remembered?": true }],
      "cloze/indexes": [],
    };

    const result = importReviews(db, [card], { deckReverse: new Map([["d", "off"]]) });

    expect(result.reviewsByKind).toEqual({ forward: 1, reverse: 2, "cloze:0": 1 });
    expect(tracksOf("c1")).toEqual([
      { kind: "cloze:0", reps: 1, dormant: 0 },
      { kind: "forward", reps: 1, dormant: 0 },
      { kind: "reverse", reps: 2, dormant: 0 },
    ]);
    // Each track is independently scheduled: the reverse lapse belongs to the
    // reverse track only.
    const byKind = db
      .prepare("SELECT kind, lapses FROM card_tracks WHERE card_id = 'c1' ORDER BY kind")
      .all() as { kind: string; lapses: number }[];
    expect(byKind).toEqual([
      { kind: "cloze:0", lapses: 0 },
      { kind: "forward", lapses: 0 },
      { kind: "reverse", lapses: 1 },
    ]);
  });

  it("gives every card a forward track even with no reviews at all", () => {
    seedDeck("d");
    seedCard("new-card", "d");
    const result = importReviews(db, [{ id: "new-card", "deck-id": "d", reviews: [] }], {
      deckReverse: new Map([["d", "off"]]),
    });
    expect(result.tracks).toBe(1);
    // SPEC derives `new?` from an empty track rather than storing it.
    expect(
      db
        .prepare(
          "SELECT count(*) FROM card_tracks WHERE card_id = 'new-card' AND reps = 0 AND due_at IS NULL",
        )
        .pluck()
        .get(),
    ).toBe(1);
    expect(result.reviews).toBe(0);
  });
});

// ─── the first review ────────────────────────────────────────────────────────

describe("the first review of a track", () => {
  it("is imported even though it has no interval and no duration", () => {
    seedDeck("d");
    seedCard("c", "d");
    // Verbatim shape of a real first record: due == date, no interval, no duration.
    importReviews(
      db,
      [
        {
          id: "c",
          "deck-id": "d",
          reviews: [
            { date: T0, due: T0, "remembered?": true },
            { date: T0, due: T0 + 3 * DAY, interval: 3, duration: 71, "remembered?": true },
          ],
        },
      ],
      { deckReverse: new Map([["d", "off"]]) },
    );

    const rows = reviewsOf("c", "forward");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      interval_days: null,
      next_interval_days: null,
      duration_ms: null,
      remembered: 1,
    });
    expect(rows[1]).toMatchObject({ next_interval_days: 3, duration_ms: 71_000 });
  });

  it("tests for absence rather than for index 0 — 82 real reverse tracks carry an interval on their first record", () => {
    const plans = planCardTracks(
      {
        id: "c",
        "reverse-reviews": [
          { date: T0, due: T0 + 5 * DAY, interval: 5, "remembered?": true },
          { date: T0 + 5 * DAY, due: T0 + 15 * DAY, interval: 10, "remembered?": true },
        ],
      },
      "on",
    );
    const reverse = plans.find((p) => p.kind === "reverse");
    expect(reverse?.reviews[0]?.nextIntervalDays).toBe(5);
    // Still no PRECEDING interval: there is no earlier review to take one from.
    expect(reverse?.reviews[0]?.intervalDays).toBeNull();
    expect(reverse?.reviews[1]?.intervalDays).toBe(5);
  });

  it("refuses a review record with no date rather than inventing one", () => {
    expect(() =>
      planCardTracks({ id: "c", reviews: [{ due: T0, "remembered?": true }] }, "off"),
    ).toThrow(/no date/);
  });
});

// ─── interval direction ──────────────────────────────────────────────────────

describe("interval direction", () => {
  it("keeps Mochi's `interval` as the NEXT interval and derives the preceding one", () => {
    seedDeck("d");
    seedCard("c", "d");
    // Real chain from 基本情報 card zBUXn1Q: intervals 3, 12, 54, 191.
    importReviews(
      db,
      [
        {
          id: "c",
          "deck-id": "d",
          reviews: [
            { date: T0, due: T0, "remembered?": true },
            { date: T0, due: T0 + 3 * DAY, interval: 3, duration: 71, "remembered?": true },
            { date: T0 + 3 * DAY, due: T0 + 15 * DAY, interval: 12, duration: 38, "remembered?": true },
            { date: T0 + 15 * DAY, due: T0 + 69 * DAY, interval: 54, duration: 80, "remembered?": true },
          ],
        },
      ],
      { deckReverse: new Map([["d", "off"]]) },
    );

    const rows = reviewsOf("c", "forward").map((r) => ({
      preceded: r["interval_days"],
      scheduled: r["next_interval_days"],
    }));
    expect(rows).toEqual([
      { preceded: null, scheduled: null },
      { preceded: null, scheduled: 3 },
      { preceded: 3, scheduled: 12 },
      { preceded: 12, scheduled: 54 },
    ]);
    // The track's own interval is the last one Mochi scheduled.
    expect(
      db.prepare("SELECT interval_days FROM card_tracks WHERE card_id = 'c'").pluck().get(),
    ).toBe(54);
  });
});

// ─── timestamps ──────────────────────────────────────────────────────────────

describe("review timestamps", () => {
  it("flags every imported review time-unknown and keeps the real local DATE", () => {
    seedDeck("d");
    seedCard("c", "d");
    const result = importReviews(
      db,
      [{ id: "c", "deck-id": "d", reviews: [{ date: T0, due: T0, "remembered?": true }] }],
      { deckReverse: new Map([["d", "off"]]) },
    );
    expect(result.reviewsTimeUnknown).toBe(1);

    const row = db
      .prepare("SELECT reviewed_at, tz_offset_minutes, time_unknown FROM reviews")
      .get() as Record<string, unknown>;
    // 15:00:00Z is midnight JST; the date is real, the clock time is not.
    expect(row).toEqual({
      reviewed_at: "2022-06-28T00:00:00+09:00",
      tz_offset_minutes: JST_OFFSET_MINUTES,
      time_unknown: 1,
    });

    const log = db
      .prepare("SELECT local_date, local_hour, time_unknown FROM review_log")
      .all() as Record<string, unknown>[];
    expect(log).toEqual([{ local_date: "2022-06-28", local_hour: null, time_unknown: 1 }]);
    // The whole point: no imported review can reach the by-hour analysis.
    expect(db.prepare("SELECT count(*) FROM retention_by_hour").pluck().get()).toBe(0);
  });

  it("formats an instant with its offset, not normalised to UTC", () => {
    expect(formatInstant(T0, JST_OFFSET_MINUTES)).toBe("2022-06-28T00:00:00+09:00");
    expect(formatInstant(new Date(T0), 0)).toBe("2022-06-27T15:00:00+00:00");
    expect(formatInstant(T0, -300)).toBe("2022-06-27T10:00:00-05:00");
    expect(formatInstant(T0 + 1234, JST_OFFSET_MINUTES)).toBe("2022-06-28T00:00:01.234+09:00");
  });
});

// ─── duration ────────────────────────────────────────────────────────────────

describe("duration", () => {
  it("converts Mochi's seconds to milliseconds and keeps a present-but-null value null", () => {
    seedDeck("d");
    seedCard("c", "d");
    const result = importReviews(
      db,
      [
        {
          id: "c",
          "deck-id": "d",
          reviews: [
            { date: T0, due: T0 + DAY, interval: 1, duration: 10, "remembered?": true },
            // 17 real rows look exactly like this: the key is there, the value is null.
            { date: T0 + DAY, due: T0 + 2 * DAY, interval: 1, duration: null, "remembered?": true },
          ],
        },
      ],
      { deckReverse: new Map([["d", "off"]]) },
    );
    expect(result.reviewsWithoutDuration).toBe(1);
    expect(db.prepare("SELECT duration_ms FROM reviews ORDER BY id").pluck().all()).toEqual([
      10_000,
      null,
    ]);
    expect(db.prepare("SELECT hours FROM study_totals").pluck().get()).toBeCloseTo(10 / 3600, 9);
  });
});

// ─── three-state reverse ─────────────────────────────────────────────────────

describe("three-state reverse resolution", () => {
  it("maps review-reverse? true to on and absent-or-false to inherit, never to off", () => {
    expect(mochiCardReverse({ id: "a", "review-reverse?": true })).toBe("on");
    expect(mochiCardReverse({ id: "b", "review-reverse?": false })).toBe("inherit");
    expect(mochiCardReverse({ id: "c" })).toBe("inherit");
  });

  it("resolves inherit up the deck tree with the workspace default off at the root", () => {
    // 日本語 shape: the root is silent, 単語 sets the flag, and a subdeck inherits.
    const decks: MochiDeck[] = [
      { id: "日本語" },
      { id: "単語", "parent-id": "日本語", "review-reverse?": true },
      { id: "N1", "parent-id": "単語" },
      { id: "文法", "parent-id": "日本語", "review-reverse?": true },
      { id: "Other", "parent-id": "日本語" },
    ];
    const map = buildDeckReverseMap(decks);
    expect(Object.fromEntries(map)).toEqual({
      日本語: "off",
      単語: "on",
      N1: "on",
      文法: "on",
      Other: "off",
    });
  });

  it("lets a card beat its deck in both directions", () => {
    expect(resolveCardReverse({ id: "a", "review-reverse?": true }, "off").reverse).toBe("on");
    expect(resolveCardReverse({ id: "b" }, "on").reverse).toBe("on");
    expect(resolveCardReverse({ id: "c" }, "off").reverse).toBe("off");
  });

  it("reads the deck tree through views.sql rather than resolving it twice", () => {
    seedDeck("日本語");
    seedDeck("単語", { parent: "日本語", reverse: "on" });
    seedDeck("N1", { parent: "単語" });
    seedCard("in-n1", "N1");
    seedCard("elsewhere", "日本語");
    const result = importReviews(db, [
      { id: "in-n1", "deck-id": "N1", reviews: [] },
      { id: "elsewhere", "deck-id": "日本語", reviews: [] },
    ]);
    expect(result.reverseEnabled).toBe(1);
    expect(tracksOf("in-n1").map((t) => t.kind)).toEqual(["forward", "reverse"]);
    expect(tracksOf("elsewhere").map((t) => t.kind)).toEqual(["forward"]);
  });
});

// ─── the invariant ───────────────────────────────────────────────────────────

describe("CRITICAL INVARIANT: reverse history is never orphaned", () => {
  /**
   * The real failure, reproduced. Six cards in the corpus carry reverse history
   * while neither they nor any ancestor deck sets review-reverse?, so they
   * resolve to the workspace default 'off' — five in English/Vocabulary and one
   * in 基本情報/第15章.
   */
  function seedTheRealFailure(): MochiCard {
    seedDeck("English");
    seedDeck("Vocabulary", { parent: "English" });
    seedCard("irksome", "Vocabulary");
    return {
      id: "irksome",
      "deck-id": "Vocabulary",
      reviews: [{ date: T0, due: T0, "remembered?": true }],
      "reverse-reviews": [{ date: T0 + DAY, due: T0 + DAY, "remembered?": true }],
    };
  }

  it("forces the card to reverse on, so its records keep their track", () => {
    const card = seedTheRealFailure();
    const result = importReviews(db, [card]);

    expect(result.reverseForced).toEqual(["irksome"]);
    expect(db.prepare("SELECT reverse FROM cards WHERE id = 'irksome'").pluck().get()).toBe("on");
    expect(
      db.prepare("SELECT reverse FROM card_reverse_resolved WHERE card_id = 'irksome'").pluck().get(),
    ).toBe("on");
    expect(reviewsOf("irksome", "reverse")).toHaveLength(1);
    expect(tracksOf("irksome")).toEqual([
      { kind: "forward", reps: 1, dormant: 0 },
      { kind: "reverse", reps: 1, dormant: 0 },
    ]);
    expect(() => assertNoOrphanedReverseHistory(db)).not.toThrow();
  });

  it("EVERY card with a non-empty reverse-reviews array resolves to on", () => {
    seedDeck("root");
    seedDeck("with-flag", { parent: "root", reverse: "on" });
    const cards: MochiCard[] = [
      // deck says on
      { id: "a", "deck-id": "with-flag", "reverse-reviews": [{ date: T0, "remembered?": true }] },
      // card says on
      {
        id: "b",
        "deck-id": "root",
        "review-reverse?": true,
        "reverse-reviews": [{ date: T0, "remembered?": true }],
      },
      // nothing says on — the invariant is the only thing that saves it
      { id: "c", "deck-id": "root", "reverse-reviews": [{ date: T0, "remembered?": true }] },
      // no reverse history, and correctly stays off
      { id: "d", "deck-id": "root" },
    ];
    for (const card of cards) {
      seedCard(card.id, card["deck-id"] as string, mochiCardReverse(card));
    }
    importReviews(db, cards);

    const resolved = db
      .prepare(
        `SELECT c.card_id, c.reverse,
                (SELECT count(*) FROM card_tracks t WHERE t.card_id = c.card_id
                   AND t.kind = 'reverse') AS reverse_tracks
           FROM card_reverse_resolved c ORDER BY c.card_id`,
      )
      .all() as { card_id: string; reverse: string; reverse_tracks: number }[];
    expect(resolved).toEqual([
      { card_id: "a", reverse: "on", reverse_tracks: 1 },
      { card_id: "b", reverse: "on", reverse_tracks: 1 },
      { card_id: "c", reverse: "on", reverse_tracks: 1 },
      { card_id: "d", reverse: "off", reverse_tracks: 0 },
    ]);
    // Stated as the invariant itself, over the database: no reverse review row
    // may exist on a card that does not resolve to 'on'.
    expect(
      db
        .prepare(
          `SELECT count(*) FROM reviews r
             JOIN card_tracks t ON t.id = r.track_id
             JOIN card_reverse_resolved cr ON cr.card_id = t.card_id
            WHERE t.kind = 'reverse' AND cr.reverse <> 'on'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("without enforcement the history survives but becomes unreachable, and the assert says so", () => {
    const card = seedTheRealFailure();
    const result = importReviews(db, [card], { enforceReverseInvariant: false });

    expect(result.reverseForced).toEqual([]);
    // The records are still written — the importer will not drop an array — but
    // the track is dormant and the card resolves off, so nothing will schedule
    // or show it. That is the orphaning SPEC warns about.
    expect(reviewsOf("irksome", "reverse")).toHaveLength(1);
    expect(tracksOf("irksome")).toEqual([
      { kind: "forward", reps: 1, dormant: 0 },
      { kind: "reverse", reps: 1, dormant: 1 },
    ]);
    expect(() => assertNoOrphanedReverseHistory(db)).toThrow(/irksome \(1 reviews/);
  });
});

// ─── the {} trap ─────────────────────────────────────────────────────────────

describe("leech flags are per track", () => {
  it("treats cloze/needs-rereview? = {} as not set, because Boolean({}) is true", () => {
    seedDeck("d");
    seedCard("c", "d", "on");
    importReviews(
      db,
      [
        {
          id: "c",
          "deck-id": "d",
          reviews: [{ date: T0, "remembered?": true }],
          "reverse-reviews": [{ date: T0, "remembered?": true }],
          "cloze/reviews": [{ date: T0, "remembered?": true }],
          // All 24 cards that carry this key carry the empty MAP, not `true`.
          "cloze/needs-rereview?": {},
          "reverse/needs-rereview?": true,
          // 7 of the 8 cards carrying this key carry `false`.
          "needs-rereview?": false,
        },
      ],
      { deckReverse: new Map([["d", "on"]]) },
    );
    expect(
      db
        .prepare("SELECT kind, needs_rereview FROM card_tracks WHERE card_id = 'c' ORDER BY kind")
        .all(),
    ).toEqual([
      { kind: "cloze:0", needs_rereview: 0 },
      { kind: "forward", needs_rereview: 0 },
      { kind: "reverse", needs_rereview: 1 },
    ]);
  });
});

// ─── idempotence ─────────────────────────────────────────────────────────────

describe("re-importing", () => {
  it("is idempotent: import_key stops a second pass duplicating four years of history", () => {
    seedDeck("d");
    seedCard("c", "d");
    const card: MochiCard = {
      id: "c",
      "deck-id": "d",
      reviews: [
        { date: T0, due: T0, "remembered?": true },
        { date: T0, due: T0 + 3 * DAY, interval: 3, duration: 9, "remembered?": false },
      ],
    };
    const first = importReviews(db, [card], { deckReverse: new Map([["d", "off"]]) });
    const second = importReviews(db, [card], { deckReverse: new Map([["d", "off"]]) });

    expect(first.reviews).toBe(2);
    expect(second.reviews).toBe(0); // nothing new inserted
    expect(db.prepare("SELECT count(*) FROM reviews").pluck().get()).toBe(2);
    expect(db.prepare("SELECT count(*) FROM card_tracks").pluck().get()).toBe(1);
    expect(db.prepare("SELECT reps, lapses FROM card_tracks").get()).toEqual({
      reps: 2,
      lapses: 1,
    });
  });

  it("refuses to import reviews for a card that is not in the database", () => {
    seedDeck("d");
    expect(() =>
      importReviews(db, [{ id: "ghost", "deck-id": "d", reviews: [{ date: T0 }] }], {
        deckReverse: new Map([["d", "off"]]),
      }),
    ).toThrow(/not in the database/);
  });
});

// ─── the real corpus ─────────────────────────────────────────────────────────

const EXPORT_DIRS = ["日本語", "English", "基本情報"].map((name) =>
  resolve(import.meta.dirname, "..", "exports", name),
);
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

describe.skipIf(!HAVE_EXPORTS)("the real corpus (exports/)", () => {
  it(
    "imports exactly 102,020 reviews, 58,937 forward + 43,083 reverse, at 96.24% retention",
    () => {
      // The shared reader owns Transit decoding and the deduped walk (its own
      // traps, its own tests). This file owns only what happens to the reviews
      // inside the cards it hands back.
      const decks: MochiDeck[] = [];
      const cards: MochiCard[] = [];
      for (const dir of EXPORT_DIRS) {
        const root = loadExport(dir);
        for (const { deck } of walkDecks(root)) decks.push(deck as unknown as MochiDeck);
        for (const { card } of walkCards(root)) cards.push(card as unknown as MochiCard);
      }

      // Stand in for the deck and card importers (other agents' files): only the
      // columns this module reads, so a bug there cannot flatter these numbers.
      const insertDeck = db.prepare(
        "INSERT INTO decks (id, parent_id, name, reverse) VALUES (?, ?, ?, ?)",
      );
      const insertCard = db.prepare(
        "INSERT INTO cards (id, deck_id, name, reverse) VALUES (?, ?, ?, ?)",
      );
      db.transaction(() => {
        for (const deck of decks) {
          insertDeck.run(
            deck.id,
            deck["parent-id"] ?? null,
            (deck as { name?: string }).name ?? "",
            mochiDeckReverse(deck),
          );
        }
        for (const card of cards) {
          insertCard.run(card.id, card["deck-id"], "", mochiCardReverse(card));
        }
      })();

      expect(cards).toHaveLength(7716);

      const result = importReviews(db, cards);

      // ── THE PASS CONDITION ──────────────────────────────────────────────
      expect(result.reviews).toBe(102_020);
      expect(result.reviewsByKind["forward"]).toBe(58_937);
      expect(result.reviewsByKind["reverse"]).toBe(43_083);
      expect(result.reviewsByKind["cloze:0"]).toBeUndefined();
      expect(result.passed).toBe(98_188);
      expect(result.lapses).toBe(3_832);
      expect(((result.retention ?? 0) * 100).toFixed(2)).toBe("96.24");

      // The same figures read back out of SQL, through views.sql.
      const totals = db
        .prepare(
          `SELECT reviews, passed, lapses, round(retention * 100, 2) AS retention_pct,
                  round(hours, 1) AS hours, study_days, first_review_date,
                  last_review_date, reviews_time_unknown
             FROM study_totals`,
        )
        .get() as Record<string, unknown>;
      expect(totals).toEqual({
        reviews: 102_020,
        passed: 98_188,
        lapses: 3_832,
        retention_pct: 96.24,
        hours: 636.1,
        study_days: 1_317,
        first_review_date: "2022-06-28",
        last_review_date: "2026-08-18",
        reviews_time_unknown: 102_020,
      });
      // Every single review is date-only, so the by-hour analysis must be empty.
      expect(db.prepare("SELECT count(*) FROM retention_by_hour").pluck().get()).toBe(0);

      const byKind = db
        .prepare(
          `SELECT track_kind, count(*) AS reviews FROM review_log
            GROUP BY track_kind ORDER BY track_kind`,
        )
        .all();
      expect(byKind).toEqual([
        { track_kind: "forward", reviews: 58_937 },
        { track_kind: "reverse", reviews: 43_083 },
      ]);

      // ── the invariant, over the real data ───────────────────────────────
      expect(() => assertNoOrphanedReverseHistory(db)).not.toThrow();
      expect([...result.reverseForced].sort()).toEqual(
        ["6bOaHfsA", "9IsiWF95", "J3R240Q0", "izVJ06yd", "oYjmEPwB", "rhX2sKTs"].sort(),
      );
      const cardsWithReverseHistory = cards.filter(
        (c) => (c["reverse-reviews"] ?? []).length > 0,
      ).length;
      expect(cardsWithReverseHistory).toBe(3_778);
      expect(
        db
          .prepare(
            `SELECT count(*) FROM card_tracks t
               JOIN card_reverse_resolved cr ON cr.card_id = t.card_id
              WHERE t.kind = 'reverse' AND (cr.reverse <> 'on' OR t.dormant = 1)`,
          )
          .pluck()
          .get(),
      ).toBe(0);

      // Tracks: one forward per card, plus one reverse per reverse-enabled card.
      expect(result.tracksByKind).toEqual({ forward: 7_716, reverse: 5_676 });
      expect(result.tracks).toBe(13_392);

      // No preceding interval for a track's first review, nor where the
      // predecessor carried none. Never guessed.
      expect(result.reviewsWithoutInterval).toBe(17_960);
      expect(result.reviewsWithoutDuration).toBe(102_020 - 92_089);

      expect(checkIntegrity(db)).toEqual([]);

      // eslint-disable-next-line no-console
      console.log("corpus import", {
        ...result,
        reverseForced: result.reverseForced.length,
        tracksByKind: result.tracksByKind,
        reviewsByKind: result.reviewsByKind,
        retention: `${((result.retention ?? 0) * 100).toFixed(2)}%`,
      });
      // eslint-disable-next-line no-console
      console.log("study_totals", totals);
      // eslint-disable-next-line no-console
      console.log(
        "retention_by_interval",
        db
          .prepare(
            `SELECT interval_bucket_label AS bucket, reviews, lapses,
                    round(retention * 100, 2) AS retention_pct
               FROM retention_by_interval ORDER BY interval_bucket`,
          )
          .all(),
      );
    },
    240_000,
  );
});
