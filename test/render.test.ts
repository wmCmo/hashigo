import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { GenerationRequest } from "../src/import/blobs.js";
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
  collectUnknowns,
  orderSides,
  parseContent,
  parseFieldValue,
  parseTemplate,
  resolveCard,
  walkSides,
  type Node,
  type Side,
  type TemplateInput,
} from "../src/template/index.js";
import {
  CLASS,
  CLOZE_MASK_TEXT,
  DATA,
  MemoryElement,
  classifyMedia,
  defaultRenderers,
  elementsByTag,
  memoryDocument,
  renderResolvedCard,
  renderSides,
  sanitiseUrl,
  serialise,
  walkMemory,
  type ClozeMount,
  type GenerationDescriptor,
  type RenderDocument,
  type RenderElement,
  type RenderResult,
  type RenderText,
} from "../src/render/index.js";

export const documentSatisfiesPort: RenderDocument<HTMLElement> =
  null as unknown as Document;
export const htmlElementSatisfiesPort: RenderElement = null as unknown as HTMLElement;
export const textSatisfiesPort: RenderText = null as unknown as Text;

export const descriptorIsAGenerationRequest: GenerationRequest =
  null as unknown as GenerationDescriptor;

const SRC_RENDER = resolve(import.meta.dirname, "..", "src", "render");

const MAY_START_PLAYBACK = ["audio.ts", "reveal.ts"] as const;

function renderSourcesThatMustNotPlay(): string[] {
  return readdirSync(SRC_RENDER)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !(MAY_START_PLAYBACK as readonly string[]).includes(name))
    .sort();
}

const FIXTURES = resolve(import.meta.dirname, "fixtures", "render");
const TEMPLATE_FIXTURES = resolve(import.meta.dirname, "fixtures", "templates");
const TEMPLATES_GOLDEN = resolve(FIXTURES, "templates.golden.html");
const CARDS_GOLDEN = resolve(FIXTURES, "cards.golden.html");

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const EXPORT_DIRS = EXPORT_NAMES.map((name) => resolve(import.meta.dirname, "..", "exports", name));
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

interface ManifestField {
  readonly id: string;
  readonly name: string;
  readonly type: string | null;
}
interface ManifestTemplate {
  readonly export: string;
  readonly id: string;
  readonly name: string;
  readonly sides: number;
  readonly content: string;
  readonly fields: readonly ManifestField[];
}
const manifest = JSON.parse(readFileSync(resolve(TEMPLATE_FIXTURES, "manifest.json"), "utf8")) as {
  readonly templates: readonly ManifestTemplate[];
};

interface FixtureCard {
  readonly why: string;
  readonly export: string;
  readonly id: string;
  readonly templateId: string;
  readonly content: string;
  readonly values: Readonly<Record<string, string>>;
}
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

function templateFor(card: FixtureCard): TemplateInput | null {
  if (card.templateId === "") return null;
  const row = manifest.templates.find(
    (entry) => entry.id === card.templateId && entry.export === card.export,
  );
  if (row === undefined) throw new Error(`no manifest row for ${card.export}/${card.templateId}`);
  return templateInput(row);
}

function render(text: string): RenderResult<MemoryElement> {
  return renderSides(parseContent(text), { document: memoryDocument() });
}

function side0(text: string): string {
  const result = render(text);
  const first = result.sides[0];
  if (first === undefined) throw new Error("no sides");
  return serialise(first.element);
}

function attributesOf(element: MemoryElement): Record<string, string> {
  return Object.fromEntries(element.attributes);
}

describe("markdown", () => {
  it("renders an ordered list, keeping a start other than 1", () => {
    expect(side0("1. route\n2. line")).toBe(
      '<section class="hashigo-side" data-side="0" data-position="0"><ol><li><p>route</p></li>' +
        "<li><p>line</p></li></ol></section>",
    );
    expect(side0("3. third\n4. fourth")).toContain('<ol start="3">');
  });

  it("renders bold, emphasis and a code span", () => {
    expect(side0("**continuously**")).toContain("<strong>continuously</strong>");
    expect(side0("_x_")).toContain("<em>x</em>");
    expect(side0("`<component/>`")).toContain("<code>&lt;component/&gt;</code>");
  });

  it("keeps `___` a rule inside a side and `---` a side separator", () => {
    const rule = render("a\n___\nb");
    expect(rule.sides).toHaveLength(1);
    expect(serialise(rule.root)).toContain('<hr class="hashigo-rule" data-marker="___">');

    const split = render("a\n---\nb");
    expect(split.sides).toHaveLength(2);
    expect(serialise(split.root)).not.toContain("<hr");
    expect(split.sides.map((s) => [s.index, s.position])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it("renders a `---` that arrived inside a field value as a rule", () => {
    const html = serialise(renderSides(parseFieldValue("one\n---\ntwo").map(
      (block, index) => ({ index, blocks: [block] }),
    ), { document: memoryDocument() }).root);
    expect(html).toContain('data-marker="---"');
  });

  it("renders blockquotes, headings and bullets", () => {
    expect(side0(">quoted")).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(side0("#### Hint")).toContain("<h4>Hint</h4>");
    expect(side0("#DaysOfMonth")).toContain("<p>#DaysOfMonth</p>");
    expect(side0("- one")).toContain("<ul><li><p>one</p></li></ul>");
  });

  it("renders a table with per-column alignment as data, never inline style", () => {
    const html = side0("| a | b |\n| :- | -: |\n| 1 | 2 |");
    expect(html).toContain('<th data-align="left">');
    expect(html).toContain('<td data-align="right">');
    expect(html).not.toContain("style=");
  });

  it("renders a fenced code block verbatim, with its language", () => {
    const html = side0("```js\nlet x = 1 < 2;\n```");
    expect(html).toBe(
      '<section class="hashigo-side" data-side="0" data-position="0" data-empty="">' +
        '<pre class="hashigo-code"><code data-language="js">let x = 1 &lt; 2;</code></pre></section>',
    );
  });

  it("renders inline math verbatim in a marked span, and does not typeset it", () => {
    expect(side0("$(I + D - 1) P$")).toContain(
      '<span class="hashigo-math" data-math="inline">(I + D - 1) P</span>',
    );
  });

  it("renders a single newline as a line break, not as paragraph whitespace", () => {
    expect(side0("路線\nroute")).toContain("路線<br>route");
  });
});

describe("wiki-links", () => {
  it("renders all three authored forms as a plain anchor", () => {
    expect(side0("[[換え|C1p9g1mL]]")).toContain(
      '<a class="hashigo-card-link" href="#/card/C1p9g1mL" data-card-id="C1p9g1mL">換え</a>',
    );
    const named = renderSides(parseContent("[[C1p9g1mL]]"), {
      document: memoryDocument(),
      resolveCardLink: (id) => ({ name: id === "C1p9g1mL" ? "換え" : null }),
    });
    expect(serialise(named.root)).toContain(">換え</a>");
    const bare = render("[[C1p9g1mL]]");
    expect(serialise(bare.root)).toContain(">C1p9g1mL</a>");
  });

  it("renders an unresolvable target as its authored text, brackets and all", () => {
    const result = renderSides(parseContent("see [[意味|pvtj9W17]] here"), {
      document: memoryDocument(),
      resolveCardLink: () => null,
    });
    const html = serialise(result.root);
    expect(html).toContain("see [[意味|pvtj9W17]] here");
    expect(html).not.toContain("<a");
    expect(result.diagnostics).toEqual([
      { kind: "card-link-unresolved", detail: "pvtj9W17", side: 0 },
    ]);
    const bare = renderSides(parseContent("[[pvtj9W17]]"), {
      document: memoryDocument(),
      resolveCardLink: () => null,
    });
    expect(serialise(bare.root)).toContain("[[pvtj9W17]]");
  });

  it("joins a U+200E-separated pair into one continuous word", () => {
    const source = "[[引き|10PQotxm]]‎[[換え|C1p9g1mL]]";
    const result = render(source);
    const paragraph = elementsByTag(result.root, "p")[0];
    expect(paragraph).toBeInstanceOf(MemoryElement);
    expect((paragraph as MemoryElement).children.map((child) => child.nodeName)).toEqual(["A", "A"]);
    expect((paragraph as MemoryElement).textContent).toBe("引き換え");
    expect(serialise(result.root)).toContain(
      '<a class="hashigo-card-link" href="#/card/10PQotxm" data-card-id="10PQotxm">引き</a>' +
        '<a class="hashigo-card-link" href="#/card/C1p9g1mL" data-card-id="C1p9g1mL">換え</a>',
    );
    expect(source).toContain("‎");
  });

  it("strips the mark from rendered text everywhere, not only between links", () => {
    expect(side0("引​換﻿え")).toContain("<p>引換え</p>");
  });

  it("mints the href itself, so a hostile target cannot become a URL", () => {
    const html = side0("[[x|javascript:alert(1)]]");
    expect(html).toContain('href="#/card/javascript%3Aalert(1)"');
    expect(html).not.toContain('href="javascript:');
  });
});

describe("the sanitiser policy", () => {
  it("keeps the one styled element the corpus has", () => {
    expect(side0('<span style="color:yellow">policy</span>')).toContain(
      '<span style="color:yellow">policy</span>',
    );
  });

  it("drops style declarations outside the five allowed properties", () => {
    const result = render('<span style="color:red;position:fixed;top:0">x</span>');
    expect(serialise(result.root)).toContain('<span style="color:red">x</span>');
    expect(result.diagnostics.map((d) => d.kind)).toEqual(["style-dropped", "style-dropped"]);
  });

  it("drops a style whose every declaration is refused, and keeps the text", () => {
    const result = render('<span style="background-image:url(x)">x</span>');
    expect(serialise(result.root)).toContain("<span>x</span>");
    expect(result.diagnostics.map((d) => d.kind)).toContain("attribute-dropped");
  });

  it("renders an element outside the allowlist as inert visible text", () => {
    const result = render("<script>alert(1)</script>");
    const html = serialise(result.root);
    expect(html).toContain('<span class="hashigo-unknown"');
    expect(html).not.toContain("<script");
    expect(result.sides[0]?.element.textContent).toContain("<script>alert(1)</script>");
  });

  it("drops event handlers, and an authored src or href, on an allowed element", () => {
    const result = render('<span onclick="x" style="color:red" href="/x" src="/y">t</span>');
    expect(serialise(result.root)).toContain('<span style="color:red">t</span>');
    expect(result.diagnostics.filter((d) => d.kind === "attribute-dropped").map((d) => d.detail)).toEqual([
      "span/onclick: not-allowed",
      "span/href: not-allowed",
      "span/src: not-allowed",
    ]);
  });

  it("allows http, https and mailto and refuses everything else", () => {
    expect(sanitiseUrl("https://jisho.org/search/x").href).toBe("https://jisho.org/search/x");
    expect(sanitiseUrl("mailto:a@b.c").href).toBe("mailto:a@b.c");
    expect(sanitiseUrl("javascript:alert(1)").reason).toBe("scheme-not-allowed");
    expect(sanitiseUrl("data:text/html,x").reason).toBe("scheme-not-allowed");
    expect(sanitiseUrl("/relative").reason).toBe("no-scheme");
    expect(sanitiseUrl("//evil.example").reason).toBe("no-scheme");
    expect(sanitiseUrl("java\nscript:alert(1)").reason).toBe("scheme-not-allowed");
    expect(sanitiseUrl("\u0000javascript:alert(1)").scheme).toBe("javascript");
    expect(sanitiseUrl("https://youglish.com/pronounce/give up/english").href).toBe(
      "https://youglish.com/pronounce/give%20up/english",
    );
  });

  it("drops the anchor of a refused URL and keeps the link text in place", () => {
    const result = render("[Jisho](javascript:void)");
    expect(serialise(result.root)).toBe(
      '<div class="hashigo-card"><section class="hashigo-side" data-side="0" data-position="0">' +
        "<p>Jisho</p></section></div>",
    );
    expect(result.diagnostics[0]?.kind).toBe("url-blocked");
    expect(result.links).toEqual([]);
  });

  it("renders an allowed external link plainly, in place, with no deferral", () => {
    const html = side0("[Jisho](https://jisho.org/search/*引*)");
    expect(html).toContain(
      '<a class="hashigo-link" href="https://jisho.org/search/*引*" rel="noopener noreferrer" ' +
        'target="_blank">Jisho</a>',
    );
  });

  it("classifies the corpus's two media reference shapes onto blob_refs.ref_key", () => {
    expect(classifyMedia("@media/mxkKeDnY.jpeg")).toEqual({
      ref: "@media/mxkKeDnY.jpeg",
      key: "mxkKeDnY.jpeg",
      kind: "image",
      extension: "jpeg",
      refused: null,
    });
    expect(classifyMedia("uVQp0iMb.mp3").kind).toBe("audio");
    expect(classifyMedia("@media/../secrets.mp3").refused).toBe("path");
    expect(classifyMedia("https://example.test/x.png").refused).toBe("absolute-url");
  });

  it("refuses to fetch an absolute media reference, and shows the alt text", () => {
    const result = render("![a picture](https://example.test/x.png)");
    expect(serialise(result.root)).toContain("<p>a picture</p>");
    expect(result.media).toEqual([]);
    expect(result.diagnostics[0]?.kind).toBe("media-blocked");
  });
});

describe("audio must never start on its own", () => {
  const AUDIO_CARD = "![Copilot_Audio_20260122_194103.mp3](uVQp0iMb.mp3)";

  it("creates a silent, sourceless audio element for an attachment", () => {
    const result = render(AUDIO_CARD);
    const audio = elementsByTag(result.root, "audio");
    expect(audio).toHaveLength(1);
    expect(attributesOf(audio[0] as MemoryElement)).toEqual({
      class: CLASS.audio,
      [DATA.mediaKind]: "audio",
      [DATA.mediaRef]: "uVQp0iMb.mp3",
      [DATA.mediaKey]: "uVQp0iMb.mp3",
      controls: "",
      preload: "none",
      "aria-label": "Copilot_Audio_20260122_194103.mp3",
    });
    expect((audio[0] as MemoryElement).hasAttribute("autoplay")).toBe(false);
    expect((audio[0] as MemoryElement).hasAttribute("loop")).toBe(false);
    expect((audio[0] as MemoryElement).hasAttribute("src")).toBe(false);
    expect(result.media[0]?.reference.key).toBe("uVQp0iMb.mp3");
    expect(result.media[0]?.origin).toBe("attachment");
  });

  it("leaves the audio element byte-identical across a cloze reveal", () => {
    const result = render(`{{答え}}\n${AUDIO_CARD}`);
    const audio = elementsByTag(result.root, "audio")[0] as MemoryElement;
    const before = serialise(audio);
    result.revealAll();
    expect(result.clozes[0]?.revealed).toBe(true);
    expect(serialise(audio)).toBe(before);
  });

  it("gives a <speech> generator a silent audio slot with no source at all", () => {
    const result = render('<speech lang="jp">言葉</speech>');
    const audio = elementsByTag(result.root, "audio")[0] as MemoryElement;
    expect(attributesOf(audio)).toEqual({
      class: CLASS.audio,
      [DATA.mediaKind]: "audio",
      controls: "",
      preload: "none",
      "aria-label": "言葉",
    });
    expect(result.generations[0]?.media?.element).toBe(audio);
  });

  it("has no way to start playback: `autoplay` and `.play(` are not in the code", () => {
    const sources = renderSourcesThatMustNotPlay();
    expect(sources.length).toBe(
      readdirSync(SRC_RENDER).filter((n) => n.endsWith(".ts")).length - MAY_START_PLAYBACK.length,
    );
    expect(sources.length).toBeGreaterThanOrEqual(8);
    for (const name of sources) {
      const code = stripComments(readFileSync(resolve(SRC_RENDER, name), "utf8"));
      expect(code, `${name} mentions autoplay`).not.toContain("autoplay");
      expect(code, `${name} calls play()`).not.toContain(".play(");
      expect(code, `${name} uses innerHTML`).not.toContain("innerHTML");
      expect(code, `${name} assigns a src`).not.toMatch(/\.src\s*=/);
      expect(code, `${name} sets a src attribute`).not.toMatch(/setAttribute\(\s*"src"/);
    }
  });
});

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("cloze", () => {
  it("builds mask and answer up front, with the answer hidden", () => {
    const result = render("{{答え}}");
    expect(serialise(result.root)).toContain(
      `<span class="hashigo-cloze" data-cloze="0" data-state="hidden">` +
        `<span class="hashigo-cloze-mask">${CLOZE_MASK_TEXT}</span>` +
        `<span class="hashigo-cloze-answer" hidden="">答え</span></span>`,
    );
    expect(result.clozes).toHaveLength(1);
    expect(result.clozes[0]?.index).toBe(null);
    expect(result.clozes[0]?.side).toBe(0);
  });

  it("reveals and conceals by attribute, with no re-render", () => {
    const result = render("{{答え}}");
    const mount = result.clozes[0] as ClozeMount<MemoryElement>;
    mount.reveal();
    expect(mount.revealed).toBe(true);
    expect(mount.element.getAttribute(DATA.state)).toBe("revealed");
    expect(mount.answer.hasAttribute("hidden")).toBe(false);
    expect(mount.mask.hasAttribute("hidden")).toBe(true);
    mount.conceal();
    expect(mount.element.getAttribute(DATA.state)).toBe("hidden");
    expect(mount.answer.hasAttribute("hidden")).toBe(true);
    expect(mount.mask.hasAttribute("hidden")).toBe(false);
  });

  it("notifies per-cloze and render-wide listeners once, after the DOM changed", () => {
    const result = render("{{a}} {{b}}");
    const seen: string[] = [];
    const mount = result.clozes[0] as ClozeMount<MemoryElement>;
    mount.onReveal((m) => seen.push(`local:${m.ordinal}:${m.element.getAttribute(DATA.state)}`));
    result.onReveal((m) => seen.push(`all:${m.ordinal}`));
    mount.reveal();
    mount.reveal();
    expect(seen).toEqual(["local:0:revealed", "all:0"]);
    result.revealAll();
    expect(seen).toEqual(["local:0:revealed", "all:0", "all:1"]);
    result.concealAll();
    expect(seen).toHaveLength(3);
  });

  it("lets a listener be removed", () => {
    const result = render("{{a}}");
    let calls = 0;
    const off = result.onReveal(() => {
      calls += 1;
    });
    off();
    result.revealAll();
    expect(calls).toBe(0);
  });
});

describe("generators", () => {
  it("renders an <ai> prompt as an empty pending slot, never as text", () => {
    const result = render("<ai>Describe a word 引き換え using emojis only</ai>");
    expect(serialise(result.root)).toContain(
      '<span class="hashigo-generator hashigo-ai" data-generator="ai" data-state="pending">' +
        "</span>",
    );
    expect(result.sides[0]?.element.textContent).toBe("");
    expect(result.generations[0]?.request).toEqual({
      kind: "ai",
      text: "Describe a word 引き換え using emojis only",
      lang: null,
      voice: null,
      options: {},
    });
    expect(result.generations[0]?.output).toBe(result.generations[0]?.element);
  });

  it("renders <furigana> as ruby over VISIBLE base text with an empty reading", () => {
    const result = render("<furigana>丁寧語</furigana>");
    expect(serialise(result.root)).toContain(
      '<ruby class="hashigo-generator hashigo-furigana" data-generator="furigana" ' +
        'data-state="pending">丁寧語<rt class="hashigo-reading"></rt></ruby>',
    );
    expect(result.generations[0]?.output?.nodeName).toBe("RT");
  });

  it("normalises the language tag on the way into the generation request", () => {
    const requests = ['<speech lang="jp">x</speech>', '<speech lang="ja-JP">x</speech>', '<speech lang="่jp">x</speech>']
      .map((source) => render(source).generations[0]?.request?.lang);
    expect(requests).toEqual(["ja-JP", "ja-JP", "ja-JP"]);
  });

  it("carries voice and the remaining attributes separately, as the cache key wants", () => {
    const result = render('<translate from="ja" to="en">言葉</translate>');
    expect(result.generations[0]?.request).toEqual({
      kind: "translate",
      text: "言葉",
      lang: null,
      voice: null,
      options: { from: "ja", to: "en" },
    });
  });
});

describe("widgets", () => {
  it("renders <draw> as a canvas carrying its authored options as data", () => {
    const html = side0('<draw height="400px" brushColor="#FF0000" brushRadius="4"/>');
    expect(html).toContain(
      '<canvas class="hashigo-draw" data-widget="draw" data-height="400px" ' +
        'data-brush-color="#FF0000" data-brush-radius="4"></canvas>',
    );
    expect(html).not.toContain("style=");
  });

  it("refuses a widget value that is not a length, a colour or a number", () => {
    const result = render('<draw height="expression(1)" brushColor="url(x)"/>');
    expect(serialise(result.root)).toContain('<canvas class="hashigo-draw" data-widget="draw">');
    expect(result.diagnostics.map((d) => d.detail)).toEqual([
      "draw/height: invalid-value",
      "draw/brushColor: invalid-value",
    ]);
  });

  it("renders <input> EMPTY, with the expected answer alongside rather than in it", () => {
    const html = side0("<input value=1234>");
    expect(html).toBe(
      '<section class="hashigo-side" data-side="0" data-position="0"><p>' +
        '<input class="hashigo-input" data-widget="input" type="text" autocomplete="off" ' +
        'autocapitalize="off" spellcheck="false" data-expect="1234" inputmode="numeric">' +
        "</p></section>",
    );
    expect(html).not.toContain('value="1234"');
    expect(render("<input value=1234>").widgets[0]?.expected).toBe("1234");
  });
});

describe("the contract other stages build against", () => {
  it("lets one node renderer be replaced without touching the rest", () => {
    const result = renderSides(parseContent("$x^2$ and **bold**"), {
      document: memoryDocument(),
      renderers: {
        math(node, parent, context) {
          const element = context.element("math-typeset");
          context.appendText(element, node.text);
          parent.appendChild(element);
        },
      },
    });
    const html = serialise(result.root);
    expect(html).toContain("<math-typeset>x^2</math-typeset>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("exposes a total registry: one renderer per AST node kind", () => {
    const renderers = defaultRenderers<MemoryElement>();
    expect(Object.keys(renderers).sort()).toEqual(
      [
        "blockquote",
        "cloze",
        "code",
        "codeBlock",
        "element",
        "emphasis",
        "field",
        "heading",
        "hrule",
        "image",
        "lineBreak",
        "link",
        "list",
        "listItem",
        "math",
        "paragraph",
        "section",
        "strong",
        "table",
        "tableCell",
        "tag",
        "text",
        "unknown",
        "wikiLink",
      ].sort(),
    );
  });

  it("calls every hook once per mount, in document order", () => {
    const calls: string[] = [];
    renderSides(
      parseContent(
        '{{a}} [[x|abc12345]] [Jisho](https://jisho.org) ![c](y.mp3) <draw/> <speech>t</speech>',
      ),
      {
        document: memoryDocument(),
        hooks: {
          side: (s) => calls.push(`side:${s.index}`),
          cloze: (m) => calls.push(`cloze:${m.ordinal}`),
          link: (m) => calls.push(`link:${m.kind}`),
          media: (m) => calls.push(`media:${m.kind}:${m.origin}`),
          widget: (m) => calls.push(`widget:${m.name}`),
          generation: (m) => calls.push(`generation:${m.name}`),
        },
      },
    );
    expect(calls).toEqual([
      "cloze:0",
      "link:card",
      "link:external",
      "media:audio:attachment",
      "widget:draw",
      "media:audio:generator",
      "generation:speech",
      "side:0",
    ]);
  });

  it("reports both side indices, and flags a side that resolves to nothing", () => {
    const tango = manifest.templates.find((row) => row.name === "単語") as ManifestTemplate;
    const rendered = resolveCard({ id: "x", values: { name: "引き換え" } }, templateInput(tango));
    const result = renderResolvedCard(rendered, { document: memoryDocument() });
    expect(result.sides.map((s) => s.empty)).toEqual([true, false, true, false]);
    expect(serialise(result.sides[0]?.element as MemoryElement)).toBe(
      '<section class="hashigo-side" data-side="0" data-position="0" data-empty=""></section>',
    );
    expect(result.diagnostics.filter((d) => d.kind === "resolver-warning").map((d) => d.detail)).toContain(
      "empty-side: 0",
    );
  });

  it("renders the sides in the order it was given, and says so on each section", () => {
    const tango = manifest.templates.find((row) => row.name === "単語") as ManifestTemplate;
    const rendered = resolveCard({ id: "x", values: { name: "引き換え" } }, templateInput(tango));
    const reverse = renderSides(orderSides(rendered.sides, "reverse", null), {
      document: memoryDocument(),
    });
    expect(reverse.sides.map((s) => [s.index, s.position])).toEqual([
      [3, 0],
      [2, 1],
      [1, 2],
      [0, 3],
    ]);
  });
});

describe("serialise", () => {
  it("escapes text and attributes, and closes only what needs closing", () => {
    const document = memoryDocument();
    const root = document.createElement("div");
    root.setAttribute("title", '<a & "b">');
    root.appendChild(document.createTextNode("1 < 2 & 3"));
    root.appendChild(document.createElement("br"));
    expect(serialise(root)).toBe(
      '<div title="&lt;a &amp; &quot;b&quot;&gt;">1 &lt; 2 &amp; 3<br></div>',
    );
  });

  it("pretty-prints for human eyes only, and says that it changes adjacency", () => {
    const result = render("[[引き|10PQotxm]]‎[[換え|C1p9g1mL]]");
    expect(serialise(result.root)).toContain("引き</a><a");
    expect(serialise(result.root, { pretty: true })).toContain("引き\n");
  });

  it("quotes an empty attribute, the way HTML's own serialiser does", () => {
    const document = memoryDocument();
    const root = document.createElement("span");
    root.setAttribute("hidden", "");
    expect(serialise(root)).toBe('<span hidden=""></span>');
  });
});

describe("goldens", () => {
  it("renders all 11 template bodies", async () => {
    const parts: string[] = [
      "<!-- GENERATED by test/render.test.ts. The 11 real template bodies of",
      "     test/fixtures/templates/manifest.json, parsed by parseTemplate and",
      "     rendered UNRESOLVED — so `section` and `field` nodes, which a resolved",
      "     card never carries, are pinned here. -->",
      "",
    ];
    for (const row of manifest.templates) {
      const result = renderSides(parseTemplate(row.content), { document: memoryDocument() });
      parts.push(`<!-- ${row.export} / ${row.name} · ${row.id} · ${row.sides} sides -->`);
      parts.push(serialise(result.root, { pretty: true }).trimEnd());
      parts.push("");
    }
    await expect(`${parts.join("\n")}\n`).toMatchFileSnapshot(TEMPLATES_GOLDEN);
  });

  it("renders 19 real cards, resolved through their real templates", async () => {
    const parts: string[] = [
      "<!-- GENERATED by test/render.test.ts from test/fixtures/render/cards.json.",
      "     Real cards, resolved and rendered FORWARD. Read 29thh3wW and ChtBgqLJ",
      "     together: they are the same template with `Reading` false and true, and",
      "     the difference between them IS the pitch-accent drill. -->",
      "",
    ];
    for (const card of fixture.cards) {
      const rendered = resolveCard(
        { id: card.id, content: card.content, values: card.values },
        templateFor(card),
      );
      const result = renderResolvedCard(rendered, { document: memoryDocument() });
      parts.push(`<!-- ${card.id} · ${card.export} · ${card.why} -->`);
      parts.push(serialise(result.root, { pretty: true }).trimEnd());
      if (result.diagnostics.length > 0) {
        parts.push(
          `<!-- diagnostics: ${result.diagnostics
            .map((d) => `${d.kind}(${d.detail})`)
            .join(", ")} -->`,
        );
      }
      parts.push("");
    }
    await expect(`${parts.join("\n")}\n`).toMatchFileSnapshot(CARDS_GOLDEN);
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

function astKinds(sides: readonly Side[]): Map<string, number> {
  const counts = new Map<string, number>();
  walkSides(sides, (node: Node) => counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1));
  return counts;
}

function mergeInto(into: Map<string, number>, from: ReadonlyMap<string, number>): void {
  for (const [key, value] of from) into.set(key, (into.get(key) ?? 0) + value);
}

describe.skipIf(!HAVE_EXPORTS)("the real corpus (exports/)", () => {
  it("the committed card fixture still matches the exports it came from", async () => {
    const { buildFixture } = await import("./fixtures/render/extract.js");
    expect(buildFixture()).toEqual(fixture);
  });

  it("renders all 7,716 cards, every side, in both directions, with nothing left over", () => {
    const { cards, templates } = readCorpus();
    expect(cards).toHaveLength(7716);

    const failures: string[] = [];
    const ast = new Map<string, number>();
    const forward = new Map<string, number>();
    const reverse = new Map<string, number>();
    const diagnostics = new Map<string, number>();
    const detail = new Map<string, number>();
    const unknowns: string[] = [];
    let sides = 0;
    let templateless = 0;

    for (const card of cards) {
      const template = templates.get(card.templateId) ?? null;
      if (template === null) templateless += 1;
      try {
        const rendered = resolveCard(
          { id: card.id, content: card.content, values: card.values },
          template,
        );
        sides += rendered.sides.length;
        mergeInto(ast, astKinds(rendered.sides));
        for (const unknown of collectUnknowns(rendered.sides)) {
          unknowns.push(`${card.id}: ${unknown.reason} ${JSON.stringify(unknown.text)}`);
        }
        const one = renderResolvedCard(rendered, { document: memoryDocument() });
        mergeInto(forward, one.census);
        for (const diagnostic of one.diagnostics) {
          diagnostics.set(diagnostic.kind, (diagnostics.get(diagnostic.kind) ?? 0) + 1);
          const sub = `${diagnostic.kind}/${diagnostic.detail.split(":")[0] ?? ""}`;
          detail.set(sub, (detail.get(sub) ?? 0) + 1);
        }
        const other = renderSides(orderSides(rendered.sides, "reverse", null), {
          document: memoryDocument(),
        });
        mergeInto(reverse, other.census);
      } catch (error) {
        failures.push(`${card.id}: ${String(error)}`);
      }
    }

    const rendered = Object.fromEntries(
      [...forward].filter(([key]) => ast.has(key)).sort(),
    ) as Record<string, number>;
    const extras = Object.fromEntries(
      [...forward].filter(([key]) => !ast.has(key)).sort(),
    ) as Record<string, number>;
    const accounted = Object.fromEntries(
      [...ast.keys()]
        .sort()
        .map((kind) => [kind, (forward.get(kind) ?? 0) + (forward.get(`hidden:${kind}`) ?? 0)]),
    ) as Record<string, number>;
    console.log(
      [
        `cards ${cards.length} (${templateless} template-less) · sides ${sides}`,
        `AST node kinds  ${JSON.stringify(Object.fromEntries([...ast].sort()), null, 1)}`,
        `rendered        ${JSON.stringify(rendered, null, 1)}`,
        `census extras   ${JSON.stringify(extras, null, 1)}`,
        `diagnostics     ${JSON.stringify(Object.fromEntries([...diagnostics].sort()))}`,
        `  by sub-kind   ${JSON.stringify(Object.fromEntries([...detail].sort()))}`,
      ].join("\n"),
    );

    expect(failures).toEqual([]);
    expect(unknowns).toEqual([]);
    expect(sides).toBe(27355);
    expect(accounted).toEqual(Object.fromEntries([...ast].sort()));
    expect([...ast.keys()].filter((kind) => !forward.has(kind))).toEqual([]);
    expect(Object.fromEntries([...reverse].sort())).toEqual(Object.fromEntries([...forward].sort()));
    expect(Object.fromEntries([...diagnostics].sort())).toEqual({
      "resolver-warning": diagnostics.get("resolver-warning") ?? 0,
    });
  });

  it("renders the authored text of every card too, where the 8,744-link oracle lives", () => {
    const { cards } = readCorpus();
    const census = new Map<string, number>();
    const failures: string[] = [];
    for (const card of cards) {
      const sides: Side[] = [...parseContent(card.content)];
      for (const value of Object.values(card.values)) {
        if (value !== "") sides.push({ index: 0, blocks: parseFieldValue(value) });
      }
      try {
        mergeInto(census, renderSides(sides, { document: memoryDocument() }).census);
      } catch (error) {
        failures.push(`${card.id}: ${String(error)}`);
      }
    }
    const links = (census.get("wikiLink") ?? 0) + (census.get("wikiLink:text") ?? 0);
    console.log(
      `authored-text projection: ${JSON.stringify(Object.fromEntries([...census].sort()), null, 1)}`,
    );
    expect(failures).toEqual([]);
    expect(links).toBe(8744);
    expect(census.get("media:audio")).toBe(288);
    expect(census.get("media:image")).toBe(14);
  });

  it("produces no media element anywhere that could start on its own", () => {
    const { cards, templates } = readCorpus();
    let media = 0;
    const offenders: string[] = [];
    for (const card of cards) {
      const sides: Side[] = [
        ...resolveCard(
          { id: card.id, content: card.content, values: card.values },
          templates.get(card.templateId) ?? null,
        ).sides,
      ];
      for (const value of Object.values(card.values)) {
        if (value !== "") sides.push({ index: 0, blocks: parseFieldValue(value) });
      }
      const result = renderSides(sides, { document: memoryDocument() });
      walkMemory(result.root, (node) => {
        if (!(node instanceof MemoryElement)) return;
        if (node.tagName !== "audio" && node.tagName !== "video") return;
        media += 1;
        for (const forbidden of ["autoplay", "loop", "src"]) {
          if (node.hasAttribute(forbidden)) offenders.push(`${card.id}: ${forbidden}`);
        }
        if (node.getAttribute("preload") !== "none") offenders.push(`${card.id}: preload`);
      });
    }
    console.log(`media elements over the whole corpus: ${media}, offenders ${offenders.length}`);
    expect(offenders).toEqual([]);
    expect(media).toBeGreaterThan(0);
  });
});
