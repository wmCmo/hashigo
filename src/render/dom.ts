export interface RenderNode {
  readonly nodeName: string;
  readonly textContent: string | null;
}

export interface RenderText extends RenderNode {
  data: string;
}

export interface RenderElement extends RenderNode {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild(child: RenderNode): void;
}

export interface RenderDocument<E extends RenderElement = RenderElement> {
  createElement(tag: string): E;
  createTextNode(data: string): RenderText;
}

export function browserDocument(doc: Document): RenderDocument<HTMLElement> {
  return {
    createElement: (tag) => doc.createElement(tag),
    createTextNode: (data) => doc.createTextNode(data),
  };
}

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

export function memoryDocument(): RenderDocument<MemoryElement> {
  return {
    createElement: (tag) => new MemoryElement(tag),
    createTextNode: (data) => new MemoryText(data),
  };
}

export function walkMemory(node: MemoryNode, visit: (node: MemoryNode) => void): void {
  visit(node);
  if (node instanceof MemoryElement) {
    for (const child of node.children) walkMemory(child, visit);
  }
}

export function elementsByTag(root: MemoryNode, tag: string): MemoryElement[] {
  const wanted = tag.toLowerCase();
  const found: MemoryElement[] = [];
  walkMemory(root, (node) => {
    if (node instanceof MemoryElement && node.tagName === wanted) found.push(node);
  });
  return found;
}

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
  readonly pretty?: boolean;
}

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
