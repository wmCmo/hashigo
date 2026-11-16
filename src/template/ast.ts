export type InterpolationPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "field"; readonly name: string };

export type Interpolation = readonly InterpolationPart[];

export function plainInterpolation(text: string): Interpolation {
  return text === "" ? [] : [{ kind: "text", text }];
}

export function isPlainInterpolation(value: Interpolation): boolean {
  return value.every((part) => part.kind === "text");
}

export function interpolationText(value: Interpolation): string {
  return value.map((part) => (part.kind === "text" ? part.text : `<<${part.name}>>`)).join("");
}

export function interpolationFields(value: Interpolation): string[] {
  return value.flatMap((part) => (part.kind === "field" ? [part.name] : []));
}

export type ElementRole = "generator" | "widget" | "markup";

export interface ElementSpec {
  readonly role: ElementRole;
  readonly void: boolean;
  readonly attributes: readonly string[] | "*";
  readonly observed: number;
}

export const ELEMENTS: Readonly<Record<string, ElementSpec>> = {
  speech: { role: "generator", void: false, attributes: ["lang", "voice", "gender"], observed: 289 },
  ai: { role: "generator", void: false, attributes: ["ai-task", "ai-custom-prompt", "randomize"], observed: 130 },
  translate: {
    role: "generator",
    void: false,
    attributes: ["from", "to", "ai-task", "ai-custom-prompt"],
    observed: 106,
  },
  furigana: { role: "generator", void: false, attributes: [], observed: 22 },
  image: { role: "generator", void: false, attributes: [], observed: 8 },
  pinyin: { role: "generator", void: false, attributes: [], observed: 0 },
  ojad: { role: "generator", void: false, attributes: [], observed: 0 },

  draw: {
    role: "widget",
    void: true,
    attributes: ["height", "brushColor", "brushRadius"],
    observed: 3,
  },
  input: { role: "widget", void: true, attributes: ["value", "placeholder"], observed: 1 },

  span: { role: "markup", void: false, attributes: ["style"], observed: 1 },
  b: { role: "markup", void: false, attributes: [], observed: 0 },
  i: { role: "markup", void: false, attributes: [], observed: 0 },
  u: { role: "markup", void: false, attributes: [], observed: 0 },
  br: { role: "markup", void: true, attributes: [], observed: 0 },
};

export function isKnownElement(name: string): boolean {
  return Object.hasOwn(ELEMENTS, name);
}

export function elementSpec(name: string): ElementSpec | null {
  return Object.hasOwn(ELEMENTS, name) ? (ELEMENTS[name] as ElementSpec) : null;
}

export const GENERATOR_ELEMENTS: readonly string[] = Object.entries(ELEMENTS)
  .filter(([, spec]) => spec.role === "generator")
  .map(([name]) => name);

export const STYLE_PROPERTIES: readonly string[] = [
  "color",
  "background-color",
  "font-weight",
  "font-style",
  "text-decoration",
];

export interface SanitisedStyle {
  readonly declarations: readonly { readonly property: string; readonly value: string }[];
  readonly dropped: readonly string[];
}

export function sanitiseStyle(css: string): SanitisedStyle {
  const declarations: { property: string; value: string }[] = [];
  const dropped: string[] = [];
  for (const chunk of css.split(";")) {
    const text = chunk.trim();
    if (text === "") continue;
    const colon = text.indexOf(":");
    const property = (colon < 0 ? text : text.slice(0, colon)).trim().toLowerCase();
    const value = colon < 0 ? "" : text.slice(colon + 1).trim();
    const safe =
      colon > 0 &&
      STYLE_PROPERTIES.includes(property) &&
      !/[(){}]|url|expression|\/\*/i.test(value);
    if (safe) declarations.push({ property, value });
    else dropped.push(text);
  }
  return { declarations, dropped };
}

export function normaliseLanguageTag(code: string): string {
  const cleaned = code.replace(/[^A-Za-z0-9-]/g, "");
  if (cleaned === "") return "";
  return cleaned.toLowerCase() === "jp" ? "ja-JP" : cleaned;
}

export interface Attribute {
  readonly name: string;
  readonly value: Interpolation | null;
}

export function findAttribute(node: ElementNode, name: string): Attribute | null {
  const wanted = name.toLowerCase();
  return node.attributes.find((attr) => attr.name.toLowerCase() === wanted) ?? null;
}

export function attributeText(node: ElementNode, name: string): string | null {
  const attr = findAttribute(node, name);
  if (attr === null) return null;
  return attr.value === null ? "" : interpolationText(attr.value);
}

export interface TextNode {
  readonly kind: "text";
  readonly text: string;
}

export interface LineBreakNode {
  readonly kind: "lineBreak";
  readonly hard: boolean;
}

export interface StrongNode {
  readonly kind: "strong";
  readonly marker: "**" | "__";
  readonly children: readonly Inline[];
}

export interface EmphasisNode {
  readonly kind: "emphasis";
  readonly marker: "*" | "_";
  readonly children: readonly Inline[];
}

export interface CodeSpanNode {
  readonly kind: "code";
  readonly text: string;
}

export interface MathNode {
  readonly kind: "math";
  readonly text: string;
  readonly display: boolean;
}

export interface WikiLinkNode {
  readonly kind: "wikiLink";
  readonly target: string;
  readonly display: string | null;
}

export interface LinkNode {
  readonly kind: "link";
  readonly href: Interpolation;
  readonly children: readonly Inline[];
}

export interface TagNode {
  readonly kind: "tag";
  readonly path: string;
  readonly source: string;
}

export interface ImageNode {
  readonly kind: "image";
  readonly src: Interpolation;
  readonly alt: string;
}

export interface ClozeNode {
  readonly kind: "cloze";
  readonly index: number | null;
  readonly children: readonly Inline[];
}

export interface ElementNode {
  readonly kind: "element";
  readonly name: string;
  readonly role: ElementRole;
  readonly attributes: readonly Attribute[];
  readonly children: readonly Inline[];
  readonly selfClosing: boolean;
}

export interface FieldRefNode {
  readonly kind: "field";
  readonly name: string;
}

export type UnknownReason =
  | "unknown-element"
  | "unclosed-element"
  | "mismatched-close"
  | "stray-section-marker";

export interface UnknownNode {
  readonly kind: "unknown";
  readonly reason: UnknownReason;
  readonly text: string;
}

export type Inline =
  | TextNode
  | LineBreakNode
  | StrongNode
  | EmphasisNode
  | CodeSpanNode
  | MathNode
  | WikiLinkNode
  | TagNode
  | LinkNode
  | ImageNode
  | ClozeNode
  | ElementNode
  | FieldRefNode
  | UnknownNode;

export interface ParagraphNode {
  readonly kind: "paragraph";
  readonly children: readonly Inline[];
}

export interface HeadingNode {
  readonly kind: "heading";
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly children: readonly Inline[];
}

export interface BlockquoteNode {
  readonly kind: "blockquote";
  readonly children: readonly Block[];
}

export interface ListItemNode {
  readonly kind: "listItem";
  readonly children: readonly Block[];
}

export interface ListNode {
  readonly kind: "list";
  readonly ordered: boolean;
  readonly start: number;
  readonly items: readonly ListItemNode[];
}

export interface HorizontalRuleNode {
  readonly kind: "hrule";
  readonly marker: "---" | "___";
}

export interface CodeBlockNode {
  readonly kind: "codeBlock";
  readonly language: string | null;
  readonly text: string;
}

export type TableAlign = "left" | "center" | "right" | null;

export interface TableCellNode {
  readonly kind: "tableCell";
  readonly children: readonly Inline[];
}

export interface TableNode {
  readonly kind: "table";
  readonly align: readonly TableAlign[];
  readonly header: readonly TableCellNode[];
  readonly rows: readonly (readonly TableCellNode[])[];
}

export interface SectionNode {
  readonly kind: "section";
  readonly name: string;
  readonly inverted: boolean;
  readonly children: readonly Block[];
}

export type Block =
  | ParagraphNode
  | HeadingNode
  | BlockquoteNode
  | ListNode
  | HorizontalRuleNode
  | CodeBlockNode
  | TableNode
  | SectionNode;

export type Node = Block | Inline | ListItemNode | TableCellNode;

export interface Side {
  readonly index: number;
  readonly blocks: readonly Block[];
}

export function side(index: number, blocks: readonly Block[]): Side {
  return { index, blocks };
}

export function childrenOf(node: Node): readonly Node[] {
  switch (node.kind) {
    case "paragraph":
    case "heading":
    case "strong":
    case "emphasis":
    case "cloze":
    case "element":
    case "link":
    case "tableCell":
      return node.children;
    case "blockquote":
    case "listItem":
    case "section":
      return node.children;
    case "list":
      return node.items;
    case "table":
      return [...node.header, ...node.rows.flat()];
    default:
      return [];
  }
}

export function walk(nodes: Iterable<Node>, visit: (node: Node) => void): void {
  for (const node of nodes) {
    visit(node);
    walk(childrenOf(node), visit);
  }
}

export function walkSides(sides: Iterable<Side>, visit: (node: Node) => void): void {
  for (const s of sides) walk(s.blocks, visit);
}

export function plainText(nodes: Iterable<Node>): string {
  const parts: string[] = [];
  walk(nodes, (node) => {
    if (node.kind === "text") parts.push(node.text);
    else if (node.kind === "code" || node.kind === "math") parts.push(node.text);
    else if (node.kind === "lineBreak") parts.push("\n");
    else if (node.kind === "wikiLink") parts.push(node.display ?? node.target);
  });
  return parts.join("");
}

export function collectUnknowns(sides: Iterable<Side>): UnknownNode[] {
  const out: UnknownNode[] = [];
  walkSides(sides, (node) => {
    if (node.kind === "unknown") out.push(node);
  });
  return out;
}

const VISIBLE = new Set([
  "code",
  "math",
  "wikiLink",
  "link",
  "image",
  "element",
  "hrule",
  "table",
  "unknown",
  "field",
]);

export function isSideEmpty(s: Side): boolean {
  let visible = false;
  walk(s.blocks, (node) => {
    if (visible) return;
    if (node.kind === "text") visible = node.text.trim() !== "";
    else if (VISIBLE.has(node.kind)) visible = true;
  });
  return !visible;
}

export function census(sides: Iterable<Side>): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (key: string, by = 1): void => {
    counts.set(key, (counts.get(key) ?? 0) + by);
  };

  for (const s of sides) {
    bump("side");
    walk(s.blocks, (node) => {
      switch (node.kind) {
        case "wikiLink":
          bump(
            node.display === null
              ? "wikiLink:bare"
              : node.display === ""
                ? "wikiLink:emptyDisplay"
                : "wikiLink",
          );
          break;
        case "list":
          bump(node.ordered ? "list:ordered" : "list:unordered");
          bump(node.ordered ? "listItem:ordered" : "listItem:unordered", node.items.length);
          break;
        case "listItem":
          break;
        case "blockquote":
          bump("blockquote");
          bump("quoteLine", quoteLines(node));
          break;
        case "element":
          bump("element");
          bump(`element:${node.name}`);
          for (const attribute of node.attributes) {
            if (attribute.value !== null) {
              bump("field:attribute", interpolationFields(attribute.value).length);
            }
          }
          break;
        case "link":
          bump("link");
          bump("field:href", interpolationFields(node.href).length);
          break;
        case "math":
          bump(node.display ? "math:display" : "math:inline");
          break;
        case "strong":
        case "emphasis":
          bump(`${node.kind}:${node.marker}`);
          break;
        case "heading":
          bump("heading");
          bump(`heading:${node.level}`);
          break;
        case "hrule":
          bump("hrule");
          bump(`hrule:${node.marker}`);
          break;
        case "unknown":
          bump(`unknown:${node.reason}`);
          break;
        default:
          bump(node.kind);
      }
    });
  }
  return counts;
}

function quoteLines(node: BlockquoteNode): number {
  let lines = 0;
  for (const block of node.children) {
    if (block.kind !== "paragraph") continue;
    lines += 1;
    walk(block.children, (child) => {
      if (child.kind === "lineBreak") lines += 1;
    });
  }
  return Math.max(1, lines);
}

export function mergeCensus(
  into: Map<string, number>,
  from: ReadonlyMap<string, number>,
): Map<string, number> {
  for (const [key, value] of from) into.set(key, (into.get(key) ?? 0) + value);
  return into;
}
