/**
 * `出典` — a card remembers the card it was found in. Zach, 2026-10-26: he meets
 * 包帯 in an example sentence, makes a card, and until now nothing recorded why.
 *
 * Three properties: the value reads back as the source and the sentence; the
 * SOURCE card lists the new one under "links here" with no second mechanism; and
 * the field and its value reach the other device through sync — a field created
 * on the laptop that the phone never hears of would be a card with its reason
 * missing on the device he reviews on.
 */
import { describe, expect, it } from "vitest";

import {
  backlinksOf,
  ensureSourceField,
  foundInOf,
  reconcileCardLinks,
  SOURCE_FIELD_ID,
  sourceValue,
} from "../src/cards/index.js";
import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { exportSync, mergeSync } from "../src/sync/index.js";

const SENTENCE = "彼女は古いシャツを細く裂いて、包帯の代わりにした。";
const EPOCH = "2020-01-01T00:00:00.000Z";

function device(): Db {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name, updated_at) VALUES ('d', '日本語', ?)").run(EPOCH);
  db.prepare("INSERT INTO templates (id, name, content) VALUES ('tango', '単語', '<<単語>>')").run();
  db.prepare(
    "INSERT INTO template_fields (template_id, id, name, type, pos) VALUES ('tango', 'name', '単語', 'plain', 'a')",
  ).run();
  db.prepare(
    "INSERT INTO cards (id, deck_id, template_id, name, updated_at) VALUES ('src', 'd', 'tango', '恒久', ?)",
  ).run(EPOCH);
  db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('src', 'forward')").run();
  return db;
}

/** What the worker's `createCard` does with a `source`. */
function createFound(db: Db): void {
  db.prepare(
    "INSERT INTO cards (id, deck_id, template_id, name, content, archived, local) VALUES ('new', 'd', 'tango', '包帯', '', 0, 1)",
  ).run();
  db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('new', 'forward')").run();
  const fieldId = ensureSourceField(db, "tango");
  db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES ('new', ?, ?)").run(
    fieldId,
    sourceValue("src", "恒久", SENTENCE),
  );
}

describe("出典 — where a card was found", () => {
  it("reads back as the source card and the sentence", () => {
    const db = device();
    createFound(db);
    expect(foundInOf(db, "new")).toEqual({
      cardId: "src",
      name: "恒久",
      deckPath: "日本語",
      sentence: SENTENCE,
    });
    expect(foundInOf(db, "src")).toBeNull();
    db.close();
  });

  it("creates the field once, with one id on every device", () => {
    const db = device();
    expect(ensureSourceField(db, "tango")).toBe(SOURCE_FIELD_ID);
    expect(ensureSourceField(db, "tango")).toBe(SOURCE_FIELD_ID);
    expect(
      db.prepare("SELECT count(*) AS n FROM template_fields WHERE template_id = 'tango' AND name = '出典'").get(),
    ).toEqual({ n: 1 });
    // Found by ROLE after a rename, so a renamed field is not duplicated.
    db.prepare("UPDATE template_fields SET name = '由来' WHERE id = ?").run(SOURCE_FIELD_ID);
    expect(ensureSourceField(db, "tango")).toBe(SOURCE_FIELD_ID);
    db.close();
  });

  it("puts the new card in the source's backlinks, from the link alone", () => {
    const db = device();
    createFound(db);
    expect(backlinksOf(db, "src")).toEqual([]);
    reconcileCardLinks(db);
    expect(backlinksOf(db, "src").map((b) => b.name)).toEqual(["包帯"]);
    db.close();
  });

  it("keeps a link intact when the source's name holds link syntax", () => {
    expect(sourceValue("x", "a|b]]", "")).toBe("[[ab|x]]");
  });

  it("reaches the other device — the field AND the value", () => {
    const laptop = device();
    const phone = device();
    createFound(laptop);
    mergeSync(phone, exportSync(laptop, "2026-10-26T09:00:00.000Z"));
    expect(foundInOf(phone, "new")).toMatchObject({ cardId: "src", sentence: SENTENCE });
    laptop.close();
    phone.close();
  });
});
