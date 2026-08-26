import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import {
  ARCHIVE_VERSION,
  ArchiveError,
  applyLocalArchive,
  exportLocalArchive,
  verifyLocalArchive,
  type LocalArchive,
} from "../src/backup/index.js";

/**
 * Decision 17's local archive.
 *
 * THE TEST THAT MATTERS is "survives a rebuild that renumbers the tracks". The
 * archive's whole design rests on `(card_id, kind)` being the identity and
 * `card_tracks.id` being an accident of insert order, and the failure mode if that
 * is wrong is the worst kind: the restore succeeds, reports every row applied, and
 * silently attaches his review history to the wrong cards. So the destination
 * database here is built with the cards inserted in the OPPOSITE order, which
 * genuinely swaps the ids, and the assertions are on which CARD ended up with which
 * review.
 */

const DB = "build/hashigo.db";
const HAS_CORPUS = existsSync(DB);
const AT = "2026-08-23T02:00:00+09:00";

/**
 * A database with two cards, forward tracks for each, and optional local data.
 *
 * `order` flips the insertion order, which is what makes the track ids differ
 * between two otherwise identical databases.
 */
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
    // A local field, a value on it, a local review on cardA only, and state.
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
      // One local review, one track's state, one local field, one value.
      expect(a.reviews).toHaveLength(1);
      expect(a.reviews[0]).toMatchObject({ cardId: "cardA", kind: "forward", remembered: 1 });
      expect(a.trackState).toHaveLength(1);
      expect(a.trackState[0]).toMatchObject({
        cardId: "cardA",
        scheduler: "fsrs6",
        schedulerState: '{"s":4.2,"d":5.1}',
      });
      // ALL fields now, not only `local = 1` — the template editor made a body and
      // its field names one fact (see the module header). The fixture's template has
      // the local 読み and nothing else, so the count is unchanged here; the corpus
      // test below is where the change shows.
      expect(a.localFields).toHaveLength(1);
      expect(a.localFields[0]).toMatchObject({ id: "local-yomi", local: true });
      expect(a.fieldValues).toEqual([
        { cardId: "cardA", fieldId: "local-yomi", value: "はし" },
      ]);
      // No track_id anywhere in the archive. Grep the serialised form, because a
      // stray id is the defect this design exists to prevent.
      expect(JSON.stringify(a)).not.toMatch(/"trackId"/);
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
        { id: "tpl", name: "単語v2", content: "<<読み>>\n---\n<<単語>>" },
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
    // `local` used to be the literal 1 in the UPSERT, because the SELECT only ever
    // produced local rows. Now that every field is archived, writing 1 for all of
    // them would tell `pruneFieldValues` never to clean up a field Mochi genuinely
    // deleted — a backup that turns into a slow leak.
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
      // Exactly the shape a pre-templates archive has: no `local` on the rows, and
      // no `templates` key at all.
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
      // Only the two non-default rows, not one per card.
      expect(a.cardState).toEqual([
        { cardId: "cardA", archived: true, pinned: false },
        { cardId: "cardB", archived: false, pinned: true },
      ]);

      // `target` is what a rebuild produces: the import wrote both flags back to 0.
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
    // The archive stores non-default rows only, so "absent" means "was 0 when the
    // backup ran". Clearing on that basis would make restoring an OLD backup delete
    // an archive he made after it. A backup that misses some work is survivable; a
    // backup that removes work is not.
    const source = fixture();
    const target = fixture();
    try {
      source.prepare("UPDATE cards SET archived = 1 WHERE id = 'cardA'").run();
      const a = exportLocalArchive(source, AT);
      // Done AFTER the backup was taken, and it must survive the restore.
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
    // `ARCHIVE_VERSION` is documented as bumped "only for a change no reader could
    // otherwise survive". A reader survives this one by defaulting to []. Bumping
    // would have rejected every backup he had already taken, at the one moment
    // those files are the only copy — so the old shape has to keep working.
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
    const rebuilt = fixture({ order: "ba" }); // cards inserted the other way round
    try {
      // The ids really do differ, or this test proves nothing.
      const before = trackIds(source);
      const after = trackIds(rebuilt);
      expect(before["cardA"]).not.toBe(after["cardA"]);
      expect(before["cardA"]).toBe(after["cardB"]);

      const archive = exportLocalArchive(source, AT);
      const report = applyLocalArchive(rebuilt, archive);
      expect(report.reviewsInserted).toBe(1);
      expect(report.reviewsOrphaned).toBe(0);
      expect(report.trackStateApplied).toBe(1);

      // THE ASSERTION: the review is attached to cardA, not to whichever track
      // happens to hold cardA's old id.
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

      // And so is the state, and the local field value.
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

      // And exactly one review row exists, not two. `reviews` is append-only with
      // a BEFORE UPDATE trigger, so a duplicate could not be cleaned up later.
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
      // The strong form: the whole archive, not a count.
      expect(second).toEqual(first);
    } finally {
      source.close();
      target.close();
    }
  });

  it("REPORTS a row whose card is gone rather than dropping or throwing", () => {
    // 8,958 tombstones in this corpus, so restoring into a database rebuilt from a
    // newer export will meet a deleted card eventually. That is not an error, but
    // it must not be silent either.
    const source = fixture({ withLocal: true });
    const target = fixture();
    try {
      target.prepare("DELETE FROM cards WHERE id = 'cardA'").run();
      const report = applyLocalArchive(target, exportLocalArchive(source, AT));
      expect(report.reviewsOrphaned).toBe(1);
      expect(report.reviewsInserted).toBe(0);
      expect(report.trackStateOrphaned).toBe(1);
      // The one that actually threw before the guard existed: card_field_values
      // has a foreign key to cards, so a single deleted card aborted the whole
      // restore. Now it is counted and the rest of the archive still lands.
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

      // What a half-written file looks like: the counts still claim one review.
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
      // Read via PRAGMA rather than imported from src/schema, which cannot be
      // loaded in a browser — and this is the value actually stamped on the file.
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
      // Today: no local grades yet, but the local FIELDS and their values are real
      // and already unreconstructible from exports/ (decision 9).
      //
      // 6 local fields is 読み, かな主流 and 型 across 単語 and 言葉 — 型 landed
      // 2026-08-23 with D3. THE COMPOSITION IS WORTH KNOWING: of the 3,848 values,
      // **3,830 are derived** 型 labels that `accent/cli.ts write` regenerates from
      // the `accents` table, and only 18 are hand-authored (12 読み + 6 かな主流).
      // They are kept anyway, deliberately: 309 KB is still instant to export, and
      // including them makes a restore a single apply rather than "restore, then
      // rebuild the 1.4 GB Python venv, then re-derive". Excluding them is one
      // WHERE clause if that ever stops being the right trade.
      expect(a.counts).toEqual({
        reviews: 0,
        trackState: 0,
        // WAS 6 — the six `local = 1` rows. It is every field now: a rename
        // rewrites the body's `<<Field>>` markers, so restoring a body without the
        // field NAMES gives back a body whose every marker resolves to nothing.
        localFields: 47,
        templates: 10,
        fieldValues: 3_848,
        settings: 4,
        // The 234 individually archived cards. They LOOK like something the export
        // rebuilds and they are not: `UPSERT_CARD` writes `archived` from Mochi, and
        // Mochi has no deck-level archive at all, so decision 16's final import
        // returns every one of them to 0. Zero pinned — his export carries none, so
        // every pin from here on is one he made in Hashigo.
        cardState: 234,
      });
      // 102,020 imported reviews are NOT in here — that is the point.
      const bytes = JSON.stringify(a).length;
      // eslint-disable-next-line no-console
      console.log(`local archive over the real corpus: ${bytes} bytes JSON`);
      // Still three orders of magnitude under the 74 MB database it protects.
      expect(bytes).toBeLessThan(400_000);
      expect(verifyLocalArchive(a)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
