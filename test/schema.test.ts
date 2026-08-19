import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MEMORY, checkIntegrity, openDatabase, schemaVersion, type Db } from "../src/db/index.js";
import {
  BINARY_GRADE,
  FROZEN_FSRS_WEIGHTS,
  FTS_MIN_QUERY_CHARS,
  FTS_TOKENIZER,
  GRADES_ARE_BINARY,
  INTERVAL_BASES,
  RETENTION_BY_INTERVAL_VIEW,
  SCHEMA_VERSION,
  TABLES,
  VIEWS,
  buildSearchText,
  clozeTrack,
  escapeLike,
  gradeFor,
  parseTrackKind,
  searchPlan,
} from "../src/schema/index.js";
import { TARGET_RETENTION } from "../src/scheduler/policy.js";

/**
 * Stage 1 acceptance. Each block below pins one schema half that SPEC.html says
 * must land now or become a migration over 7,716 cards and 102,020 reviews.
 *
 * The load-bearing one is "finds Japanese by a mid-string substring": it is the
 * proof that the FTS5 tokeniser choice is right, and it fails on SQLite's
 * default tokeniser, which is demonstrated in the same test rather than
 * asserted.
 */

let db: Db;

beforeEach(() => {
  db = openDatabase(MEMORY);
});

afterEach(() => {
  db.close();
});

/** A deck, a template with one field, and one card — the minimum to insert into. */
function seedCard(
  cardId: string,
  fields: Readonly<Record<string, string>> = {},
  options: { readonly deckId?: string; readonly name?: string; readonly content?: string } = {},
): void {
  const deckId = options.deckId ?? "deck-単語";
  db.prepare("INSERT OR IGNORE INTO decks (id, name) VALUES (?, ?)").run(deckId, "単語");
  db.prepare("INSERT INTO cards (id, deck_id, name, content) VALUES (?, ?, ?, ?)").run(
    cardId,
    deckId,
    options.name ?? "",
    options.content ?? "",
  );
  const insertValue = db.prepare(
    "INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?)",
  );
  for (const [fieldId, value] of Object.entries(fields)) {
    insertValue.run(cardId, fieldId, value);
  }
  // Every write path owes search_text. The raw values above are stored verbatim;
  // only this derived column is rendered and stripped.
  refreshSearchText(cardId);
}

/**
 * What the importer and the editor must do after any content edit: recompute
 * `cards.search_text` from the raw content and field values. There is no SQL
 * that can do it — link stripping needs a regex — so this is the one place the
 * transform is applied, via `buildSearchText`.
 */
function refreshSearchText(cardId: string): void {
  const card = db.prepare("SELECT content FROM cards WHERE id = ?").get(cardId) as
    | { content: string }
    | undefined;
  if (!card) return;
  const values = db
    .prepare("SELECT value FROM card_field_values WHERE card_id = ? ORDER BY field_id")
    .all(cardId) as { value: string }[];
  db.prepare("UPDATE cards SET search_text = ? WHERE id = ?").run(
    buildSearchText(card.content, ...values.map((row) => row.value)),
    cardId,
  );
}

function createTrack(cardId: string, kind: string): number {
  const info = db
    .prepare("INSERT INTO card_tracks (card_id, kind) VALUES (?, ?)")
    .run(cardId, kind);
  return Number(info.lastInsertRowid);
}

describe("open", () => {
  it("stamps the version, enables foreign keys, and creates every table and view", () => {
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    const objects = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as {
        name: string;
      }[]).map((row) => row.name),
    );
    for (const table of TABLES) expect(objects.has(table), `missing table ${table}`).toBe(true);
    for (const view of VIEWS) expect(objects.has(view), `missing view ${view}`).toBe(true);
    expect(checkIntegrity(db)).toEqual([]);
  });

  it("uses WAL on a file database and re-opens it without reapplying the schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "hashigo-schema-"));
    try {
      const file = join(dir, "hashigo.db");
      const first = openDatabase(file);
      expect(first.pragma("journal_mode", { simple: true })).toBe("wal");
      first.prepare("INSERT INTO decks (id, name) VALUES ('d', '日本語')").run();
      first.close();

      const second = openDatabase(file);
      expect(schemaVersion(second)).toBe(SCHEMA_VERSION);
      expect(
        second.prepare("SELECT name FROM decks WHERE id = 'd'").get(),
      ).toEqual({ name: "日本語" });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FTS over Japanese", () => {
  it("finds a card by a MID-STRING Japanese substring", () => {
    seedCard("card-1", { f1: "単語の意味は「word」です", f2: "これは例文です" }, { name: "単語" });
    seedCard("card-2", { f1: "全く関係のない文章" }, { name: "無関係" });

    const hits = db
      .prepare("SELECT card_id FROM card_fts WHERE card_fts MATCH ?")
      .all('"語の意"') as { card_id: string }[];

    expect(hits.map((row) => row.card_id)).toEqual(["card-1"]);
    console.log(`  tokenize=${FTS_TOKENIZER}  MATCH '"語の意"' ->`, hits);

    // Same data, SQLite's default tokeniser: this is what the trigram choice
    // buys, and why it had to be settled at stage 1.
    db.exec("CREATE VIRTUAL TABLE control_fts USING fts5(card_id UNINDEXED, body)");
    db.prepare("INSERT INTO control_fts (card_id, body) VALUES (?, ?)").run(
      "card-1",
      "単語の意味は「word」です",
    );
    const control = db
      .prepare("SELECT card_id FROM control_fts WHERE control_fts MATCH ?")
      .all('"語の意"');
    expect(control).toEqual([]);
    console.log("  tokenize=unicode61 (default) same query ->", control);
  });

  it("indexes card names and tag paths, and follows edits and deletes", () => {
    db.prepare("INSERT INTO tags (path, parent_path, name) VALUES ('Dialect', NULL, 'Dialect')").run();
    db.prepare(
      "INSERT INTO tags (path, parent_path, name) VALUES ('Dialect/Kansai', 'Dialect', 'Kansai')",
    ).run();
    seedCard("card-3", { f1: "ほんまに" }, { name: "関西弁のカード" });
    db.prepare("INSERT INTO card_tags (card_id, tag_path) VALUES ('card-3', 'Dialect/Kansai')").run();

    const byName = db
      .prepare("SELECT card_id FROM card_fts WHERE card_fts MATCH ?")
      .all('name:"西弁の"') as { card_id: string }[];
    expect(byName.map((row) => row.card_id)).toEqual(["card-3"]);

    const byTag = db
      .prepare("SELECT card_id FROM card_fts WHERE card_fts MATCH ?")
      .all('tags:"ct/Kan"') as { card_id: string }[];
    expect(byTag.map((row) => row.card_id)).toEqual(["card-3"]);

    db.prepare("UPDATE card_field_values SET value = ? WHERE card_id = ? AND field_id = ?").run(
      "せやろ",
      "card-3",
      "f1",
    );
    // THE STALENESS HAZARD, asserted rather than left as a surprise. Because the
    // index reads the derived cards.search_text, a writer that edits a field
    // value and does not recompute it leaves the old text indexed. No SQL can
    // enforce this; the test pins it so nobody meets it in the search box first.
    expect(db.prepare("SELECT count(*) c FROM card_fts WHERE card_fts MATCH ?").get('"ほんまに"'))
      .toEqual({ c: 1 });

    refreshSearchText("card-3");
    expect(db.prepare("SELECT count(*) c FROM card_fts WHERE card_fts MATCH ?").get('"ほんまに"'))
      .toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) c FROM card_fts WHERE card_fts MATCH ?").get('"せやろ"'))
      .toEqual({ c: 1 });

    db.prepare("DELETE FROM cards WHERE id = 'card-3'").run();
    expect(db.prepare("SELECT count(*) c FROM card_fts").get()).toEqual({ c: 0 });
  });
});

describe("review tracks", () => {
  it("keeps forward, reverse and cloze:n as independent logs on one card", () => {
    seedCard("card-4");
    const forward = createTrack("card-4", "forward");
    const reverse = createTrack("card-4", "reverse");
    const cloze = createTrack("card-4", clozeTrack(3));

    expect(parseTrackKind("cloze:3")).toBe("cloze:3");
    expect(parseTrackKind("cloze:x")).toBeNull();
    expect(() => createTrack("card-4", "cloze:x")).toThrow(/CHECK constraint failed/);
    expect(() => createTrack("card-4", "forward")).toThrow(/UNIQUE constraint failed/);

    const insert = db.prepare(
      "INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown," +
        " remembered, scheduled_days, duration_ms, source, import_key)" +
        " VALUES (?, ?, 540, 1, ?, ?, ?, 'mochi', ?)",
    );
    insert.run(forward, "2022-06-26T15:00:00Z", 1, 24.7, 10_000, "card-4/forward/0");
    insert.run(forward, "2022-06-26T15:00:00Z", 0, 24.7, 12_000, "card-4/forward/1");
    insert.run(reverse, "2023-01-01T15:00:00Z", 1, 400, 8_000, "card-4/reverse/0");
    insert.run(cloze, "2023-02-01T15:00:00Z", 1, 3, 5_000, "card-4/cloze:3/0");

    const perTrack = db
      .prepare(
        "SELECT track_kind, count(*) reviews FROM review_log" +
          " GROUP BY track_kind ORDER BY track_kind",
      )
      .all();
    expect(perTrack).toEqual([
      { track_kind: "cloze:3", reviews: 1 },
      { track_kind: "forward", reviews: 2 },
      { track_kind: "reverse", reviews: 1 },
    ]);

    // Two reviews of one track can share reviewed_at exactly, because Mochi
    // stored dates. import_key is what makes re-import idempotent.
    expect(() =>
      insert.run(forward, "2022-06-26T15:00:00Z", 1, 24.7, 10_000, "card-4/forward/0"),
    ).toThrow(/UNIQUE constraint failed: reviews.import_key/);
  });

  it("carries the leech flag per track, which is where Mochi keeps it", () => {
    seedCard("card-11");
    const forward = createTrack("card-11", "forward");
    const reverse = createTrack("card-11", "reverse");
    db.prepare("UPDATE card_tracks SET needs_rereview = 1 WHERE id = ?").run(reverse);

    expect(
      db
        .prepare("SELECT kind, needs_rereview FROM card_tracks WHERE card_id = 'card-11' ORDER BY kind")
        .all(),
    ).toEqual([
      { kind: "forward", needs_rereview: 0 },
      { kind: "reverse", needs_rereview: 1 },
    ]);
    expect(forward).not.toBe(reverse);
    // The card-level flag is separate and stays addressable for the UI.
    expect(
      db.prepare("SELECT needs_rereview FROM cards WHERE id = 'card-11'").get(),
    ).toEqual({ needs_rereview: 0 });
  });

  it("names the measured interval and the planned one separately, and they differ", () => {
    seedCard("card-12");
    const track = createTrack("card-12", "forward");
    const insert = db.prepare(
      "INSERT INTO reviews (track_id, reviewed_at, time_unknown, remembered, elapsed_days," +
        " scheduled_days, next_scheduled_days, due_at, duration_ms)" +
        " VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?)",
    );
    // Mochi stores date, due and interval == due - date, so next_scheduled_days
    // is Mochi's own field and scheduled_days is the PRECEDING row's copy of it.
    // The review planned for 2024-01-04 was actually taken on 2024-01-10: six
    // days late, which is the whole reason both numbers exist. 22,226 reviews in
    // the real corpus were taken more than 1.5 days late.
    insert.run(track, "2024-01-01T15:00:00Z", null, null, 3, "2024-01-04T15:00:00Z", 71_000);
    insert.run(track, "2024-01-10T15:00:00Z", 9, 3, 12, "2024-01-22T15:00:00Z", 38_000);

    expect(
      db
        .prepare(
          "SELECT elapsed_days, scheduled_days, next_scheduled_days, due_at" +
            " FROM reviews ORDER BY reviewed_at",
        )
        .all(),
    ).toEqual([
      {
        elapsed_days: null,
        scheduled_days: null,
        next_scheduled_days: 3,
        due_at: "2024-01-04T15:00:00Z",
      },
      {
        elapsed_days: 9,
        scheduled_days: 3,
        next_scheduled_days: 12,
        due_at: "2024-01-22T15:00:00Z",
      },
    ]);

    // The ambiguous name is gone from every object, so a stale query fails
    // loudly instead of returning a plausible wrong number.
    for (const object of [
      "reviews",
      "review_log",
      "review_log_elapsed",
      "card_tracks",
      "review_log_bucketed",
    ]) {
      expect(
        () => db.prepare(`SELECT interval_days FROM ${object}`).all(),
        `interval_days still resolves on ${object}`,
      ).toThrow(/no such column/);
    }

    // review_log itself carries only what is stored. The measured interval —
    // and therefore anything that can be plotted — comes from review_log_elapsed,
    // which is where the window is paid for.
    expect(() => db.prepare("SELECT elapsed_days FROM review_log").all()).toThrow(
      /no such column/,
    );
    const log = db
      .prepare(
        "SELECT elapsed_days, elapsed_days_stored, elapsed_days_measured, scheduled_days" +
          " FROM review_log_elapsed ORDER BY reviewed_at",
      )
      .all();
    console.log("  review_log_elapsed intervals ->", log);
    expect(log).toEqual([
      {
        elapsed_days: null,
        elapsed_days_stored: null,
        elapsed_days_measured: null,
        scheduled_days: null,
      },
      {
        elapsed_days: 9,
        elapsed_days_stored: 9,
        elapsed_days_measured: 9,
        scheduled_days: 3,
      },
    ]);

    // Both stored facts are audited against the timestamps and against the
    // preceding row. No rows means the denormalisation is honest.
    expect(db.prepare("SELECT * FROM review_interval_audit").all()).toEqual([]);
  });

  it("backfills elapsed_days from the timestamps when it was never stored", () => {
    seedCard("card-13");
    const track = createTrack("card-13", "forward");
    // The 8,934-row case: Mochi recorded no interval, so scheduled_days is NULL
    // and the importer had nothing to copy into elapsed_days either. The gap is
    // still a measured fact, and review_log recovers it.
    const insert = db.prepare(
      "INSERT INTO reviews (track_id, reviewed_at, time_unknown, remembered) VALUES (?, ?, 1, 1)",
    );
    insert.run(track, "2024-03-01T15:00:00Z");
    insert.run(track, "2024-03-08T15:00:00Z");
    insert.run(track, "2024-03-08T15:00:00Z"); // same day: 0, not NULL and not a guess
    insert.run(track, "2025-04-01T15:00:00Z"); // 389d: past the year the planned basis cannot see

    const rows = db
      .prepare(
        "SELECT elapsed_days, elapsed_days_stored, scheduled_days FROM review_log_elapsed" +
          " ORDER BY reviewed_at, review_id",
      )
      .all();
    console.log("  backfilled elapsed ->", rows);
    expect(rows).toEqual([
      { elapsed_days: null, elapsed_days_stored: null, scheduled_days: null },
      { elapsed_days: 7, elapsed_days_stored: null, scheduled_days: null },
      { elapsed_days: 0, elapsed_days_stored: null, scheduled_days: null },
      { elapsed_days: 389, elapsed_days_stored: null, scheduled_days: null },
    ]);

    // OVERNIGHT.md 2.5 in miniature: the planned basis reports nothing past a
    // year, the measured basis reports the observation that actually exists.
    const elapsed = db
      .prepare(
        "SELECT interval_bucket_label, reviews FROM " +
          RETENTION_BY_INTERVAL_VIEW.elapsed +
          " WHERE interval_bucket = 8",
      )
      .all();
    const scheduled = db
      .prepare(
        "SELECT interval_bucket_label, reviews FROM " +
          RETENTION_BY_INTERVAL_VIEW.scheduled +
          " WHERE interval_bucket = 8",
      )
      .all();
    expect(elapsed).toEqual([{ interval_bucket_label: "> 365d", reviews: 1 }]);
    expect(scheduled).toEqual([]);
    expect(INTERVAL_BASES).toEqual(["elapsed", "scheduled"]);
    console.log("  > 365d  elapsed ->", elapsed, " scheduled ->", scheduled);
  });

  it("catches a broken interval chain instead of trusting the stored copy", () => {
    seedCard("card-14");
    const track = createTrack("card-14", "forward");
    const insert = db.prepare(
      "INSERT INTO reviews (track_id, reviewed_at, time_unknown, remembered, elapsed_days," +
        " scheduled_days, next_scheduled_days) VALUES (?, ?, 1, 1, ?, ?, ?)",
    );
    insert.run(track, "2024-01-01T15:00:00Z", null, null, 3);
    // elapsed_days claims 30 where the timestamps say 9, and scheduled_days
    // claims 99 where the previous row scheduled 3. Both are exactly the drift
    // that made one column mean three things.
    insert.run(track, "2024-01-10T15:00:00Z", 30, 99, 12);

    const problems = db
      .prepare("SELECT problem, stored, expected FROM review_interval_audit ORDER BY problem")
      .all();
    console.log("  review_interval_audit ->", problems);
    expect(problems).toEqual([
      { problem: "elapsed-mismatch", stored: 30, expected: 9 },
      { problem: "scheduled-chain-break", stored: 99, expected: 3 },
    ]);
  });

  it("is append-only", () => {
    seedCard("card-5");
    const track = createTrack("card-5", "forward");
    db.prepare(
      "INSERT INTO reviews (track_id, reviewed_at, remembered) VALUES (?, '2026-08-19T23:14:05+09:00', 1)",
    ).run(track);
    expect(() => db.prepare("UPDATE reviews SET remembered = 0").run()).toThrow(
      /append-only/,
    );
  });

  it("switching reverse off leaves the track dormant, not deleted", () => {
    seedCard("card-6");
    const reverse = createTrack("card-6", "reverse");
    db.prepare(
      "INSERT INTO reviews (track_id, reviewed_at, time_unknown, remembered) " +
        "VALUES (?, '2023-05-05T15:00:00Z', 1, 1)",
    ).run(reverse);

    db.prepare("UPDATE cards SET reverse = 'off' WHERE id = 'card-6'").run();
    db.prepare("UPDATE card_tracks SET dormant = 1 WHERE id = ?").run(reverse);

    expect(
      db.prepare("SELECT count(*) c FROM reviews WHERE track_id = ?").get(reverse),
    ).toEqual({ c: 1 });
    expect(
      db.prepare("SELECT reverse FROM card_reverse_resolved WHERE card_id = 'card-6'").get(),
    ).toEqual({ reverse: "off" });
  });
});

describe("review timestamps", () => {
  it("separates a real local hour from an imported date-only review", () => {
    seedCard("card-7");
    const track = createTrack("card-7", "forward");
    const insert = db.prepare(
      "INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown, remembered)" +
        " VALUES (?, ?, ?, ?, 1)",
    );
    // Imported: Mochi stored midnight JST for a review done on 2022-06-27.
    insert.run(track, "2022-06-26T15:00:00Z", 540, 1);
    // Authored now, with the offset that makes 23:00 in Tokyo a different fact
    // from 23:00 abroad.
    insert.run(track, "2026-08-19T23:14:05+09:00", 540, 0);
    insert.run(track, "2026-08-19T23:14:05-07:00", -420, 0);

    const rows = db
      .prepare(
        "SELECT local_date, local_hour, time_unknown FROM review_log ORDER BY reviewed_at",
      )
      .all();
    expect(rows).toEqual([
      { local_date: "2022-06-27", local_hour: null, time_unknown: 1 },
      { local_date: "2026-08-19", local_hour: 23, time_unknown: 0 },
      { local_date: "2026-08-19", local_hour: 23, time_unknown: 0 },
    ]);

    // The point of the flag: no false spike at hour 0.
    const hours = db.prepare("SELECT local_hour, reviews FROM retention_by_hour").all();
    expect(hours).toEqual([{ local_hour: 23, reviews: 2 }]);
    console.log("  retention_by_hour ->", hours, "  review_log ->", rows);
  });

  it("computes the dashboard aggregate from the review log", () => {
    seedCard("card-8");
    const track = createTrack("card-8", "forward");
    const insert = db.prepare(
      "INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown," +
        " remembered, scheduled_days, duration_ms) VALUES (?, ?, 540, 1, ?, ?, ?)",
    );
    // Three reviews on three consecutive days, planned at 0.5d, 30d and 400d.
    // Studied far ahead of schedule, which is SPEC's over-studying finding.
    insert.run(track, "2024-01-01T15:00:00Z", 1, 0.5, 3_600_000);
    insert.run(track, "2024-01-02T15:00:00Z", 1, 30, 1_800_000);
    insert.run(track, "2024-01-03T15:00:00Z", 0, 400, 1_800_000);

    expect(
      db.prepare("SELECT reviews, lapses, retention, hours, study_days FROM study_totals").get(),
    ).toEqual({ reviews: 3, lapses: 1, retention: 2 / 3, hours: 2, study_days: 3 });

    // THE SAME THREE REVIEWS, THE TWO BASES, COMPLETELY DIFFERENT CHARTS. This
    // is the defect in miniature: one of these used to be the only one on
    // screen, and nothing on the page said which.
    const scheduled = db
      .prepare(
        "SELECT interval_bucket_label, reviews, lapses FROM retention_by_scheduled_interval" +
          " ORDER BY interval_bucket",
      )
      .all();
    const elapsed = db
      .prepare(
        "SELECT interval_bucket_label, reviews, lapses FROM retention_by_elapsed_interval" +
          " ORDER BY interval_bucket",
      )
      .all();
    console.log("  by scheduled ->", scheduled);
    console.log("  by elapsed   ->", elapsed);

    expect(scheduled).toEqual([
      { interval_bucket_label: "<= 1d", reviews: 1, lapses: 0 },
      { interval_bucket_label: "21-60d", reviews: 1, lapses: 0 },
      { interval_bucket_label: "> 365d", reviews: 1, lapses: 1 },
    ]);
    expect(elapsed).toEqual([
      { interval_bucket_label: "unknown", reviews: 1, lapses: 0 }, // no predecessor
      { interval_bucket_label: "<= 1d", reviews: 2, lapses: 1 },
    ]);

    // The ambiguous view name is gone too, for the same reason as the column.
    expect(() => db.prepare("SELECT * FROM retention_by_interval").all()).toThrow(
      /no such table/,
    );
  });
});

describe("three-state reverse", () => {
  beforeEach(() => {
    db.prepare("INSERT INTO decks (id, parent_id, name, reverse) VALUES ('日本語', NULL, '日本語', 'inherit')").run();
    db.prepare("INSERT INTO decks (id, parent_id, name, reverse) VALUES ('単語', '日本語', '単語', 'on')").run();
    db.prepare("INSERT INTO decks (id, parent_id, name, reverse) VALUES ('敬語', '単語', '敬語', 'inherit')").run();
    db.prepare("INSERT INTO decks (id, parent_id, name, reverse) VALUES ('数字', '単語', '数字', 'off')").run();
  });

  it("resolves up the deck tree, with the workspace default off at the root", () => {
    const resolved = db
      .prepare(
        "SELECT p.path, r.reverse FROM deck_reverse_resolved r" +
          " JOIN deck_paths p ON p.deck_id = r.deck_id ORDER BY p.path",
      )
      .all();
    expect(resolved).toEqual([
      { path: "日本語", reverse: "off" }, // inherit -> workspace default
      { path: "日本語/単語", reverse: "on" }, // explicit
      // BINARY collation: 敬 U+656C sorts before 数 U+6570.
      { path: "日本語/単語/敬語", reverse: "on" }, // inherit -> nearest ancestor
      { path: "日本語/単語/数字", reverse: "off" }, // subdeck overrides its parent
    ]);
    console.log("  deck_reverse_resolved ->", resolved);
  });

  it("lets a card beat its deck in both directions", () => {
    seedCard("inherits-on", {}, { deckId: "単語" });
    seedCard("explicit-off", {}, { deckId: "単語" });
    seedCard("inherits-off", {}, { deckId: "数字" });
    seedCard("explicit-on", {}, { deckId: "数字" });
    seedCard("root-default", {}, { deckId: "日本語" });
    db.prepare("UPDATE cards SET reverse = 'off' WHERE id = 'explicit-off'").run();
    db.prepare("UPDATE cards SET reverse = 'on' WHERE id = 'explicit-on'").run();

    const resolved = db
      .prepare("SELECT card_id, deck_reverse, card_reverse, reverse FROM card_reverse_resolved ORDER BY card_id")
      .all();
    expect(resolved).toEqual([
      { card_id: "explicit-off", deck_reverse: "on", card_reverse: "off", reverse: "off" },
      { card_id: "explicit-on", deck_reverse: "off", card_reverse: "on", reverse: "on" },
      { card_id: "inherits-off", deck_reverse: "off", card_reverse: "inherit", reverse: "off" },
      { card_id: "inherits-on", deck_reverse: "on", card_reverse: "inherit", reverse: "on" },
      { card_id: "root-default", deck_reverse: "off", card_reverse: "inherit", reverse: "off" },
    ]);
    console.log("  card_reverse_resolved ->", resolved);

    expect(() => db.prepare("UPDATE cards SET reverse = 'maybe' WHERE id = 'explicit-on'").run())
      .toThrow(/CHECK constraint failed/);
  });

  it("nests deck paths and keeps the per-deck target retention inheritable", () => {
    expect(db.prepare("SELECT path, depth FROM deck_paths WHERE deck_id = '敬語'").get()).toEqual({
      path: "日本語/単語/敬語",
      depth: 2,
    });

    // SPEC: target retention is a per-deck setting, defaulting to the workspace
    // value, because 漢字 and 基本情報 have different stakes.
    db.prepare("UPDATE decks SET target_retention = 0.85 WHERE id = '単語'").run();
    expect(
      db
        .prepare(
          "SELECT deck_id, target_retention FROM deck_target_retention_resolved" +
            " WHERE deck_id IN ('日本語', '単語', '敬語') ORDER BY deck_id",
        )
        .all(),
    ).toEqual([
      { deck_id: "単語", target_retention: 0.85 },
      { deck_id: "敬語", target_retention: 0.85 },
      { deck_id: "日本語", target_retention: 0.9 },
    ]);
  });

  // Regression: the seeded default and src/scheduler/policy.ts disagreed, so the
  // resolved view silently returned a different target than every artefact
  // claimed. They are now both 0.90 — settled 2026-08-19 after measuring the load
  // under the 365-day cap: 0.90 gives 62-97 reviews/day against a realised 69.2,
  // where 0.95 gives 130-204. This test exists to keep the two in lockstep, so
  // if you change one and not the other it fails here.
  it("seeds the target retention Zach settled (0.90), in lockstep with policy.ts", () => {
    // Read the constant rather than a literal, so the two genuinely cannot drift.
    const seeded = db
      .prepare("SELECT value FROM settings WHERE key = 'target_retention.default'")
      .get() as { value: string };
    expect(Number(seeded.value)).toBe(TARGET_RETENTION);
    expect(TARGET_RETENTION).toBe(0.9);

    // and a deck with no override of its own inherits exactly that
    // (日本語 is the fixture's un-overridden root; 単語 carries 0.85 from above)
    expect(
      db
        .prepare("SELECT target_retention FROM deck_target_retention_resolved WHERE deck_id = '日本語'")
        .get(),
    ).toEqual({ target_retention: TARGET_RETENTION });
  });
});

describe("tags as materialised paths", () => {
  it("requires every prefix to exist and serves the subtree by prefix scan", () => {
    expect(() =>
      db
        .prepare("INSERT INTO tags (path, parent_path, name) VALUES ('Dialect/Kansai', 'Dialect', 'Kansai')")
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);

    const insert = db.prepare("INSERT INTO tags (path, parent_path, name) VALUES (?, ?, ?)");
    insert.run("Dialect", null, "Dialect");
    insert.run("Dialect/Kansai", "Dialect", "Kansai");
    insert.run("Dialect/Kansai/Osaka", "Dialect/Kansai", "Osaka");

    // A path that disagrees with its parent + name is not representable.
    expect(() => insert.run("Dialect/Tohoku", "Dialect", "Kansai")).toThrow(
      /CHECK constraint failed/,
    );

    seedCard("card-9", {}, { name: "たこ焼き" });
    db.prepare("INSERT INTO card_tags (card_id, tag_path) VALUES ('card-9', 'Dialect/Kansai/Osaka')").run();

    expect(db.prepare("SELECT path, depth FROM tags ORDER BY path").all()).toEqual([
      { path: "Dialect", depth: 0 },
      { path: "Dialect/Kansai", depth: 1 },
      { path: "Dialect/Kansai/Osaka", depth: 2 },
    ]);
    expect(
      db.prepare("SELECT path, cards_direct, cards_subtree FROM tag_usage ORDER BY path").all(),
    ).toEqual([
      { path: "Dialect", cards_direct: 0, cards_subtree: 1 },
      { path: "Dialect/Kansai", cards_direct: 0, cards_subtree: 1 },
      { path: "Dialect/Kansai/Osaka", cards_direct: 1, cards_subtree: 1 },
    ]);
  });
});

describe("card links", () => {
  it("represents an unresolved target instead of dropping it", () => {
    seedCard("越す", {}, { name: "越す" });
    seedCard("に越したことはない", {}, { name: "～に越したことはない" });
    const insert = db.prepare(
      "INSERT INTO card_links (from_card_id, to_card_id, display_text, ordinal) VALUES (?, ?, ?, ?)",
    );
    insert.run("に越したことはない", "越す", "越す", 0);
    insert.run("に越したことはない", "card-never-exported", "引く", 1);

    expect(
      db
        .prepare(
          "SELECT to_card_id, display_text, resolved FROM card_links_resolved" +
            " WHERE from_card_id = ? ORDER BY ordinal",
        )
        .all("に越したことはない"),
    ).toEqual([
      { to_card_id: "越す", display_text: "越す", resolved: 1 },
      { to_card_id: "card-never-exported", display_text: "引く", resolved: 0 },
    ]);
  });
});

describe("blobs", () => {
  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);

  beforeEach(() => {
    seedCard("card-10");
    db.prepare(
      "INSERT INTO blobs (hash, kind, mime, byte_size, source_text, voice, lang)" +
        " VALUES (?, 'speech', 'audio/mpeg', 4096, ?, 'ja-JP-NanamiNeural', 'ja-JP')",
    ).run(HASH_A, "スプリント");
    db.prepare(
      "INSERT INTO blobs (hash, kind, mime, byte_size, source_text, voice, lang)" +
        " VALUES (?, 'speech', 'audio/mpeg', 4096, ?, 'ja-JP-NanamiNeural', 'ja-JP')",
    ).run(HASH_B, "スプリント計画");
  });

  it("refcounts by reference rows and refuses to delete a referenced blob", () => {
    const ref = db.prepare(
      "INSERT INTO blob_refs (blob_hash, card_id, field_id, ref_key) VALUES (?, 'card-10', ?, ?)",
    );
    ref.run(HASH_A, "Speech", "0");
    ref.run(HASH_A, null, "audio-1.mp3");
    expect(db.prepare("SELECT refcount FROM blobs WHERE hash = ?").get(HASH_A)).toEqual({
      refcount: 2,
    });

    expect(() => db.prepare("DELETE FROM blobs WHERE hash = ?").run(HASH_A)).toThrow(
      /delete only at refcount 0/,
    );

    db.prepare("DELETE FROM blob_refs WHERE blob_hash = ? AND field_id IS NULL").run(HASH_A);
    expect(db.prepare("SELECT refcount FROM blobs WHERE hash = ?").get(HASH_A)).toEqual({
      refcount: 1,
    });

    // Re-pointing a reference moves the count; this is the typo-fix case that
    // cost Mochi 8,958 tombstones.
    db.prepare("UPDATE blob_refs SET blob_hash = ? WHERE blob_hash = ?").run(HASH_B, HASH_A);
    expect(db.prepare("SELECT hash, refcount FROM blobs ORDER BY hash").all()).toEqual([
      { hash: HASH_A, refcount: 0 },
      { hash: HASH_B, refcount: 1 },
    ]);

    // Now, and only now, it can go — with no tombstone left behind.
    db.prepare("DELETE FROM blobs WHERE hash = ?").run(HASH_A);
    expect(db.prepare("SELECT count(*) c FROM blobs").get()).toEqual({ c: 1 });

    // Deleting a card releases its references.
    db.prepare("DELETE FROM cards WHERE id = 'card-10'").run();
    expect(db.prepare("SELECT refcount FROM blobs WHERE hash = ?").get(HASH_B)).toEqual({
      refcount: 0,
    });
  });

  it("is immutable in its identity tuple but not in refcount or path", () => {
    expect(() =>
      db.prepare("UPDATE blobs SET source_text = 'スプリント!' WHERE hash = ?").run(HASH_A),
    ).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE blobs SET bytes = x'00' WHERE hash = ?").run(HASH_A)).toThrow(
      /immutable/,
    );
    db.prepare("UPDATE blobs SET path = 'media/aaa.mp3' WHERE hash = ?").run(HASH_A);
    expect(db.prepare("SELECT path FROM blobs WHERE hash = ?").get(HASH_A)).toEqual({
      path: "media/aaa.mp3",
    });
  });

  it("has no tombstone column anywhere in the schema", () => {
    // Mochi's failure mode was `deleted?: true` with nothing reconciling the
    // leftovers. Refcounting replaces it, so the flag must not exist at all.
    const columns: string[] = [];
    for (const table of TABLES) {
      for (const row of db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]) {
        columns.push(`${table}.${row.name}`);
      }
    }
    expect(columns.filter((c) => /deleted|tombstone/i.test(c))).toEqual([]);
    expect(columns).toContain("blobs.refcount");
  });
});

describe("grades are binary", () => {
  it("has no grade column anywhere, in any table or view", () => {
    // Binary remembered/forgot is a DESIGN DECISION, not a limitation of the
    // imported data: Anki's four-button Again/Hard/Good/Easy was considered and
    // rejected. A `grade` column that is NULL on all 102,020 rows and on every
    // future row advertises support that does not exist, so it is not here.
    const objects = (
      db
        .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view')")
        .all() as { name: string; type: string }[]
    ).filter((row) => !row.name.startsWith("sqlite_"));

    const graded: string[] = [];
    for (const object of objects) {
      for (const column of db.prepare(`PRAGMA table_info(${object.name})`).all() as {
        name: string;
      }[]) {
        if (/^grade/i.test(column.name)) graded.push(`${object.name}.${column.name}`);
      }
    }
    console.log(`  scanned ${objects.length} tables and views for a grade column ->`, graded);
    expect(graded).toEqual([]);

    expect(() =>
      db.prepare("INSERT INTO reviews (track_id, reviewed_at, remembered, grade) VALUES (1,'x',1,3)"),
    ).toThrow(/no column named grade/);
    expect(() => db.prepare("SELECT grade FROM reviews").all()).toThrow(/no such column/);
    expect(() => db.prepare("SELECT grade FROM review_log").all()).toThrow(/no such column/);
  });

  it("maps the boolean to the only two FSRS ratings it can produce", () => {
    expect(GRADES_ARE_BINARY).toBe(true);
    expect(BINARY_GRADE).toEqual({ forgot: 1, remembered: 3 });
    expect(gradeFor(true)).toBe(3);
    expect(gradeFor(false)).toBe(1);
    expect(gradeFor(1)).toBe(3);
    expect(gradeFor(0)).toBe(1);

    // w[15] (Hard penalty) and w[16] (Easy bonus) are unreachable under binary
    // grading and must be frozen rather than fitted. Named here so a future
    // optimiser cannot quietly start moving them.
    expect(FROZEN_FSRS_WEIGHTS).toEqual([15, 16]);
    // Hard (2) and Easy (4) are not producible, which is what makes w[15]/w[16]
    // unreachable in the first place.
    const producible: readonly number[] = Object.values(BINARY_GRADE);
    expect(producible.includes(2)).toBe(false);
    expect(producible.includes(4)).toBe(false);
  });

  it("keeps remembered as the whole signal, with no third state", () => {
    seedCard("card-15");
    const track = createTrack("card-15", "forward");
    const insert = db.prepare(
      "INSERT INTO reviews (track_id, reviewed_at, remembered) VALUES (?, '2026-08-19T23:14:05+09:00', ?)",
    );
    insert.run(track, 1);
    insert.run(track, 0);
    expect(() => insert.run(track, 2)).toThrow(/CHECK constraint failed/);
    expect(() => insert.run(track, null)).toThrow(/NOT NULL constraint failed/);
  });
});

describe("search over rendered text", () => {
  const LTR = "\u200E";
  // Real shape from the corpus: a compound stored as two linked cards, joined by
  // an invisible LEFT-TO-RIGHT MARK because Mochi's parser could not tell where
  // one link ended and the next began. 3,016 of these across 2,504 cards.
  const RAW_COMPOUND = `[[引き|10PQotxm]]${LTR}[[換え|C1p9g1mL]]`;

  it("renders link syntax to display text and drops the invisibles", () => {
    expect(buildSearchText(RAW_COMPOUND)).toBe("引き換え");
    expect(buildSearchText("[[越す|abc12345]]に越したことはない")).toBe("越すに越したことはない");
    // Bare and empty-display forms: 46 + 8 in the corpus. The id is not text.
    expect(buildSearchText("[[10PQotxm]]")).toBe("");
    expect(buildSearchText("[[|C1p9g1mL]]")).toBe("");
    // Mochi's own reference extractor mis-parsed this one; the display half is
    // still the searchable text.
    expect(buildSearchText("[[**enactment**|zeeUDLTL]]")).toBe("**enactment**");
    expect(buildSearchText("あ\u200Bい\u200Cう\u200Dえ\uFEFFお")).toBe("あいうえお");
    expect(buildSearchText("単語", null, undefined, "", "意味")).toBe("単語\n意味");
    expect(buildSearchText()).toBe("");
  });

  it("finds a split compound, and keeps the stored value byte-identical", () => {
    seedCard("split", { 単語: RAW_COMPOUND }, { name: "引き換え" });
    // Same text, but this card's search_text was never maintained, so
    // card_search_index falls back to the raw concatenation — which is the
    // behaviour the fix replaces.
    seedCard("unrendered", { 単語: RAW_COMPOUND }, { name: "" });
    // NULL is "nobody maintained this", which is what triggers the fallback.
    // '' would mean "maintained, and this card really has no text" — 16 empty
    // "Untitled card" rows in the corpus are exactly that, and conflating the
    // two would make them permanently indistinguishable from an un-migrated
    // writer.
    db.prepare("UPDATE cards SET search_text = NULL WHERE id = 'unrendered'").run();

    const populated = db
      .prepare("SELECT card_id, search_text_populated FROM card_search_index ORDER BY card_id")
      .all();
    console.log("  card_search_index ->", populated);
    expect(populated).toEqual([
      { card_id: "split", search_text_populated: 1 },
      { card_id: "unrendered", search_text_populated: 0 },
    ]);

    // An empty string is still "maintained": it indexes nothing and does NOT
    // fall back to the raw text.
    seedCard("blank", {}, { name: "Untitled card" });
    expect(
      db
        .prepare("SELECT search_text_populated FROM card_search_index WHERE card_id = 'blank'")
        .pluck()
        .get(),
    ).toBe(1);
    expect(db.prepare("SELECT search_text FROM cards WHERE id = 'blank'").pluck().get()).toBe("");

    const hits = db
      .prepare("SELECT card_id FROM card_fts WHERE body MATCH ? ORDER BY card_id")
      .all('"引き換え"') as { card_id: string }[];
    console.log('  MATCH body:"引き換え" ->', hits);
    expect(hits.map((row) => row.card_id)).toEqual(["split"]);

    // ROUND-TRIP FIDELITY. The mark and the link syntax survive verbatim in the
    // stored value; only the derived column was cleaned.
    const stored = db
      .prepare("SELECT value FROM card_field_values WHERE card_id = 'split'")
      .pluck()
      .get() as string;
    expect(stored).toBe(RAW_COMPOUND);
    expect(stored.includes(LTR)).toBe(true);
    expect(stored).toContain("[[引き|10PQotxm]]");
  });

  it("serves a TWO-character Japanese query, which the trigram index cannot", () => {
    seedCard("imi", { f1: "この単語の意味を調べる" }, { name: "調べる" });
    seedCard("other", { f1: "全く関係のない文章" }, { name: "無関係" });

    // The floor is real: MATCH returns nothing for a 2-character query.
    const match = db
      .prepare("SELECT card_id FROM card_fts WHERE card_fts MATCH ?")
      .all('"意味"');
    expect(match).toEqual([]);

    const short = searchPlan("意味");
    expect(short?.mode).toBe("like");
    const found = db.prepare(short!.sql).all(...short!.params) as { card_id: string }[];
    console.log(`  searchPlan('意味') mode=${short?.mode} ->`, found);
    expect(found.map((row) => row.card_id)).toEqual(["imi"]);

    // Note WHERE the hit is: in the body, not the name. A name-only fallback
    // would have found nothing, which is why the scan covers body and tags too.
    expect(
      db.prepare("SELECT name FROM cards WHERE id = 'imi'").pluck().get(),
    ).not.toContain("意味");

    // Three characters and up goes back to the index.
    const long = searchPlan("語の意");
    expect(long?.mode).toBe("fts");
    expect(FTS_MIN_QUERY_CHARS).toBe(3);
    const longHits = db.prepare(long!.sql).all(...long!.params) as { card_id: string }[];
    console.log(`  searchPlan('語の意') mode=${long?.mode} ->`, longHits);
    expect(longHits.map((row) => row.card_id)).toEqual(["imi"]);

    // Character count, not UTF-16 length: a 2-codepoint query stays on the scan.
    expect(searchPlan("あい")?.mode).toBe("like");
    expect(searchPlan("あいう")?.mode).toBe("fts");
    expect(searchPlan("   ")).toBeNull();
    expect(searchPlan("")).toBeNull();
  });

  it("treats LIKE metacharacters in a short query as literal text", () => {
    seedCard("wild", { f1: "jisho \\*ける wildcard" }, { name: "100%" });
    seedCard("plain", { f1: "no metacharacters here at all" }, { name: "plain" });

    expect(escapeLike("100%_")).toBe("100\\%\\_");
    const plan = searchPlan("%_");
    expect(plan?.mode).toBe("like");
    const hits = db.prepare(plan!.sql).all(...plan!.params) as { card_id: string }[];
    console.log("  searchPlan('%_') ->", hits);
    // A literal '%_' occurs nowhere, so an unescaped pattern would have matched
    // every card instead of none.
    expect(hits).toEqual([]);
  });
});
