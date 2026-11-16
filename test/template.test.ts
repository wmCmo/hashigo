import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { fieldValueText } from "../src/import/entities.js";
import {
  asRecord,
  asText,
  isRecord,
  loadExport,
  walkCards,
  type MochiRecord,
} from "../src/import/transit.js";
import {
  census,
  collectUnknowns,
  interpolationText,
  isSideEmpty,
  mergeCensus,
  normaliseLanguageTag,
  plainText,
  sanitiseStyle,
  walk,
  type Block,
  type Inline,
  type Node,
  type Side,
} from "../src/template/ast.js";
import {
  maskFields,
  normaliseSource,
  parseContent,
  parseFieldValue,
  parseTemplate,
  sideCount,
} from "../src/template/parse.js";
import {
  isPermutation,
  orderSides,
  parseReversePermutation,
  renderCard,
  resolveCard,
  resolveSideTexts,
  sideOrder,
  type TemplateInput,
} from "../src/template/resolve.js";

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const EXPORT_DIRS = EXPORT_NAMES.map((name) => resolve(import.meta.dirname, "..", "exports", name));
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

const FIXTURES = resolve(import.meta.dirname, "fixtures", "templates");
const GOLDEN = resolve(FIXTURES, "parsed.golden.json");

interface ManifestField {
  readonly id: string;
  readonly name: string;
  readonly type: string | null;
  readonly source: string | null;
  readonly options: unknown;
  readonly pos: string;
}

interface ManifestTemplate {
  readonly export: string;
  readonly id: string;
  readonly name: string;
  readonly pos: string;
  readonly sides: number;
  readonly content: string;
  readonly fields: readonly ManifestField[];
}

interface Manifest {
  readonly generatedFrom: readonly string[];
  readonly rows: number;
  readonly distinctIds: number;
  readonly templates: readonly ManifestTemplate[];
}

const manifest = JSON.parse(readFileSync(resolve(FIXTURES, "manifest.json"), "utf8")) as Manifest;

function template(name: string): ManifestTemplate {
  const row = manifest.templates.find((entry) => entry.name === name);
  if (row === undefined) throw new Error(`no template named ${name} in the manifest`);
  return row;
}

function asInput(row: ManifestTemplate, reversePermutation: readonly number[] | null = null): TemplateInput {
  return {
    id: row.id,
    content: row.content,
    fields: row.fields.map((field) => ({
      id: field.id,
      name: field.name,
      ...(field.type === null ? {} : { type: field.type }),
    })),
    reversePermutation,
  };
}

function nodesIn<K extends Node["kind"]>(
  root: Iterable<Node>,
  kind: K,
): Extract<Node, { kind: K }>[] {
  const found: Extract<Node, { kind: K }>[] = [];
  walk(root, (node) => {
    if (node.kind === kind) found.push(node as Extract<Node, { kind: K }>);
  });
  return found;
}

function only<T>(items: readonly T[], what: string): T {
  expect(items, what).toHaveLength(1);
  return items[0] as T;
}

function childrenKinds(node: Node): string[] {
  const kids = "children" in node ? (node.children as readonly Node[]) : [];
  return kids.map((child) => child.kind);
}

describe("surface 2 — the eleven real template bodies", () => {
  it("is the whole corpus of templates: 11 rows, 10 distinct ids, 単語 twice", () => {
    expect(manifest.rows).toBe(11);
    expect(manifest.templates).toHaveLength(11);
    expect(manifest.distinctIds).toBe(10);
    const oiaISYb2 = manifest.templates.filter((row) => row.id === "oiaISYb2");
    expect(oiaISYb2.map((row) => row.export)).toEqual(["日本語", "基本情報"]);
    expect(oiaISYb2[0]?.content).toBe(oiaISYb2[1]?.content);
  });

  it("parses every template with zero unknown constructs", () => {
    const offenders: string[] = [];
    for (const row of manifest.templates) {
      for (const unknown of collectUnknowns(parseTemplate(row.content))) {
        offenders.push(`${row.export}/${row.name}: ${unknown.reason} ${JSON.stringify(unknown.text)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares the side counts SPEC states, and 19 `---` in total", () => {
    const sides = Object.fromEntries(
      manifest.templates.map((row) => [`${row.export}/${row.name}`, sideCount(row.content)]),
    );
    expect(sides).toEqual({
      "日本語/言葉": 3,
      "日本語/文法": 3,
      "日本語/単語": 4,
      "日本語/漢字": 4,
      "日本語/Polysemy": 2,
      "日本語/敬語": 2,
      "日本語/数字": 2,
      "English/New Vocab": 3,
      "English/Synonym": 1,
      "基本情報/基本情報": 2,
      "基本情報/単語": 4,
    });
    const separators = Object.values(sides).reduce((total, count) => total + count - 1, 0);
    expect(separators).toBe(19);
    for (const row of manifest.templates) {
      expect(parseTemplate(row.content)).toHaveLength(row.sides);
    }
  });

  it("reproduces SPEC's surface-2 table exactly", () => {
    const tally = new Map<string, number>();
    for (const row of manifest.templates) mergeCensus(tally, census(parseTemplate(row.content)));

    const sigils = new Map<string, number>();
    for (const row of manifest.templates) {
      for (const token of maskFields(row.content).tokens) {
        const key = token.sigil === "" ? "plain" : token.sigil;
        sigils.set(key, (sigils.get(key) ?? 0) + 1);
      }
    }
    expect(Object.fromEntries(sigils)).toEqual({ plain: 65, "#": 2, "^": 2, "/": 4 });
    expect([...sigils.values()].reduce((a, b) => a + b, 0)).toBe(73);
    expect(
      (tally.get("field") ?? 0) + (tally.get("field:href") ?? 0) + (tally.get("field:attribute") ?? 0),
    ).toBe(65);
    expect(tally.get("field")).toBe(53);
    expect(tally.get("field:href")).toBe(11);
    expect(tally.get("field:attribute")).toBe(1);

    expect(tally.get("link")).toBe(11);
    expect(tally.get("cloze")).toBe(8);
    expect(tally.get("quoteLine")).toBe(6);
    expect(tally.get("element:ai")).toBe(5);
    expect(tally.get("heading:4")).toBe(5);
    expect(tally.get("hrule:___")).toBe(4);
    expect(tally.get("section")).toBe(4);
    expect(tally.get("element:furigana")).toBe(3);
    expect(tally.get("element:draw")).toBe(1);
    expect(tally.get("element:input")).toBe(1);
    expect(tally.get("hrule:---")).toBeUndefined();

    expect(tally.get("element:speech")).toBe(2);
    const withSpeech = manifest.templates
      .filter((row) => (census(parseTemplate(row.content)).get("element:speech") ?? 0) > 0)
      .map((row) => row.name);
    expect(withSpeech).toEqual(["Polysemy", "敬語"]);
  });

  it("matches the golden AST for all ten distinct templates", async () => {
    const seen = new Set<string>();
    const golden: Record<string, readonly Side[]> = {};
    for (const row of manifest.templates) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      golden[`${row.id} ${row.name}`] = parseTemplate(row.content);
    }
    expect(Object.keys(golden)).toHaveLength(10);
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(GOLDEN);
  });
});

describe("parser trap 1 — `---` separates sides, `___` is a rule inside one", () => {
  it("splits 言葉 on `---` only, keeping its `___` as a rule on side 1", () => {
    const sides = parseTemplate(template("言葉").content);
    expect(sides).toHaveLength(3);
    expect(sides[0]?.blocks.map((block) => block.kind)).toEqual(["paragraph", "hrule", "paragraph"]);
    expect(nodesIn(sides[0]?.blocks ?? [], "hrule")).toEqual([{ kind: "hrule", marker: "___" }]);
    for (const side of sides) {
      for (const rule of nodesIn(side.blocks, "hrule")) {
        expect(rule).toEqual({ kind: "hrule", marker: "___" });
      }
    }
  });

  it("does not let a `___` split a side, nor a `---` survive as a node", () => {
    expect(parseContent("a\n___\nb")).toHaveLength(1);
    expect(parseContent("a\n---\nb")).toHaveLength(2);
    expect(nodesIn(parseContent("a\n___\nb")[0]?.blocks ?? [], "hrule")).toHaveLength(1);
    expect(nodesIn(parseContent("a\n---\nb")[0]?.blocks ?? [], "hrule")).toHaveLength(0);
  });

  it("keeps a `---` that arrives inside a field value as a rule, not a new side", () => {
    const row = template("基本情報");
    const rendered = resolveCard(
      { id: "EPp9rse6", values: { name: "one\n---\ntwo\n---\nthree" } },
      asInput(row),
    );
    expect(rendered.sides).toHaveLength(2);
    expect(nodesIn(rendered.sides[0]?.blocks ?? [], "hrule")).toEqual([
      { kind: "hrule", marker: "---" },
      { kind: "hrule", marker: "---" },
    ]);
    expect(rendered.warnings).toContainEqual({ kind: "side-break-in-value", detail: "Cue" });
  });
});

describe("parser trap 2 — constructs nest and resolve inside-out", () => {
  it("nests cloze over furigana over field in 単語, in that order", () => {
    const sides = parseTemplate(template("単語").content);
    const clozes = nodesIn(sides[1]?.blocks ?? [], "cloze");
    expect(clozes).toHaveLength(2);
    const ruby = clozes.filter((node) => childrenKinds(node)[0] === "element");
    const furigana = only(nodesIn(ruby, "element"), "one <furigana>");
    expect(furigana.name).toBe("furigana");
    expect(furigana.role).toBe("generator");
    expect(furigana.children).toEqual([{ kind: "field", name: "単語" }]);
  });

  it("nests cloze over ai over text-and-field in the 単語 heading", () => {
    const sides = parseTemplate(template("単語").content);
    const heading = only(nodesIn(sides[3]?.blocks ?? [], "heading"), "one heading");
    const cloze = only(nodesIn([heading], "cloze"), "one cloze");
    const ai = only(nodesIn([cloze], "element"), "one <ai>");
    expect(ai.name).toBe("ai");
    expect(ai.children.map((child) => child.kind)).toEqual(["text", "field", "text"]);
    expect(plainText([ai])).toBe("Describe a word  using emojis only");
  });

  it("keeps a code span verbatim, so `<component/>` is not an element", () => {
    const blocks = parseFieldValue("{{空要素（例：`<component/>`）}}");
    const cloze = only(nodesIn(blocks, "cloze"), "one cloze");
    expect(nodesIn([cloze], "element")).toEqual([]);
    expect(nodesIn([cloze], "unknown")).toEqual([]);
    expect(only(nodesIn([cloze], "code"), "one code span")).toEqual({
      kind: "code",
      text: "<component/>",
    });
  });
});

describe("parser trap 3 — fields inside unquoted attributes and URLs", () => {
  it("tokenises `<input value=<<NoComma>>>` in 数字", () => {
    const sides = parseTemplate(template("数字").content);
    expect(sides).toHaveLength(2);
    const input = only(nodesIn(sides[0]?.blocks ?? [], "element"), "one element");
    expect(input.name).toBe("input");
    expect(input.role).toBe("widget");
    expect(input.selfClosing).toBe(true);
    expect(input.attributes).toEqual([{ name: "value", value: [{ kind: "field", name: "NoComma" }] }]);
    expect(nodesIn(sides[0]?.blocks ?? [], "unknown")).toEqual([]);
  });

  it("keeps the field and the escaped wildcards inside 漢字's jisho URL", () => {
    const sides = parseTemplate(template("漢字").content);
    const links = nodesIn(sides[3]?.blocks ?? [], "link");
    expect(links).toHaveLength(4);
    const hrefs = links.map((link) => interpolationText(link.href));
    expect(hrefs).toEqual([
      "https://www.wanikani.com/kanji/<<Kanji>>",
      "https://jisho.org/search/*<<Kanji>>*",
      "https://jisho.org/search/<<Kanji>>%20%23kanji",
      "https://www.kakimashou.com/dictionary/character/<<Kanji>>",
    ]);
  });

  it("keeps `<draw>`'s configuration attributes", () => {
    const sides = parseTemplate(template("漢字").content);
    const draw = only(nodesIn(sides[1]?.blocks ?? [], "element"), "one element");
    expect(draw.name).toBe("draw");
    expect(draw.selfClosing).toBe(true);
    expect(draw.attributes.map((attr) => [attr.name, interpolationText(attr.value ?? [])])).toEqual([
      ["height", "400px"],
      ["brushColor", "#FF0000"],
      ["brushRadius", "4"],
    ]);
  });
});

describe("surface 1 details the corpus forced", () => {
  it("requires a space after `#`, so `#DaysOfMonth` stays text", () => {
    expect(nodesIn(parseFieldValue("#DaysOfMonth"), "heading")).toEqual([]);
    expect(nodesIn(parseFieldValue("#駅について"), "heading")).toEqual([]);
    expect(nodesIn(parseFieldValue("#### Hint"), "heading")).toHaveLength(1);
  });

  it("treats a bare `\\r` as a line ending, so numbered senses stay one list", () => {
    const blocks = parseFieldValue("1. one\r\n\r2. two\r\r\n3. three");
    const list = only(nodesIn(blocks, "list"), "one list");
    expect(list.items).toHaveLength(3);
    expect(normaliseSource("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("applies the intraword `_` rule to Japanese, not only to ASCII", () => {
    const emphasis = (source: string): number => nodesIn(parseFieldValue(source), "emphasis").length;
    expect(emphasis("a_b_c")).toBe(0);
    expect(emphasis("路_線_図")).toBe(0);
    expect(emphasis("これは_強調_です")).toBe(0);
    expect(emphasis("音声_20260122_01.mp3")).toBe(0);
    expect(plainText(parseFieldValue("路_線_図"))).toBe("路_線_図");
    expect(emphasis("word _Leo_.")).toBe(1);
    expect(emphasis("これは _強調_ です")).toBe(1);
    expect(emphasis("路*線*図")).toBe(1);
  });

  it("reads all three wiki-link spellings, and keeps unresolved targets", () => {
    const links = nodesIn(parseFieldValue("[[路|qGLtu5I1]] [[pvtj9W17]] [[|YGaSlUTe]]"), "wikiLink");
    expect(links).toEqual([
      { kind: "wikiLink", display: "路", target: "qGLtu5I1" },
      { kind: "wikiLink", display: null, target: "pvtj9W17" },
      { kind: "wikiLink", display: "", target: "YGaSlUTe" },
    ]);
  });

  it("degrades an unclosed construct to literal text instead of throwing", () => {
    for (const source of ["to get [[stout", "{{unclosed", "`unclosed", "$unclosed", "**unclosed"]) {
      const blocks = parseFieldValue(source);
      expect(nodesIn(blocks, "unknown"), source).toEqual([]);
      expect(plainText(blocks), source).toBe(source);
    }
  });

  it("parses a pipe table whose cells hold clozes", () => {
    const blocks = parseFieldValue("|a|b|\n|---|---|\n|{{共通鍵}}|x|");
    const table = only(nodesIn(blocks, "table"), "one table");
    expect(table.header).toHaveLength(2);
    expect(table.rows).toHaveLength(1);
    expect(nodesIn(blocks, "cloze")).toHaveLength(1);
  });

  it("keeps display maths inline so it can live inside a cloze", () => {
    const blocks = parseFieldValue("{{$$(I + D - 1)\\times　P$$}}\n$I$: {{命令数}}");
    const cloze = nodesIn(blocks, "cloze");
    expect(cloze).toHaveLength(2);
    const maths = nodesIn(blocks, "math");
    expect(maths.map((node) => node.display)).toEqual([true, false]);
    expect(maths[0]?.text).toBe("(I + D - 1)\\times　P");
  });

  it("has a sanitiser policy for the one raw `<span style>` in the corpus", () => {
    const span = only(
      nodesIn(parseFieldValue('x <span style="color:yellow">policy</span>'), "element"),
      "one element",
    );
    expect(span.name).toBe("span");
    expect(span.role).toBe("markup");
    expect(sanitiseStyle("color:yellow")).toEqual({
      declarations: [{ property: "color", value: "yellow" }],
      dropped: [],
    });
    expect(sanitiseStyle("position:fixed;background:url(x);color:red")).toEqual({
      declarations: [{ property: "color", value: "red" }],
      dropped: ["position:fixed", "background:url(x)"],
    });
  });

  it("names an unknown tag rather than dropping or trusting it", () => {
    const blocks = parseFieldValue("<marquee>x</marquee>");
    expect(nodesIn(blocks, "unknown")).toEqual([
      { kind: "unknown", reason: "unknown-element", text: "<marquee>" },
      { kind: "unknown", reason: "mismatched-close", text: "</marquee>" },
    ]);
    expect(plainText(blocks)).toBe("x");
    expect(nodesIn(parseFieldValue("1 < 2 > 3"), "unknown")).toEqual([]);
  });

  it("normalises Mochi's `lang=\"jp\"`, including the one corrupted spelling", () => {
    expect(normaliseLanguageTag("jp")).toBe("ja-JP");
    expect(normaliseLanguageTag("่jp")).toBe("ja-JP");
    expect(normaliseLanguageTag("ja-JP")).toBe("ja-JP");
    expect(normaliseLanguageTag("en")).toBe("en");
  });
});

describe("the resolver", () => {
  const 単語 = () => asInput(template("単語"));
  const VALUES = {
    name: "気に入る",
    yPvQCIRC: "[[気|EfJIGa9h]]に[[入|EhFCxqnd]]る",
    RRps0xEY: "to like",
    "1SNMVvMK": "この本が気に入る。",
    A2jzI2Kg: "I like this book.",
  } as const;

  it("gates `<<^Reading>>` on and `<<#Reading>>` off when Reading is false", () => {
    const rendered = resolveCard({ values: { ...VALUES, "4Oge7w2M": "false" } }, 単語());
    expect(rendered.source).toBe("template");
    expect(rendered.sides).toHaveLength(4);
    expect(isSideEmpty(rendered.sides[0] as Side)).toBe(true);
    expect(rendered.warnings).toContainEqual({ kind: "empty-side", detail: "0" });
    expect(nodesIn(rendered.sides[1]?.blocks ?? [], "cloze")).toHaveLength(2);
    expect(plainText(rendered.sides[1]?.blocks ?? [])).toContain("気に入る");
  });

  it("gates the other way when Reading is true", () => {
    const rendered = resolveCard({ values: { ...VALUES, "4Oge7w2M": "true" } }, 単語());
    expect(isSideEmpty(rendered.sides[0] as Side)).toBe(false);
    expect(plainText(rendered.sides[0]?.blocks ?? [])).toContain("気に入る");
    expect(nodesIn(rendered.sides[1]?.blocks ?? [], "cloze")).toHaveLength(1);
  });

  it("treats absent, empty and `\"false\"` as falsey", () => {
    for (const value of [undefined, "", "  ", "false"]) {
      const values = value === undefined ? VALUES : { ...VALUES, "4Oge7w2M": value };
      expect(isSideEmpty(resolveCard({ values }, 単語()).sides[0] as Side), String(value)).toBe(true);
    }
    expect(isSideEmpty(resolveCard({ values: { ...VALUES, "4Oge7w2M": "true" } }, 単語()).sides[0] as Side)).toBe(false);
  });

  it("interpolates before markup, so an unquoted attribute value survives", () => {
    const rendered = resolveCard({ values: { name: "1000", "8T6pdCKh": "1000" } }, asInput(template("数字")));
    const input = only(nodesIn(rendered.sides[0]?.blocks ?? [], "element"), "one element");
    expect(input.attributes).toEqual([{ name: "value", value: [{ kind: "text", text: "1000" }] }]);
    expect(nodesIn(rendered.sides[0]?.blocks ?? [], "unknown")).toEqual([]);
  });

  it("interpolates into a URL, which is SPEC's answer leak on the last side", () => {
    const rendered = resolveCard({ values: { name: "人" } }, asInput(template("漢字")));
    const hrefs = nodesIn(rendered.sides[3]?.blocks ?? [], "link").map((link) =>
      interpolationText(link.href),
    );
    expect(hrefs[0]).toBe("https://www.wanikani.com/kanji/人");
    expect(hrefs[1]).toBe("https://jisho.org/search/*人*");
  });

  it("keeps an unknown `<<Field>>` as a field node instead of deleting it", () => {
    const rendered = resolveCard({ values: {} }, { content: "a <<Nope>> b" });
    expect(nodesIn(rendered.sides[0]?.blocks ?? [], "field")).toEqual([
      { kind: "field", name: "Nope" },
    ]);
    expect(nodesIn(rendered.sides[0]?.blocks ?? [], "unknown")).toEqual([]);
    expect(rendered.warnings).toContainEqual({ kind: "unknown-field", detail: "Nope" });
  });

  it("never prints a boolean gate as text", () => {
    const rendered = resolveCard(
      { values: { flag: "true" } },
      { content: "[<<Flag>>]", fields: [{ id: "flag", name: "Flag", type: "boolean" }] },
    );
    expect(plainText(rendered.sides[0]?.blocks ?? [])).toBe("[]");
    expect(rendered.warnings).toContainEqual({ kind: "boolean-interpolated", detail: "Flag" });
  });

  it("takes sides from `content` when there is no template", () => {
    const rendered = resolveCard({
      content: '新\n---\n<draw height="200px"/>\n---\nシン\n---\nnew',
    });
    expect(rendered.source).toBe("content");
    expect(rendered.sides).toHaveLength(4);
    expect(nodesIn(rendered.sides[1]?.blocks ?? [], "element")).toHaveLength(1);
  });

  it("reports the legacy `content` a templated card still carries", () => {
    const rendered = resolveCard({ id: "mewHqlL2", content: "stale text", values: {} }, { content: "x" });
    expect(rendered.warnings).toContainEqual({ kind: "content-ignored", detail: "mewHqlL2" });
  });

  it("exposes the resolved text of each side, which stage 9 caches on", () => {
    const { texts } = resolveSideTexts({ values: { name: "人" } }, asInput(template("漢字")));
    expect(texts).toHaveLength(4);
    expect(texts[0]).toBe("人");
    expect(texts[1]).toBe('<draw height="400px" brushColor="#FF0000" brushRadius="4"/>');
  });
});

describe("direction — reverse is a declared permutation, default reversed", () => {
  it("defaults to the reversed side list", () => {
    expect(sideOrder(4, "forward")).toEqual([0, 1, 2, 3]);
    expect(sideOrder(4, "reverse")).toEqual([3, 2, 1, 0]);
    expect(sideOrder(1, "reverse")).toEqual([0]);
    expect(sideOrder(0, "reverse")).toEqual([]);
  });

  it("honours a declared permutation and keeps each side's authored index", () => {
    const sides: Side[] = [0, 1, 2, 3].map((index) => ({ index, blocks: [] }));
    expect(orderSides(sides, "reverse", [3, 0, 1, 2]).map((side) => side.index)).toEqual([3, 0, 1, 2]);
    expect(orderSides(sides, "forward", [3, 0, 1, 2]).map((side) => side.index)).toEqual([0, 1, 2, 3]);
    expect(orderSides(sides, "reverse").map((side) => side.index)).toEqual([3, 2, 1, 0]);
  });

  it("falls back to reversed, loudly, when the permutation is not one", () => {
    expect(isPermutation([3, 2, 1, 0], 4)).toBe(true);
    expect(isPermutation([0, 0, 1, 2], 4)).toBe(false);
    expect(isPermutation([0, 1, 2], 4)).toBe(false);
    expect(isPermutation([0, 1, 2, 9], 4)).toBe(false);
    const rendered = renderCard({ values: {} }, { content: "a\n---\nb", reversePermutation: [0, 0] }, "reverse");
    expect(rendered.sides.map((side) => side.index)).toEqual([1, 0]);
    expect(rendered.warnings).toContainEqual({ kind: "invalid-permutation", detail: "[0,0]" });
  });

  it("decodes `templates.reverse_permutation` from the JSON the schema stores", () => {
    expect(parseReversePermutation("[3,0,1,2]")).toEqual([3, 0, 1, 2]);
    expect(parseReversePermutation(null)).toBeNull();
    expect(parseReversePermutation("")).toBeNull();
    expect(parseReversePermutation("nonsense")).toBeNull();
    expect(parseReversePermutation('["a"]')).toBeNull();
  });

  it("flips 単語 so 意味 is asked first, which is what a reverse track is for", () => {
    const row = template("単語");
    const forward = renderCard({ values: { name: "気に入る", RRps0xEY: "to like" } }, asInput(row), "forward");
    const reverse = renderCard({ values: { name: "気に入る", RRps0xEY: "to like" } }, asInput(row), "reverse");
    expect(forward.sides.map((side) => side.index)).toEqual([0, 1, 2, 3]);
    expect(reverse.sides.map((side) => side.index)).toEqual([3, 2, 1, 0]);
    expect(plainText(reverse.sides[0]?.blocks ?? [])).toContain("to like");
  });
});

interface CorpusCard {
  readonly id: string;
  readonly templateId: string;
  readonly content: string;
  readonly values: Record<string, string>;
}

function readCorpus(): { cards: CorpusCard[]; templates: Map<string, MochiRecord> } {
  const cards: CorpusCard[] = [];
  const templates = new Map<string, MochiRecord>();
  for (const dir of EXPORT_DIRS) {
    const root = loadExport(dir);
    for (const raw of (root["templates"] as MochiRecord[] | undefined) ?? []) {
      if (isRecord(raw)) templates.set(asText(raw["id"]), raw);
    }
    for (const { card } of walkCards(root)) {
      const values: Record<string, string> = {};
      for (const [fieldId, field] of Object.entries(asRecord(card["fields"]))) {
        values[fieldId] = fieldValueText(isRecord(field) ? field["value"] : field);
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
  it("the committed manifest still matches the exports it was generated from", async () => {
    const { buildManifest } = await import("./fixtures/templates/extract.js");
    expect(buildManifest()).toEqual(manifest);
  });

  it("parses the content and every field value of all 7,716 cards", () => {
    const { cards } = readCorpus();
    expect(cards).toHaveLength(7716);

    const tally = new Map<string, number>();
    const failures: string[] = [];
    const unknowns: string[] = [];
    let contentSides = 0;
    let values = 0;

    for (const card of cards) {
      const sides: Side[] = [];
      try {
        const parsed = parseContent(card.content);
        contentSides += parsed.length;
        sides.push(...parsed);
        for (const value of Object.values(card.values)) {
          if (value === "") continue;
          values += 1;
          sides.push({ index: 0, blocks: parseFieldValue(value) });
        }
      } catch (error) {
        failures.push(`${card.id}: ${String(error)}`);
        continue;
      }
      mergeCensus(tally, census(sides));
      for (const unknown of collectUnknowns(sides)) {
        unknowns.push(`${card.id}: ${unknown.reason} ${JSON.stringify(unknown.text)}`);
      }
    }

    const counts = Object.fromEntries([...tally].sort()) as Record<string, number>;
    const sideBreaks = contentSides - cards.length;
    console.log(
      `surface 1 over ${cards.length} cards / ${values} field values` +
        `\n  parse failures ${failures.length} | unknown constructs ${unknowns.length}` +
        `\n  side breaks in content ${sideBreaks} + hrule:--- ${counts["hrule:---"]} = ${sideBreaks + (counts["hrule:---"] ?? 0)}` +
        `\n${Object.entries(counts)
          .map(([key, value]) => `  ${key.padEnd(22)} ${value}`)
          .join("\n")}`,
    );

    expect(failures).toEqual([]);
    expect(unknowns).toEqual([]);

    expect(counts["wikiLink"]).toBe(8690);
    expect(sideBreaks + (counts["hrule:---"] ?? 0)).toBe(1694);
    expect(counts["hrule:___"]).toBe(255);
    expect(counts["code"]).toBe(294);
    expect(counts["element:speech"]).toBe(287);
    expect(counts["element:ai"]).toBe(124);
    expect(counts["element:translate"]).toBe(106);
    expect(counts["element:furigana"]).toBe(19);
    expect(counts["element:image"]).toBe(8);
    expect(counts["element"]).toBe(287 + 124 + 106 + 19 + 8 + 2 + 1);
    expect((counts["math:inline"] ?? 0) + (counts["math:display"] ?? 0)).toBe(29);
    expect((counts["quoteLine"] ?? 0) + (counts["heading"] ?? 0) + (counts["listItem:unordered"] ?? 0)).toBe(76);
    expect(counts["quoteLine"]).toBe(45);
    expect(counts["heading"]).toBe(15);
    expect(counts["listItem:unordered"]).toBe(16);
    expect(counts["image"]).toBe(7);
    expect(counts["table"]).toBe(1);
    expect(counts["element:draw"]).toBe(2);
    expect((counts["emphasis:*"] ?? 0) + (counts["emphasis:_"] ?? 0)).toBe(3);
    expect(counts["element:span"]).toBe(1);

    expect(counts["listItem:ordered"]).toBe(4318);
    let afterBareCR = 0;
    for (const card of cards) {
      for (const source of [card.content, ...Object.values(card.values)]) {
        afterBareCR += [...source.matchAll(/\r(?!\n)[ \t]*\d{1,9}\.[ \t]/g)].length;
      }
    }
    expect(afterBareCR).toBe(4);
    expect(counts["listItem:ordered"]! - afterBareCR).toBe(4314);
    expect(counts["cloze"]).toBe(1079);
    expect(counts["strong:**"]).toBe(312);
    expect(counts["wikiLink:bare"]).toBe(46);
    expect(counts["wikiLink:emptyDisplay"]).toBe(8);

    let clozeInCode = 0;
    let boldInDisplay = 0;
    for (const card of cards) {
      const blocks: Block[] = [
        ...parseContent(card.content).flatMap((side) => side.blocks),
        ...Object.values(card.values).flatMap((value) => parseFieldValue(value)),
      ];
      for (const code of nodesIn(blocks, "code")) {
        if (code.text.includes("{{")) clozeInCode += 1;
      }
      for (const link of nodesIn(blocks, "wikiLink")) {
        if ((link.display ?? "").includes("**")) boldInDisplay += 1;
      }
    }
    expect(clozeInCode).toBe(1);
    expect(boldInDisplay).toBe(1);
    expect(counts["cloze"]! + clozeInCode).toBe(1080);
    expect(counts["strong:**"]! + boldInDisplay).toBe(313);
  });

  it("resolves all 7,716 cards through their templates with zero unknowns", () => {
    const { cards, templates } = readCorpus();
    const inputs = new Map<string, TemplateInput>();
    for (const [id, raw] of templates) {
      inputs.set(id, {
        id,
        content: asText(raw["content"]),
        fields: Object.entries(asRecord(raw["fields"])).flatMap(([key, field]) =>
          isRecord(field)
            ? [{ id: asText(field["id"]) || key, name: asText(field["name"]), type: asText(field["type"]) || "plain" }]
            : [],
        ),
        reversePermutation: null,
      });
    }

    const unknowns: string[] = [];
    const warnings = new Map<string, number>();
    const bySource = { template: 0, content: 0 };
    let sides = 0;
    let emptySides = 0;
    let reverseMismatch = 0;

    for (const card of cards) {
      const input = card.templateId === "" ? null : (inputs.get(card.templateId) ?? null);
      const rendered = resolveCard({ id: card.id, content: card.content, values: card.values }, input);
      bySource[rendered.source] += 1;
      sides += rendered.sides.length;
      for (const side of rendered.sides) if (isSideEmpty(side)) emptySides += 1;
      for (const warning of rendered.warnings) {
        warnings.set(warning.kind, (warnings.get(warning.kind) ?? 0) + 1);
      }
      for (const unknown of collectUnknowns(rendered.sides)) {
        unknowns.push(`${card.id}: ${unknown.reason} ${JSON.stringify(unknown.text)}`);
      }
      const reverse = renderCard({ id: card.id, content: card.content, values: card.values }, input, "reverse");
      const indices = reverse.sides.map((side) => side.index);
      if (indices.join() !== [...indices].sort((a, b) => b - a).join()) reverseMismatch += 1;
    }

    console.log(
      `resolver over ${cards.length} cards` +
        `\n  sides ${sides} | empty sides ${emptySides} | unknown constructs ${unknowns.length}` +
        `\n  source ${JSON.stringify(bySource)} | reverse order mismatches ${reverseMismatch}` +
        `\n  warnings ${JSON.stringify(Object.fromEntries([...warnings].sort()))}`,
    );

    expect(unknowns).toEqual([]);
    expect(reverseMismatch).toBe(0);
    expect(bySource.template + bySource.content).toBe(7716);
    expect(bySource.content).toBe(cards.filter((card) => card.templateId === "").length);
    expect(warnings.get("content-ignored")).toBe(3160);
    expect(warnings.get("side-break-in-value")).toBe(1);
    expect(warnings.get("stray-section-marker")).toBeUndefined();
    expect(warnings.get("boolean-interpolated")).toBeUndefined();
    expect(warnings.get("invalid-permutation")).toBeUndefined();
  });

  it("finds a `<<Field>>` reference inside every ai prompt that names one", () => {
    const { templates } = readCorpus();
    const found: string[] = [];
    for (const raw of templates.values()) {
      for (const field of Object.values(asRecord(raw["fields"]))) {
        if (!isRecord(field)) continue;
        const prompt = asText(asRecord(field["options"])["ai-custom-prompt"]);
        if (prompt === "") continue;
        for (const token of maskFields(prompt).tokens) {
          found.push(`${asText(raw["name"])}/${asText(field["name"])} -> ${token.name}`);
        }
      }
    }
    expect(found.sort()).toEqual([
      "Polysemy/Example -> 言葉",
      "Synonym/Synonyms -> Word",
      "単語/例文 -> 単語",
      "言葉/Example -> 言葉",
    ]);
  });
});

describe("AST helpers", () => {
  it("walks every node exactly once, parents first", () => {
    const sides = parseContent("# h\n\n> q\n\n1. a\n2. b");
    const kinds: string[] = [];
    walk(sides[0]?.blocks ?? [], (node) => kinds.push(node.kind));
    expect(kinds).toEqual([
      "heading", "text",
      "blockquote", "paragraph", "text",
      "list", "listItem", "paragraph", "text", "listItem", "paragraph", "text",
    ]);
  });

  it("counts a list's items with the list, so the two cannot disagree", () => {
    const counts = census(parseContent("1. a\n2. b\n3. c"));
    expect(counts.get("list:ordered")).toBe(1);
    expect(counts.get("listItem:ordered")).toBe(3);
    expect(counts.get("listItem")).toBeUndefined();
  });

  it("calls a side empty only when nothing would be drawn", () => {
    const empty = (source: string): boolean => isSideEmpty({ index: 0, blocks: parseFieldValue(source) });
    expect(empty("")).toBe(true);
    expect(empty("   \n  \n")).toBe(true);
    expect(empty(">")).toBe(true);
    expect(empty("x")).toBe(false);
    expect(empty("___")).toBe(false);
    expect(empty("<draw/>")).toBe(false);
    expect(empty("[[a|b]]")).toBe(false);
  });

  it("keeps inline text recoverable, including a wiki-link's display", () => {
    const blocks: readonly Inline[] = (parseFieldValue("a [[b|id]] `c`")[0] as { children: readonly Inline[] }).children;
    expect(plainText(blocks)).toBe("a b `c`".replace(/`/g, ""));
  });
});
