import type { Mora, Phrase } from "../accent/sentence.js";
import { parseAnnotation } from "../accent/sentence.js";
import type { RenderElement } from "./dom.js";
import { CLASS, DATA, defaultRenderers, type NodeRenderers, type RenderContext } from "./nodes.js";

export const OJAD = "ojad";

export const MARK_CLASS = {
  container: "hashigo-ojad",
  reading: "hashigo-ojad-reading",
  gap: "hashigo-ojad-gap",
  mora: "hashigo-mora",
  head: "hashigo-mora-head",
  devoiced: "hashigo-mora-devoiced",
} as const;

export interface MarkMount<E extends RenderElement> {
  readonly element: E;
  annotate(marks: string): number;
}

export interface MarkSupport<E extends RenderElement> {
  readonly renderers: Partial<NodeRenderers<E>>;
  readonly mounts: readonly MarkMount<E>[];
  annotateAll(marks: string): number;
}

export function accentMarkSupport<E extends RenderElement>(
  options: { readonly fallback?: NodeRenderers<E>["element"] } = {},
): MarkSupport<E> {
  const fallback = options.fallback ?? defaultRenderers<E>().element;
  const mounts: MarkMount<E>[] = [];

  const renderers: Partial<NodeRenderers<E>> = {
    element(node, parent, context) {
      if (node.name !== OJAD) {
        fallback(node, parent, context);
        return;
      }
      renderMarks(parent, context, mounts);
    },
  };

  return {
    renderers,
    mounts,
    annotateAll(marks): number {
      if (marks === "") return 0;
      let filled = 0;
      for (const mount of mounts) {
        if (mount.annotate(marks) > 0) filled += 1;
      }
      return filled;
    },
  };
}

function renderMarks<E extends RenderElement>(
  parent: E,
  context: RenderContext<E>,
  mounts: MarkMount<E>[],
): void {
  const container = context.element("span", `${CLASS.generator} ${MARK_CLASS.container}`);
  context.attribute(container, DATA.generator, OJAD);
  context.attribute(container, DATA.state, "pending");
  context.count(`element:${OJAD}`);

  const reading = context.element("span", MARK_CLASS.reading);
  container.appendChild(reading);
  parent.appendChild(container);

  mounts.push({
    element: container,
    annotate(value: string): number {
      let phrases: Phrase[];
      try {
        phrases = parseAnnotation(value);
      } catch {
        context.attribute(container, DATA.state, "missing");
        return 0;
      }
      let placed = 0;
      for (const [index, phrase] of phrases.entries()) {
        if (index > 0) {
          const gap = context.element("span", MARK_CLASS.gap);
          context.appendText(gap, " ");
          reading.appendChild(gap);
        }
        for (const mora of phrase.morae) {
          reading.appendChild(moraElement(context, mora));
          placed += 1;
        }
      }
      if (placed === 0) {
        context.attribute(container, DATA.state, "missing");
        return 0;
      }
      context.attribute(container, DATA.state, "revealed");
      context.attribute(container, DATA.resolved, "1");
      return placed;
    },
  });
}

function moraElement<E extends RenderElement>(context: RenderContext<E>, mora: Mora): E {
  const classes: string[] = [MARK_CLASS.mora];
  if (mora.head) classes.push(MARK_CLASS.head);
  if (mora.devoiced) classes.push(MARK_CLASS.devoiced);
  const element = context.element("span", classes.join(" "));
  context.appendText(element, mora.kana);
  return element;
}
