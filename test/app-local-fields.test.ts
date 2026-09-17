import { describe, expect, it } from "vitest";

import { mergeLocalFields, type FieldsDb } from "../app/local-fields.js";
import { MEMORY, openDatabase, type Db } from "../src/db/index.js";

/**
 * FILE 4, THE ONE THAT CARRIES WHAT MOCHI NEVER HAD.
 *
 * Zach, 2026-09-17, over a 風潮 card on his phone: *"somehow ojad field is not
 * here..."*. It had been fixed on the laptop an hour earlier and could not cross,
 * because the card database is re-fetched only when `seedReviews` differs and
 * authoring a field value moves that by zero.
 *
 * THE PROPERTY THESE PROTECT is that the merge may ADD and may never OVERWRITE —
 * `setField` and decision 29's `Reading → true` both write values on the device,
 * and a seed that took those back would do it silently, on a boot that looked
 * like a download.
 *
 * In `app/` over a structural handle for `deck-scope.ts`'s reason: `test/` cannot
 * import the worker, and worker SQL nobody can test is how the deck archive
 * shipped inverted.
 */
function fixture(): Db {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name) VALUES ('d', 'deck')").run();
  db.prepare("INSERT INTO templates (id, name, content) VALUES ('t', '単語', '<<単語>>')").run();
  db.prepare(
    `INSERT INTO template_fields (template_id, id, name, type, pos, local)
     VALUES ('t', 'name', '単語', 'plain', 0, 0)`,
  ).run();
  for (const id of ["c1", "c2"]) {
    db.prepare("INSERT INTO cards (id, deck_id, template_id, name) VALUES (?, 'd', 't', ?)").run(
      id,
      id,
    );
  }
  return db;
}

const OJAD = {
  template_id: "t",
  id: "ojad",
  name: "OJAD",
  type: "plain",
  source_field_id: null,
  options: "{}",
  pos: 9,
} as const;

function valueOf(db: Db, cardId: string, fieldId: string): string | undefined {
  return (
    db
      .prepare("SELECT value AS v FROM card_field_values WHERE card_id = ? AND field_id = ?")
      .get(cardId, fieldId) as { v: string } | undefined
  )?.v;
}

describe("merging the local-field seed", () => {
  it("declares the field before the value, or the value renders nothing", () => {
    const db = fixture();
    try {
      const report = mergeLocalFields(
        db as unknown as FieldsDb,
        [OJAD],
        [{ card_id: "c1", field_id: "ojad", value: "えすえぬえ*す" }],
      );
      expect(report).toMatchObject({ added: 1, differs: 0, unknownCards: 0, fields: 1 });
      expect(valueOf(db, "c1", "ojad")).toBe("えすえぬえ*す");
      // The declaration is what makes it renderable at all — this is how `ojad`
      // itself would arrive on a device that had never seen the field.
      expect(
        db.prepare("SELECT type FROM template_fields WHERE template_id='t' AND id='ojad'").get(),
      ).toMatchObject({ type: "plain" });
    } finally {
      db.close();
    }
  });

  it("NEVER overwrites a value this device already holds", () => {
    const db = fixture();
    try {
      mergeLocalFields(db as unknown as FieldsDb, [OJAD], []);
      // Stand-in for `setField` / decision 29's `Reading` flip: something he did here.
      db.prepare(
        "INSERT INTO card_field_values (card_id, field_id, value) VALUES ('c1', 'ojad', 'HIS')",
      ).run();

      const report = mergeLocalFields(
        db as unknown as FieldsDb,
        [OJAD],
        [
          { card_id: "c1", field_id: "ojad", value: "SERVED" },
          { card_id: "c2", field_id: "ojad", value: "NEW" },
        ],
      );
      expect(valueOf(db, "c1", "ojad")).toBe("HIS");
      expect(valueOf(db, "c2", "ojad")).toBe("NEW");
      // AND IT SAYS SO. A value stuck on the device must not look like one in
      // agreement — that is decision 33's deferred clock made visible.
      expect(report).toMatchObject({ added: 1, differs: 1 });
    } finally {
      db.close();
    }
  });

  it("is silent when the device already agrees", () => {
    const db = fixture();
    try {
      const rows = [{ card_id: "c1", field_id: "ojad", value: "SAME" }];
      mergeLocalFields(db as unknown as FieldsDb, [OJAD], rows);
      const second = mergeLocalFields(db as unknown as FieldsDb, [OJAD], rows);
      expect(second).toMatchObject({ added: 0, differs: 0 });
    } finally {
      db.close();
    }
  });

  it("skips a value whose card is not here, instead of losing the whole merge", () => {
    const db = fixture();
    try {
      // `card_field_values` has a foreign key to `cards`. Letting this throw would
      // take every other value in the transaction with it, and 8,958 tombstones
      // make a missing card an ordinary thing rather than a corrupt file.
      const report = mergeLocalFields(
        db as unknown as FieldsDb,
        [OJAD],
        [
          { card_id: "gone", field_id: "ojad", value: "X" },
          { card_id: "c1", field_id: "ojad", value: "Y" },
        ],
      );
      expect(report).toMatchObject({ added: 1, unknownCards: 1 });
      expect(valueOf(db, "c1", "ojad")).toBe("Y");
    } finally {
      db.close();
    }
  });

  it("has NO count shortcut — equal totals can still hide a difference", () => {
    const db = fixture();
    try {
      mergeLocalFields(db as unknown as FieldsDb, [OJAD], []);
      // The device holds ONE value the file does not, and is missing ONE it does.
      // The totals match at 1 = 1, which is exactly the state the first cut of
      // this skipped on — and 風潮's annotation was invisible for a whole boot.
      db.prepare(
        "INSERT INTO card_field_values (card_id, field_id, value) VALUES ('c1', 'ojad', 'OLD')",
      ).run();
      const report = mergeLocalFields(db as unknown as FieldsDb, [OJAD], [
        { card_id: "c2", field_id: "ojad", value: "WANTED" },
      ]);
      expect(report.added).toBe(1);
      expect(valueOf(db, "c2", "ojad")).toBe("WANTED");
    } finally {
      db.close();
    }
  });
});
