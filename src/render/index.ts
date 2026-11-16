import type { RenderedCard, Side } from "../template/index.js";
import { isSideEmpty } from "../template/index.js";
import type { RenderElement, RenderText } from "./dom.js";
import {
  CLASS,
  DATA,
  defaultRenderers,
  type ClozeMount,
  type GeneratorMount,
  type GenerationDescriptor,
  type LinkMount,
  type MediaMount,
  type MountState,
  type NodeRenderers,
  type RenderContext,
  type RenderDiagnostic,
  type RenderDiagnosticKind,
  type RenderSettings,
  type RenderedSide,
  type WidgetMount,
} from "./nodes.js";
import type { MediaKind, MediaReference } from "./sanitise.js";
import { attributeValue } from "./sanitise.js";
import { stripInvisible } from "../text/index.js";
import type { Node } from "../template/index.js";

export * from "./dom.js";
export * from "./nodes.js";
export * from "./sanitise.js";

export interface RenderResult<E extends RenderElement = RenderElement> {
  readonly root: E;
  readonly sides: readonly RenderedSide<E>[];
  readonly clozes: readonly ClozeMount<E>[];
  readonly media: readonly MediaMount<E>[];
  readonly generations: readonly GeneratorMount<E>[];
  readonly widgets: readonly WidgetMount<E>[];
  readonly links: readonly LinkMount<E>[];
  readonly census: ReadonlyMap<string, number>;
  readonly diagnostics: readonly RenderDiagnostic[];
  revealAll(): void;
  concealAll(): void;
  onReveal(listener: (mount: ClozeMount<E>) => void): () => void;
}

class Driver<E extends RenderElement> implements RenderContext<E> {
  readonly settings: RenderSettings<E>;
  readonly frame = { headerCell: false, cellAlign: null as RenderContext<E>["frame"]["cellAlign"] };

  side = -1;

  readonly clozes: ClozeMount<E>[] = [];
  readonly media: MediaMount<E>[] = [];
  readonly generations: GeneratorMount<E>[] = [];
  readonly widgets: WidgetMount<E>[] = [];
  readonly links: LinkMount<E>[] = [];
  readonly census = new Map<string, number>();
  readonly diagnostics: RenderDiagnostic[] = [];

  readonly #renderers: NodeRenderers<E>;
  readonly #revealListeners = new Set<(mount: ClozeMount<E>) => void>();

  constructor(settings: RenderSettings<E>) {
    this.settings = settings;
    this.#renderers = { ...defaultRenderers<E>(), ...(settings.renderers ?? {}) };
  }

  element(tag: string, className?: string): E {
    const element = this.settings.document.createElement(tag);
    if (className !== undefined) element.setAttribute("class", className);
    return element;
  }

  text(value: string): RenderText {
    return this.settings.document.createTextNode(stripInvisible(value));
  }

  verbatim(value: string): RenderText {
    return this.settings.document.createTextNode(value);
  }

  appendText(parent: E, value: string): void {
    const text = stripInvisible(value);
    if (text === "") return;
    parent.appendChild(this.settings.document.createTextNode(text));
  }

  attribute(parent: E, name: string, value: string): void {
    parent.setAttribute(name, attributeValue(value));
  }

  node(parent: E, node: Node): void {
    this.count(node.kind);
    const render = this.#renderers[node.kind] as (n: Node, p: E, c: RenderContext<E>) => void;
    render(node, parent, this);
  }

  nodes(parent: E, nodes: readonly Node[]): void {
    for (const node of nodes) this.node(parent, node);
  }

  #clozeDepth = 0;

  withinCloze<T>(run: () => T): T {
    this.#clozeDepth += 1;
    try {
      return run();
    } finally {
      this.#clozeDepth -= 1;
    }
  }

  mountCloze(parts: { element: E; mask: E; answer: E; index: number | null }): ClozeMount<E> {
    const ordinal = this.clozes.length;
    const side = this.side;
    const { element, mask, answer, index } = parts;
    element.setAttribute(DATA.cloze, String(ordinal));
    if (index !== null) element.setAttribute(DATA.clozeIndex, String(index));
    element.setAttribute(DATA.state, "hidden" satisfies MountState);
    answer.setAttribute("hidden", "");

    const listeners = new Set<(mount: ClozeMount<E>) => void>();
    let revealed = false;
    const driver = this;
    const mount: ClozeMount<E> = {
      element,
      mask,
      answer,
      index,
      ordinal,
      side,
      get revealed(): boolean {
        return revealed;
      },
      reveal(): void {
        if (revealed) return;
        revealed = true;
        element.setAttribute(DATA.state, "revealed" satisfies MountState);
        answer.removeAttribute("hidden");
        mask.setAttribute("hidden", "");
        for (const listener of [...listeners]) listener(mount);
        for (const listener of [...driver.#revealListeners]) listener(mount);
      },
      conceal(): void {
        if (!revealed) return;
        revealed = false;
        element.setAttribute(DATA.state, "hidden" satisfies MountState);
        answer.setAttribute("hidden", "");
        mask.removeAttribute("hidden");
      },
      onReveal(listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    this.clozes.push(mount);
    this.settings.hooks?.cloze?.(mount);
    return mount;
  }

  mountMedia(parts: {
    element: E;
    kind: MediaKind;
    reference: MediaReference;
    alt: string;
    origin: "attachment" | "generator";
  }): MediaMount<E> {
    const mount: MediaMount<E> = { ...parts, side: this.side, ordinal: this.media.length };
    this.media.push(mount);
    this.count(`media:${mount.kind}`);
    this.settings.hooks?.media?.(mount);
    return mount;
  }

  mountGenerator(parts: {
    element: E;
    name: string;
    request: GenerationDescriptor | null;
    output: E | null;
    media: MediaMount<E> | null;
  }): GeneratorMount<E> {
    const mount: GeneratorMount<E> = {
      ...parts,
      inCloze: this.#clozeDepth > 0,
      side: this.side,
      ordinal: this.generations.length,
    };
    this.generations.push(mount);
    this.settings.hooks?.generation?.(mount);
    return mount;
  }

  mountWidget(parts: {
    element: E;
    name: string;
    attributes: Readonly<Record<string, string>>;
    expected: string | null;
  }): WidgetMount<E> {
    const mount: WidgetMount<E> = { ...parts, side: this.side, ordinal: this.widgets.length };
    this.widgets.push(mount);
    this.settings.hooks?.widget?.(mount);
    return mount;
  }

  mountLink(parts: { element: E; kind: "card" | "external"; target: string; href: string }): LinkMount<E> {
    const mount: LinkMount<E> = { ...parts, side: this.side, ordinal: this.links.length };
    this.links.push(mount);
    this.settings.hooks?.link?.(mount);
    return mount;
  }

  diagnose(kind: RenderDiagnosticKind, detail: string): void {
    this.diagnostics.push({ kind, detail, side: this.side });
  }

  count(key: string): void {
    this.census.set(key, (this.census.get(key) ?? 0) + 1);
  }

  onReveal(listener: (mount: ClozeMount<E>) => void): () => void {
    this.#revealListeners.add(listener);
    return () => this.#revealListeners.delete(listener);
  }
}

export function renderSides<E extends RenderElement>(
  sides: readonly Side[],
  settings: RenderSettings<E>,
): RenderResult<E> {
  return renderWith(sides, settings, []);
}

function renderWith<E extends RenderElement>(
  sides: readonly Side[],
  settings: RenderSettings<E>,
  carried: readonly RenderDiagnostic[],
): RenderResult<E> {
  const driver = new Driver(settings);
  driver.diagnostics.push(...carried);
  const root = driver.element("div", CLASS.card);
  const rendered: RenderedSide<E>[] = [];

  sides.forEach((side, position) => {
    driver.side = side.index;
    driver.frame.headerCell = false;
    driver.frame.cellAlign = null;
    const element = driver.element("section", CLASS.side);
    driver.attribute(element, DATA.side, String(side.index));
    driver.attribute(element, DATA.position, String(position));
    const empty = isSideEmpty(side);
    if (empty) driver.attribute(element, DATA.empty, "");
    driver.count("side");
    driver.nodes(element, side.blocks);
    root.appendChild(element);
    const entry: RenderedSide<E> = { index: side.index, position, element, empty };
    rendered.push(entry);
    settings.hooks?.side?.(entry);
  });
  driver.side = -1;

  const result: RenderResult<E> = {
    root,
    sides: rendered,
    clozes: driver.clozes,
    media: driver.media,
    generations: driver.generations,
    widgets: driver.widgets,
    links: driver.links,
    census: driver.census,
    diagnostics: driver.diagnostics,
    revealAll(): void {
      for (const cloze of driver.clozes) cloze.reveal();
    },
    concealAll(): void {
      for (const cloze of driver.clozes) cloze.conceal();
    },
    onReveal(listener): () => void {
      return driver.onReveal(listener);
    },
  };
  return result;
}

export function renderResolvedCard<E extends RenderElement>(
  card: RenderedCard,
  settings: RenderSettings<E>,
): RenderResult<E> {
  return renderWith(
    card.sides,
    settings,
    card.warnings.map((warning) => ({
      kind: "resolver-warning" as const,
      detail: `${warning.kind}: ${warning.detail}`,
      side: -1,
    })),
  );
}
