/**
 * Making a card — `src/cards/create.ts`, the code the app's worker and
 * `scripts/cards-add.ts` both call.
 *
 * Two defects found while adding a 漢検 batch on 2026-10-29: a card and its
 * values were written in separate steps, so a fill that lost the race left a card
 * with EMPTY fields (簿 was made that way); and nothing stopped a second card of
 * a name that already existed. Both are pinned here.
 */
import { describe, expect, it } from "vitest";

import {
  cardsNamed,
  createCard,
  createTemplate,
  DuplicateCardError,
  loadRenderedCard,
  SOURCE_FIELD_ID,
} from "../src/cards/index.js";
import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { exportSync, mergeSync } from "../src/sync/index.js";

function db(): Db {
  const d = openDatabase(MEMORY);
  d.prepare("INSERT INTO decks (id, name) VALUES ('d', '日本語')").run();
  d.prepare("INSERT INTO templates (id, name, content) VALUES ('tango', '単語', '<<単語>>')").run();
  const field = d.prepare(
    "INSERT INTO template_fields (template_id, id, name, type, pos) VALUES ('tango', ?, ?, ?, ?)",
  );
  field.run("name", "単語", "plain", "a");
  field.run("imi", "意味", "plain", "b");
  field.run("reading", "Reading", "boolean", "c");
  field.run("speech", "Speech", "speech", "d");
  return d;
}

const valuesOf = (d: Db, cardId: string): Record<string, string> =>
  Object.fromEntries(
    (
      d.prepare("SELECT field_id, value FROM card_field_values WHERE card_id = ?").all(cardId) as {
        field_id: string;
        value: string;
      }[]
    ).map((r) => [r.field_id, r.value]),
  );

describe("createCard", () => {
  it("writes the card, its values and its tracks together", () => {
    const d = db();
    const made = createCard(d, {
      deckId: "d",
      templateId: "tango",
      name: "停滞",
      values: { imi: "stagnation", reading: "false" },
    });
    expect(made.tracks).toEqual(["forward"]);
    // The head word comes from the title when the values do not give it.
    expect(valuesOf(d, made.cardId)).toEqual({ name: "停滞", imi: "stagnation", reading: "false" });
    const row = d.prepare("SELECT name, local, archived FROM cards WHERE id = ?").get(made.cardId);
    expect(row).toEqual({ name: "停滞", local: 1, archived: 0 });
    const track = d
      .prepare("SELECT due_at, reps FROM card_tracks WHERE card_id = ? AND kind = 'forward'")
      .get(made.cardId);
    // New, not overdue: decision 12's limit decides when it is first shown.
    expect(track).toEqual({ due_at: null, reps: 0 });
  });

  it("refuses a field the template does not have, and makes nothing", () => {
    const d = db();
    expect(() =>
      createCard(d, { deckId: "d", templateId: "tango", name: "停滞", values: { nope: "x" } }),
    ).toThrow(/no field nope/);
    expect(() =>
      createCard(d, { deckId: "d", templateId: "tango", name: "停滞", values: { speech: "x" } }),
    ).toThrow(/generated/);
    expect(d.prepare("SELECT count(*) AS n FROM cards").get()).toEqual({ n: 0 });
  });

  it("refuses a second card of the same name on the template, and says where the first is", () => {
    const d = db();
    const first = createCard(d, { deckId: "d", templateId: "tango", name: "功績" });
    let caught: unknown;
    try {
      createCard(d, { deckId: "d", templateId: "tango", name: " 功績 " });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(DuplicateCardError);
    expect((caught as DuplicateCardError).existing).toEqual([
      { cardId: first.cardId, deckPath: "日本語", archived: false },
    ]);
    expect((caught as DuplicateCardError).message).toBe("功績 already exists on 単語 — in 日本語");
    expect(d.prepare("SELECT count(*) AS n FROM cards").get()).toEqual({ n: 1 });
  });

  it("counts an archived card, and makes the second one when asked to", () => {
    const d = db();
    const first = createCard(d, { deckId: "d", templateId: "tango", name: "篤" });
    d.prepare("UPDATE cards SET archived = 1 WHERE id = ?").run(first.cardId);
    expect(cardsNamed(d, "tango", "篤")).toEqual([
      { cardId: first.cardId, deckPath: "日本語", archived: true },
    ]);
    expect(() => createCard(d, { deckId: "d", templateId: "tango", name: "篤" })).toThrow(
      DuplicateCardError,
    );
    const second = createCard(d, { deckId: "d", templateId: "tango", name: "篤" }, { allowDuplicate: true });
    expect(second.cardId).not.toBe(first.cardId);
  });

  it("does not call a blank name or a template-less card a duplicate", () => {
    const d = db();
    createCard(d, { deckId: "d", templateId: "tango", name: "" });
    createCard(d, { deckId: "d", templateId: "tango", name: "" });
    createCard(d, { deckId: "d", templateId: null, name: "note" });
    createCard(d, { deckId: "d", templateId: null, name: "note" });
    expect(d.prepare("SELECT count(*) AS n FROM cards").get()).toEqual({ n: 4 });
  });

  it("writes 出典 in the same transaction", () => {
    const d = db();
    const source = createCard(d, { deckId: "d", templateId: "tango", name: "恒久" });
    const made = createCard(d, {
      deckId: "d",
      templateId: "tango",
      name: "包帯",
      source: { cardId: source.cardId, sentence: "包帯の代わりにした。" },
    });
    expect(valuesOf(d, made.cardId)[SOURCE_FIELD_ID]).toContain(`[[恒久|${source.cardId}]]`);
  });
});

describe("createTemplate", () => {
  it("starts with two fields and two sides, and a card on it is not blank", () => {
    const d = db();
    const made = createTemplate(d, "対義語");
    expect(made.fieldIds[0]).toBe("name");
    const card = createCard(d, {
      deckId: "d",
      templateId: made.templateId,
      name: "没頭",
      values: { [made.fieldIds[1]]: "専念" },
    });
    const rendered = loadRenderedCard(d, card.cardId, "forward");
    expect(rendered?.sides.length).toBe(2);
    // Both markers resolve: the title went into the head field, the value into Back.
    expect(JSON.stringify(rendered?.sides[0])).toContain("没頭");
    expect(JSON.stringify(rendered?.sides[1])).toContain("専念");
    expect(rendered?.warnings).toEqual([]);
  });

  it("refuses a blank name and a name another template has", () => {
    const d = db();
    expect(() => createTemplate(d, "  ")).toThrow(/needs a name/);
    expect(() => createTemplate(d, "単語")).toThrow(/already a template called 単語/);
  });

  it("reaches the other device with its fields, its body and the cards on it", () => {
    // 2026-10-30: the merge counted a template it did not have as ORPHANED and
    // skipped it, so a template made on the laptop never reached the phone and
    // every card on it arrived with no fields.
    const laptop = db();
    const phone = db();
    const made = createTemplate(laptop, "対義語");
    const card = createCard(laptop, {
      deckId: "d",
      templateId: made.templateId,
      name: "没頭",
      values: { [made.fieldIds[1]]: "専念" },
    });
    const report = mergeSync(phone, exportSync(laptop, "2026-10-30T00:00:00.000Z"));
    expect(report.applied.templatesInserted).toBe(1);
    expect(phone.prepare("SELECT name, content FROM templates WHERE id = ?").get(made.templateId)).toEqual({
      name: "対義語",
      content: "<< Front >>\n---\n<< Back >>",
    });
    const rendered = loadRenderedCard(phone, card.cardId, "forward");
    expect(JSON.stringify(rendered?.sides[1])).toContain("専念");
    expect(
      phone.prepare("SELECT count(*) AS n FROM card_tracks WHERE card_id = ?").get(card.cardId),
    ).toEqual({ n: 1 });
    // And a second merge of the same payload changes nothing.
    expect(mergeSync(phone, exportSync(laptop, "2026-10-30T00:00:01.000Z")).applied.templatesInserted).toBe(0);
  });
});
