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

export const canvasSatisfiesDrawSurface: DrawSurface = null as unknown as HTMLCanvasElement;
export const context2dSatisfiesDrawContext: DrawContext =
  null as unknown as CanvasRenderingContext2D;
export const domRectSatisfiesDrawRect: DrawRect = null as unknown as DOMRect;
export const pointerEventSatisfiesPort: DrawPointerEvent = null as unknown as PointerEvent;
export const inputSatisfiesInputSurface: InputSurface = null as unknown as HTMLInputElement;
export const keyboardEventSatisfiesPort: InputKeyEvent = null as unknown as KeyboardEvent;

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

function visibleText(node: MemoryNode): string {
  if (!(node instanceof MemoryElement)) return node.textContent ?? "";
  if (node.hasAttribute("hidden")) return "";
  return node.children.map(visibleText).join("");
}

function attributesOf(element: MemoryElement): Record<string, string> {
  return Object.fromEntries(element.attributes);
}

describe("kana classification", () => {
  it("separates kana, kanji and everything else", () => {
    expect([..."あアーヶ"].map(isKana)).toEqual([true, true, true, true]);
    expect([..."引換々"].map(isKanji)).toEqual([true, true, true]);
    expect(isKana("～")).toBe(false);
    expect(isKanji("～")).toBe(false);
    expect(isKanji("A")).toBe(false);
    expect(isKana("A")).toBe(false);
  });

  it("folds katakana to hiragana without changing the length", () => {
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
      expect(alignment.segments).toHaveLength(baseRuns(word).length);
      expect(alignment.segments.map((s) => s.base).join("")).toBe(word);
      expect(alignment.segments.map((s) => s.reading ?? s.base).join("")).toBe(reading);
    }
  });

  it("segments the four authored <furigana> bases, given their readings", () => {
    expect(rubyPlainText(alignFurigana("果て", "はて"))).toBe("果(は)て");
    expect(rubyPlainText(alignFurigana("巡る", "めぐる"))).toBe("巡(めぐ)る");
    expect(rubyPlainText(alignFurigana("覚ます", "さます"))).toBe("覚(さ)ます");
    const kana = alignFurigana("すずらん", "すずらん");
    expect(kana.kind).toBe("none");
    expect(kana.segments).toEqual([]);
  });

  it("annotates a katakana reading over a single kanji, 1,660 cards' shape", () => {
    const alignment = alignFurigana("密", "ミツ");
    expect(alignment.kind).toBe("segmented");
    expect(alignment.segments).toEqual([{ base: "密", kind: "kanji", reading: "ミツ" }]);
  });

  it("splits an interior kana run when it occurs exactly once", () => {
    expect(rubyPlainText(alignFurigana("書き込み", "かきこみ"))).toBe("書(か)き込(こ)み");
    expect(rubyPlainText(alignFurigana("引き換え", "ひきかえ"))).toBe("引(ひ)き換(か)え");
  });

  it("REFUSES an ambiguous split rather than guessing", () => {
    const ambiguous = alignFurigana("行き来", "ゆきき");
    expect(ambiguous.kind).toBe("whole");
    expect(ambiguous.reason).toBe("kana run き occurs more than once: ambiguous");
    expect(ambiguous.segments).toEqual([{ base: "行き来", kind: "kanji", reading: "ゆきき" }]);
  });

  it("refuses a reading that does not contain the base's own kana", () => {
    expect(alignFurigana("畳む", "たたみ")).toEqual({
      kind: "whole",
      segments: [{ base: "畳む", kind: "kanji", reading: "たたみ" }],
      reason: "trailing kana run む does not end the reading",
    });
    expect(alignFurigana("～に引き換え", "ひきかえ").reason).toBe("kana run に not at the cursor");
    expect(rubyPlainText(alignFurigana("～に引き換え", "にひきかえ"))).toBe("～に引(ひ)き換(か)え");
    expect(alignFurigana("巡る", "").kind).toBe("whole");
    expect(alignFurigana("", "めぐる").kind).toBe("whole");
    expect(alignFurigana("巡る", "る").reason).toBe(
      "trailing kana run る does not end the reading",
    );
    expect(alignFurigana("見る～", "みるか").reason).toBe(
      "reading longer than the base accounts for",
    );
    expect(rubyPlainText(alignFurigana("見る～", "みる"))).toBe("見(み)る～");
  });
});

describe("<furigana> as ruby", () => {
  it("emits one <rt> per base run, empty, before any reading exists", () => {
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
    expect(ruby.annotate("じゅんる").kind).toBe("segmented");
    expect(serialise(result.root)).toBe(once);
  });

  it("annotates by base, over a whole render", () => {
    const { result, support } = render("<furigana>巡る</furigana> and <furigana>果て</furigana>");
    expect(support.annotate(new Map([["巡る", "めぐる"], ["果て", "はて"], ["密", "ミツ"]]))).toBe(2);
    expect(result.root.textContent).toBe("巡めぐる and 果はて");
  });

  it("delegates every other element to the core renderer, byte for byte", () => {
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
    expect(elementsByTag(cloze.answer, "ruby")).toEqual([ruby]);
    expect(elementsByTag(cloze.mask, "ruby")).toEqual([]);
    support.rubies[0]!.annotate("あらかた");

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

    cloze.reveal();
    expect(visibleText(result.root)).toBe("粗方あらかた");
    expect(serialise(result.root)).toContain(
      '<span class="hashigo-cloze-answer"><ruby class="hashigo-generator hashigo-furigana"',
    );
    expect(serialise(result.root)).toContain('<span class="hashigo-cloze-mask" hidden="">');
  });

  it("filling a reading into a HIDDEN cloze does not reveal it", () => {
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
    cloze.reveal();
    expect(visibleText(result.root)).toBe("粗方あらかた");
  });

  it("renders 29thh3wW and ChtBgqLJ — the same template, Reading false and true", () => {
    const hidden = renderFixture("29thh3wW");
    expect(hidden.result.sides[0]!.empty).toBe(true);
    expect(hidden.support.rubies).toHaveLength(1);
    expect(hidden.support.rubies[0]!.base).toBe("～に引き換え");
    expect(hidden.support.rubies[0]!.runs).toHaveLength(6);
    const side2 = hidden.result.sides[1]!.element;
    expect(elementsByTag(side2, "ruby")).toHaveLength(1);
    expect(visibleText(side2)).toBe("[…][…]");
    hidden.result.revealAll();
    expect(visibleText(side2)).toBe("～に引き換え～に引き換え");

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
  readonly holding = new Set<number>();
  setPointerCapture(pointerId: number): void {
    this.captured.push(pointerId);
    this.holding.add(pointerId);
  }
  hasPointerCapture(pointerId: number): boolean {
    return this.holding.has(pointerId);
  }
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
      "contextrestored",
      "lostpointercapture",
      "pointercancel",
      "pointerdown",
      "pointermove",
      "pointerup",
    ]);
    for (const [, list] of canvas.listeners) {
      for (const entry of list) expect(entry.passive).toBe(false);
    }
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
    expect(canvas.context.ops.slice(0, 3)).toEqual([
      "setTransform(1,0,0,1,0,0)",
      "clearRect(0,0,900,1200)",
      "setTransform(3,0,0,3,0,0)",
    ]);
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
    expect(prevented).toBe(3);
    expect(canvas.captured).toEqual([7]);
    expect(canvas.released).toEqual([7]);
    expect(canvas.attributes.get(DRAW_DATA.strokes)).toBe("1");
    expect(canvas.context.ops).toEqual([
      "setTransform(1,0,0,1,0,0)",
      "beginPath",
      "moveTo(100,100)",
      "lineTo(100,100)",
      "stroke",
      "setTransform(1,0,0,1,0,0)",
      "beginPath",
      "moveTo(100,100)",
      "lineTo(120,120)",
      "stroke",
      "setTransform(1,0,0,1,0,0)",
      "beginPath",
      "moveTo(120,120)",
      "lineTo(140,100)",
      "stroke",
    ]);
  });

  it("survives Android resetting the context: strokes stay put, clear wipes everything", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 320, height: 400 });
    const handle = attachDraw(null, canvas, { devicePixelRatio: 2.8125 });
    expect([canvas.width, canvas.height]).toEqual([900, 1125]);
    canvas.fire("pointerdown", pointer(10, 10));
    canvas.fire("pointerup", pointer(10, 10));

    canvas.context.ops.length = 0;
    canvas.fire("pointerdown", pointer(300, 380));
    expect(canvas.context.ops.slice(0, 2)).toEqual(["setTransform(2.8125,0,0,2.8125,0,0)", "beginPath"]);
    canvas.context.ops.length = 0;
    canvas.fire("pointermove", pointer(310, 390));
    expect(canvas.context.ops.slice(0, 2)).toEqual(["setTransform(2.8125,0,0,2.8125,0,0)", "beginPath"]);
    canvas.fire("pointerup", pointer(310, 390));

    canvas.context.ops.length = 0;
    handle.clear();
    expect(canvas.context.ops.slice(0, 2)).toEqual(["setTransform(1,0,0,1,0,0)", "clearRect(0,0,900,1125)"]);
    expect(handle.strokes).toEqual([]);

    canvas.fire("pointerdown", pointer(50, 50));
    canvas.fire("pointerup", pointer(50, 50));
    canvas.context.ops.length = 0;
    canvas.fire("contextrestored", pointer(0, 0));
    expect(canvas.context.ops.slice(0, 3)).toEqual([
      "setTransform(1,0,0,1,0,0)",
      "clearRect(0,0,900,1125)",
      "setTransform(2.8125,0,0,2.8125,0,0)",
    ]);
    expect(canvas.context.ops.filter((op) => op === "stroke")).toHaveLength(1);
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

    canvas.fire("pointermove", pointer(10, 10));
    expect(canvas.context.ops).toEqual([]);

    canvas.fire("pointerdown", pointer(10, 10));
    canvas.fire("pointerdown", pointer(200, 200, { pointerId: 9, isPrimary: false }));
    canvas.fire("pointermove", pointer(210, 210, { pointerId: 9, isPrimary: false }));
    canvas.fire("pointermove", pointer(20, 20));
    canvas.fire("pointerup", pointer(20, 20));
    expect(handle.strokes).toHaveLength(1);
    expect(handle.strokes[0]!.points).toEqual([{ x: 10, y: 10 }, { x: 20, y: 20 }]);
  });

  it("RECOVERS from a stroke whose pointerup never arrives — his 2026-09-13 report", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 300, height: 400 });
    const handle = attachDraw(null, canvas, { devicePixelRatio: 1 });

    canvas.fire("pointerdown", pointer(10, 10));
    canvas.fire("pointermove", pointer(40, 40));
    canvas.loseCapture(7);

    canvas.fire("pointerdown", pointer(100, 100));
    canvas.fire("pointermove", pointer(140, 140));
    canvas.fire("pointerup", pointer(140, 140));

    expect(handle.drawing).toBe(false);
    expect(handle.strokes).toHaveLength(2);
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
    expect(handle.drawing).toBe(false);
    expect(handle.strokes).toHaveLength(1);
    expect(canvas.attributes.get(DRAW_DATA.strokes)).toBe("1");
  });

  it("still ignores a SECOND DEVICE while a stroke is genuinely live", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 300, height: 400 });
    const handle = attachDraw(null, canvas, { devicePixelRatio: 1 });
    canvas.fire("pointerdown", pointer(10, 10));
    canvas.fire("pointerdown", pointer(200, 200, { pointerId: 4, pointerType: "pen" }));
    canvas.fire("pointermove", pointer(20, 20));
    canvas.fire("pointerup", pointer(20, 20));
    expect(handle.strokes).toHaveLength(1);
    expect(handle.strokes[0]!.points).toEqual([{ x: 10, y: 10 }, { x: 20, y: 20 }]);
  });

  it("RECOVERS from being attached before it has a box — his one-pixel canvas", () => {
    const canvas = new FakeCanvas({ left: 0, top: 0, width: 0, height: 0 });
    const handle = attachDraw(null, canvas, { devicePixelRatio: 3 });
    expect([canvas.width, canvas.height]).toEqual([1, 1]);

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

    canvas.fire("pointerdown", pointer(10, 10));
    canvas.fire("pointerup", pointer(10, 10));
    expect(canvas.context.ops.filter((op) => op.startsWith("clearRect"))).toEqual([]);
    expect(canvas.context.ops.filter((op) => op.startsWith("setTransform"))).toEqual([
      "setTransform(1,0,0,1,0,0)",
    ]);

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
    const source = readFileSync(resolve(import.meta.dirname, "..", "src", "render", "draw.ts"), "utf8");
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "toDataURL", "fetch("]) {
      expect(executable, forbidden).not.toContain(forbidden);
    }
  });
});

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
    const { result } = renderFixture("007pK38v");
    expect(serialise(result.sides[0]!.element)).toBe(
      '<section class="hashigo-side" data-side="0" data-position="0"><p>' +
        '<input class="hashigo-input" data-widget="input" type="text" autocomplete="off" ' +
        'autocapitalize="off" spellcheck="false" data-expect="662928912" inputmode="numeric">' +
        "</p></section>",
    );
    expect(serialise(result.root)).not.toContain('value="662928912"');
    expect(result.widgets[0]!.expected).toBe("662928912");
    expect(visibleText(result.sides[1]!.element)).toBe("662,928,912");
  });

  it("substitutes the value verbatim, whatever it is — including hostile ones", () => {
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
    expect(expectOf("1>2")).toBe("1");
    expect(sideOf("1>2")).toContain('data-expect="1"');
    expect(sideOf("1>2")).toContain("2&gt;");
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
    expect(renderMath("a\\cdot b", false).html).toContain(
      'a<span class="hashigo-math-op">⋅</span>b',
    );
    expect(renderMath("\\pm 1", false).html).toContain(
      '<span class="hashigo-math-op">±</span>1',
    );
  });

  it("keeps the source on both paths, so nothing authored disappears", () => {
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
    const core = renderSides(parseContent("$\\sqrt{2}$"), { document: memoryDocument() });
    expect(core.root.textContent).toBe(renderMath("\\sqrt{2}", false).html.includes(">\\sqrt{2}<") ? "\\sqrt{2}" : "");
  });

  it("keeps an escaped dollar out of math altogether", () => {
    for (const text of ["counterfeit of $10 notes", "\\$100m of taxpayers' money"]) {
      const result = renderSides(parseContent(text), {
        document: memoryDocument(),
        renderers: mathRenderers<MemoryElement>(),
      });
      expect(result.census.get("math"), text).toBeUndefined();
    }
  });

  it("typesets math inside a cloze, on the real cards that do it", () => {
    const { result } = renderFixture("04rkyELR");
    expect(result.clozes).toHaveLength(3);
    expect(visibleText(result.sides[0]!.element)).toBe("[…]=[…]の合計÷[…]の回数");
    result.revealAll();
    expect(visibleText(result.sides[0]!.element)).toBe("MTTR=故障時間の合計÷故障の回数");
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

interface CorpusCard {
  readonly id: string;
  readonly templateId: string;
  readonly content: string;
  readonly values: Record<string, string>;
}

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
        totalRtsInDom += elementsByTag(result.root, "rt").length;
      }
    }

    expect(failures).toEqual([]);
    expect(shapeFailures).toEqual([]);
    expect(totalRts).toBe(totalRuns);
    expect(totalRuns).toBe(4934 * 2);
    expect(totalRtsInDom).toBe(4944 * 2);
    expect(Object.fromEntries(counts.forward)).toEqual({
      "element:furigana": 3503,
      "element:draw": 1663,
      "element:input": 90,
      math: 28,
      "math:subset": 28,
    });
    expect(Object.fromEntries(counts.reverse)).toEqual(Object.fromEntries(counts.forward));
    expect(mathRefusals).toEqual([]);
    expect(counts.forward.get("math:source")).toBeUndefined();

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

    expect([...drawAttributes]).toEqual([
      [JSON.stringify({ height: "400px", brushColor: "#FF0000", brushRadius: "4" }), 1662],
      [JSON.stringify({ height: "200px", brushColor: "#FF0000", brushRadius: "4" }), 1],
    ]);

    expect(inputExpectations).toHaveLength(90);
    expect(inputExpectations.every((value) => /^[0-9]+$/.test(value))).toBe(true);
  });

  it("accepts the revealed 数字 answer on all 90 cards", () => {
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
    const discarded: [string, number][] = [];
    for (const card of cards) {
      const template = card.templateId === "" ? null : templates.get(card.templateId) ?? null;
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
    expect(discarded).toEqual([["3gtxY7Mo", 1]]);
    expect(fragments.length - discarded.length).toBe(28);
    for (const latex of new Set(fragments)) {
      expect(parseMath(latex).kind, latex).toBe("typeset");
    }
  });
});

describe("parsing Zach's parenthesis workaround", () => {
  it("keys on SCRIPT, not on which side the bracket is", () => {
    const outside = parseReading("x", "器（うつわ）");
    const inside = parseReading("x", "めす（雌）");
    expect(outside?.head).toBe("器");
    expect(outside?.yomi).toBe("うつわ");
    expect(outside?.verdict).toBe("読み");
    expect(inside?.head).toBe("雌");
    expect(inside?.yomi).toBe("めす");
    expect(inside?.verdict).toBe("かな主流");

    const flipped = parseReading("other-card", "（おす）雄");
    expect(flipped?.head).toBe("雄");
    expect(flipped?.yomi).toBe("おす");
  });

  it("applies the one ratified override, and only to its own card", () => {
    const overridden = parseReading("Ufs9lMJR", "（おす）雄");
    expect(overridden?.ruled).toBe("読み");
    expect(overridden?.verdict).toBe("かな主流");
    expect(overridden?.overridden).toBe(true);
    expect(overridden?.kanaPrimary).toBe(1);

    const same = parseReading("some-other-id", "（おす）雄");
    expect(same?.verdict).toBe("読み");
    expect(same?.overridden).toBe(false);
    expect(same?.head).toBe(overridden?.head);
    expect(same?.yomi).toBe(overridden?.yomi);
  });

  it("treats a Latin gloss as 意味 and writes no reading for it", () => {
    const gloss = parseReading("x", "はたち (as in 20 years old)");
    expect(gloss?.verdict).toBe("意味");
    expect(gloss?.head).toBe("はたち");
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
    expect(classifyParenthesis("かな", "かな")).toBe("?");
    expect(classifyParenthesis("漢字", "漢字")).toBe("?");
  });
});
