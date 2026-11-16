import { describe, expect, it } from "vitest";

import { mergeLocalFields, reapplyCorrections, type FieldsDb } from "../app/local-fields.js";
import { MEMORY, openDatabase, type Db } from "../src/db/index.js";

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

  it("replaces a value ONLY while it still equals what the pipeline wrote before", () => {
    const db = fixture();
    try {
      mergeLocalFields(db as unknown as FieldsDb, [OJAD], []);
      db.prepare(
        "INSERT INTO card_field_values (card_id, field_id, value) VALUES ('c1', 'ojad', '頭高'), ('c2', 'ojad', 'HIS')",
      ).run();
      const served = [
        { card_id: "c1", field_id: "ojad", value: "平板" },
        { card_id: "c2", field_id: "ojad", value: "平板" },
      ];
      const corrections = [
        { card_id: "c1", field_id: "ojad", was: "頭高", value: "平板" },
        { card_id: "c2", field_id: "ojad", was: "頭高", value: "平板" },
      ];
      const report = mergeLocalFields(db as unknown as FieldsDb, [OJAD], served, corrections);
      expect(valueOf(db, "c1", "ojad")).toBe("平板");
      expect(valueOf(db, "c2", "ojad")).toBe("HIS");
      expect(report).toMatchObject({ added: 0, corrected: 1, differs: 1 });

      const again = mergeLocalFields(db as unknown as FieldsDb, [OJAD], served, corrections);
      expect(again).toMatchObject({ added: 0, corrected: 0, differs: 1 });
    } finally {
      db.close();
    }
  });

  it("ignores a correction that is not to the value being served", () => {
    const db = fixture();
    try {
      mergeLocalFields(db as unknown as FieldsDb, [OJAD], []);
      db.prepare(
        "INSERT INTO card_field_values (card_id, field_id, value) VALUES ('c1', 'ojad', '頭高')",
      ).run();
      const report = mergeLocalFields(
        db as unknown as FieldsDb,
        [OJAD],
        [{ card_id: "c1", field_id: "ojad", value: "平板" }],
        [{ card_id: "c1", field_id: "ojad", was: "頭高", value: "尾高" }],
      );
      expect(valueOf(db, "c1", "ojad")).toBe("頭高");
      expect(report).toMatchObject({ corrected: 0, differs: 1 });
    } finally {
      db.close();
    }
  });

  it("re-corrects a value a sync merge carried back — and still never touches his edit", () => {
    const db = fixture();
    try {
      mergeLocalFields(db as unknown as FieldsDb, [OJAD], []);
      db.prepare(
        "INSERT INTO card_field_values (card_id, field_id, value) VALUES ('c1', 'ojad', '中高 (2)'), ('c2', 'ojad', 'HIS')",
      ).run();
      const corrections = [
        { card_id: "c1", field_id: "ojad", was: "中高 (2)", value: "平板" },
        { card_id: "c2", field_id: "ojad", was: "中高 (2)", value: "平板" },
      ];
      expect(reapplyCorrections(db as unknown as FieldsDb, corrections)).toBe(1);
      expect(valueOf(db, "c1", "ojad")).toBe("平板");
      expect(valueOf(db, "c2", "ojad")).toBe("HIS");
      expect(reapplyCorrections(db as unknown as FieldsDb, corrections)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("has NO count shortcut — equal totals can still hide a difference", () => {
    const db = fixture();
    try {
      mergeLocalFields(db as unknown as FieldsDb, [OJAD], []);
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
