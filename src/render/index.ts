/**
 * Stage 4 — the renderer. Resolved sides in, DOM out, and nothing else.
 *
 *     import { memoryDocument, renderResolvedCard, serialise } from "hashigo/render";
 *     import { resolveCard } from "hashigo/template";
 *
 *     const document = memoryDocument();                    // or browserDocument(window.document)
 *     const result = renderResolvedCard(resolveCard(card, template), { document });
 *     serialise(result.root);                               // memory documents only
 *
 * WHERE THIS STOPS. It builds DOM and hands back mounts. It does not grade, does
 * not queue, does not decide when a cloze is revealed, does not fetch a blob and
 * does not start playback — every one of those needs Zach's taste and belongs to
 * stage 7. The mounts are the seam: `RenderResult.clozes[i].onReveal(…)` is how
 * the review UI attaches behaviour without this module knowing what behaviour is.
 *
 * FOUR THINGS THAT ARE NOT NEGOTIABLE, all of them observable from outside:
 *
 *   1. NO AUDIO EVER STARTS HERE. There is no `autoplay`, no `.play()`, no
 *      `src`. `test/render.test.ts` greps this directory for both and censuses
 *      every media element the corpus produces.
 *   2. NO STRING BECOMES MARKUP. `createTextNode` and `setAttribute` are the only
 *      two ways anything authored reaches the DOM. See `./dom.ts` for why that
 *      rather than an escaper, and `./sanitise.ts` for what is then allowed.
 *   3. NOTHING AUTHORED DISAPPEARS. An unknown element, an unknown node, an
 *      unresolved field and an unresolvable link each render as visible text.
 *      Every one of those also lands in `diagnostics`, so a card that renders
 *      oddly can be explained rather than guessed at.
 *   4. THE SIDE ORDER IS THE CALLER'S. `orderSides` in `src/template/resolve.ts`
 *      owns the reverse permutation; this module renders the array it is given,
 *      in order, and reports both the authored index and the presentation
 *      position on each side. A renderer that re-ordered sides would be a second
 *      opinion on direction, which SPEC's locked reverse-permutation decision
 *      does not want.
 */

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

// ─── the result ──────────────────────────────────────────────────────────────

export interface RenderResult<E extends RenderElement = RenderElement> {
  /** `<div class="hashigo-card">`, holding one `<section>` per side. */
  readonly root: E;
  readonly sides: readonly RenderedSide<E>[];
  readonly clozes: readonly ClozeMount<E>[];
  /** Attachment references AND generator slots, in document order. */
  readonly media: readonly MediaMount<E>[];
  readonly generations: readonly GeneratorMount<E>[];
  readonly widgets: readonly WidgetMount<E>[];
  readonly links: readonly LinkMount<E>[];
  /** Node kinds rendered, plus `side`, `element:<name>` and the fallbacks. */
  readonly census: ReadonlyMap<string, number>;
  readonly diagnostics: readonly RenderDiagnostic[];
  /** Reveal every cloze. Fires each mount's listeners, in document order. */
  revealAll(): void;
  concealAll(): void;
  /** Fires for every cloze revealed anywhere in this render. Returns unsubscribe. */
  onReveal(listener: (mount: ClozeMount<E>) => void): () => void;
}

// ─── the driver ──────────────────────────────────────────────────────────────

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
    // Defaults first, so a partial override replaces exactly what it names.
    this.#renderers = { ...defaultRenderers<E>(), ...(settings.renderers ?? {}) };
  }

  // ── DOM ──
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
    // A node that strips to nothing is not appended AT ALL. That is what makes
    // `[[引き|…]]<U+200E>[[換え|…]]` two adjacent anchors and one word.
    if (text === "") return;
    parent.appendChild(this.settings.document.createTextNode(text));
  }

  attribute(parent: E, name: string, value: string): void {
    parent.setAttribute(name, attributeValue(value));
  }

  // ── dispatch ──
  node(parent: E, node: Node): void {
    this.count(node.kind);
    // The cast is the one place the mapped type has to be indexed dynamically:
    // `NodeRenderers` is total over `Node["kind"]`, so a renderer always exists,
    // but TypeScript cannot see that the value's kind matches the key it looked
    // it up with. Nothing is unchecked at runtime — a missing key is impossible.
    const render = this.#renderers[node.kind] as (n: Node, p: E, c: RenderContext<E>) => void;
    render(node, parent, this);
  }

  nodes(parent: E, nodes: readonly Node[]): void {
    for (const node of nodes) this.node(parent, node);
  }

  // ── mounts ──
  /**
   * How many cloze answers we are currently rendering inside. A COUNTER rather
   * than a flag: a cloze nested in a cloze must not un-mask its parent on the way
   * out. `try/finally` so a renderer that throws does not leave it raised and
   * mark the rest of the card as masked.
   */
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
        // DOM first, listeners second: a listener that plays audio or measures
        // the answer must see the revealed tree, not the one before it.
        for (const listener of [...listeners]) listener(mount);
        for (const listener of [...driver.#revealListeners]) listener(mount);
      },
      conceal(): void {
        if (!revealed) return;
        revealed = false;
        element.setAttribute(DATA.state, "hidden" satisfies MountState);
        answer.setAttribute("hidden", "");
        mask.removeAttribute("hidden");
        // Deliberately silent. Concealing is not a reveal, and firing the same
        // listeners would play the clip he has already heard.
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

  // ── bookkeeping ──
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

// ─── the entry points ────────────────────────────────────────────────────────

/**
 * Render an ordered list of resolved sides.
 *
 * `sides` is what `resolveCard` / `orderSides` produced; this renders them in
 * the order given. Each `<section>` records BOTH indices, because the two answer
 * different questions: `data-side` says which side of the template you are
 * looking at (needed to explain 単語's empty first side), and `data-position`
 * says where it sits in the sequence you are being shown (needed once reverse
 * mode permutes them).
 */
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
  // Carried diagnostics go in FIRST, so a card's list reads resolver-then-render
  // in the order the two stages ran.
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

/**
 * Render what stage 3 handed you, warnings and all.
 *
 * The resolver's warnings are carried into `diagnostics` so that ONE list
 * explains a card: "this side is empty because `Reading` is false" and "this
 * attribute was dropped" are the same kind of fact to whoever is looking at a
 * card that renders oddly, and making the caller merge two lists guarantees one
 * of them gets ignored.
 */
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
