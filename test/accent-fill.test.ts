/**
 * The database half of the laptop accent helper (`src/accent/fill.ts`), with
 * the helper's answers written by hand — the Python side is the batch pipeline's
 * own functions and is measured there.
 *
 * What must hold: only cards made in the app and only EMPTY fields are planned;
 * a guarded word gets no label; `読み` is written only when the two analysers'
 * readings agree; nothing he already typed is ever overwritten.
 */
import { describe, expect, it } from "vitest";

import { applyAccentFill, planAccentFill, type DeriveResult, type DerivedLine } from "../src/accent/fill.js";
import { loadCard } from "../src/cards/index.js";
import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { ROLE_KEY } from "../src/fields/roles.js";
import { fieldGenerationRequest, storeDescriptorText, storeTextResolver } from "../src/generate/index.js";

function device(): Db {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name) VALUES ('d', '日本語')").run();
  db.prepare("INSERT INTO templates (id, name, content) VALUES ('tango', '単語', '<<単語>>')").run();
  const field = db.prepare(
    "INSERT INTO template_fields (template_id, id, name, type, source_field_id, pos, local) VALUES ('tango', ?, ?, ?, ?, ?, ?)",
  );
  field.run("name", "単語", "plain", null, "a", 0);
  field.run("local-yomi", "読み", "plain", null, "b", 1);
  field.run("local-accent", "型", "accent", "name", "c", 1);
  return db;
}

function card(db: Db, id: string, word: string, local = 1): void {
  db.prepare("INSERT INTO cards (id, deck_id, template_id, name, local) VALUES (?, 'd', 'tango', ?, ?)").run(id, word, local);
  db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, 'name', ?)").run(id, word);
}

const valueOf = (db: Db, id: string, field: string): string | undefined =>
  (db.prepare("SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?").get(id, field) as
    | { value: string }
    | undefined)?.value;

function line(value: string, type: string | null, accent: number | null, reading: string, ok = true): DerivedLine {
  return {
    value,
    ok,
    basis: ok ? "probe" : "guarded",
    type,
    accent_type: accent,
    phrases: ok && accent !== null ? [[reading.length, accent]] : [],
    reading,
    version: "pyopenjtalk-plus/test",
    probe: "が",
    analyser: "openjtalk",
  };
}

const result = (openjtalk: DerivedLine, kana: string | null, pron: string | null): DeriveResult => ({
  openjtalk,
  unidic: null,
  kana,
  pron,
});

describe("filling a card made in the app", () => {
  it("plans only cards made here, and only their empty fields", () => {
    const db = device();
    card(db, "made", "包帯");
    card(db, "imported", "係数", 0);
    card(db, "typed", "貫く");
    db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES ('typed', 'local-accent', '中高 (3)')").run();
    const plan = planAccentFill(db);
    expect(plan.map((i) => i.cardId).sort()).toEqual(["made", "typed"]);
    const typed = plan.find((i) => i.cardId === "typed");
    expect(typed?.labelField).toBeNull();
    expect(typed?.yomiField).toBe("local-yomi");
    db.close();
  });

  it("writes the label and the written-kana reading when the analysers agree", () => {
    const db = device();
    card(db, "made", "包帯");
    const plan = planAccentFill(db);
    const report = applyAccentFill(
      db,
      plan,
      new Map([["包帯", result(line("包帯", "平板", 0, "ホータイ"), "ホウタイ", "ホータイ")]]),
      [],
    );
    expect(report).toMatchObject({ labels: 1, yomi: 1 });
    expect(valueOf(db, "made", "local-accent")).toBe("平板");
    // UniDic's WRITTEN kana, not the spoken ホータイ.
    expect(valueOf(db, "made", "local-yomi")).toBe("ほうたい");
    db.close();
  });

  it("leaves 読み empty when the readings disagree, and 型 empty when the rule refused", () => {
    const db = device();
    card(db, "made", "市場");
    card(db, "odd", "嘸かし");
    const plan = planAccentFill(db);
    applyAccentFill(
      db,
      plan,
      new Map([
        ["市場", result(line("市場", "頭高", 1, "シジョー"), "イチバ", "イチバ")],
        ["嘸かし", result(line("嘸かし", null, null, "", false), null, null)],
      ]),
      [],
    );
    expect(valueOf(db, "made", "local-accent")).toBe("頭高");
    expect(valueOf(db, "made", "local-yomi")).toBeUndefined();
    expect(valueOf(db, "odd", "local-accent")).toBeUndefined();
    db.close();
  });

  it("never overwrites a value he typed while the helper was answering", () => {
    const db = device();
    card(db, "made", "包帯");
    const plan = planAccentFill(db);
    db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES ('made', 'local-accent', '尾高')").run();
    applyAccentFill(db, plan, new Map([["包帯", result(line("包帯", "平板", 0, "ホータイ"), "ホウタイ", "ホータイ")]]), []);
    expect(valueOf(db, "made", "local-accent")).toBe("尾高");
    db.close();
  });

  it("lets a hand adjudication beat the analyser — a word settled from jpdb", () => {
    const db = device();
    card(db, "made", "高め");
    // OpenJTalk says 尾高; `DICTIONARY_ADJUDICATIONS` says 平板 (jpdb.io, 2026-10-25).
    applyAccentFill(db, planAccentFill(db), new Map([["高め", result(line("高め", "尾高", 3, "タカメ"), "タカメ", "タカメ")]]), []);
    expect(valueOf(db, "made", "local-accent")).toBe("平板");
    db.close();
  });
});

/**
 * Zach, 2026-11-11, over 安値 on the tablet: *"why am i not seeing ojad"*. The
 * example sentence was made where the card was first SHOWN — the tablet — so the
 * laptop's sweep found no sentence and skipped OJAD on every boot. The plan now
 * names such a card, so the page fetches the sentence and plans again.
 */
describe("a card whose example sentence is not on this device", () => {
  function withSentence(): Db {
    const db = device();
    const field = db.prepare(
      "INSERT INTO template_fields (template_id, id, name, type, source_field_id, pos, local, options) VALUES ('tango', ?, ?, ?, ?, ?, ?, ?)",
    );
    field.run("rei", "例文", "ai", null, "d", 0, '{"ai-custom-prompt":"Use <<単語>> in a sentence"}');
    field.run("ojad", "OJAD", "plain", "rei", "e", 1, `{"${ROLE_KEY}":"ojad"}`);
    card(db, "made", "安値");
    // 型 and 読み already there, so OJAD is the only thing this card could want.
    db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES ('made', 'local-accent', '中高 (2)')").run();
    db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES ('made', 'local-yomi', 'やすね')").run();
    return db;
  }

  function fileSentence(db: Db, text: string): void {
    const loaded = loadCard(db, "made");
    const template = loaded?.template;
    const rei = template?.fields.find((f) => f.id === "rei");
    if (template == null || rei === undefined) throw new Error("fixture lost its template");
    const request = fieldGenerationRequest(rei, {
      fields: template.fields,
      values: loaded!.values,
      resolveGenerated: storeTextResolver(db),
    });
    if (request === null) throw new Error("no request for 例文");
    storeDescriptorText(db, request, text);
  }

  it("is planned as sentence-pending, with nothing to annotate yet", () => {
    const db = withSentence();
    const plan = planAccentFill(db);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ cardId: "made", sentencePending: true, ojad: null });
    db.close();
  });

  it("gets its OJAD planned once the sentence is here", () => {
    const db = withSentence();
    fileSentence(db, "今日の取引でその会社の株価は安値を更新した。");
    const plan = planAccentFill(db);
    expect(plan[0]?.sentencePending).toBe(false);
    expect(plan[0]?.ojad?.sentence).toContain("安値を更新した");
    db.close();
  });

  it("is not pending once OJAD holds a value, sentence or no sentence", () => {
    const db = withSentence();
    db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES ('made', 'ojad', 'やす*ねを')").run();
    expect(planAccentFill(db)).toEqual([]);
    db.close();
  });
});
