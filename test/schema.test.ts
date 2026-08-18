import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MEMORY, checkIntegrity, openDatabase, schemaVersion, type Db } from "../src/db/index.js";
import {
  FTS_TOKENIZER,
  SCHEMA_VERSION,
  TABLES,
  VIEWS,
  clozeTrack,
  parseTrackKind,
} from "../src/schema/index.js";

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
        " remembered, interval_days, duration_ms, source, import_key)" +
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

  it("keeps both the interval that preceded a review and the one it scheduled", () => {
    seedCard("card-12");
    const track = createTrack("card-12", "forward");
    const insert = db.prepare(
      "INSERT INTO reviews (track_id, reviewed_at, time_unknown, remembered, interval_days," +
        " next_interval_days, due_at, duration_ms) VALUES (?, ?, 1, 1, ?, ?, ?, ?)",
    );
    // Mochi stores date, due and interval == due - date. interval_days (the
    // preceding one, which the backtest scores against) is derived on import.
    insert.run(track, "2024-01-01T15:00:00Z", null, 3, "2024-01-04T15:00:00Z", 71_000);
    insert.run(track, "2024-01-04T15:00:00Z", 3, 12, "2024-01-16T15:00:00Z", 38_000);

    expect(
      db
        .prepare(
          "SELECT interval_days, next_interval_days, due_at FROM reviews ORDER BY reviewed_at",
        )
        .all(),
    ).toEqual([
      { interval_days: null, next_interval_days: 3, due_at: "2024-01-04T15:00:00Z" },
      { interval_days: 3, next_interval_days: 12, due_at: "2024-01-16T15:00:00Z" },
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
        " remembered, interval_days, duration_ms) VALUES (?, ?, 540, 1, ?, ?, ?)",
    );
    insert.run(track, "2024-01-01T15:00:00Z", 1, 0.5, 3_600_000);
    insert.run(track, "2024-01-02T15:00:00Z", 1, 30, 1_800_000);
    insert.run(track, "2024-01-03T15:00:00Z", 0, 400, 1_800_000);

    expect(
      db.prepare("SELECT reviews, lapses, retention, hours, study_days FROM study_totals").get(),
    ).toEqual({ reviews: 3, lapses: 1, retention: 2 / 3, hours: 2, study_days: 3 });

    expect(
      db
        .prepare(
          "SELECT interval_bucket_label, reviews, lapses FROM retention_by_interval" +
            " ORDER BY interval_bucket",
        )
        .all(),
    ).toEqual([
      { interval_bucket_label: "<= 1d", reviews: 1, lapses: 0 },
      { interval_bucket_label: "21-60d", reviews: 1, lapses: 0 },
      { interval_bucket_label: "> 365d", reviews: 1, lapses: 1 },
    ]);
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
