/**
 * Stage 4 acceptance. SPEC's "Renderer" stage plus the pitch-accent note that
 * governs it ("Read this before building the renderer or the review UI").
 *
 * 1. THE PORT IS THE REAL DOM. Type-only assignments, in the manner of
 *    `spike/contract-compat.ts`: `Document`, `HTMLElement` and `Text` satisfy
 *    `RenderDocument`, `RenderElement` and `RenderText`. Nothing executes; if
 *    someone widens the port past what a browser provides, `npm run typecheck`
 *    stops compiling. The same trick pins `GenerationDescriptor` against
 *    `GenerationRequest` in `src/import/blobs.ts`, so stage 9 can pass a mount's
 *    request straight to `resolveGeneration` with no adapter.
 *
 * 2. THE HARD RULE, THREE WAYS. Audio must never start when a side appears,
 *    because 単語's sides are a produce-then-verify drill for 高低アクセント and
 *    hearing the contour before producing it destroys the exercise. Asserted as
 *    (a) no `autoplay`/`loop` on any media element the corpus produces, (b) the
 *    audio element is byte-identical before and after `revealAll()`, and (c) the
 *    literal strings `autoplay` and `.play(` do not occur in the executable text
 *    of `src/render/`. A renderer that cannot express playback cannot regress
 *    into it.
 *
 * 3. THE CORPUS. All 7,716 real cards, resolved through their real templates and
 *    rendered in BOTH directions: zero thrown errors, and every AST node the
 *    resolver produced accounted for in the render census — the same bar stage 3
 *    met for parsing. Plus the authored-text projection (content + every field
 *    value), which is where the 8,744-link oracle lives.
 *
 * 4. GOLDENS. All 11 template bodies, and 19 real cards from
 *    `test/fixtures/render/cards.json`, so the pitch-accent side order and the
 *    U+200E adjacency are pinned as OUTPUT rather than as counts. Both run on a
 *    clean clone with no `exports/`.
 */

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

// ─── 1. the port really is the DOM ───────────────────────────────────────────

/**
 * Type-only. `null as unknown as T` produces no runtime value; the assignment is
 * the assertion, and it fails at compile time or not at all.
 */
export const documentSatisfiesPort: RenderDocument<HTMLElement> =
  null as unknown as Document;
export const htmlElementSatisfiesPort: RenderElement = null as unknown as HTMLElement;
export const textSatisfiesPort: RenderText = null as unknown as Text;

/** A mount's request is exactly what `resolveGeneration` takes. */
export const descriptorIsAGenerationRequest: GenerationRequest =
  null as unknown as GenerationDescriptor;

// ─── helpers ─────────────────────────────────────────────────────────────────

const SRC_RENDER = resolve(import.meta.dirname, "..", "src", "render");

/**
 * The two modules ALLOWED to start a sound, named individually.
 *
 * `audio.ts` is the only code in Hashigo that calls `play()`, and `reveal.ts`
 * calls into it — from `reveal()` and `play()`, never from `enter()`. Everything
 * else in `src/render` must be unable to.
 */
const MAY_START_PLAYBACK = ["audio.ts", "reveal.ts"] as const;

/**
 * WHY THIS IS DERIVED AND NOT A LIST.
 *
 * This was `["index.ts", "dom.ts", "nodes.ts", "sanitise.ts"]` — hardcoded, and
 * four of the ten files in `src/render`. The four were right, but the SHAPE was
 * wrong: the no-autoplay rule is the project's most safety-critical invariant
 * (CLAUDE.md: "autoplay is the default in most flashcard renderers and it does
 * not degrade this exercise, it deletes it"), and a hardcoded allow-list means a
 * NEW module added to this directory is unchecked by default. `ruby.ts`,
 * `draw.ts`, `input.ts` and `math.ts` were already escaping it.
 *
 * Inverting it fixes the default: every file in the directory is checked unless
 * it is explicitly named as allowed to play, and the count is asserted so the
 * allow-list cannot quietly grow either.
 */
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

/** Render authored card text (surface 1). One memory document per call. */
function render(text: string): RenderResult<MemoryElement> {
  return renderSides(parseContent(text), { document: memoryDocument() });
}

/** The serialised first side of authored text. */
function side0(text: string): string {
  const result = render(text);
  const first = result.sides[0];
  if (first === undefined) throw new Error("no sides");
  return serialise(first.element);
}

function attributesOf(element: MemoryElement): Record<string, string> {
  return Object.fromEntries(element.attributes);
}

// ─── 2. markdown, as the corpus writes it ────────────────────────────────────

describe("markdown", () => {
  it("renders an ordered list, keeping a start other than 1", () => {
    // 4,318 ordered lists; 21 of them start elsewhere because a plain line
    // interrupted the numbering.
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
    // Parser trap 1. Conflating the two silently restructures his cards.
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
    // Card EPp9rse6 writes a four-step answer into 基本情報's `Cue` field.
    const html = serialise(renderSides(parseFieldValue("one\n---\ntwo").map(
      (block, index) => ({ index, blocks: [block] }),
    ), { document: memoryDocument() }).root);
    expect(html).toContain('data-marker="---"');
  });

  it("renders blockquotes, headings and bullets", () => {
    expect(side0(">quoted")).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(side0("#### Hint")).toContain("<h4>Hint</h4>");
    // `#` without a space is a hashtag he typed, not a heading. 22 of 37 are.
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
    // `data-empty` is WRONG here, and it is not this module's bug: `isSideEmpty`
    // in src/template/ast.ts treats a `codeBlock` as invisible, because its text
    // hangs off `node.text` rather than off a `text` child and `codeBlock` is
    // missing from its VISIBLE set. Latent — the corpus has 0 code blocks — so it
    // is reported as an ORPHAN rather than patched in another stage's file, and
    // pinned here so that the day it is fixed, this expectation says so.
  });

  it("renders inline math verbatim in a marked span, and does not typeset it", () => {
    expect(side0("$(I + D - 1) P$")).toContain(
      '<span class="hashigo-math" data-math="inline">(I + D - 1) P</span>',
    );
  });

  it("renders a single newline as a line break, not as paragraph whitespace", () => {
    // 7,670 of 7,716 cards contain no blank line at all; one fact per line.
    expect(side0("路線\nroute")).toContain("路線<br>route");
  });
});

// ─── 3. wiki-links and the U+200E convention ─────────────────────────────────

describe("wiki-links", () => {
  it("renders all three authored forms as a plain anchor", () => {
    expect(side0("[[換え|C1p9g1mL]]")).toContain(
      '<a class="hashigo-card-link" href="#/card/C1p9g1mL" data-card-id="C1p9g1mL">換え</a>',
    );
    // `[[id]]` (46 uses) and `[[|id]]` (8) carry no display text of their own.
    const named = renderSides(parseContent("[[C1p9g1mL]]"), {
      document: memoryDocument(),
      resolveCardLink: (id) => ({ name: id === "C1p9g1mL" ? "換え" : null }),
    });
    expect(serialise(named.root)).toContain(">換え</a>");
    const bare = render("[[C1p9g1mL]]");
    // No resolver: the anchor still renders, falling back to the id rather than
    // to an empty, untappable anchor.
    expect(serialise(bare.root)).toContain(">C1p9g1mL</a>");
  });

  it("renders an unresolvable target as its authored text, brackets and all", () => {
    // 18 of the 8,744 links point at decks that were never exported.
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
    // and the display-less forms come back as themselves too
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
    // No node at all between the two anchors: the invisible mark stripped to
    // nothing and an empty text node is never appended.
    expect((paragraph as MemoryElement).children.map((child) => child.nodeName)).toEqual(["A", "A"]);
    expect((paragraph as MemoryElement).textContent).toBe("引き換え");
    expect(serialise(result.root)).toContain(
      '<a class="hashigo-card-link" href="#/card/10PQotxm" data-card-id="10PQotxm">引き</a>' +
        '<a class="hashigo-card-link" href="#/card/C1p9g1mL" data-card-id="C1p9g1mL">換え</a>',
    );
    // The stored text is untouched — this is a read-time projection.
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

// ─── 4. the sanitiser policy ─────────────────────────────────────────────────

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
    // Nothing authored is lost: the tag text and the body are both there.
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
    // The bypass browsers create by stripping these characters before parsing.
    expect(sanitiseUrl("java\nscript:alert(1)").reason).toBe("scheme-not-allowed");
    expect(sanitiseUrl("\u0000javascript:alert(1)").scheme).toBe("javascript");
    // Spaces survive as %20, because field values interpolate into URLs.
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
    // Locked decision 5: Zach overruled the answer-leak deferral on 2026-08-20.
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

// ─── 5. THE HARD RULE: audio never autoplays ─────────────────────────────────

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
    // The three attributes that would break the shadowing exercise.
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
    // A source check, because the property is about what the module CANNOT do.
    // Comments are stripped first — the header of nodes.ts discusses both.
    const sources = renderSourcesThatMustNotPlay();
    // EVERY file in the directory bar the two named exceptions. Asserted, so
    // that adding a module to src/render cannot silently escape this check and
    // enlarging MAY_START_PLAYBACK cannot silently shrink it.
    expect(sources.length).toBe(
      readdirSync(SRC_RENDER).filter((n) => n.endsWith(".ts")).length - MAY_START_PLAYBACK.length,
    );
    expect(sources.length).toBeGreaterThanOrEqual(8);
    for (const name of sources) {
      const code = stripComments(readFileSync(resolve(SRC_RENDER, name), "utf8"));
      expect(code, `${name} mentions autoplay`).not.toContain("autoplay");
      expect(code, `${name} calls play()`).not.toContain(".play(");
      expect(code, `${name} uses innerHTML`).not.toContain("innerHTML");
      // `src` as a STRING is fine and necessary — sanitise.ts refuses it as an
      // authored attribute name. What must not exist is an assignment to one.
      expect(code, `${name} assigns a src`).not.toMatch(/\.src\s*=/);
      expect(code, `${name} sets a src attribute`).not.toMatch(/setAttribute\(\s*"src"/);
    }
  });
});

/** Crude but sufficient for files we own: drop block and line comments. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ─── 6. cloze reveal ─────────────────────────────────────────────────────────

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
    mount.reveal(); // idempotent
    expect(seen).toEqual(["local:0:revealed", "all:0"]);
    result.revealAll();
    expect(seen).toEqual(["local:0:revealed", "all:0", "all:1"]);
    // Concealing is deliberately silent: it is not a reveal.
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

// ─── 7. generators ───────────────────────────────────────────────────────────

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
    // `lang="jp"` 264 uses, `ja-JP` 15, and one `lang="่jp"` with a stray Thai
    // tone mark. All three have to hash to one cache key in stage 9.
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

// ─── 8. widgets ──────────────────────────────────────────────────────────────

describe("widgets", () => {
  it("renders <draw> as a canvas carrying its authored options as data", () => {
    const html = side0('<draw height="400px" brushColor="#FF0000" brushRadius="4"/>');
    expect(html).toContain(
      '<canvas class="hashigo-draw" data-widget="draw" data-height="400px" ' +
        'data-brush-color="#FF0000" data-brush-radius="4"></canvas>',
    );
    // No width/height/style: the backing store has to be sized to
    // devicePixelRatio by the widget, or the strokes blur.
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

// ─── 9. the extension points ─────────────────────────────────────────────────

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
    // 単語's first side is `<<#Reading>>…<</Reading>>` and is empty by design
    // whenever `Reading` is false, which is the default.
    const tango = manifest.templates.find((row) => row.name === "単語") as ManifestTemplate;
    const rendered = resolveCard({ id: "x", values: { name: "引き換え" } }, templateInput(tango));
    const result = renderResolvedCard(rendered, { document: memoryDocument() });
    // Sides 0 AND 2 are empty for this card: side 0 is the `<<#Reading>>`
    // section with Reading false, and side 2 is 例文 + Translate + Audio, all
    // three of them generated fields that no generator has filled yet.
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

// ─── 10. serialising ─────────────────────────────────────────────────────────

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
    // `hidden` and `hidden=""` are equivalent HTML, but only the quoted form is
    // byte-identical to Chrome's `outerHTML` — measured in a real browser against
    // dist/, 9 bytes apart on one card with the boolean shorthand. Byte-identity
    // is the property a precomputed render needs.
    const document = memoryDocument();
    const root = document.createElement("span");
    root.setAttribute("hidden", "");
    expect(serialise(root)).toBe('<span hidden=""></span>');
  });
});

// ─── 11. goldens ─────────────────────────────────────────────────────────────

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

// ─── 12. the real corpus ─────────────────────────────────────────────────────

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
          // Sub-kind too, for the report: "10,316 resolver warnings" says nothing,
          // "7,156 empty sides and 3,159 ignored stale contents" says what
          // happened. (This comment read 7,368 and 2,948, which reproduce as
          // neither figure — and 3,159 is the number in CLAUDE.md's locked
          // decision 5, so the wrong one contradicted a settled decision from
          // inside a test. STAGE4.md ORPHAN 2.)
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
    /**
     * Every AST node accounted for: dispatched to a renderer, or deliberately
     * never dispatched because it sits inside a GENERATOR'S PROMPT.
     *
     * That second case is the whole reason this arithmetic is spelled out.
     * `<ai>Describe a word 引き換え using emojis only</ai>` has children, and they
     * are the INPUT to the generation, not the output — so 6,920 nodes across the
     * corpus (6,911 of them the prompt text itself, plus 5 code spans, 1 bold run
     * and 3 wiki-links authored inside prompts) correctly produce no DOM at all.
     * Counted under `hidden:<kind>` rather than assumed, because otherwise the
     * corpus census would show 5 code spans parsed and never rendered with
     * nothing to say why.
     *
     * `text:empty` and `text:invisible` are a BREAKDOWN of the dispatched `text`
     * count, not an addition to it: a text node that is nothing but Zach's U+200E
     * marks is dispatched, counted, and then appends no DOM node — which is what
     * makes two adjacent wiki-links read as one word.
     */
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

    // ZERO thrown errors, ZERO unrendered node types, ZERO unknown constructs.
    expect(failures).toEqual([]);
    expect(unknowns).toEqual([]);
    expect(sides).toBe(27352);
    // Every AST node the resolver produced is accounted for, exactly once.
    expect(accounted).toEqual(Object.fromEntries([...ast].sort()));
    // And every AST node KIND reached a renderer: no kind is missing outright.
    expect([...ast.keys()].filter((kind) => !forward.has(kind))).toEqual([]);
    // Reverse is a permutation of the same sides, so it renders the same nodes.
    expect(Object.fromEntries([...reverse].sort())).toEqual(Object.fromEntries([...forward].sort()));
    // Nothing was refused, dropped or left unresolved anywhere in the corpus.
    expect(Object.fromEntries([...diagnostics].sort())).toEqual({
      "resolver-warning": diagnostics.get("resolver-warning") ?? 0,
    });
  });

  it("renders the authored text of every card too, where the 8,744-link oracle lives", () => {
    // A templated card's own `content` is stale pre-template text and is NOT
    // rendered (locked decision 5 of CLAUDE.md), so the resolved projection above
    // cannot see the links inside it. This one renders content + every field
    // value, which is the same corpus stage 3 censused.
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
    // SPEC's 8,690 piped + 46 bare + 8 empty-display = 8,744.
    expect(links).toBe(8744);
    // 287 inline `<speech>` tags each get a silent audio slot, plus the single
    // real `.mp3` attachment on CtDsQetR.
    expect(census.get("media:audio")).toBe(288);
    // 8 inline `<image>` generators plus the 6 real image attachments — 5 in
    // field values and one in card 3Ep6ZQKU's own `content`, which the resolved
    // projection above cannot see because that content is stale pre-template text.
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
