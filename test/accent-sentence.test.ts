import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AnnotationError,
  cleanSentence,
  flatten,
  formatAnnotation,
  MARKS_FIELD,
  parseAnnotation,
  splitMorae,
  toHiragana,
} from "../src/accent/sentence.js";
import { openDatabase } from "../src/db/index.js";
import { memoryDocument, type MemoryElement } from "../src/render/dom.js";
import { accentMarkSupport } from "../src/render/accent-marks.js";
import { renderSides } from "../src/render/index.js";
import { parseContent } from "../src/template/index.js";

/**
 * Stage 12 — the per-mora accent annotation for an example sentence.
 *
 * Zach, 2026-09-13: *"do you think it's possible that we can add field type
 * called OJAD? … we will feed in the example sentence, which will get turned
 * into all ひらがな, and for each hiragana, if it's accented … then 開 would be
 * in our red, and if it's devoiced … し would be blue, or gray"*.
 *
 * THE ONE THING THESE MUST PROTECT is that a mark never lands on the wrong mora.
 * Every other failure is visible; that one looks exactly like a correct card.
 */

describe("the notation", () => {
  it("round-trips through format and parse", () => {
    const marks = "わたしわ|かれーを|たべ*るときに|い*つも|おなかが|おどりま*す_";
    const phrases = parseAnnotation(marks);
    expect(formatAnnotation(phrases)).toBe(marks);
    expect(phrases).toHaveLength(6);
    expect(flatten(phrases)).toHaveLength(26);
  });

  it("marks the head, the devoiced, and both at once", () => {
    const [phrase] = parseAnnotation("ま*す_");
    expect(phrase?.morae).toEqual([
      { kana: "ま", head: true, devoiced: false },
      { kana: "す", head: false, devoiced: true },
    ]);
    expect(parseAnnotation("す*_")[0]?.morae[0]).toEqual({
      kana: "す",
      head: true,
      devoiced: true,
    });
  });

  it("keeps a small kana with its mora — きょ is ONE mora, not two", () => {
    // ぎょ is ONE mora and ー is its own — 企業が is 4 morae, which is exactly
    // what the analyser reported for it (きぎょーが, phrase length 4).
    expect(splitMorae("きぎょーが")).toEqual(["き", "ぎょ", "ー", "が"]);
    expect(splitMorae("きょう")).toEqual(["きょ", "う"]);
    const [phrase] = parseAnnotation("きょ*うと");
    expect(phrase?.morae.map((m) => m.kana)).toEqual(["きょ", "う", "と"]);
    expect(phrase?.morae[0]?.head).toBe(true);
  });

  /**
   * STRICT ON PURPOSE. This is parsed on his phone at render time, and the
   * alternative to refusing is painting a plausible WRONG contour — decision 8's
   * "a wrong accent drilled is worse than no accent" in its display form.
   */
  it("refuses every malformed shape rather than guessing", () => {
    for (const [value, why] of [
      ["*かな", "a mark before any mora"],
      ["か**な", "the same mora marked twice"],
      ["か__な", "devoiced twice"],
      ["か*ょ", "a small kana after a mark"],
      ["かAな", "latin"],
      ["か|", "an empty phrase"],
      ["か*な*", "two drops in one accent phrase"],
    ] as const) {
      expect(() => parseAnnotation(value), why).toThrow(AnnotationError);
    }
  });

  it("an empty value is empty, not an error — an unannotated card is normal", () => {
    expect(parseAnnotation("")).toEqual([]);
  });

  it("converts katakana to hiragana and LEAVES ー alone", () => {
    // ー has no hiragana form, and guessing `い` would be one kana pretending to
    // be one mora. See `toHiragana`.
    expect(toHiragana("ケーキノ")).toBe("けーきの");
    expect(toHiragana("キギョーガ")).toBe("きぎょーが");
  });
});

describe("cleaning the generated sentence", () => {
  it("takes the Japanese as authored when there is nothing to strip", () => {
    expect(cleanSentence("彼は本を読んでいます。")).toBe("彼は本を読んでいます。");
  });

  /**
   * OPENJTALK READS LATIN LETTERS OUT ONE AT A TIME, so an unstripped gloss does
   * not fail — it appends ティー アール エー … to the reading and every mark after
   * the sentence lands on a letter name. Measured: that is where 581 "alignment
   * failures" came from in the first probe, and none of them were the analyser.
   */
  it("strips a latin parenthetical, which is a gloss and not the sentence", () => {
    expect(cleanSentence("私は猫が好きです。(Watashi wa neko ga suki desu.)")).toBe(
      "私は猫が好きです。",
    );
    expect(cleanSentence("私は猫が好きです。（Translation: I like cats.）")).toBe(
      "私は猫が好きです。",
    );
  });

  it("REFUSES when latin is woven in, rather than guessing where it starts", () => {
    expect(cleanSentence("私は cat が好きです。")).toBeNull();
    expect(cleanSentence("Just an English sentence.")).toBeNull();
    expect(cleanSentence("")).toBeNull();
  });

  it("unwraps quote furniture only when it wraps the WHOLE line", () => {
    expect(cleanSentence("「私は猫が好きです。」")).toBe("私は猫が好きです。");
    // 「」 inside a sentence is dialogue and belongs to the reading.
    expect(cleanSentence("彼は「おはよう」と言った。")).toBe("彼は「おはよう」と言った。");
  });
});

describe("<ojad> renders", () => {
  function render(body: string) {
    const marks = accentMarkSupport<MemoryElement>();
    const result = renderSides(parseContent(body), {
      document: memoryDocument(),
      renderers: marks.renderers,
    });
    return { marks, result };
  }

  it("leaves the sentence alone — the marks are BESIDE it, never instead of it", () => {
    // The sentence is its own field and renders as it always has. `<ojad>` adds
    // a reading line and nothing else; with no annotation it adds nothing at all.
    const { result, marks } = render("彼は本を読んでいます。\n<ojad></ojad>");
    const text = result.sides[0]?.element.textContent ?? "";
    expect(text).toContain("彼は本を読んでいます。");
    expect(marks.mounts).toHaveLength(1);
    expect(marks.mounts[0]?.element.getAttribute("data-state")).toBe("pending");
  });

  it("places one element per mora, and marks only what the notation says", () => {
    const { marks, result } = render("私は猫が好きです。\n<ojad></ojad>");
    expect(marks.mounts).toHaveLength(1);
    const placed = marks.annotateAll("わたしわ|ねこが|す*きです_");
    expect(placed).toBe(1);

    const morae = [...findAll(result.sides[0]!.element, "hashigo-mora")];
    expect(morae.map((m) => m.textContent)).toEqual([
      ..."わたしわ",
      ..."ねこが",
      ..."すきです",
    ]);
    const heads = morae.filter((m) => className(m).includes("hashigo-mora-head"));
    const devoiced = morae.filter((m) => className(m).includes("hashigo-mora-devoiced"));
    expect(heads.map((m) => m.textContent)).toEqual(["す"]);
    expect(devoiced.map((m) => m.textContent)).toEqual(["す"]);
  });

  it("a 平板 phrase carries NO mark — that absence is the signal", () => {
    const { marks, result } = render("鼻が高い\n<ojad></ojad>");
    marks.annotateAll("はなが|たか*い");
    const morae = [...findAll(result.sides[0]!.element, "hashigo-mora")];
    const marked = morae.filter((m) => className(m).includes("hashigo-mora-head"));
    // はなが is 平板: the drop is on the NEXT phrase, so nothing inside it is red.
    expect(marked.map((m) => m.textContent)).toEqual(["か"]);
  });

  it("a malformed annotation paints NOTHING and says so", () => {
    const { marks, result } = render("私は猫が好きです。\n<ojad></ojad>");
    expect(marks.annotateAll("か**な")).toBe(0);
    expect([...findAll(result.sides[0]!.element, "hashigo-mora")]).toHaveLength(0);
    expect(marks.mounts[0]?.element.getAttribute("data-state")).toBe("missing");
    // And the sentence is still there.
    expect(result.sides[0]?.element.textContent).toContain("私は猫が好きです。");
  });

  /**
   * COMPOSITION, because `furiganaSupport` overrides the same renderer and a 単語
   * card has both on it. If the chain is wrong the inner support's elements stop
   * rendering silently — the base text survives, so the card still looks fine.
   */
  it("delegates everything that is not an <ojad> to the fallback", () => {
    let delegated = 0;
    const marks = accentMarkSupport<MemoryElement>({
      fallback: (node, parent, context) => {
        delegated += 1;
        context.appendText(parent, `[${node.name}]`);
      },
    });
    const result = renderSides(parseContent("<ojad></ojad> <speech>犬</speech>"), {
      document: memoryDocument(),
      renderers: marks.renderers,
    });
    expect(delegated).toBe(1);
    expect(result.sides[0]?.element.textContent).toContain("[speech]");
    expect(marks.mounts).toHaveLength(1);
  });
});

/** The real corpus, when it is present. */
const DB = "build/hashigo.db";
describe.runIf(existsSync(DB))("over the real corpus", () => {
  it("every stored annotation parses, and none marks two drops in a phrase", () => {
    const db = openDatabase(DB, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT card_id AS cardId, value FROM card_field_values WHERE field_id = ?")
        .all(MARKS_FIELD.id) as { cardId: string; value: string }[];
      // The load path parses before it stores; this asserts the database agrees,
      // because the two could drift through any other writer.
      expect(rows.length).toBeGreaterThan(3000);
      let morae = 0;
      let heads = 0;
      for (const row of rows) {
        const phrases = parseAnnotation(row.value);
        for (const phrase of phrases) {
          expect(phrase.morae.filter((m) => m.head).length, row.cardId).toBeLessThanOrEqual(1);
        }
        const flat = flatten(phrases);
        morae += flat.length;
        heads += flat.filter((m) => m.head).length;
      }
      // THE PHANTOM-尾高 GUARD. Marking the last mora of every phrase (the naive
      // rule, and the one CLAUDE.md records as drilling 2,065 phantom 尾高)
      // produced 21.1%; the correct rule gives 13.8%. A regression would show up
      // here as the rate climbing back toward a fifth of every mora.
      const rate = (100 * heads) / morae;
      expect(rate).toBeGreaterThan(10);
      expect(rate).toBeLessThan(18);
    } finally {
      db.close();
    }
  });
});

function className(element: MemoryElement): string {
  return element.getAttribute("class") ?? "";
}

function* findAll(root: MemoryElement, wanted: string): Generator<MemoryElement> {
  for (const child of root.children) {
    if (!isElement(child)) continue;
    const classes = className(child).split(" ");
    if (classes.includes(wanted)) yield child;
    yield* findAll(child, wanted);
  }
}

function isElement(node: unknown): node is MemoryElement {
  return typeof node === "object" && node !== null && "children" in node && "getAttribute" in node;
}
