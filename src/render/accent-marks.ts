/**
 * Stage 12 — `<ojad>` as one element per MORA, so a sentence can show its own
 * pitch accent and devoicing.
 *
 * Zach, 2026-09-13: *"the head of the accent is some color, and i would know
 * that it would fall, and the 平板 would have no color, and other color for the
 * devoiced"*. That is OJAD's own notation, which he already reads, and he chose
 * it over a stepped 高低 line explicitly — *"we don't need line, im used to the
 * ojad notation"*.
 *
 * ─── WHY THIS COSTS NO SCHEMA CHANGE, WHICH IS THE WHOLE REASON IT IS A
 *     GENERATOR AND NOT A FIELD TYPE ──────────────────────────────────────────
 *
 * He asked for *"a field type called OJAD"*. `template_fields.type` is a CHECK
 * constraint, so that is a schema bump — and decision 41 made those expensive on
 * 2026-09-13 itself: the final import has happened, so `rm` + re-import is no
 * longer a lossless reset and a bump has to answer for the live review history.
 *
 * `nodes.ts` already documents the escape, about a generator that has existed
 * since stage 4: *"`pinyin` has no row in `BLOB_KINDS` and therefore no request;
 * it still renders its base text."* A generator element needs a renderer and
 * nothing else. So `<ojad>` is not in `GENERATOR_KIND`, asks the store for
 * nothing, and is filled from a `local = 1` field — the `型` pattern, which the
 * schema's own comment says was chosen in stage 1 precisely to avoid *"a
 * migration over 7,716 cards"*.
 *
 * ─── THE SHAPE IS `furiganaSupport`'S, DELIBERATELY ─────────────────────────
 *
 * One support object per render, collecting mounts, filled once the value is
 * known. Decision 20 recorded why a generator cannot read its own field: *"a
 * resolved plain field is substituted to TEXT before the render and nothing
 * downstream knows 平板 came from 型."* The same is true here.
 *
 * ─── `<ojad></ojad>` IS EMPTY, AND THAT WAS NOT THE FIRST DESIGN ────────────
 *
 * It wrapped the field to begin with — `<ojad><< 例文 >></ojad>` — so the element
 * could read the sentence as its own base. **That cannot work, and the suite
 * said so in four places at once.** `例文` is an `ai` FIELD: by the time the
 * renderer sees the body, `expandGeneratorFields` has rewritten the reference
 * into an `<ai>` element whose text arrives later through `fillText`. So the
 * children of `<ojad>` were a nested generator rather than text — the wrapper
 * matched nothing, and it displaced the speech mount that reads the same field.
 * `test/cards.test.ts`'s corpus mount census caught that, which is the census it
 * exists for.
 *
 * The repair is smaller than the thing it replaced. The sentence is already on
 * screen: `<< 例文 >>` renders it as it always has. `<ojad></ojad>` sits on the
 * line below and renders ONLY the marked reading. Nothing nests, nothing is
 * displaced, and his sentence stays true — *"while reading the example sentence
 * i can see hear how it's pronounced and confirm by looking at the field"* —
 * confirm, beside, never instead.
 *
 * Every mora is its own element because a mark is per mora and because it has to
 * wrap: a 110-mora sentence on a 375px phone breaks across lines, and inline
 * elements break where a single long element could not.
 */

import type { Mora, Phrase } from "../accent/sentence.js";
import { parseAnnotation } from "../accent/sentence.js";
import type { RenderElement } from "./dom.js";
import { CLASS, DATA, defaultRenderers, type NodeRenderers, type RenderContext } from "./nodes.js";

/** The element name, as authored in a template body. */
export const OJAD = "ojad";

/** Class names this renderer emits. Kept here so `style.css` has one source. */
export const MARK_CLASS = {
  container: "hashigo-ojad",
  reading: "hashigo-ojad-reading",
  gap: "hashigo-ojad-gap",
  mora: "hashigo-mora",
  head: "hashigo-mora-head",
  devoiced: "hashigo-mora-devoiced",
} as const;

/** One `<ojad>` on the page, waiting for its annotation. */
export interface MarkMount<E extends RenderElement> {
  readonly element: E;
  /** Fill it. Returns the number of morae placed; 0 when the value was unusable. */
  annotate(marks: string): number;
}

export interface MarkSupport<E extends RenderElement> {
  readonly renderers: Partial<NodeRenderers<E>>;
  readonly mounts: readonly MarkMount<E>[];
  /**
   * Fill every mount with the card's annotation.
   *
   * A card carries a single `ojad` value because it has a single example
   * sentence, so there is nothing to key on. **The staleness this admits is the
   * same one `型` already has**: both are materialised from something that could
   * later change without the materialiser being re-run, and both are re-run as
   * part of the documented rebuild sequence. It is not a new class of risk, and
   * pretending to verify it (by mora count, say) would be a check that passes
   * for the wrong sentence.
   */
  annotateAll(marks: string): number;
}

/**
 * An `<ojad>`-aware `element` renderer, plus the mounts it produces.
 *
 * Anything that is not an `<ojad>` is delegated untouched — the same delegation
 * `furiganaSupport` does, so `<speech>`, `<ai>`, `<draw>` and the inert-unknown
 * path keep behaving exactly as `nodes.ts` says they do.
 */
export function accentMarkSupport<E extends RenderElement>(
  options: { readonly fallback?: NodeRenderers<E>["element"] } = {},
): MarkSupport<E> {
  // COMPOSABLE, because `furiganaSupport` overrides the same renderer and a 単語
  // card has both on it. Whoever wraps whom, the one that does not match must
  // delegate rather than fall through to the core — otherwise the inner
  // support's elements silently stop rendering and the card still looks fine.
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
  // The core counts every element it renders as `element:<name>`; this stands in
  // for it, so it keeps the census whole — the same line and the same reason as
  // `renderFurigana`. Without it a corpus census loses every <ojad> silently.
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
        // REFUSED, NOT APPROXIMATED. A malformed annotation is decision 8's case
        // — "a wrong accent drilled is worse than no accent" — and the sentence
        // is rendered by its own field above, so refusing costs only the marks.
        context.attribute(container, DATA.state, "missing");
        return 0;
      }
      let placed = 0;
      for (const [index, phrase] of phrases.entries()) {
        if (index > 0) {
          // The phrase break is a real boundary and it is worth seeing: it is
          // where a new accent may begin. A thin gap, not a bar — a bar in the
          // middle of a reading reads as punctuation he has to parse.
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
