import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { refreshSearchText } from "../src/generate/index.js";
import { searchCards } from "../src/search/index.js";

import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import {
  ARCHIVE_VERSION,
  ArchiveError,
  applyLocalArchive,
  exportLocalArchive,
  verifyLocalArchive,
  type LocalArchive,
} from "../src/backup/index.js";

const DB = "build/hashigo.db";
const HAS_CORPUS = existsSync(DB);
const AT = "2026-08-23T02:00:00+09:00";

function fixture(options: { order?: "ab" | "ba"; withLocal?: boolean } = {}): Db {
  const db = openDatabase(MEMORY);
  const ids = options.order === "ba" ? ["cardB", "cardA"] : ["cardA", "cardB"];
  db.prepare("INSERT INTO decks (id, name) VALUES ('d', '日本語')").run();
  db.prepare("INSERT INTO templates (id, name) VALUES ('tpl', '単語')").run();
  for (const id of ids) {
    db.prepare("INSERT INTO cards (id, deck_id, name, template_id) VALUES (?, 'd', ?, 'tpl')").run(
      id,
      id === "cardA" ? "橋" : "箸",
    );
    db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES (?, 'forward')").run(id);
  }

  if (options.withLocal === true) {
    db.prepare(
      `INSERT INTO template_fields (template_id, id, name, type, pos, local)
       VALUES ('tpl', 'local-yomi', '読み', 'plain', 'ab', 1)`,
    ).run();
    db.prepare(
      "INSERT INTO card_field_values (card_id, field_id, value) VALUES ('cardA', 'local-yomi', 'はし')",
    ).run();
    const track = db
      .prepare("SELECT id FROM card_tracks WHERE card_id = 'cardA' AND kind = 'forward'")
      .get() as { id: number };
    db.prepare(
      `INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown, remembered,
                            elapsed_days, scheduled_days, next_scheduled_days, due_at, source)
       VALUES (?, '2026-08-22T09:00:00+09:00', 540, 0, 1, 3, 3, 12, '2026-09-03T00:00:00+09:00', 'local')`,
    ).run(track.id);
    db.prepare(
      `UPDATE card_tracks SET due_at = '2026-09-03T00:00:00+09:00', scheduled_days = 12,
              reps = 1, lapses = 0, last_reviewed_at = '2026-08-22T09:00:00+09:00',
              scheduler = 'fsrs6', scheduler_state = '{"s":4.2,"d":5.1}' WHERE id = ?`,
    ).run(track.id);
  }
  return db;
}

function trackIds(db: Db): Record<string, number> {
  const rows = db.prepare("SELECT card_id, id FROM card_tracks").all() as {
    card_id: string;
    id: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.card_id, r.id]));
}

describe("the local archive", () => {
  it("carries only what exports/ cannot rebuild", () => {
    const db = fixture({ withLocal: true });
    try {
      const a = exportLocalArchive(db, AT);
      expect(a.archiveVersion).toBe(ARCHIVE_VERSION);
      expect(a.createdAt).toBe(AT);
      expect(a.reviews).toHaveLength(1);
      expect(a.reviews[0]).toMatchObject({ cardId: "cardA", kind: "forward", remembered: 1 });
      expect(a.trackState).toHaveLength(1);
      expect(a.trackState[0]).toMatchObject({
        cardId: "cardA",
        scheduler: "fsrs6",
        schedulerState: '{"s":4.2,"d":5.1}',
      });
      expect(a.localFields).toHaveLength(1);
      expect(a.localFields[0]).toMatchObject({ id: "local-yomi", local: true });
      expect(a.fieldValues).toEqual([
        { cardId: "cardA", fieldId: "local-yomi", value: "はし" },
      ]);
      expect(JSON.stringify(a)).not.toMatch(/"trackId"/);
    } finally {
      db.close();
    }
  });

  it("CARRIES A CARD HE MADE HERE — nothing else in the project does", () => {
    const source = fixture({ withLocal: true });
    const target = fixture({ withLocal: true });
    try {
      source
        .prepare(
          `INSERT INTO cards (id, deck_id, template_id, name, content, archived, local)
           VALUES ('mine', 'd', 'tpl', '造語', '', 0, 1)`,
        )
        .run();
      source
        .prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('mine', 'forward')")
        .run();
      source
        .prepare(
          `INSERT INTO card_field_values (card_id, field_id, value)
           VALUES ('mine', 'local-yomi', 'ぞうご')`,
        )
        .run();

      const a = exportLocalArchive(source, AT);
      expect(a.localCards).toEqual([
        {
          id: "mine",
          deckId: "d",
          templateId: "tpl",
          name: "造語",
          content: "",
          reverse: "inherit",
          voice: null,
          archived: false,
          pinned: false,
          tracks: ["forward"],
        },
      ]);
      expect(a.localCards).toHaveLength(1);

      const report = applyLocalArchive(target, a);
      expect(report.localCardsInserted).toBe(1);
      expect(report.localCardsOrphaned).toBe(0);
      expect(
        (target
          .prepare("SELECT count(*) AS n FROM card_tracks WHERE card_id = 'mine'")
          .get() as { n: number }).n,
      ).toBe(1);
      expect(
        (target
          .prepare("SELECT value FROM card_field_values WHERE card_id = 'mine'")
          .get() as { value: string }).value,
      ).toBe("ぞうご");
    } finally {
      source.close();
      target.close();
    }
  });

  it("SKIPS a card that is already here rather than overwriting it", () => {
    const source = fixture({ withLocal: true });
    const target = fixture({ withLocal: true });
    try {
      for (const db of [source, target]) {
        db.prepare(
          `INSERT INTO cards (id, deck_id, template_id, name, content, archived, local)
           VALUES ('mine', 'd', 'tpl', ?, '', 0, 1)`,
        ).run(db === source ? "old name" : "the name he changed it to");
        db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('mine', 'forward')").run();
      }
      const report = applyLocalArchive(target, exportLocalArchive(source, AT));
      expect(report.localCardsInserted).toBe(0);
      expect(report.localCardsSkipped).toBe(1);
      expect(
        (target.prepare("SELECT name FROM cards WHERE id = 'mine'").get() as { name: string })
          .name,
      ).toBe("the name he changed it to");
    } finally {
      source.close();
      target.close();
    }
  });

  it("reports a card whose DECK is gone instead of inventing one", () => {
    const source = fixture({ withLocal: true });
    const target = fixture({ withLocal: true });
    try {
      source.prepare("INSERT INTO decks (id, name) VALUES ('gone', '消えたデッキ')").run();
      source
        .prepare(
          `INSERT INTO cards (id, deck_id, template_id, name, content, archived, local)
           VALUES ('orphan', 'gone', 'tpl', 'みなしご', '', 0, 1)`,
        )
        .run();
      const report = applyLocalArchive(target, exportLocalArchive(source, AT));
      expect(report.localCardsOrphaned).toBe(1);
      expect(report.localCardsInserted).toBe(0);
      expect(target.prepare("SELECT 1 FROM decks WHERE id = 'gone'").get()).toBeUndefined();
    } finally {
      source.close();
      target.close();
    }
  });

  it("does not DOUBLE-COUNT a local field's value on a local card", () => {
    const db = fixture({ withLocal: true });
    try {
      db.prepare(
        `INSERT INTO cards (id, deck_id, template_id, name, content, archived, local)
         VALUES ('mine', 'd', 'tpl', 'x', '', 0, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO card_field_values (card_id, field_id, value)
         VALUES ('mine', 'local-yomi', 'えっくす')`,
      ).run();
      const a = exportLocalArchive(db, AT);
      const keys = a.fieldValues.map((v) => `${v.cardId}/${v.fieldId}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(verifyLocalArchive(a)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("carries the template BODY, which the final import overwrites", () => {
    const source = fixture({ withLocal: true });
    const target = fixture({ withLocal: true });
    try {
      source
        .prepare("UPDATE templates SET content = ?, name = ? WHERE id = 'tpl'")
        .run("<<読み>>\n---\n<<単語>>", "単語v2");
      const a = exportLocalArchive(source, AT);
      expect(a.templates).toEqual([
        {
          id: "tpl",
          name: "単語v2",
          content: "<<読み>>\n---\n<<単語>>",
          updatedAt: expect.any(String) as unknown as string,
        },
      ]);

      const report = applyLocalArchive(target, a);
      expect(report.templatesApplied).toBe(1);
      expect(report.templatesOrphaned).toBe(0);
      expect(
        target.prepare("SELECT name, content FROM templates WHERE id = 'tpl'").get(),
      ).toEqual({ name: "単語v2", content: "<<読み>>\n---\n<<単語>>" });
    } finally {
      source.close();
      target.close();
    }
  });

  it("RESTORES A MOCHI FIELD WITHOUT MARKING IT LOCAL — that would leak values forever", () => {
    const source = fixture({ withLocal: true });
    const target = fixture({ withLocal: true });
    try {
      source
        .prepare(
          `INSERT INTO template_fields (template_id, id, name, type, pos, local)
           VALUES ('tpl', 'mochiField', '意味', 'plain', 'zz', 0)`,
        )
        .run();
      const a = exportLocalArchive(source, AT);
      applyLocalArchive(target, a);
      const rows = Object.fromEntries(
        (target
          .prepare("SELECT id, local FROM template_fields WHERE template_id = 'tpl'")
          .all() as { id: string; local: number }[]).map((r) => [r.id, r.local]),
      );
      expect(rows["mochiField"]).toBe(0);
      expect(rows["local-yomi"]).toBe(1);
    } finally {
      source.close();
      target.close();
    }
  });

  it("an OLD archive's fields default to local, which is what they all were", () => {
    const source = fixture({ withLocal: true });
    const target = fixture({ withLocal: true });
    try {
      const a = exportLocalArchive(source, AT);
      const old = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
      for (const field of old["localFields"] as Record<string, unknown>[]) {
        delete field["local"];
      }
      delete old["templates"];
      delete (old["counts"] as Record<string, number>)["templates"];
      target.prepare("UPDATE template_fields SET local = 0 WHERE id = 'local-yomi'").run();
      const report = applyLocalArchive(target, old as never);
      expect(report.templatesApplied).toBe(0);
      expect(
        (target
          .prepare("SELECT local FROM template_fields WHERE id = 'local-yomi'")
          .get() as { local: number }).local,
      ).toBe(1);
    } finally {
      source.close();
      target.close();
    }
  });

  it("carries archived and pinned, and restoring puts them back", () => {
    const source = fixture();
    const target = fixture();
    try {
      source.prepare("UPDATE cards SET archived = 1 WHERE id = 'cardA'").run();
      source.prepare("UPDATE cards SET pinned = 1 WHERE id = 'cardB'").run();
      const a = exportLocalArchive(source, AT);
      expect(a.cardState).toEqual([
        { cardId: "cardA", archived: true, pinned: false },
        { cardId: "cardB", archived: false, pinned: true },
      ]);

      const flags = (db: typeof target): Record<string, string> =>
        Object.fromEntries(
          (db.prepare("SELECT id, archived, pinned FROM cards ORDER BY id").all() as {
            id: string;
            archived: number;
            pinned: number;
          }[]).map((r) => [r.id, `${r.archived}${r.pinned}`]),
        );
      expect(flags(target)).toEqual({ cardA: "00", cardB: "00" });

      const report = applyLocalArchive(target, a);
      expect(report.cardStateApplied).toBe(2);
      expect(report.cardStateOrphaned).toBe(0);
      expect(flags(target)).toEqual({ cardA: "10", cardB: "01" });
    } finally {
      source.close();
      target.close();
    }
  });

  it("NEVER CLEARS A FLAG THE ARCHIVE DOES NOT HOLD — a restore must not undo work", () => {
    const source = fixture();
    const target = fixture();
    try {
      source.prepare("UPDATE cards SET archived = 1 WHERE id = 'cardA'").run();
      const a = exportLocalArchive(source, AT);
      target.prepare("UPDATE cards SET pinned = 1 WHERE id = 'cardB'").run();
      applyLocalArchive(target, a);
      const row = target
        .prepare("SELECT archived, pinned FROM cards WHERE id = 'cardB'")
        .get() as { archived: number; pinned: number };
      expect(row).toEqual({ archived: 0, pinned: 1 });
    } finally {
      source.close();
      target.close();
    }
  });

  it("READS AN ARCHIVE WRITTEN BEFORE `cardState` EXISTED — the version is not bumped", () => {
    const source = fixture({ withLocal: true });
    const target = fixture({ withLocal: true });
    try {
      const a = exportLocalArchive(source, AT);
      const old = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
      delete old["cardState"];
      delete (old["counts"] as Record<string, number>)["cardState"];
      expect(verifyLocalArchive(old as never)).toBeUndefined();
      const report = applyLocalArchive(target, old as never);
      expect(report.cardStateApplied).toBe(0);
      expect(report.cardStateOrphaned).toBe(0);
    } finally {
      source.close();
      target.close();
    }
  });

  it("SURVIVES A REBUILD THAT RENUMBERS THE TRACKS — the whole design, tested", () => {
    const source = fixture({ order: "ab", withLocal: true });
    const rebuilt = fixture({ order: "ba" });
    try {
      const before = trackIds(source);
      const after = trackIds(rebuilt);
      expect(before["cardA"]).not.toBe(after["cardA"]);
      expect(before["cardA"]).toBe(after["cardB"]);

      const archive = exportLocalArchive(source, AT);
      const report = applyLocalArchive(rebuilt, archive);
      expect(report.reviewsInserted).toBe(1);
      expect(report.reviewsOrphaned).toBe(0);
      expect(report.trackStateApplied).toBe(1);

      const landed = rebuilt
        .prepare(
          `SELECT t.card_id AS card_id, r.remembered, r.reviewed_at
             FROM reviews r JOIN card_tracks t ON t.id = r.track_id
            WHERE r.source = 'local'`,
        )
        .all() as { card_id: string; remembered: number; reviewed_at: string }[];
      expect(landed).toEqual([
        { card_id: "cardA", remembered: 1, reviewed_at: "2026-08-22T09:00:00+09:00" },
      ]);

      const state = rebuilt
        .prepare(
          "SELECT card_id, scheduler, scheduler_state FROM card_tracks WHERE scheduler_state IS NOT NULL",
        )
        .all();
      expect(state).toEqual([
        { card_id: "cardA", scheduler: "fsrs6", scheduler_state: '{"s":4.2,"d":5.1}' },
      ]);
      expect(
        rebuilt.prepare("SELECT value FROM card_field_values WHERE card_id = 'cardA'").get(),
      ).toEqual({ value: "はし" });
    } finally {
      source.close();
      rebuilt.close();
    }
  });

  it("is IDEMPOTENT: applying twice inserts nothing the second time", () => {
    const source = fixture({ withLocal: true });
    const target = fixture();
    try {
      const archive = exportLocalArchive(source, AT);
      const first = applyLocalArchive(target, archive);
      expect(first).toMatchObject({ reviewsInserted: 1, reviewsSkipped: 0, noop: false });

      const second = applyLocalArchive(target, archive);
      expect(second).toMatchObject({ reviewsInserted: 0, reviewsSkipped: 1, noop: true });

      expect(
        target.prepare("SELECT count(*) AS n FROM reviews").get(),
      ).toEqual({ n: 1 });
    } finally {
      source.close();
      target.close();
    }
  });

  it("round-trips: export, apply elsewhere, export again, byte-identical", () => {
    const source = fixture({ withLocal: true });
    const target = fixture({ order: "ba" });
    try {
      const first = exportLocalArchive(source, AT);
      applyLocalArchive(target, first);
      const second = exportLocalArchive(target, AT);
      expect(second).toEqual(first);
    } finally {
      source.close();
      target.close();
    }
  });

  it("REPORTS a row whose card is gone rather than dropping or throwing", () => {
    const source = fixture({ withLocal: true });
    const target = fixture();
    try {
      target.prepare("DELETE FROM cards WHERE id = 'cardA'").run();
      const report = applyLocalArchive(target, exportLocalArchive(source, AT));
      expect(report.reviewsOrphaned).toBe(1);
      expect(report.reviewsInserted).toBe(0);
      expect(report.trackStateOrphaned).toBe(1);
      expect(report.fieldValuesOrphaned).toBe(1);
      expect(report.fieldValuesUpserted).toBe(0);
      expect(report.fieldsUpserted).toBe(1);
      expect(report.settingsUpserted).toBeGreaterThan(0);
    } finally {
      source.close();
      target.close();
    }
  });

  it("refuses a truncated archive instead of restoring half of it", () => {
    const db = fixture({ withLocal: true });
    try {
      const good = exportLocalArchive(db, AT);
      expect(() => verifyLocalArchive(good)).not.toThrow();

      const truncated = { ...good, reviews: [] } as unknown as LocalArchive;
      expect(() => verifyLocalArchive(truncated)).toThrow(ArchiveError);
      expect(() => applyLocalArchive(db, truncated)).toThrow(/truncated or edited/);

      const wrongVersion = { ...good, archiveVersion: 99 } as unknown as LocalArchive;
      expect(() => verifyLocalArchive(wrongVersion)).toThrow(/archive version 99/);
    } finally {
      db.close();
    }
  });

  it("records the schema version it came from, read from the file", () => {
    const db = fixture();
    try {
      const a = exportLocalArchive(db, AT);
      expect(a.schemaVersion).toBeGreaterThan(0);
      const pragma = db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(a.schemaVersion).toBe(pragma.user_version);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!HAS_CORPUS)("the local archive over the real corpus", () => {
  it("is small, and is exactly the irreplaceable rows", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const a = exportLocalArchive(db, AT);
      expect(a.counts).toEqual({
        reviews: 0,
        trackState: 0,
        localFields: 48,
        localCards: 0,
        templates: 10,
        fieldValues: 29_895,
        settings: 4,
        cardState: 244,
      });
      const bytes = JSON.stringify(a).length;
      // eslint-disable-next-line no-console
      console.log(`local archive over the real corpus: ${bytes} bytes JSON`);
      expect(bytes).toBeLessThan(4_000_000);
      expect(verifyLocalArchive(a)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("apply refreshes the search index", () => {
  it("finds a created card by the value the sync brought", () => {
    const source = fixture({ withLocal: true });
    const target = fixture({ withLocal: true });
    try {
      for (const db of [source, target]) {
        db.prepare(
          `INSERT INTO template_fields (template_id, id, name, type, pos, local)
           VALUES ('tpl', 'meaning', '意味', 'plain', 'aa', 0)`,
        ).run();
        db.prepare(
          `INSERT INTO cards (id, deck_id, template_id, name, content, archived, local)
           VALUES ('mine', 'd', 'tpl', '自作', '', 0, 1)`,
        ).run();
        db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('mine', 'forward')").run();
      }
      source.prepare(`INSERT INTO card_field_values (card_id, field_id, value) VALUES ('mine', 'meaning', 'laptop wording pqzr')`).run();
      target.prepare(`INSERT INTO card_field_values (card_id, field_id, value) VALUES ('mine', 'meaning', 'phone wording mbxw')`).run();
      refreshSearchText(target, ["mine"]);

      applyLocalArchive(target, exportLocalArchive(source, AT));

      const found = (q: string) => searchCards(target, q).hits.map((h) => h.cardId);
      expect(found("pqzr")).toEqual(["mine"]);
      expect(found("mbxw")).toEqual([]);
    } finally {
      source.close();
      target.close();
    }
  });
});
