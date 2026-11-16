import type { BlobKind } from "../schema/index.js";
import {
  normaliseLanguageTag,
  plainText,
  walk,
  type ElementNode,
  type Node,
  type TableAlign,
} from "../template/index.js";
import { stripInvisible } from "../text/index.js";
import {
  attributeValue,
  cardHref,
  tagHref,
  classifyMedia,
  dataSuffix,
  inertElementText,
  interpolationValue,
  sanitiseElement,
  sanitiseUrl,
  type MediaKind,
  type MediaReference,
} from "./sanitise.js";
import type { RenderDocument, RenderElement, RenderText } from "./dom.js";

export const CLASS = {
  card: "hashigo-card",
  side: "hashigo-side",
  cloze: "hashigo-cloze",
  clozeMask: "hashigo-cloze-mask",
  clozeAnswer: "hashigo-cloze-answer",
  rule: "hashigo-rule",
  code: "hashigo-code",
  math: "hashigo-math",
  cardLink: "hashigo-card-link",
  tag: "hashigo-tag",
  link: "hashigo-link",
  image: "hashigo-image",
  audio: "hashigo-audio",
  video: "hashigo-video",
  file: "hashigo-file",
  generator: "hashigo-generator",
  reading: "hashigo-reading",
  draw: "hashigo-draw",
  input: "hashigo-input",
  section: "hashigo-section",
  missingField: "hashigo-missing-field",
  unknown: "hashigo-unknown",
} as const;

export const DATA = {
  side: "data-side",
  position: "data-position",
  empty: "data-empty",
  cloze: "data-cloze",
  clozeIndex: "data-cloze-index",
  state: "data-state",
  marker: "data-marker",
  language: "data-language",
  math: "data-math",
  cardId: "data-card-id",
  tag: "data-tag",
  resolved: "data-resolved",
  mediaKind: "data-media-kind",
  mediaRef: "data-media-ref",
  mediaKey: "data-media-key",
  generator: "data-generator",
  widget: "data-widget",
  expect: "data-expect",
  field: "data-field",
  reason: "data-reason",
  align: "data-align",
  section: "data-section",
  inverted: "data-inverted",
  lang: "data-lang",
} as const;

export const CLOZE_MASK_TEXT = "[…]";

export type MountState = "hidden" | "revealed" | "pending";

export interface RenderedSide<E extends RenderElement = RenderElement> {
  readonly index: number;
  readonly position: number;
  readonly element: E;
  readonly empty: boolean;
}

export interface ClozeMount<E extends RenderElement = RenderElement> {
  readonly element: E;
  readonly mask: E;
  readonly answer: E;
  readonly index: number | null;
  readonly ordinal: number;
  readonly side: number;
  readonly revealed: boolean;
  reveal(): void;
  conceal(): void;
  onReveal(listener: (mount: ClozeMount<E>) => void): () => void;
}

export interface MediaMount<E extends RenderElement = RenderElement> {
  readonly element: E;
  readonly kind: MediaKind;
  readonly reference: MediaReference;
  readonly alt: string;
  readonly origin: "attachment" | "generator";
  readonly side: number;
  readonly ordinal: number;
}

export interface GenerationDescriptor {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
}

export interface GeneratorMount<E extends RenderElement = RenderElement> {
  readonly element: E;
  readonly name: string;
  readonly request: GenerationDescriptor | null;
  readonly output: E | null;
  readonly media: MediaMount<E> | null;
  readonly inCloze: boolean;
  readonly side: number;
  readonly ordinal: number;
}

export interface WidgetMount<E extends RenderElement = RenderElement> {
  readonly element: E;
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly expected: string | null;
  readonly side: number;
  readonly ordinal: number;
}

export interface LinkMount<E extends RenderElement = RenderElement> {
  readonly element: E;
  readonly kind: "card" | "external";
  readonly target: string;
  readonly href: string;
  readonly side: number;
  readonly ordinal: number;
}

export type RenderDiagnosticKind =
  | "attribute-dropped"
  | "style-dropped"
  | "url-blocked"
  | "media-blocked"
  | "tag-unresolved"
  | "card-link-unresolved"
  | "element-unknown"
  | "node-unknown"
  | "field-unresolved"
  | "resolver-warning";

export interface RenderDiagnostic {
  readonly kind: RenderDiagnosticKind;
  readonly detail: string;
  readonly side: number;
}

export interface TagTarget {
  readonly href?: string;
}

export interface CardLinkTarget {
  readonly href?: string;
  readonly name?: string | null;
}

export interface RenderHooks<E extends RenderElement = RenderElement> {
  side?(side: RenderedSide<E>): void;
  cloze?(mount: ClozeMount<E>): void;
  media?(mount: MediaMount<E>): void;
  generation?(mount: GeneratorMount<E>): void;
  widget?(mount: WidgetMount<E>): void;
  link?(mount: LinkMount<E>): void;
}

export interface RenderSettings<E extends RenderElement = RenderElement> {
  readonly document: RenderDocument<E>;
  readonly resolveCardLink?: (id: string) => CardLinkTarget | null;
  readonly resolveTag?: (path: string) => TagTarget | null;
  readonly renderers?: Partial<NodeRenderers<E>>;
  readonly hooks?: RenderHooks<E>;
}

export interface RenderContext<E extends RenderElement = RenderElement> {
  readonly settings: RenderSettings<E>;
  readonly side: number;
  readonly frame: { headerCell: boolean; cellAlign: TableAlign };

  element(tag: string, className?: string): E;
  text(value: string): RenderText;
  verbatim(value: string): RenderText;
  appendText(parent: E, value: string): void;
  attribute(parent: E, name: string, value: string): void;
  node(parent: E, node: Node): void;
  nodes(parent: E, nodes: readonly Node[]): void;

  withinCloze<T>(run: () => T): T;
  mountCloze(parts: { element: E; mask: E; answer: E; index: number | null }): ClozeMount<E>;
  mountMedia(parts: {
    element: E;
    kind: MediaKind;
    reference: MediaReference;
    alt: string;
    origin: "attachment" | "generator";
  }): MediaMount<E>;
  mountGenerator(parts: {
    element: E;
    name: string;
    request: GenerationDescriptor | null;
    output: E | null;
    media: MediaMount<E> | null;
  }): GeneratorMount<E>;
  mountWidget(parts: {
    element: E;
    name: string;
    attributes: Readonly<Record<string, string>>;
    expected: string | null;
  }): WidgetMount<E>;
  mountLink(parts: { element: E; kind: "card" | "external"; target: string; href: string }): LinkMount<E>;

  diagnose(kind: RenderDiagnosticKind, detail: string): void;
  count(key: string): void;
}

export type NodeRenderer<K extends Node["kind"], E extends RenderElement = RenderElement> = (
  node: Extract<Node, { kind: K }>,
  parent: E,
  context: RenderContext<E>,
) => void;

export type NodeRenderers<E extends RenderElement = RenderElement> = {
  readonly [K in Node["kind"]]: NodeRenderer<K, E>;
};

const GENERATOR_KIND: Readonly<Record<string, BlobKind>> = {
  speech: "speech",
  ai: "ai",
  translate: "translate",
  furigana: "furigana",
  image: "image",
};

const RUBY_GENERATORS: ReadonlySet<string> = new Set(["furigana", "pinyin"]);

function generationDescriptor(
  node: ElementNode,
  attributes: readonly { readonly name: string; readonly value: string }[],
): GenerationDescriptor | null {
  const kind = GENERATOR_KIND[node.name];
  if (kind === undefined) return null;
  let lang: string | null = null;
  let voice: string | null = null;
  const options: Record<string, string> = {};
  for (const { name, value } of attributes) {
    const lower = name.toLowerCase();
    if (lower === "lang") lang = normaliseLanguageTag(value) || null;
    else if (lower === "voice") voice = value === "" ? null : value;
    else options[lower] = value;
  }
  return { kind, text: plainText(node.children), lang, voice, options };
}

const MEDIA_TAG: Readonly<Record<MediaKind, string>> = {
  audio: "audio",
  image: "img",
  video: "video",
  file: "span",
};

const MEDIA_CLASS: Readonly<Record<MediaKind, string>> = {
  audio: CLASS.audio,
  image: CLASS.image,
  video: CLASS.video,
  file: CLASS.file,
};

function pendingReference(kind: MediaKind): MediaReference {
  return { ref: "", key: null, kind, extension: "", refused: null };
}

function mediaElement<E extends RenderElement>(
  context: RenderContext<E>,
  kind: MediaKind,
  reference: MediaReference,
  alt: string,
): E {
  const element = context.element(MEDIA_TAG[kind], MEDIA_CLASS[kind]);
  context.attribute(element, DATA.mediaKind, kind);
  if (reference.ref !== "") context.attribute(element, DATA.mediaRef, reference.ref);
  if (reference.key !== null) context.attribute(element, DATA.mediaKey, reference.key);
  if (kind === "audio" || kind === "video") {
    context.attribute(element, "controls", "");
    context.attribute(element, "preload", "none");
  }
  if (kind === "image") context.attribute(element, "alt", alt);
  else if (alt !== "") context.attribute(element, "aria-label", alt);
  return element;
}

export function defaultRenderers<E extends RenderElement>(): NodeRenderers<E> {
  return {
    paragraph(node, parent, context) {
      const element = context.element("p");
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    heading(node, parent, context) {
      const element = context.element(`h${node.level}`);
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    blockquote(node, parent, context) {
      const element = context.element("blockquote");
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    list(node, parent, context) {
      const element = context.element(node.ordered ? "ol" : "ul");
      if (node.ordered && node.start !== 1) {
        context.attribute(element, "start", String(node.start));
      }
      context.nodes(element, node.items);
      parent.appendChild(element);
    },

    listItem(node, parent, context) {
      const element = context.element("li");
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    hrule(node, parent, context) {
      const element = context.element("hr", CLASS.rule);
      context.attribute(element, DATA.marker, node.marker);
      parent.appendChild(element);
    },

    codeBlock(node, parent, context) {
      const pre = context.element("pre", CLASS.code);
      const code = context.element("code");
      if (node.language !== null && node.language !== "") {
        context.attribute(code, DATA.language, node.language);
      }
      code.appendChild(context.verbatim(node.text));
      pre.appendChild(code);
      parent.appendChild(pre);
    },

    table(node, parent, context) {
      const table = context.element("table");
      const thead = context.element("thead");
      const headRow = context.element("tr");
      context.frame.headerCell = true;
      node.header.forEach((cell, column) => {
        context.frame.cellAlign = node.align[column] ?? null;
        context.node(headRow, cell);
      });
      context.frame.headerCell = false;
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = context.element("tbody");
      for (const row of node.rows) {
        const tr = context.element("tr");
        row.forEach((cell, column) => {
          context.frame.cellAlign = node.align[column] ?? null;
          context.node(tr, cell);
        });
        tbody.appendChild(tr);
      }
      context.frame.cellAlign = null;
      table.appendChild(tbody);
      parent.appendChild(table);
    },

    tableCell(node, parent, context) {
      const element = context.element(context.frame.headerCell ? "th" : "td");
      if (context.frame.cellAlign !== null) {
        context.attribute(element, DATA.align, context.frame.cellAlign);
      }
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    section(node, parent, context) {
      const element = context.element("div", CLASS.section);
      context.attribute(element, DATA.section, node.name);
      if (node.inverted) context.attribute(element, DATA.inverted, "");
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    text(node, parent, context) {
      if (node.text === "") {
        context.count("text:empty");
        return;
      }
      if (stripInvisible(node.text) === "") {
        context.count("text:invisible");
        return;
      }
      context.appendText(parent, node.text);
    },

    lineBreak(_node, parent, context) {
      parent.appendChild(context.element("br"));
    },

    strong(node, parent, context) {
      const element = context.element("strong");
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    emphasis(node, parent, context) {
      const element = context.element("em");
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    code(node, parent, context) {
      const element = context.element("code");
      element.appendChild(context.verbatim(node.text));
      parent.appendChild(element);
    },

    math(node, parent, context) {
      const element = context.element("span", CLASS.math);
      context.attribute(element, DATA.math, node.display ? "display" : "inline");
      element.appendChild(context.verbatim(node.text));
      parent.appendChild(element);
    },

    tag(node, parent, context) {
      const resolve = context.settings.resolveTag;
      if (resolve === undefined) {
        context.appendText(parent, node.source);
        context.count("tag:text");
        return;
      }
      const target = node.path === "" ? null : resolve(node.path);
      if (target === null) {
        context.diagnose("tag-unresolved", node.source);
        context.appendText(parent, node.source);
        context.count("tag:text");
        return;
      }
      const element = context.element("a", CLASS.tag);
      context.attribute(element, "href", target.href ?? tagHref(node.path));
      context.attribute(element, DATA.tag, node.path);
      context.appendText(element, `#${node.path}`);
      parent.appendChild(element);
      context.count("tag:link");
    },

    wikiLink(node, parent, context) {
      const resolve = context.settings.resolveCardLink;
      const target = resolve === undefined ? {} : resolve(node.target);
      if (target === null) {
        context.diagnose("card-link-unresolved", node.target);
        context.appendText(parent, wikiLinkSource(node.display, node.target));
        context.count("wikiLink:text");
        return;
      }
      const element = context.element("a", CLASS.cardLink);
      const href = target.href ?? cardHref(node.target);
      context.attribute(element, "href", href);
      context.attribute(element, DATA.cardId, node.target);
      const authored = node.display !== null && node.display !== "" ? node.display : null;
      const display = authored ?? target.name ?? "";
      context.appendText(element, display === "" ? node.target : display);
      parent.appendChild(element);
      context.mountLink({ element, kind: "card", target: node.target, href });
    },

    link(node, parent, context) {
      const raw = interpolationValue(node.href);
      const { href, reason } = sanitiseUrl(raw);
      if (href === null) {
        context.diagnose("url-blocked", `${reason ?? "refused"}: ${raw}`);
        context.nodes(parent, node.children);
        context.count("link:text");
        return;
      }
      const element = context.element("a", CLASS.link);
      context.attribute(element, "href", href);
      context.attribute(element, "rel", "noopener noreferrer");
      context.attribute(element, "target", "_blank");
      context.nodes(element, node.children);
      parent.appendChild(element);
      context.mountLink({ element, kind: "external", target: href, href });
    },

    image(node, parent, context) {
      const reference = classifyMedia(interpolationValue(node.src));
      const alt = attributeValue(stripInvisible(node.alt));
      if (reference.refused !== null) {
        context.diagnose("media-blocked", `${reference.refused}: ${reference.ref}`);
        context.appendText(parent, alt === "" ? reference.ref : alt);
        context.count("image:text");
        return;
      }
      const element = mediaElement(context, reference.kind, reference, alt);
      parent.appendChild(element);
      context.mountMedia({
        element,
        kind: reference.kind,
        reference,
        alt,
        origin: "attachment",
      });
    },

    cloze(node, parent, context) {
      const element = context.element("span", CLASS.cloze);
      const mask = context.element("span", CLASS.clozeMask);
      mask.appendChild(context.text(CLOZE_MASK_TEXT));
      const answer = context.element("span", CLASS.clozeAnswer);
      context.withinCloze(() => {
        context.nodes(answer, node.children);
      });
      element.appendChild(mask);
      element.appendChild(answer);
      parent.appendChild(element);
      context.mountCloze({ element, mask, answer, index: node.index });
    },

    element(node, parent, context) {
      renderElementNode(node, parent, context);
    },

    field(node, parent, context) {
      context.diagnose("field-unresolved", node.name);
      const element = context.element("span", CLASS.missingField);
      context.attribute(element, DATA.field, node.name);
      element.appendChild(context.text(`<<${node.name}>>`));
      parent.appendChild(element);
    },

    unknown(node, parent, context) {
      context.diagnose("node-unknown", `${node.reason}: ${node.text}`);
      const element = context.element("span", CLASS.unknown);
      context.attribute(element, DATA.reason, node.reason);
      element.appendChild(context.verbatim(node.text));
      parent.appendChild(element);
    },
  };
}

function wikiLinkSource(display: string | null, target: string): string {
  return display === null ? `[[${target}]]` : `[[${display}|${target}]]`;
}

function renderElementNode<E extends RenderElement>(
  node: ElementNode,
  parent: E,
  context: RenderContext<E>,
): void {
  const sanitised = sanitiseElement(node);
  for (const dropped of sanitised.dropped) {
    context.diagnose("attribute-dropped", `${node.name}/${dropped.name}: ${dropped.reason}`);
  }
  for (const declaration of sanitised.droppedStyle) {
    context.diagnose("style-dropped", `${node.name}: ${declaration}`);
  }

  if (sanitised.role === null) {
    context.diagnose("element-unknown", node.name);
    context.appendText(parent, inertElementText(node));
    if (!node.selfClosing) context.nodes(parent, node.children);
    context.count("element:inert");
    return;
  }

  context.count(`element:${node.name}`);
  if (sanitised.role === "generator") {
    renderGenerator(node, parent, context, sanitised.attributes);
    return;
  }
  if (sanitised.role === "widget") {
    renderWidget(node, parent, context, sanitised.attributes);
    return;
  }
  renderMarkup(node, parent, context, sanitised.attributes);
}

function renderGenerator<E extends RenderElement>(
  node: ElementNode,
  parent: E,
  context: RenderContext<E>,
  attributes: readonly { readonly name: string; readonly value: string }[],
): void {
  const request = generationDescriptor(node, attributes);
  const ruby = RUBY_GENERATORS.has(node.name);
  const element = context.element(ruby ? "ruby" : "span", `${CLASS.generator} hashigo-${node.name}`);
  context.attribute(element, DATA.generator, node.name);
  context.attribute(element, DATA.state, "pending" satisfies MountState);
  if (request?.lang != null) context.attribute(element, DATA.lang, request.lang);

  let output: E | null = null;
  let media: MediaMount<E> | null = null;

  if (ruby) {
    context.nodes(element, node.children);
    output = context.element("rt", CLASS.reading);
    element.appendChild(output);
  } else if (node.name === "speech" || node.name === "image") {
    const kind: MediaKind = node.name === "speech" ? "audio" : "image";
    const label = plainText(node.children);
    const reference = pendingReference(kind);
    const slot = mediaElement(context, kind, reference, label);
    element.appendChild(slot);
    media = context.mountMedia({ element: slot, kind, reference, alt: label, origin: "generator" });
  } else {
    output = element;
  }

  if (!ruby) {
    walk(node.children, (child) => context.count(`hidden:${child.kind}`));
  }

  parent.appendChild(element);
  context.mountGenerator({ element, name: node.name, request, output, media });
}

function renderWidget<E extends RenderElement>(
  node: ElementNode,
  parent: E,
  context: RenderContext<E>,
  attributes: readonly { readonly name: string; readonly value: string }[],
): void {
  const kept: Record<string, string> = {};
  for (const { name, value } of attributes) kept[name] = value;

  if (node.name === "input") {
    const element = context.element("input", CLASS.input);
    context.attribute(element, DATA.widget, "input");
    context.attribute(element, "type", "text");
    context.attribute(element, "autocomplete", "off");
    context.attribute(element, "autocapitalize", "off");
    context.attribute(element, "spellcheck", "false");
    const expected = kept["value"] ?? null;
    const placeholder = kept["placeholder"];
    if (placeholder !== undefined) context.attribute(element, "placeholder", placeholder);
    if (expected !== null) {
      context.attribute(element, DATA.expect, expected);
      if (expected !== "" && /^[0-9]+$/.test(expected)) {
        context.attribute(element, "inputmode", "numeric");
      }
    }
    parent.appendChild(element);
    context.mountWidget({ element, name: "input", attributes: kept, expected });
    return;
  }

  const element =
    node.name === "draw"
      ? context.element("canvas", CLASS.draw)
      : context.element("span", `hashigo-${node.name}`);
  context.attribute(element, DATA.widget, node.name);
  for (const [name, value] of Object.entries(kept)) {
    context.attribute(element, `data-${dataSuffix(name)}`, value);
  }
  parent.appendChild(element);
  context.mountWidget({ element, name: node.name, attributes: kept, expected: null });
}

function renderMarkup<E extends RenderElement>(
  node: ElementNode,
  parent: E,
  context: RenderContext<E>,
  attributes: readonly { readonly name: string; readonly value: string }[],
): void {
  const element = context.element(node.name);
  for (const { name, value } of attributes) context.attribute(element, name, value);
  if (!node.selfClosing) context.nodes(element, node.children);
  parent.appendChild(element);
}

