/**
 * Stage 4 — the DOM surface the renderer builds against, and the in-memory
 * implementation that makes it testable under Node.
 *
 * THE CHOICE, AND WHY. SPEC's renderer has to run in two places: a browser tab,
 * and `vitest` under Node where there is no `document` at all. The three options
 * were weighed against one requirement — that the sanitiser question stay
 * answerable — and only one survives it:
 *
 *   1. Emit an HTML string and `innerHTML` it. REJECTED, and it is the reason
 *      this file exists. The moment markup is assembled by concatenation, "can a
 *      card inject an element" becomes a question about the correctness of an
 *      escaper, which is a question nobody can answer by reading the code. It
 *      also makes every test a string-comparison test.
 *   2. Pull in jsdom (or happy-dom) as a devDependency. REJECTED: it tests a
 *      second implementation of the DOM, and this project's rule is that the
 *      thing tested is the thing that ships (`src/blobs/sqlite.ts` runs in both
 *      Node and the browser for exactly that reason). A 3 MB dependency to
 *      assert `appendChild` also does not pay for itself here.
 *   3. A tiny port — FIVE operations — with a real-DOM adapter and a Node-side
 *      implementation. CHOSEN. The renderer can only create elements, create
 *      text, set an attribute, remove an attribute and append a child. There is
 *      no `innerHTML` in the surface, so markup injection is not filtered out;
 *      it is unrepresentable.
 *
 * THE PORT IS PROVED, NOT ASSERTED. `RenderElement` and `RenderDocument` are
 * shaped so the platform's own `HTMLElement` and `Document` satisfy them
 * structurally, and `test/render.test.ts` pins that with a type-only assignment
 * in the manner of `test/db-contract.types.ts`. If someone widens this surface
 * past what the real DOM provides, `npm run typecheck` stops compiling — which
 * is the moment to find out.
 *
 * `MemoryDocument` IS NOT ONLY A TEST DOUBLE. CLAUDE.md's first problem is
 * battery drain, answered with "precomputed renders": a render produced off the
 * main thread, serialised, and stored. `serialise()` is that path, and it is
 * also what the golden files in `test/render.test.ts` compare. Keeping it here
 * rather than in the test means the precompute story does not need a second
 * renderer — but note the direction: `serialise` is an OUTPUT projection of a
 * tree that was built node by node. Nothing in `src/render/` ever parses HTML
 * back in.
 */

// ─── the port ────────────────────────────────────────────────────────────────

/**
 * Anything the renderer can append. Only `nodeName` is exposed, purely so the
 * type is not structurally empty (which would make every value assignable, and
 * a mistake unnoticeable). The real `Node.nodeName` satisfies it.
 */
export interface RenderNode {
  readonly nodeName: string;
  /** Concatenated text, for callers and tests. Real DOM's is mutable; ours is not. */
  readonly textContent: string | null;
}

/** A text node. `data` is exposed so a caller can update text after mounting. */
export interface RenderText extends RenderNode {
  data: string;
}

/**
 * An element.
 *
 * `appendChild` returns `void` deliberately: the real signature is
 * `appendChild<T extends Node>(node: T): T`, and a method returning something is
 * assignable to a method returning nothing, so `void` is the widest thing that
 * both implementations satisfy without a generic escaping into every caller.
 */
export interface RenderElement extends RenderNode {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild(child: RenderNode): void;
}

/**
 * The two factories, parameterised on the element type so a browser caller keeps
 * its `HTMLElement`s — `result.clozes[0].element.addEventListener(…)` has to
 * work without a cast, or stage 7 will reach around this module instead.
 */
export interface RenderDocument<E extends RenderElement = RenderElement> {
  createElement(tag: string): E;
  createTextNode(data: string): RenderText;
}

/**
 * Adapt a real `Document`.
 *
 * Explicitly annotated rather than returning `doc` directly: `createElement` is
 * an overloaded generic on `Document`, and inference through an overload is the
 * kind of thing that works until someone upgrades TypeScript. Two arrow
 * functions cost nothing and pin the types.
 *
 * Nothing in this module touches `document` at load time, so importing
 * `src/render/*` under Node — which `scripts/verify-dist.mjs` does to every
 * emitted module — is safe.
 */
export function browserDocument(doc: Document): RenderDocument<HTMLElement> {
  return {
    createElement: (tag) => doc.createElement(tag),
    createTextNode: (data) => doc.createTextNode(data),
  };
}

// ─── the Node-side implementation ────────────────────────────────────────────

const MEMORY_NODE: unique symbol = Symbol("hashigo.render.memory-node");

export class MemoryText implements RenderText {
  readonly [MEMORY_NODE] = true;
  readonly nodeName = "#text";
  data: string;

  constructor(data: string) {
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }
}

/**
 * An element as three fields: a tag, an insertion-ordered attribute map and a
 * child array. Attribute ORDER is preserved because the golden files diff on it;
 * a `Map` gives that for free and a plain object would not survive a numeric-ish
 * attribute name.
 */
export class MemoryElement implements RenderElement {
  readonly [MEMORY_NODE] = true;
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: MemoryNode[] = [];

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }

  get nodeName(): string {
    return this.tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name.toLowerCase(), value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name.toLowerCase());
  }

  appendChild(child: RenderNode): void {
    if (!isMemoryNode(child)) {
      throw new TypeError(
        `MemoryElement.appendChild was handed a foreign node (${child.nodeName}). ` +
          `A memory document and a real document cannot share a tree.`,
      );
    }
    this.children.push(child);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name.toLowerCase());
  }

  get textContent(): string {
    return this.children.map((child) => child.textContent).join("");
  }
}

export type MemoryNode = MemoryElement | MemoryText;

export function isMemoryNode(value: unknown): value is MemoryNode {
  return typeof value === "object" && value !== null && MEMORY_NODE in value;
}

export function isMemoryElement(value: unknown): value is MemoryElement {
  return value instanceof MemoryElement;
}

/** A document whose trees are plain objects. Used by the tests and by precompute. */
export function memoryDocument(): RenderDocument<MemoryElement> {
  return {
    createElement: (tag) => new MemoryElement(tag),
    createTextNode: (data) => new MemoryText(data),
  };
}

// ─── walking a memory tree ───────────────────────────────────────────────────

/** Depth-first, parents before children. */
export function walkMemory(node: MemoryNode, visit: (node: MemoryNode) => void): void {
  visit(node);
  if (node instanceof MemoryElement) {
    for (const child of node.children) walkMemory(child, visit);
  }
}

/** Every element in the tree whose tag is `tag`. */
export function elementsByTag(root: MemoryNode, tag: string): MemoryElement[] {
  const wanted = tag.toLowerCase();
  const found: MemoryElement[] = [];
  walkMemory(root, (node) => {
    if (node instanceof MemoryElement && node.tagName === wanted) found.push(node);
  });
  return found;
}

// ─── serialising ─────────────────────────────────────────────────────────────

/** HTML's void elements: no children, no closing tag. */
const VOID_TAGS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

export interface SerialiseOptions {
  /**
   * Put each element on its own line, indented. The golden files use this; a
   * precomputed render would not, because whitespace between inline elements is
   * significant — see `pretty` below.
   */
  readonly pretty?: boolean;
}

/**
 * A memory tree as HTML text.
 *
 * `pretty` INSERTS WHITESPACE THAT CHANGES RENDERING. Two adjacent `<a>`
 * elements with a newline between them read as two words; that is the whole
 * U+200E problem (see `src/text/render.ts`) and it is why pretty output is for
 * human eyes and golden diffs only. The default is exact.
 */
export function serialise(node: MemoryNode, options: SerialiseOptions = {}): string {
  const pretty = options.pretty === true;
  const out: string[] = [];
  write(node, 0);
  return out.join("");

  function write(current: MemoryNode, depth: number): void {
    const pad = pretty ? "  ".repeat(depth) : "";
    const end = pretty ? "\n" : "";
    if (current instanceof MemoryText) {
      if (current.data === "") return;
      out.push(`${pad}${escapeText(current.data)}${end}`);
      return;
    }
    // Always `name="value"`, even when the value is empty. That is HTML's own
    // fragment-serialisation algorithm, and it is what makes a memory render
    // byte-identical to `element.outerHTML` in Chrome — measured, with the
    // boolean shorthand it is NOT (`hidden` vs `hidden=""`, 9 bytes apart on one
    // card). Byte-identity is the property a precomputed render needs.
    const attributes = [...current.attributes]
      .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
      .join("");
    if (VOID_TAGS.has(current.tagName)) {
      out.push(`${pad}<${current.tagName}${attributes}>${end}`);
      return;
    }
    if (current.children.length === 0) {
      out.push(`${pad}<${current.tagName}${attributes}></${current.tagName}>${end}`);
      return;
    }
    out.push(`${pad}<${current.tagName}${attributes}>${end}`);
    for (const child of current.children) write(child, depth + 1);
    out.push(`${pad}</${current.tagName}>${end}`);
  }
}
