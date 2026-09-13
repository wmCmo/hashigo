/**
 * Stage 4b — the four constructs that make this a JAPANESE STUDY app rather than
 * a generic markdown renderer: `<furigana>`, `<draw>`, `<input>` and `$…$`.
 *
 * Each one is checked three ways, in this order:
 *
 *   1. UNIT, against the smallest real input — the authored tag, verbatim from
 *      the template.
 *   2. THROUGH A REAL CARD, resolved through its real template out of the
 *      committed fixtures (`test/fixtures/render/cards.json`,
 *      `test/fixtures/templates/manifest.json`), so it runs on a clean clone
 *      with no `exports/`.
 *   3. OVER THE WHOLE CORPUS, gated on `exports/` being present, asserting the
 *      counts against the census that stage 3 and stage 4 measured:
 *      furigana 3,502 · draw 1,663 · input 90 · math 28, per direction.
 *
 * THE ONE THAT IS EASY TO GET WRONG is furigana, because in the 単語 template it
 * is authored INSIDE a cloze — `{{<furigana><< 単語 >></furigana>}}` — and the
 * reading is the thing being recalled. So ruby and cloze have to compose in the
 * right order (fields resolve, then tags, then cloze), the reading must be
 * hidable, and stage 9 filling a reading into a HIDDEN cloze must not reveal it.
 * `hiddenText`/`visibleText` below are the projections that make "hidden" an
 * assertion rather than a hope.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { classifyParenthesis, hasParenthesis, parseReading } from "../src/text/index.js";

import { fieldValueText } from "../src/import/entities.js";
import {
  asRecord,
  asRecords,
  asText,
  isRecord,
  loadExport,
  walkCards,
  type MochiRecord,
} from "../src/import/transit.js";
import {
  parseContent,
  renderCard,
  resolveCard,
  type TemplateInput,
} from "../src/template/index.js";
import {
  MemoryElement,
  elementsByTag,
  memoryDocument,
  renderResolvedCard,
  renderSides,
  serialise,
  type MemoryNode,
  type NodeRenderers,
  type RenderResult,
} from "../src/render/index.js";
import {
  alignFurigana,
  baseRuns,
  furiganaSupport,
  isKana,
  isKanji,
  rubyPlainText,
  toHiragana,
  RUBY_DATA,
} from "../src/render/ruby.js";
import {
  attachDraw,
  drawSettings,
  DRAW_DATA,
  DRAW_DEFAULTS,
  type DrawContext,
  type DrawPointerEvent,
  type DrawRect,
  type DrawSurface,
} from "../src/render/draw.js";
import {
  attachInput,
  checkAnswer,
  normaliseAnswer,
  INPUT_DATA,
  type InputKeyEvent,
  type InputSurface,
} from "../src/render/input.js";
import { mathPlainText, mathRenderers, parseMath } from "../src/render/math.js";

// ─── 0. the ports really are the DOM ─────────────────────────────────────────

/**
 * Type-only, in the manner of `test/render.test.ts`: `null as unknown as T`
 * produces no runtime value, so the assignment is the whole assertion and it
 * fails at compile time or not at all. If someone widens one of these ports past
 * what a browser actually provides, `npm run typecheck` stops compiling — which
 * is the moment to find out, not when a finger touches the canvas.
 */
export const canvasSatisfiesDrawSurface: DrawSurface = null as unknown as HTMLCanvasElement;
export const context2dSatisfiesDrawContext: DrawContext =
  null as unknown as CanvasRenderingContext2D;
export const domRectSatisfiesDrawRect: DrawRect = null as unknown as DOMRect;
export const pointerEventSatisfiesPort: DrawPointerEvent = null as unknown as PointerEvent;
export const inputSatisfiesInputSurface: InputSurface = null as unknown as HTMLInputElement;
export const keyboardEventSatisfiesPort: InputKeyEvent = null as unknown as KeyboardEvent;

// ─── fixtures ────────────────────────────────────────────────────────────────

const FIXTURES = resolve(import.meta.dirname, "fixtures", "render");
const TEMPLATE_FIXTURES = resolve(import.meta.dirname, "fixtures", "templates");
const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const EXPORT_DIRS = EXPORT_NAMES.map((name) => resolve(import.meta.dirname, "..", "exports", name));
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

interface ManifestTemplate {
  readonly export: string;
  readonly id: string;
  readonly name: string;
  readonly sides: number;
  readonly content: string;
  readonly fields: readonly { readonly id: string; readonly name: string; readonly type: string | null }[];
}
interface FixtureCard {
  readonly why: string;
  readonly export: string;
  readonly id: string;
  readonly templateId: string;
  readonly content: string;
  readonly values: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(
  readFileSync(resolve(TEMPLATE_FIXTURES, "manifest.json"), "utf8"),
) as { readonly templates: readonly ManifestTemplate[] };
const fixture = JSON.parse(readFileSync(resolve(FIXTURES, "cards.json"), "utf8")) as {
  readonly cards: readonly FixtureCard[];
};

function templateInput(row: ManifestTemplate): TemplateInput {
  return {
    id: row.id,
    content: row.content,
    fields: row.fields.map((field) => ({
      id: field.id,
      name: field.name,
      ...(field.type === null ? {} : { type: field.type }),
    })),
    reversePermutation: null,
  };
}

function fixtureCard(id: string): FixtureCard {
  const card = fixture.cards.find((entry) => entry.id === id);
  if (card === undefined) throw new Error(`no fixture card ${id}`);
  return card;
}

function templateFor(card: FixtureCard): TemplateInput | null {
  if (card.templateId === "") return null;
  const row = manifest.templates.find(
    (entry) => entry.id === card.templateId && entry.export === card.export,
  );
  if (row === undefined) throw new Error(`no manifest row for ${card.export}/${card.templateId}`);
  return templateInput(row);
}

/** Every renderer this stage contributes, merged the way stage 6 will merge them. */
function japaneseRenderers(
  support: { readonly renderers: Partial<NodeRenderers<MemoryElement>> },
  onRefused?: (source: string, reason: string) => void,
): Partial<NodeRenderers<MemoryElement>> {
  return {
    ...support.renderers,
    ...mathRenderers<MemoryElement>(
      onRefused === undefined ? {} : { onRefused: (s, r) => onRefused(s, r) },
    ),
  };
}

/** Render authored card text through this stage's renderers. */
function render(
  text: string,
  options: Parameters<typeof furiganaSupport<MemoryElement>>[0] = {},
): {
  result: RenderResult<MemoryElement>;
  support: ReturnType<typeof furiganaSupport<MemoryElement>>;
  refusals: string[];
} {
  const support = furiganaSupport<MemoryElement>(options);
  const refusals: string[] = [];
  const result = renderSides(parseContent(text), {
    document: memoryDocument(),
    renderers: japaneseRenderers(support, (source, reason) => refusals.push(`${source} :: ${reason}`)),
  });
  return { result, support, refusals };
}

/** Render a fixture card through its real template. */
function renderFixture(
  id: string,
  options: Parameters<typeof furiganaSupport<MemoryElement>>[0] = {},
): {
  result: RenderResult<MemoryElement>;
  support: ReturnType<typeof furiganaSupport<MemoryElement>>;
} {
  const card = fixtureCard(id);
  const support = furiganaSupport<MemoryElement>(options);
  const result = renderResolvedCard(
    resolveCard({ id: card.id, content: card.content, values: card.values }, templateFor(card)),
    { document: memoryDocument(), renderers: japaneseRenderers(support) },
  );
  return { result, support };
}

/**
 * The text a person can actually see: `hidden` subtrees contribute NOTHING.
 *
 * This is the projection the pitch-accent drill is defined in terms of. A cloze
 * whose answer is present in `textContent` but inside `hidden` is invisible in a
 * browser, so asserting on `textContent` would pass while the card leaked.
 */
function visibleText(node: MemoryNode): string {
  if (!(node instanceof MemoryElement)) return node.textContent ?? "";
  if (node.hasAttribute("hidden")) return "";
  return node.children.map(visibleText).join("");
}

function attributesOf(element: MemoryElement): Record<string, string> {
  return Object.fromEntries(element.attributes);
}

// ─── 1. kana, runs and alignment ─────────────────────────────────────────────

describe("kana classification", () => {
  it("separates kana, kanji and everything else", () => {
    expect([..."あアーヶ"].map(isKana)).toEqual([true, true, true, true]);
    expect([..."引換々"].map(isKanji)).toEqual([true, true, true]);
    // ～ (U+FF5E) opens 1,000+ 単語 entries and is NEITHER; a reading never
    // records it, so it has to be skippable rather than annotatable.
    expect(isKana("～")).toBe(false);
    expect(isKanji("～")).toBe(false);
    expect(isKanji("A")).toBe(false);
    expect(isKana("A")).toBe(false);
  });

  it("folds katakana to hiragana without changing the length", () => {
    // The aligner searches the folded reading and slices the original, so a fold
    // that changed length would misplace every annotation after it.
    expect(toHiragana("ミツ")).toBe("みつ");
    expect(toHiragana("コーヒー")).toBe("こーひー");
    for (const sample of ["ミツ", "コーヒー", "セキ", "あらかた", "～に引き換え", "ABC"]) {
      expect(toHiragana(sample)).toHaveLength(sample.length);
    }
  });

  it("cuts a base into runs, `～に引き換え` into six", () => {
    expect(baseRuns("～に引き換え")).toEqual([
      { text: "～", kind: "other" },
      { text: "に", kind: "kana" },
      { text: "引", kind: "kanji" },
      { text: "き", kind: "kana" },
      { text: "換", kind: "kanji" },
      { text: "え", kind: "kana" },
    ]);
    expect(baseRuns("粗方")).toEqual([{ text: "粗方", kind: "kanji" }]);
    expect(baseRuns("すずらん")).toEqual([{ text: "すずらん", kind: "kana" }]);
  });
});

describe("furigana alignment", () => {
  /**
   * REAL PAIRS, measured. The 単語 template's `Reference` field holds a kana
   * reading on the cards where `Reading` is true; of 3,469 単語 cards, 8 have a
   * pure-kana `Reference` and 4 of those have kanji in the word itself. These
   * are those four, by card id, and the corpus-gated test below re-derives the
   * list from `exports/` and fails if it has drifted.
   */
  const REAL_PAIRS: readonly (readonly [string, string, string, string])[] = [
    ["3ZHpsPgC", "畳む", "たたむ", "畳(たた)む"],
    ["ChtBgqLJ", "粗方", "あらかた", "粗方(あらかた)"],
    ["LXIMpdM3", "賄う", "まかなう", "賄(まかな)う"],
    ["hvXfocqp", "忙しない", "せわしない", "忙(せわ)しない"],
  ];

  it("segments the four real (単語, kana Reference) pairs in the corpus", () => {
    for (const [id, word, reading, expected] of REAL_PAIRS) {
      const alignment = alignFurigana(word, reading);
      expect(alignment.kind, `${id} ${word}`).toBe("segmented");
      expect(rubyPlainText(alignment), id).toBe(expected);
      // A segmentation covers every run, and its readings concatenate back to
      // exactly the reading it was given. Nothing invented, nothing lost.
      expect(alignment.segments).toHaveLength(baseRuns(word).length);
      expect(alignment.segments.map((s) => s.base).join("")).toBe(word);
      expect(alignment.segments.map((s) => s.reading ?? s.base).join("")).toBe(reading);
    }
  });

  it("segments the four authored <furigana> bases, given their readings", () => {
    // The bases are the corpus's (cards fLTqmtpA, dk97adgi, i0E4Bmvz, OglIuWhv);
    // the readings are HAND-SUPPLIED, because the corpus has none — every
    // furigana reading in it is a pending generation. Labelled as such.
    expect(rubyPlainText(alignFurigana("果て", "はて"))).toBe("果(は)て");
    expect(rubyPlainText(alignFurigana("巡る", "めぐる"))).toBe("巡(めぐ)る");
    expect(rubyPlainText(alignFurigana("覚ます", "さます"))).toBe("覚(さ)ます");
    // All kana, and the reading is the base: there is nothing to annotate, and
    // すずらん over すずらん would be noise on the card.
    const kana = alignFurigana("すずらん", "すずらん");
    expect(kana.kind).toBe("none");
    expect(kana.segments).toEqual([]);
  });

  it("annotates a katakana reading over a single kanji, 1,660 cards' shape", () => {
    // 漢字's `Reading` is katakana; the base is one character. Folding is for
    // COMPARISON only — the annotation keeps the katakana it was given.
    const alignment = alignFurigana("密", "ミツ");
    expect(alignment.kind).toBe("segmented");
    expect(alignment.segments).toEqual([{ base: "密", kind: "kanji", reading: "ミツ" }]);
  });

  it("splits an interior kana run when it occurs exactly once", () => {
    expect(rubyPlainText(alignFurigana("書き込み", "かきこみ"))).toBe("書(か)き込(こ)み");
    expect(rubyPlainText(alignFurigana("引き換え", "ひきかえ"))).toBe("引(ひ)き換(か)え");
  });

  it("REFUSES an ambiguous split rather than guessing", () => {
    // 行き来 / ゆきき: the interior き occurs twice in the reading, so 行 could
    // take ゆ or ゆき. A wrong reading on a card he trusts is worse than a coarse
    // one, so it falls back to the whole base and says why.
    const ambiguous = alignFurigana("行き来", "ゆきき");
    expect(ambiguous.kind).toBe("whole");
    expect(ambiguous.reason).toBe("kana run き occurs more than once: ambiguous");
    expect(ambiguous.segments).toEqual([{ base: "行き来", kind: "kanji", reading: "ゆきき" }]);
  });

  it("refuses a reading that does not contain the base's own kana", () => {
    // 畳む / たたみ — the tail does not match, so this is not a reading of this
    // word (a conjugated form, or the wrong entry).
    expect(alignFurigana("畳む", "たたみ")).toEqual({
      kind: "whole",
      segments: [{ base: "畳む", kind: "kanji", reading: "たたみ" }],
      reason: "trailing kana run む does not end the reading",
    });
    // ～に引き換え with a reading that drops the leading に: the kana run cannot
    // be found where it must be.
    expect(alignFurigana("～に引き換え", "ひきかえ").reason).toBe("kana run に not at the cursor");
    // ...and with the full reading, it segments.
    expect(rubyPlainText(alignFurigana("～に引き換え", "にひきかえ"))).toBe("～に引(ひ)き換(か)え");
    // Empty either side; a reading too short to leave the kanji anything; and a
    // reading with more in it than the base can account for.
    expect(alignFurigana("巡る", "").kind).toBe("whole");
    expect(alignFurigana("", "めぐる").kind).toBe("whole");
    expect(alignFurigana("巡る", "る").reason).toBe(
      "trailing kana run る does not end the reading",
    );
    expect(alignFurigana("見る～", "みるか").reason).toBe(
      "reading longer than the base accounts for",
    );
    // ...and 見る～/みる, where the trailing ～ consumes nothing, does segment.
    expect(rubyPlainText(alignFurigana("見る～", "みる"))).toBe("見(み)る～");
  });
});

// ─── 2. furigana renders as ruby, and composes with cloze ─────────────────────

describe("<furigana> as ruby", () => {
  it("emits one <rt> per base run, empty, before any reading exists", () => {
    // This is what all 3,502 of the corpus's furigana look like today: the
    // skeleton is built from the BASE alone, because the reading is a pending
    // generation and the DOM port cannot restructure a <ruby> afterwards.
    const { result, support } = render("<furigana>巡る</furigana>");
    expect(serialise(result.sides[0]!.element)).toBe(
      '<section class="hashigo-side" data-side="0" data-position="0"><p>' +
        '<ruby class="hashigo-generator hashigo-furigana" data-generator="furigana" ' +
        'data-state="pending" data-ruby-runs="2">' +
        '巡<rt class="hashigo-reading"></rt>る<rt class="hashigo-reading"></rt>' +
        "</ruby></p></section>",
    );
    const ruby = support.rubies[0]!;
    expect(ruby.base).toBe("巡る");
    expect(ruby.runs.map((entry) => entry.run)).toEqual([
      { text: "巡", kind: "kanji" },
      { text: "る", kind: "kana" },
    ]);
    // The core's generation request is preserved, so stage 9 sees this ruby as
    // just another generation and files its output under blobs.kind = furigana.
    expect(ruby.generator.request).toEqual({
      kind: "furigana",
      text: "巡る",
      lang: null,
      voice: null,
      options: {},
    });
    expect(result.census.get("element:furigana")).toBe(1);
    expect(result.generations).toHaveLength(1);
  });

  it("puts the reading over the kanji run when it arrives, not over the tail", () => {
    const { result, support } = render("<furigana>巡る</furigana>");
    const alignment = support.rubies[0]!.annotate("めぐる");
    expect(alignment.kind).toBe("segmented");
    expect(serialise(elementsByTag(result.root, "ruby")[0]!)).toBe(
      '<ruby class="hashigo-generator hashigo-furigana" data-generator="furigana" ' +
        'data-state="pending" data-ruby-runs="2" data-reading="めぐる" ' +
        'data-ruby-align="segmented" data-resolved="">' +
        '巡<rt class="hashigo-reading">めぐ</rt>る<rt class="hashigo-reading"></rt></ruby>',
    );
  });

  it("takes a reading at render time too, with the same result", () => {
    const early = render("<furigana>巡る</furigana>", { reading: () => "めぐる" });
    const late = render("<furigana>巡る</furigana>");
    late.support.rubies[0]!.annotate("めぐる");
    expect(serialise(early.result.root)).toBe(serialise(late.result.root));
  });

  it("gives a refused reading the whole base, when it knows in time", () => {
    // Known up front, the alignment picks the SHAPE: a refusal takes one base and
    // one <rt>, which is the core renderer's shape and is right for a whole-base
    // reading. The same refusal arriving late cannot be placed — a multi-run
    // skeleton would print ひきかえ over ～ — so it is recorded, not written.
    const early = render("<furigana>～に引き換え</furigana>", { reading: () => "ひきかえ" });
    expect(serialise(elementsByTag(early.result.root, "ruby")[0]!)).toContain(
      '～に引き換え<rt class="hashigo-reading">ひきかえ</rt>',
    );
    const late = render("<furigana>～に引き換え</furigana>");
    const alignment = late.support.rubies[0]!.annotate("ひきかえ");
    expect(alignment.kind).toBe("whole");
    const ruby = elementsByTag(late.result.root, "ruby")[0]!;
    expect(attributesOf(ruby)[RUBY_DATA.reading]).toBe("ひきかえ");
    expect(attributesOf(ruby)[RUBY_DATA.align]).toBe("whole");
    expect(ruby.textContent).toBe("～に引き換え");
    for (const rt of elementsByTag(ruby, "rt")) expect(rt.textContent).toBe("");
  });

  it("writes nothing when the base already reads itself", () => {
    const { result, support } = render("<furigana>すずらん</furigana>");
    expect(support.rubies[0]!.annotate("すずらん").kind).toBe("none");
    expect(elementsByTag(result.root, "rt")[0]!.textContent).toBe("");
  });

  it("is idempotent: a second reading cannot double the text", () => {
    const { result, support } = render("<furigana>巡る</furigana>");
    const ruby = support.rubies[0]!;
    ruby.annotate("めぐる");
    const once = serialise(result.root);
    expect(ruby.annotate("めぐる").kind).toBe("segmented");
    expect(ruby.annotate("じゅんる").kind).toBe("segmented"); // the first wins
    expect(serialise(result.root)).toBe(once);
  });

  it("annotates by base, over a whole render", () => {
    const { result, support } = render("<furigana>巡る</furigana> and <furigana>果て</furigana>");
    expect(support.annotate(new Map([["巡る", "めぐる"], ["果て", "はて"], ["密", "ミツ"]]))).toBe(2);
    expect(result.root.textContent).toBe("巡めぐる and 果はて");
  });

  it("delegates every other element to the core renderer, byte for byte", () => {
    // A furigana-aware `element` renderer must not become a second opinion on
    // <speech>, <ai>, <draw>, <span style> or the inert-unknown path.
    const source =
      '<speech lang="jp">言葉</speech> <ai>Describe 単語</ai> ' +
      '<draw height="400px" brushColor="#FF0000" brushRadius="4"/> ' +
      '<span style="color:yellow">x</span> <blink>y</blink>';
    const plain = renderSides(parseContent(source), { document: memoryDocument() });
    const support = furiganaSupport<MemoryElement>();
    const mine = renderSides(parseContent(source), {
      document: memoryDocument(),
      renderers: support.renderers,
    });
    expect(serialise(mine.root)).toBe(serialise(plain.root));
    expect(mine.diagnostics).toEqual(plain.diagnostics);
    expect(support.rubies).toHaveLength(0);
  });

  it("delegates a <furigana> whose base is not plain text, keeping the link", () => {
    // The corpus has no link-bearing furigana; it has 10 EMPTY ones (see the
    // corpus test), which take the same path. The guard exists so that the day a
    // link is authored inside one it renders — with the core's single whole-base
    // <rt> — rather than losing the link to a flattened run split.
    const { result, support } = render("<furigana>[[夫|LqP5GCkb]]</furigana>");
    expect(support.rubies).toHaveLength(0);
    expect(serialise(result.root)).toContain(
      '<ruby class="hashigo-generator hashigo-furigana" data-generator="furigana" data-state="pending">' +
        '<a class="hashigo-card-link" href="#/card/LqP5GCkb" data-card-id="LqP5GCkb">夫</a>' +
        '<rt class="hashigo-reading"></rt></ruby>',
    );
  });
});

describe("ruby INSIDE a cloze — the pitch-accent drill", () => {
  const SOURCE = "{{<furigana>粗方</furigana>}}";

  it("nests cloze OUTSIDE ruby, so the reading is what gets hidden", () => {
    const { result, support } = render(SOURCE);
    const cloze = result.clozes[0]!;
    const ruby = elementsByTag(result.root, "ruby")[0]!;
    // The order is fields -> tags -> cloze, so the ruby is inside the cloze's
    // ANSWER, not the other way round. If it were outside, the base would show
    // and the mask would hide only the reading — a different exercise.
    expect(elementsByTag(cloze.answer, "ruby")).toEqual([ruby]);
    expect(elementsByTag(cloze.mask, "ruby")).toEqual([]);
    support.rubies[0]!.annotate("あらかた");

    // HIDDEN: the mask is all a person can see. Not the base, not the reading.
    expect(cloze.revealed).toBe(false);
    expect(visibleText(result.root)).toBe("[…]");
    expect(visibleText(result.root)).not.toContain("あらかた");
    expect(serialise(result.root)).toBe(
      '<div class="hashigo-card"><section class="hashigo-side" data-side="0" data-position="0"><p>' +
        '<span class="hashigo-cloze" data-cloze="0" data-state="hidden">' +
        '<span class="hashigo-cloze-mask">[…]</span>' +
        '<span class="hashigo-cloze-answer" hidden="">' +
        '<ruby class="hashigo-generator hashigo-furigana" data-generator="furigana" ' +
        'data-state="pending" data-ruby-runs="1" data-reading="あらかた" ' +
        'data-ruby-align="segmented" data-resolved="">' +
        '粗方<rt class="hashigo-reading">あらかた</rt></ruby>' +
        "</span></span></p></section></div>",
    );

    // REVEALED: base and reading, ruby structure intact.
    cloze.reveal();
    expect(visibleText(result.root)).toBe("粗方あらかた");
    expect(serialise(result.root)).toContain(
      '<span class="hashigo-cloze-answer"><ruby class="hashigo-generator hashigo-furigana"',
    );
    expect(serialise(result.root)).toContain('<span class="hashigo-cloze-mask" hidden="">');
  });

  it("filling a reading into a HIDDEN cloze does not reveal it", () => {
    // Stage 9 finishes a generation while the card is on screen and unanswered.
    // `annotate` writes to the <rt> and to the <ruby>'s own attributes, and to
    // nothing above them — so this cannot leak the answer.
    const { result, support } = render(SOURCE);
    const cloze = result.clozes[0]!;
    const before = attributesOf(cloze.element);
    let revealsSeen = 0;
    result.onReveal(() => (revealsSeen += 1));

    support.rubies[0]!.annotate("あらかた");

    expect(cloze.revealed).toBe(false);
    expect(revealsSeen).toBe(0);
    expect(attributesOf(cloze.element)).toEqual(before);
    expect(attributesOf(cloze.answer)["hidden"]).toBe("");
    expect(visibleText(result.root)).toBe("[…]");
    // ...and it is there the moment he asks for it.
    cloze.reveal();
    expect(visibleText(result.root)).toBe("粗方あらかた");
  });

  it("renders 29thh3wW and ChtBgqLJ — the same template, Reading false and true", () => {
    // The two halves of the drill, on real cards. 29thh3wW: Reading false, so
    // side 1 is empty and side 2 clozes both the Reference and the ruby.
    const hidden = renderFixture("29thh3wW");
    expect(hidden.result.sides[0]!.empty).toBe(true);
    expect(hidden.support.rubies).toHaveLength(1);
    expect(hidden.support.rubies[0]!.base).toBe("～に引き換え");
    expect(hidden.support.rubies[0]!.runs).toHaveLength(6);
    const side2 = hidden.result.sides[1]!.element;
    expect(elementsByTag(side2, "ruby")).toHaveLength(1);
    // Both clozes on that side hide their contents; the audio is a separate
    // element and is NOT what the cloze covers.
    expect(visibleText(side2)).toBe("[…][…]");
    hidden.result.revealAll();
    expect(visibleText(side2)).toBe("～に引き換え～に引き換え");

    // ChtBgqLJ: Reading true, so side 1 shows the reference outright and the
    // ruby on side 2 is the same drill with the answer already given.
    const shown = renderFixture("ChtBgqLJ");
    expect(visibleText(shown.result.sides[0]!.element)).toBe("あらかた");
    expect(shown.support.rubies[0]!.base).toBe("粗方");
    expect(shown.support.rubies[0]!.runs).toHaveLength(1);
  });

  it("renders 敬語 ZVvviezQ: ruby on side 2, and the audio still silent", () => {
    const { result, support } = renderFixture("ZVvviezQ");
    expect(support.rubies.map((ruby) => ruby.base)).toEqual(["伺う"]);
    expect(support.rubies[0]!.annotate("うかがう").kind).toBe("segmented");
    expect(visibleText(result.sides[1]!.element)).toBe("伺うかがう");
    // The hard rule holds through this renderer too: 1 audio element, no
    // autoplay, no loop, no src.
    const audio = elementsByTag(result.root, "audio");
    expect(audio).toHaveLength(1);
    expect(attributesOf(audio[0]!)).toEqual({
      class: "hashigo-audio",
      "data-media-kind": "audio",
      controls: "",
      preload: "none",
      "aria-label": "聞く",
    });
  });
});

// ─── 3. the <draw> canvas ────────────────────────────────────────────────────

class FakeDrawContext implements DrawContext {
  lineWidth = 1;
  strokeStyle: string | object = "#000000";
  lineCap = "butt";
  lineJoin = "miter";
  readonly ops: string[] = [];

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.ops.push(`setTransform(${a},${b},${c},${d},${e},${f})`);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.ops.push(`clearRect(${x},${y},${w},${h})`);
  }
  beginPath(): void {
    this.ops.push("beginPath");
  }
  moveTo(x: number, y: number): void {
    this.ops.push(`moveTo(${x},${y})`);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(`lineTo(${x},${y})`);
  }
  stroke(): void {
    this.ops.push("stroke");
  }
}

/**
 * A canvas element as three maps and a rectangle.
 *
 * Not jsdom, for the same reason `MemoryDocument` is not jsdom: the thing tested
 * has to be the thing that ships. The type-only assignment at the top of this
 * file is what proves the port this implements is the real `HTMLCanvasElement`'s.
 */
class FakeCanvas implements DrawSurface {
  width = 300;
  height = 150;
  readonly style = { touchAction: "", height: "", width: "" };
  readonly attributes = new Map<string, string>();
  readonly context = new FakeDrawContext();
  readonly listeners = new Map<string, { fn: (event: DrawPointerEvent) => void; passive?: boolean }[]>();
  readonly captured: number[] = [];
  readonly released: number[] = [];
  rect: DrawRect;

  constructor(rect: DrawRect = { left: 20, top: 40, width: 300, height: 400 }) {
    this.rect = rect;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getContext(id: "2d"): DrawContext | null {
    return id === "2d" ? this.context : null;
  }
  getBoundingClientRect(): DrawRect {
    return this.rect;
  }
  addEventListener(
    type: string,
    fn: (event: DrawPointerEvent) => void,
    options?: { readonly passive?: boolean },
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(options?.passive === undefined ? { fn } : { fn, passive: options.passive });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (event: DrawPointerEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry.fn !== fn));
  }
  /** Pointers we currently hold, so `hasPointerCapture` can answer honestly. */
  readonly holding = new Set<number>();
  setPointerCapture(pointerId: number): void {
    this.captured.push(pointerId);
    this.holding.add(pointerId);
  }
  hasPointerCapture(pointerId: number): boolean {
    return this.holding.has(pointerId);
  }
  /**
   * What Android does when it takes a gesture away: the capture is gone and no
   * event says so. `attachDraw` has to survive exactly this — see its `onDown`.
   */
  loseCapture(pointerId: number): void {
    this.holding.delete(pointerId);
  }
  releasePointerCapture(pointerId: number): void {
    this.holding.delete(pointerId);
    this.released.push(pointerId);
  }
  fire(type: string, event: DrawPointerEvent): void {
    for (const entry of [...(this.listeners.get(type) ?? [])]) entry.fn(event);
  }
}

let prevented = 0;
function pointer(x: number, y: number, extra: Partial<DrawPointerEvent> = {}): DrawPointerEvent {
  return {
    pointerId: 7,
    pointerType: "touch",
    isPrimary: true,
    clientX: x,
    clientY: y,
    preventDefault(): void {
      prevented += 1;
    },
    ...extra,
  };
}

describe("<draw> renders as a canvas", () => {
  it("carries the 漢字 template's authored options as data, on a real card", () => {
    const { result } = renderFixture("8mpbIWYV");
    const canvas = elementsByTag(result.root, "canvas");
    expect(canvas).toHaveLength(1);
    expect(serialise(canvas[0]!)).toBe(
      '<canvas class="hashigo-draw" data-widget="draw" data-height="400px" ' +
        'data-brush-color="#FF0000" data-brush-radius="4"></canvas>',
    );
    // Side 2 of four: the kanji, then this, then the reading. Produce, then verify.
    expect(result.sides[1]!.element.children.map((child) => child.nodeName)).toEqual(["P"]);
    expect(result.widgets.map((widget) => [widget.name, widget.side])).toEqual([["draw", 1]]);
    expect(result.widgets[0]!.attributes).toEqual({
      height: "400px",
      brushColor: "#FF0000",
      brushRadius: "4",
    });
  });

  it("reads the authored options, and defaults the rest", () => {
    expect(drawSettings({ height: "400px", brushColor: "#FF0000", brushRadius: "4" })).toEqual({
      height: "400px",
      brushColor: "#FF0000",
      brushRadius: 4,
    });
    // Card 7U1FyQB6, the corpus's other use, is 200px.
    expect(drawSettings({ height: "200px" }).height).toBe("200px");
    expect(drawSettings({})).toEqual(DRAW_DEFAULTS);
    expect(drawSettings({ height: "400" }).height).toBe("400px");
  });
});

describe("the canvas accepts a stroke from a finger", () => {
  it("listens for POINTER events only, non-passive, and refuses to be scrolled", () => {
    const canvas = new FakeCanvas();
    attachDraw(null, canvas, { attributes: { height: "400px" } });
    expect([...canvas.listeners.keys()].sort()).toEqual([
      // `lostpointercapture` is not decoration: it is the event that fires when
      // Android takes the gesture away mid-stroke, and without it the stroke is
      // never closed. See the dead-canvas regression below.
      "lostpointercapture",
      "pointercancel",
      "pointerdown",
      "pointermove",
      "pointerup",
    ]);
    for (const [, list] of canvas.listeners) {
      for (const entry of list) expect(entry.passive).toBe(false);
    }
    // A mouse-only canvas loses the start of every stroke on Android, and a
    // touch-action left alone means the first movement scrolls the card away.
    expect([...canvas.listeners.keys()].some((type) => type.startsWith("mouse"))).toBe(false);
    expect([...canvas.listeners.keys()].some((type) => type.startsWith("touch"))).toBe(false);
    expect(canvas.style.touchAction).toBe("none");
    expect(canvas.style.height).toBe("400px");
  });

  it("sizes the backing store to devicePixelRatio and draws in CSS pixels", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 300, height: 400 });
    const handle = attachDraw(null, canvas, {
      attributes: { height: "400px", brushColor: "#FF0000", brushRadius: "4" },
      devicePixelRatio: 3,
    });
    expect([canvas.width, canvas.height]).toEqual([900, 1200]);
    expect(canvas.context.ops[0]).toBe("setTransform(3,0,0,3,0,0)");
    // brushRadius is a RADIUS, so the stroke is twice as wide.
    expect(canvas.context.lineWidth).toBe(8);
    expect(canvas.context.strokeStyle).toBe("#FF0000");
    expect(canvas.context.lineCap).toBe("round");
    expect(canvas.context.lineJoin).toBe("round");
    expect(handle.settings.brushRadius).toBe(4);
  });

  it("records a synthetic pointer stroke, in element coordinates", () => {
    const canvas = new FakeCanvas({ left: 20, top: 40, width: 300, height: 400 });
    const handle = attachDraw(null, canvas, { devicePixelRatio: 1 });
    canvas.context.ops.length = 0;
    prevented = 0;

    canvas.fire("pointerdown", pointer(120, 140));
    expect(handle.drawing).toBe(true);
    canvas.fire("pointermove", pointer(140, 160));
    canvas.fire("pointermove", pointer(160, 140));
    canvas.fire("pointerup", pointer(160, 140));

    expect(handle.drawing).toBe(false);
    expect(handle.strokes).toEqual([
      {
        pointerType: "touch",
        points: [
          { x: 100, y: 100 },
          { x: 120, y: 120 },
          { x: 140, y: 100 },
        ],
      },
    ]);
    // pointerdown and both moves are preventDefault'd — a stroke must not also
    // select text or drag the element. `pointerup` is NOT: by then there is
    // nothing left to suppress, and cancelling it would also cancel the click
    // that stage 7 may want for "reveal".
    expect(prevented).toBe(3);
    expect(canvas.captured).toEqual([7]);
    expect(canvas.released).toEqual([7]);
    expect(canvas.attributes.get(DRAW_DATA.strokes)).toBe("1");
    // The 2D calls, in order: a dot at pointerdown, then one segment per move.
    expect(canvas.context.ops).toEqual([
      "beginPath",
      "moveTo(100,100)",
      "lineTo(100,100)",
      "stroke",
      "beginPath",
      "moveTo(100,100)",
      "lineTo(120,120)",
      "stroke",
      "beginPath",
      "moveTo(120,120)",
      "lineTo(140,100)",
      "stroke",
    ]);
  });

  it("leaves a dot for a tap — 点 is a stroke", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 300, height: 400 });
    const handle = attachDraw(null, canvas, { devicePixelRatio: 1 });
    canvas.fire("pointerdown", pointer(10, 10));
    canvas.fire("pointerup", pointer(10, 10));
    expect(handle.strokes).toEqual([{ pointerType: "touch", points: [{ x: 10, y: 10 }] }]);
  });

  it("ignores a second finger, and a move that never began", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 300, height: 400 });
    const handle = attachDraw(null, canvas, { devicePixelRatio: 1 });
    canvas.context.ops.length = 0;

    // A move with no pointerdown: a pinch, or a pointer captured elsewhere.
    canvas.fire("pointermove", pointer(10, 10));
    expect(canvas.context.ops).toEqual([]);

    canvas.fire("pointerdown", pointer(10, 10));
    // Palm, or the second finger of a pinch: not primary, and a different id.
    canvas.fire("pointerdown", pointer(200, 200, { pointerId: 9, isPrimary: false }));
    canvas.fire("pointermove", pointer(210, 210, { pointerId: 9, isPrimary: false }));
    canvas.fire("pointermove", pointer(20, 20));
    canvas.fire("pointerup", pointer(20, 20));
    expect(handle.strokes).toHaveLength(1);
    expect(handle.strokes[0]!.points).toEqual([{ x: 10, y: 10 }, { x: 20, y: 20 }]);
  });

  /**
   * ─── THE DEAD CANVAS: "working on my pc but not on my mobile" ──────────────
   *
   * Zach, 2026-09-13: *"why is `<draw/>` working on my pc but not on my mobile?
   * the canvas is there but when i draw nothing comes up at all..."*
   *
   * `onDown` refused while `activePointer !== null`, and only a MATCHING
   * `pointerup` cleared it. So one stroke whose end never arrives left the guard
   * latched and every later stroke was rejected — for the rest of the card,
   * silently, with the half-stroke's ink still on screen.
   *
   * **A mouse almost always delivers its `pointerup`; a finger routinely does
   * not** — Android takes the gesture for an edge swipe, the notification shade,
   * a task switch. That asymmetry is the whole of "works on PC, not on mobile",
   * and it is why this is asserted in both arms: the stroke must recover, AND a
   * genuine simultaneous second device must still be ignored.
   */
  it("RECOVERS from a stroke whose pointerup never arrives — his 2026-09-13 report", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 300, height: 400 });
    const handle = attachDraw(null, canvas, { devicePixelRatio: 1 });

    canvas.fire("pointerdown", pointer(10, 10));
    canvas.fire("pointermove", pointer(40, 40));
    // Android takes the gesture. No pointerup, no pointercancel — the capture is
    // simply gone, which is the one thing we can still observe.
    canvas.loseCapture(7);   // `pointer()` defaults to id 7

    // A fresh touch has to draw. This is the assertion that was failing on his
    // phone: before the fix, `strokes` stayed at the abandoned stroke for ever.
    canvas.fire("pointerdown", pointer(100, 100));
    canvas.fire("pointermove", pointer(140, 140));
    canvas.fire("pointerup", pointer(140, 140));

    expect(handle.drawing).toBe(false);
    expect(handle.strokes).toHaveLength(2);
    // The abandoned stroke is COMMITTED, not dropped: its ink is already on
    // screen and `repaint()` rebuilds from `strokes`, so dropping it would make
    // the next undo/clear/resize erase something he drew and watched appear.
    expect(handle.strokes[0]!.points).toEqual([{ x: 10, y: 10 }, { x: 40, y: 40 }]);
    expect(handle.strokes[1]!.points).toEqual([{ x: 100, y: 100 }, { x: 140, y: 140 }]);
  });

  it("closes the stroke on lostpointercapture, without waiting for the next touch", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 300, height: 400 });
    const handle = attachDraw(null, canvas, { devicePixelRatio: 1 });
    canvas.fire("pointerdown", pointer(10, 10));
    canvas.fire("pointermove", pointer(30, 30));
    expect(handle.drawing).toBe(true);

    canvas.fire("lostpointercapture", pointer(30, 30));
    // Closed immediately — the difference between "it hiccuped once" and "the
    // canvas stopped working".
    expect(handle.drawing).toBe(false);
    expect(handle.strokes).toHaveLength(1);
    expect(canvas.attributes.get(DRAW_DATA.strokes)).toBe("1");
  });

  it("still ignores a SECOND DEVICE while a stroke is genuinely live", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 300, height: 400 });
    const handle = attachDraw(null, canvas, { devicePixelRatio: 1 });
    canvas.fire("pointerdown", pointer(10, 10));
    // A pen is `isPrimary` within its OWN pointer type, so `isPrimary` alone does
    // not reject it — the capture check is what keeps the finger's stroke.
    canvas.fire("pointerdown", pointer(200, 200, { pointerId: 4, pointerType: "pen" }));
    canvas.fire("pointermove", pointer(20, 20));
    canvas.fire("pointerup", pointer(20, 20));
    expect(handle.strokes).toHaveLength(1);
    expect(handle.strokes[0]!.points).toEqual([{ x: 10, y: 10 }, { x: 20, y: 20 }]);
  });

  /**
   * ─── THE ONE-PIXEL CANVAS, from his own handset ────────────────────────────
   *
   * `?drawdebug` on his phone, 2026-09-13, after two fixes that were not this:
   *
   *     touch-action  none
   *     css           319 x 400
   *     backing       1 x 1     dpr 2.8125
   *     strokes       22
   *     events        pointerdown 22  pointermove 768  pointerup 22
   *
   * Nothing was wrong with the input. `touch-action` was right, every event
   * arrived, and TWENTY-TWO complete strokes were recorded. They were painted
   * into a canvas one pixel across, because `resize()` measured the element
   * before it had a laid-out box — `Math.max(1, round(0 * ratio))` is 1 — and
   * then never ran again.
   *
   * A measurement taken before layout is a measurement of nothing. These pin
   * that it is taken again, by either of the two routes.
   */
  it("RECOVERS from being attached before it has a box — his one-pixel canvas", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 0, height: 0 });
    const handle = attachDraw(null, canvas, { devicePixelRatio: 3 });
    // Attached while hidden: the degenerate backing store the bug baked in.
    expect([canvas.width, canvas.height]).toEqual([1, 1]);

    // The side is revealed, the element gets its box, and the next stroke must
    // find a canvas it can actually paint into. No ResizeObserver exists in
    // Node, so this is the `pointerdown` re-measure carrying it alone — which is
    // exactly why that second net is there.
    canvas.rect = { left: 0, top: 0, width: 319, height: 400 };
    canvas.fire("pointerdown", pointer(10, 10));
    expect([canvas.width, canvas.height]).toEqual([957, 1200]);
    canvas.fire("pointermove", pointer(40, 40));
    canvas.fire("pointerup", pointer(40, 40));
    expect(handle.strokes).toHaveLength(1);
  });

  it("does not bake in a zero box, and does not re-measure when nothing moved", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 300, height: 400 });
    const handle = attachDraw(null, canvas, { devicePixelRatio: 1 });
    canvas.context.ops.length = 0;

    // Same box: no setTransform, because a resize clears the backing store and
    // replaying strokes for nothing would cost battery on every single stroke.
    canvas.fire("pointerdown", pointer(10, 10));
    canvas.fire("pointerup", pointer(10, 10));
    expect(canvas.context.ops.filter((op) => op.startsWith("setTransform"))).toEqual([]);

    // A rotation DOES move it, and the strokes have to survive the re-measure.
    canvas.rect = { left: 0, top: 0, width: 400, height: 300 };
    canvas.fire("pointerdown", pointer(20, 20));
    expect([canvas.width, canvas.height]).toEqual([400, 300]);
    canvas.fire("pointerup", pointer(20, 20));
    expect(handle.strokes).toHaveLength(2);
  });

  it("undoes, clears and survives a resize by replaying", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 300, height: 400 });
    const changes: number[] = [];
    const handle = attachDraw(null, canvas, {
      devicePixelRatio: 1,
      onChange: (strokes) => changes.push(strokes.length),
    });
    for (const at of [10, 20, 30]) {
      canvas.fire("pointerdown", pointer(at, at));
      canvas.fire("pointerup", pointer(at, at));
    }
    expect(handle.strokes).toHaveLength(3);

    expect(handle.undo()).toBe(true);
    expect(handle.strokes).toHaveLength(2);
    expect(canvas.attributes.get(DRAW_DATA.strokes)).toBe("2");

    // A rotation clears the backing store, so the strokes have to be replayed or
    // half a character disappears.
    canvas.rect = { left: 0, top: 0, width: 800, height: 400 };
    canvas.context.ops.length = 0;
    handle.resize();
    expect([canvas.width, canvas.height]).toEqual([800, 400]);
    expect(canvas.context.ops.filter((op) => op === "stroke")).toHaveLength(2);
    expect(canvas.context.ops[0]).toBe("setTransform(1,0,0,1,0,0)");
    expect(canvas.context.ops[1]).toBe("clearRect(0,0,800,400)");

    handle.clear();
    expect(handle.strokes).toEqual([]);
    expect(handle.undo()).toBe(false);
    expect(changes).toEqual([0, 1, 2, 3, 2, 0]);

    handle.detach();
    canvas.fire("pointerdown", pointer(50, 50));
    expect(handle.strokes).toEqual([]);
  });

  it("does not persist a single stroke anywhere, on purpose", () => {
    // Stated rather than implied: the handle is the only home a stroke has. There
    // is no db, no blob, no storage call in this module — he checks the character
    // against the answer side and moves on.
    const source = readFileSync(resolve(import.meta.dirname, "..", "src", "render", "draw.ts"), "utf8");
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "toDataURL", "fetch("]) {
      expect(executable, forbidden).not.toContain(forbidden);
    }
  });
});

// ─── 4. the <input> answer box, and the unquoted-attribute trap ───────────────

class FakeInput implements InputSurface {
  value = "";
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: InputKeyEvent) => void)[]>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  addEventListener(type: string, fn: (event: InputKeyEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (event: InputKeyEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== fn));
  }
  fire(type: string, key = ""): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ key, preventDefault(): void {} });
  }
  typeText(text: string): void {
    this.value = text;
    this.fire("input");
  }
}

describe("<input value=<<Field>>> — interpolation before markup", () => {
  it("resolves the field into the attribute on the real 数字 card", () => {
    // The trap, end to end: `<input value=<<NoComma>>>` is a field reference
    // inside an UNQUOTED attribute, and it works only because interpolation is
    // textual and happens before the tag is lexed. Card 007pK38v, NoComma
    // 662928912, revealed on side 2 as 662,928,912.
    const { result } = renderFixture("007pK38v");
    expect(serialise(result.sides[0]!.element)).toBe(
      '<section class="hashigo-side" data-side="0" data-position="0"><p>' +
        '<input class="hashigo-input" data-widget="input" type="text" autocomplete="off" ' +
        'autocapitalize="off" spellcheck="false" data-expect="662928912" inputmode="numeric">' +
        "</p></section>",
    );
    // The box is EMPTY: the authored `value` is the answer, not a prefill.
    expect(serialise(result.root)).not.toContain('value="662928912"');
    expect(result.widgets[0]!.expected).toBe("662928912");
    expect(visibleText(result.sides[1]!.element)).toBe("662,928,912");
  });

  it("substitutes the value verbatim, whatever it is — including hostile ones", () => {
    // What holds this together is that all 90 NoComma values are ASCII digits.
    // These are the shapes that would NOT survive, recorded so the next person
    // does not have to discover it on a card: a space ends the attribute, and a
    // `>` ends the tag.
    const template: TemplateInput = {
      id: "trap",
      content: "<input value=<<NoComma>>>",
      fields: [{ id: "n", name: "NoComma", type: "number" }],
      reversePermutation: null,
    };
    const renderValue = (value: string): RenderResult<MemoryElement> =>
      renderSides(resolveCard({ id: "x", values: { n: value } }, template).sides, {
        document: memoryDocument(),
      });
    const expectOf = (value: string): string | null =>
      renderValue(value).widgets[0]?.expected ?? null;
    const sideOf = (value: string): string => serialise(renderValue(value).sides[0]!.element);
    const diagnosticsOf = (value: string): unknown[] => [...renderValue(value).diagnostics];
    expect(expectOf("662928912")).toBe("662928912");
    expect(expectOf("1,234")).toBe("1,234");
    // A `>` closes the tag early: the expectation is truncated to `1` and the
    // rest of the value lands on the card as text.
    expect(expectOf("1>2")).toBe("1");
    expect(sideOf("1>2")).toContain('data-expect="1"');
    expect(sideOf("1>2")).toContain("2&gt;");
    // A space, a quote, a `<` or an EMPTY value stop it being a tag at all: the
    // parser leaves the whole thing as text, so there is no widget, no
    // expectation, and — this is the part worth knowing — no diagnostic either.
    // What the card shows is its own source, which is rule 3 working as intended.
    for (const value of ["1 234", '1"2', "1<2", ""]) {
      expect(expectOf(value), value).toBeNull();
    }
    expect(sideOf("1 234")).toContain("&lt;input value=1 234&gt;");
    expect(sideOf("")).toContain("&lt;input value=&gt;");
    expect(diagnosticsOf("1 234")).toEqual([]);
  });
});

describe("answer checking", () => {
  it("accepts the formatted number the card reveals", () => {
    const check = checkAnswer("662928912", "662,928,912");
    expect(check.ok).toBe(true);
    expect(check.normalisedTyped).toBe("662928912");
  });

  it("accepts a 全角 answer, which is what a Japanese IME produces", () => {
    expect(checkAnswer("662928912", "６６２，９２８，９１２").ok).toBe(true);
    expect(normaliseAnswer("６６２，９２８，９１２")).toBe("662928912");
    // U+3000 IDEOGRAPHIC SPACE, and 、 as a separator.
    expect(normaliseAnswer("1　2、3")).toBe("123");
  });

  it("rejects a wrong digit, and an empty box", () => {
    expect(checkAnswer("662928912", "662928913").ok).toBe(false);
    expect(checkAnswer("662928912", "").ok).toBe(false);
    expect(checkAnswer("", "").ok).toBe(false);
  });

  it("does NOT fold kana unless asked, because 音読み is not 訓読み", () => {
    expect(checkAnswer("みる", "ミル").ok).toBe(false);
    expect(checkAnswer("みる", "ミル", { foldKana: true }).ok).toBe(true);
  });

  it("marks the box, clears the mark on the next keystroke, and submits on Enter", () => {
    const input = new FakeInput();
    const submitted: (boolean | null)[] = [];
    const handle = attachInput({ expected: "662928912" }, input, {
      onSubmit: (check) => submitted.push(check === null ? null : check.ok),
    });
    input.typeText("662,928,912");
    input.fire("keydown", "Enter");
    expect(submitted).toEqual([true]);
    expect(input.attributes.get(INPUT_DATA.answer)).toBe("correct");

    input.typeText("662,928,91");
    // A red box that stays red while he fixes a typo is a lie about the contents.
    expect(input.attributes.has(INPUT_DATA.answer)).toBe(false);
    input.fire("keydown", "Enter");
    expect(input.attributes.get(INPUT_DATA.answer)).toBe("incorrect");

    handle.reset();
    expect(handle.value).toBe("");
    expect(input.attributes.has(INPUT_DATA.answer)).toBe(false);
    handle.detach();
    input.fire("keydown", "Enter");
    expect(submitted).toEqual([true, false]);
  });

  it("has nothing to check when the card expects nothing", () => {
    const input = new FakeInput();
    const handle = attachInput({ expected: null }, input, {});
    input.typeText("anything");
    expect(handle.check()).toBeNull();
    expect(input.attributes.has(INPUT_DATA.answer)).toBe(false);
  });
});

// ─── 5. LaTeX ────────────────────────────────────────────────────────────────

/**
 * Every distinct fragment the corpus contains, lifted from the four card bodies
 * and the field values that carry `$`. 29 AUTHORED uses over 18 cards — the
 * RESOLVED corpus sees 28, and `src/render/math.ts`'s header holds both bases and
 * the reason they differ. These are the 14 distinct strings, on either basis; the
 * corpus-gated test below re-derives the 29, and pins the one fragment in the gap.
 */
const CORPUS_MATH: readonly (readonly [string, boolean, string])[] = [
  ["log", false, "log"],
  ["log_2n", false, "log<sub>2</sub>n"],
  ["\\times", false, '<span class="hashigo-math-op">×</span>'],
  ["\\div", false, '<span class="hashigo-math-op">÷</span>'],
  ["\\times(", false, '<span class="hashigo-math-op">×</span>('],
  ["1", false, "1"],
  ["I", false, "I"],
  ["D", false, "D"],
  ["P", false, "P"],
  ["10^{-6}", false, "10<sup>-6</sup>"],
  ["x\\times y", false, 'x<span class="hashigo-math-op">×</span>y'],
  [
    "\\frac x3",
    false,
    '<span class="hashigo-math-frac"><sup class="hashigo-math-num">x</sup>' +
      '<span class="hashigo-math-slash">⁄</span>' +
      '<sub class="hashigo-math-den">3</sub></span>',
  ],
  [
    "-\\text{ヒット率})",
    false,
    '-<span class="hashigo-math-upright">ヒット率</span>)',
  ],
  [
    "(I + D - 1)\\times　P",
    true,
    '(I + D - 1)<span class="hashigo-math-op">×</span>P',
  ],
];

function renderMath(latex: string, display: boolean): { html: string; refusals: string[] } {
  const refusals: string[] = [];
  const source = display ? `$$${latex}$$` : `$${latex}$`;
  const result = renderSides(parseContent(source), {
    document: memoryDocument(),
    renderers: mathRenderers<MemoryElement>({
      onRefused: (text, reason) => refusals.push(`${text} :: ${reason}`),
    }),
  });
  const span = elementsByTag(result.root, "span").find(
    (element) => element.getAttribute("class") === "hashigo-math",
  );
  return { html: span === undefined ? "" : serialise(span), refusals };
}

describe("LaTeX: typeset the verified subset, show the source for the rest", () => {
  it("typesets all 14 distinct fragments the corpus contains", () => {
    for (const [latex, display, inner] of CORPUS_MATH) {
      const { html, refusals } = renderMath(latex, display);
      expect(refusals, latex).toEqual([]);
      expect(html, latex).toBe(
        `<span class="hashigo-math" data-math="${display ? "display" : "inline"}" ` +
          `data-latex="${latex.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" ` +
          `data-typeset="subset">${inner}</span>`,
      );
    }
  });

  it("substitutes the two symbols the corpus does not use, since they ship anyway", () => {
    // \div 12 and \times 7 are the corpus's only symbol commands. \cdot and \pm
    // are in the table regardless; untested code in a renderer is how a wrong
    // glyph reaches a card.
    expect(renderMath("a\\cdot b", false).html).toContain(
      'a<span class="hashigo-math-op">⋅</span>b',
    );
    expect(renderMath("\\pm 1", false).html).toContain(
      '<span class="hashigo-math-op">±</span>1',
    );
  });

  it("keeps the source on both paths, so nothing authored disappears", () => {
    // Typeset: the LaTeX is in data-latex. Refused: it is the visible text AND in
    // data-latex, with the reason alongside it.
    const typeset = renderMath("\\frac x3", false);
    expect(typeset.html).toContain('data-latex="\\frac x3"');
    const refused = renderMath("\\sqrt{2}", false);
    expect(refused.html).toBe(
      '<span class="hashigo-math" data-math="inline" data-latex="\\sqrt{2}" ' +
        'data-typeset="source" data-refused="unknown command \\sqrt">\\sqrt{2}</span>',
    );
    expect(refused.refusals).toEqual(["\\sqrt{2} :: unknown command \\sqrt"]);
  });

  it("refuses anything it cannot be sure of, and says why", () => {
    const reasons = new Map(
      [
        "\\sqrt{2}",
        "\\begin{matrix}a\\end{matrix}",
        "a^",
        "{x",
        "x}",
        "\\frac{1}",
        "a & b",
        "x\\\\y",
        "\\",
      ].map((latex) => [latex, parseMath(latex)] as const),
    );
    expect(
      [...reasons].map(([latex, parsed]) => [
        latex,
        parsed.kind === "refused" ? parsed.reason : "TYPESET",
      ]),
    ).toEqual([
      ["\\sqrt{2}", "unknown command \\sqrt"],
      ["\\begin{matrix}a\\end{matrix}", "unknown command \\begin"],
      ["a^", "argument missing"],
      ["{x", "unbalanced brace"],
      ["x}", "unbalanced brace"],
      ["\\frac{1}", "argument missing"],
      ["a & b", "alignment outside the subset"],
      ["x\\\\y", "line break outside the subset"],
      ["\\", "trailing backslash"],
    ]);
    // A refusal renders the source, which is byte for byte what the core
    // renderer in nodes.ts does — the fallback is not a second behaviour.
    const core = renderSides(parseContent("$\\sqrt{2}$"), { document: memoryDocument() });
    expect(core.root.textContent).toBe(renderMath("\\sqrt{2}", false).html.includes(">\\sqrt{2}<") ? "\\sqrt{2}" : "");
  });

  it("keeps an escaped dollar out of math altogether", () => {
    // Two false positives in the corpus that a naive `$` scan would typeset:
    // card DcrJvBDB's "counterfeit of $10 notes" (one dollar sign) and
    // g7BKnlZr's "\$100m of taxpayers' money". Neither is math, and neither
    // reaches this renderer.
    for (const text of ["counterfeit of $10 notes", "\\$100m of taxpayers' money"]) {
      const result = renderSides(parseContent(text), {
        document: memoryDocument(),
        renderers: mathRenderers<MemoryElement>(),
      });
      expect(result.census.get("math"), text).toBeUndefined();
    }
  });

  it("typesets math inside a cloze, on the real cards that do it", () => {
    // 04rkyELR: {{MTTR}}={{故障時間}}の合計$\div${{故障}}の回数 — the formula is
    // outside the clozes, the terms are inside them.
    const { result } = renderFixture("04rkyELR");
    expect(result.clozes).toHaveLength(3);
    expect(visibleText(result.sides[0]!.element)).toBe("[…]=[…]の合計÷[…]の回数");
    result.revealAll();
    expect(visibleText(result.sides[0]!.element)).toBe("MTTR=故障時間の合計÷故障の回数");
    // urSsYURi: inline math inside a 漢字 Meaning field, beside a wiki-link.
    const kanji = renderFixture("urSsYURi");
    expect(visibleText(kanji.result.sides[3]!.element)).toContain("volume, product (x×y)");
  });

  it("projects back to plain text for a log line", () => {
    const parsed = parseMath("\\frac x3");
    expect(parsed.kind).toBe("typeset");
    if (parsed.kind !== "typeset") return;
    expect(mathPlainText(parsed.items)).toBe("x/3");
    const power = parseMath("10^{-6}");
    if (power.kind !== "typeset") throw new Error("expected typeset");
    expect(mathPlainText(power.items)).toBe("10^-6");
  });
});

// ─── 6. the real corpus ──────────────────────────────────────────────────────

interface CorpusCard {
  readonly id: string;
  readonly templateId: string;
  readonly content: string;
  readonly values: Record<string, string>;
}

/**
 * Read the three exports. Deliberately my own reader rather than the one in
 * `test/render.test.ts`: the counts below are only worth something if they were
 * derived independently of the code that first published them.
 */
function readCorpus(): { cards: CorpusCard[]; templates: Map<string, TemplateInput> } {
  const cards: CorpusCard[] = [];
  const templates = new Map<string, TemplateInput>();
  for (const dir of EXPORT_DIRS) {
    const root = loadExport(dir);
    for (const raw of asRecords(root["templates"])) {
      templates.set(asText(raw["id"]), {
        id: asText(raw["id"]),
        content: asText(raw["content"]),
        fields: Object.entries(asRecord(raw["fields"])).flatMap(([key, field]) =>
          isRecord(field)
            ? [
                {
                  id: asText(field["id"]) || key,
                  name: asText(field["name"]),
                  ...(asText(field["type"]) === "" ? {} : { type: asText(field["type"]) }),
                },
              ]
            : [],
        ),
        reversePermutation: null,
      });
    }
    for (const { card } of walkCards(root)) {
      const values: Record<string, string> = {};
      for (const [fieldId, field] of Object.entries(asRecord(card["fields"]))) {
        values[fieldId] = fieldValueText(isRecord(field) ? (field as MochiRecord)["value"] : field);
      }
      cards.push({
        id: asText(card["id"]),
        templateId: asText(card["template-id"]),
        content: asText(card["content"]),
        values,
      });
    }
  }
  return { cards, templates };
}

describe.skipIf(!HAVE_EXPORTS)("the real corpus (exports/)", () => {
  // 7,716 cards x 2 directions x 4 constructs, plus the shape of every ruby's
  // skeleton: 2.6-9.2 s on this machine, against `vitest.config.ts`'s
  // `testTimeout: 120_000` — which is there because five files now sweep this
  // corpus in parallel workers. This one also YIELDS every 500 cards: a test that
  // blocks the event loop for ten seconds starves vitest's own reporter RPC, and
  // that surfaces as `[vitest-worker]: Timeout calling "onTaskUpdate"` beside an
  // otherwise passing suite. One line, and one fewer confusing failure.
  it("renders every card that uses each construct, in both directions", async () => {
    const { cards, templates } = readCorpus();
    expect(cards).toHaveLength(7716);

    const counts = { forward: new Map<string, number>(), reverse: new Map<string, number>() };
    const rubyRuns = new Map<number, number>();
    const rubyBases = new Set<string>();
    const drawAttributes = new Map<string, number>();
    const inputExpectations: string[] = [];
    const mathRefusals: string[] = [];
    const failures: string[] = [];
    const shapeFailures: string[] = [];
    let totalRuns = 0;
    let totalRts = 0;
    let totalRtsInDom = 0;

    for (const direction of ["forward", "reverse"] as const) {
      const into = counts[direction];
      let since = 0;
      for (const card of cards) {
        if ((since += 1) % 500 === 0) await new Promise((done) => setImmediate(done));
        const template = card.templateId === "" ? null : templates.get(card.templateId) ?? null;
        const support = furiganaSupport<MemoryElement>();
        let result: RenderResult<MemoryElement>;
        try {
          result = renderSides(
            renderCard({ id: card.id, content: card.content, values: card.values }, template, direction)
              .sides,
            {
              document: memoryDocument(),
              renderers: japaneseRenderers(support, (source, reason) =>
                mathRefusals.push(`${card.id}: ${source} :: ${reason}`),
              ),
            },
          );
        } catch (error) {
          failures.push(`${card.id} (${direction}): ${String(error)}`);
          continue;
        }
        for (const key of ["element:furigana", "element:draw", "element:input", "math", "math:subset", "math:source"]) {
          const value = result.census.get(key);
          if (value !== undefined) into.set(key, (into.get(key) ?? 0) + value);
        }
        if (direction === "forward") {
          for (const ruby of support.rubies) {
            rubyRuns.set(ruby.runs.length, (rubyRuns.get(ruby.runs.length) ?? 0) + 1);
            rubyBases.add(ruby.base);
          }
          for (const widget of result.widgets) {
            if (widget.name === "draw") {
              const key = JSON.stringify(widget.attributes);
              drawAttributes.set(key, (drawAttributes.get(key) ?? 0) + 1);
            }
            if (widget.name === "input" && widget.expected !== null) {
              inputExpectations.push(widget.expected);
            }
          }
        }
        // Every ruby the corpus produces really is a <ruby> with one <rt> per
        // run. Counted rather than asserted per card: 6,984 assertions inside the
        // hot loop cost more than the whole render does.
        for (const ruby of support.rubies) {
          if (ruby.element.nodeName !== "RUBY") shapeFailures.push(`${card.id}: not a ruby`);
          const rts = (ruby.element as MemoryElement).children.filter(
            (child) => child.nodeName === "RT",
          ).length;
          if (rts !== ruby.runs.length) {
            shapeFailures.push(`${card.id}: ${rts} rt for ${ruby.runs.length} runs`);
          }
          totalRuns += ruby.runs.length;
          totalRts += rts;
        }
        // And every <rt> in the SERIALISED side, which is a larger set than the
        // skeleton's: the 10 empty `<furigana></furigana>` never register a ruby
        // here at all, because they go to the CORE renderer, which emits an empty
        // base and one empty <rt>. Asserted below rather than described, because
        // a report that quoted 4,933 as the number of <rt> ELEMENTS was wrong on
        // exactly this distinction.
        totalRtsInDom += elementsByTag(result.root, "rt").length;
      }
    }

    expect(failures).toEqual([]);
    expect(shapeFailures).toEqual([]);
    // TWO COUNTS, NAMED. 4,933 SKELETON RUNS per direction — 2,383 one-run bases
    // plus 913 two-run, 70 three-run, 120 four-run, 3 five-, 2 six- and 1
    // seven-run — each of which is one <rt> inside a ruby the furigana support
    // built. And 4,943 <rt> ELEMENTS per direction in the rendered DOM: the same
    // 4,933 plus the 10 empty `<furigana></furigana>` the core renderer handles.
    // Quoting either number as the other is the mistake this pins.
    expect(totalRts).toBe(totalRuns);
    expect(totalRuns).toBe(4934 * 2);
    expect(totalRtsInDom).toBe(4944 * 2);
    // The census, per direction, against what stages 3 and 4 measured.
    expect(Object.fromEntries(counts.forward)).toEqual({
      "element:furigana": 3503,
      "element:draw": 1663,
      "element:input": 90,
      math: 28,
      "math:subset": 28,
    });
    expect(Object.fromEntries(counts.reverse)).toEqual(Object.fromEntries(counts.forward));
    // 0 refusals: every formula in the corpus is inside the subset.
    expect(mathRefusals).toEqual([]);
    expect(counts.forward.get("math:source")).toBeUndefined();

    // 3,502 furigana ELEMENTS, of which 3,492 get the run skeleton: the other 10
    // are `<furigana></furigana>` — the annotated field is empty on those cards —
    // and go to the core renderer, which emits an empty base and one empty <rt>.
    // Then: how the 3,492 bases split. 2,383 are a single run, which is the shape
    // the core renderer would have got right anyway; the other 1,109 are why this
    // module exists, because a single <rt> over them would put the reading of the
    // kanji over the kana as well.
    expect([...rubyRuns].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 2384],
      [2, 913],
      [3, 70],
      [4, 120],
      [5, 3],
      [6, 2],
      [7, 1],
    ]);
    expect([...rubyRuns.values()].reduce((sum, n) => sum + n, 0)).toBe(3493);
    expect(rubyBases.size).toBe(3483);

    // Both authored <draw> attribute sets, and nothing else.
    expect([...drawAttributes]).toEqual([
      [JSON.stringify({ height: "400px", brushColor: "#FF0000", brushRadius: "4" }), 1662],
      [JSON.stringify({ height: "200px", brushColor: "#FF0000", brushRadius: "4" }), 1],
    ]);

    // All 90 expectations are ASCII digits — which is the only reason the
    // unquoted-attribute trap has never bitten.
    expect(inputExpectations).toHaveLength(90);
    expect(inputExpectations.every((value) => /^[0-9]+$/.test(value))).toBe(true);
  });

  it("accepts the revealed 数字 answer on all 90 cards", () => {
    // A real labelled test set for the answer check: `NoComma` is what he types,
    // `Number` is what side 2 reveals, and the two must compare equal.
    const { cards } = readCorpus();
    const rows = cards.filter((card) => card.templateId === "ibeOPZ1V");
    expect(rows).toHaveLength(90);
    const wrong = rows.filter((card) => {
      const expected = card.values["8T6pdCKh"] ?? "";
      const shown = card.values["name"] ?? "";
      return !checkAnswer(expected, shown).ok;
    });
    expect(wrong).toEqual([]);
  });

  it("aligns all 1,661 漢字 (Kanji, Reading) pairs, and refuses none of them", () => {
    const { cards } = readCorpus();
    const rows = cards
      .filter((card) => card.templateId === "Dq5TYgr9")
      .map((card) => ({
        id: card.id,
        kanji: card.values["name"] ?? "",
        reading: card.values["atw8SiGn"] ?? "",
      }))
      .filter((row) => row.kanji !== "" && row.reading !== "");
    const kinds = new Map<string, number>();
    const notCovering: string[] = [];
    for (const row of rows) {
      const alignment = alignFurigana(row.kanji, row.reading);
      kinds.set(alignment.kind, (kinds.get(alignment.kind) ?? 0) + 1);
      if (alignment.segments.map((segment) => segment.base).join("") !== row.kanji) {
        notCovering.push(row.id);
      }
    }
    expect(rows).toHaveLength(1661);
    // Not one refusal: a one-character base and a katakana reading is the easiest
    // alignment there is, and it is also 1,661 real annotations rather than a
    // hand-picked three.
    expect(Object.fromEntries(kinds)).toEqual({ segmented: 1661 });
    expect(notCovering).toEqual([]);
  });

  it("re-derives the four real (単語, kana Reference) pairs from the export", () => {
    const { cards } = readCorpus();
    const KANA_ONLY = /^[ぁ-ゟ゠-ヿー～]+$/u;
    const pairs = cards
      .filter((card) => card.templateId === "oiaISYb2")
      .map((card) => ({
        id: card.id,
        word: card.values["name"] ?? "",
        reference: card.values["yPvQCIRC"] ?? "",
      }))
      .filter(
        (row) =>
          row.reference !== "" &&
          KANA_ONLY.test(row.reference) &&
          [...row.word].some((ch) => isKanji(ch)),
      )
      .map((row) => [row.id, row.word, row.reference] as const)
      // By code point, not by locale: `localeCompare` puts hvXfocqp before
      // LXIMpdM3 and the list stops being reproducible from a SQL ORDER BY.
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(pairs).toEqual([
      ["3ZHpsPgC", "畳む", "たたむ"],
      ["ChtBgqLJ", "粗方", "あらかた"],
      ["LXIMpdM3", "賄う", "まかなう"],
      ["hvXfocqp", "忙しない", "せわしない"],
    ]);
  });

  it("finds 29 AUTHORED math fragments on 18 cards; 28 of them survive import", () => {
    const { cards, templates } = readCorpus();
    const fragments: string[] = [];
    const cardsWithMath = new Set<string>();
    /** [card id, fragments] for math that lives ONLY in discarded stale content. */
    const discarded: [string, number][] = [];
    for (const card of cards) {
      const template = card.templateId === "" ? null : templates.get(card.templateId) ?? null;
      // The AUTHORED projection: content plus every field value, which is where
      // the count of 29 comes from — the rendered corpus sees 28, because one of
      // them is in the stale content of a templated card, which import discards.
      const texts: [string, string][] = [["content", card.content]];
      for (const value of Object.values(card.values)) texts.push(["value", value]);
      for (const [where, text] of texts) {
        if (text === "") continue;
        const result = renderSides(parseContent(text), {
          document: memoryDocument(),
          renderers: mathRenderers<MemoryElement>(),
        });
        const found = result.census.get("math") ?? 0;
        if (found === 0) continue;
        cardsWithMath.add(card.id);
        // Stale `content` on a TEMPLATED card is what the importer throws away
        // (CLAUDE.md decision 5), so math there is authored-only.
        if (where === "content" && card.templateId !== "") discarded.push([card.id, found]);
        for (const span of elementsByTag(result.root, "span")) {
          const latex = span.getAttribute("data-latex");
          if (latex !== null) fragments.push(latex);
        }
      }
      void template;
    }
    expect(fragments).toHaveLength(29);
    expect(cardsWithMath.size).toBe(18);
    expect(new Set(fragments).size).toBe(CORPUS_MATH.length);
    // 29 authored - 1 discarded = the 28 the corpus sweep above asserts. Naming
    // the card means a future change to either number has to explain itself.
    expect(discarded).toEqual([["3gtxY7Mo", 1]]);
    expect(fragments.length - discarded.length).toBe(28);
    for (const latex of new Set(fragments)) {
      expect(parseMath(latex).kind, latex).toBe("typeset");
    }
  });
});

// ─── decision 10: the parenthesis workaround ─────────────────────────────────

describe("parsing Zach's parenthesis workaround", () => {
  it("keys on SCRIPT, not on which side the bracket is", () => {
    // The failure this exists to prevent, and it was a live bug: keying on
    // POSITION emits head=おす, 読み=雄 for `（おす）雄` — a kana head word with a
    // kanji reading, backwards, and it would have been written to his cards.
    const outside = parseReading("x", "器（うつわ）");
    const inside = parseReading("x", "めす（雌）");
    expect(outside?.head).toBe("器");
    expect(outside?.yomi).toBe("うつわ");
    expect(outside?.verdict).toBe("読み");
    expect(inside?.head).toBe("雌");
    expect(inside?.yomi).toBe("めす");
    expect(inside?.verdict).toBe("かな主流");

    // The bracket on the OTHER side, same script layout as its twin above.
    const flipped = parseReading("other-card", "（おす）雄");
    expect(flipped?.head).toBe("雄");
    expect(flipped?.yomi).toBe("おす");
  });

  it("applies the one ratified override, and only to its own card", () => {
    // `（おす）雄` is kanji-outside, so the rule says 読み; Zach ruled it
    // kana-primary like its twin めす（雌）. Listed by card id so it cannot
    // generalise — the same string on another card still follows the rule.
    const overridden = parseReading("Ufs9lMJR", "（おす）雄");
    expect(overridden?.ruled).toBe("読み");
    expect(overridden?.verdict).toBe("かな主流");
    expect(overridden?.overridden).toBe(true);
    expect(overridden?.kanaPrimary).toBe(1);

    const same = parseReading("some-other-id", "（おす）雄");
    expect(same?.verdict).toBe("読み");
    expect(same?.overridden).toBe(false);
    // Either way the head word and the reading are identical — only the label
    // differs, which is why the override is safe to carry as one row.
    expect(same?.head).toBe(overridden?.head);
    expect(same?.yomi).toBe(overridden?.yomi);
  });

  it("treats a Latin gloss as 意味 and writes no reading for it", () => {
    const gloss = parseReading("x", "はたち (as in 20 years old)");
    expect(gloss?.verdict).toBe("意味");
    expect(gloss?.head).toBe("はたち");
    // Empty, not the gloss: writing a 読み here would make `<<#Reading>>` look
    // answered when it is not.
    expect(gloss?.yomi).toBe("");
  });

  it("handles both bracket widths and a full-width space separator", () => {
    expect(parseReading("x", "日向　(ひなた)")?.head).toBe("日向");
    expect(parseReading("x", "日向　(ひなた)")?.yomi).toBe("ひなた");
    expect(parseReading("x", "あり(蟻)")?.head).toBe("蟻");
    expect(hasParenthesis("普通")).toBe(false);
    expect(parseReading("x", "普通")).toBeNull();
  });

  it("returns ? rather than guessing when the rule does not decide", () => {
    // Kana both sides: nothing distinguishes a reading from a kana-primary form,
    // and every writer in this repo refuses to write on a ?.
    expect(classifyParenthesis("かな", "かな")).toBe("?");
    expect(classifyParenthesis("漢字", "漢字")).toBe("?");
  });
});
