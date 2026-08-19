/**
 * Stage 4 — LaTeX. `$…$` and `$$…$$`, on 18 cards, every one of them in 基本情報
 * (the IT Fundamentals Exam deck).
 *
 * TWO COUNTS, AND THEY ARE DIFFERENT NUMBERS — say which one you mean, the way
 * `reviews.elapsed_days` and `reviews.scheduled_days` have to be named:
 *
 *   AUTHORED  29 fragments. Every `$…$` in `card.content` PLUS every field
 *             value, unresolved. `\div` appears 12 times.
 *   RESOLVED  28 fragments, per direction. What this renderer is actually
 *             handed, and the only count a test of the renderer can assert.
 *             `\div` appears 11 times.
 *
 * The one fragment in the gap is a `\div` in the stale pre-template `content` of
 * card `3gtxY7Mo`, which the importer discards by design (CLAUDE.md decision 5).
 * Distinct fragment strings: 14, on both bases. Re-measured 2026-08-20 by
 * resolving all 7,716 cards in both directions.
 *
 * ── THE DECISION, AND WHY IT IS NOT "SHIP KATEX" ─────────────────────────────
 *
 * A WRONG FORMULA IS WORSE THAN VISIBLE SOURCE. He is memorising 稼働率 = MTBF ÷
 * (MTBF + MTTR) for an exam that marks it right or wrong. So the renderer may
 * typeset only what it can typeset CORRECTLY, and must show the source for
 * anything else — a `\div` silently rendered as nothing, or a fraction rendered
 * upside down, is a card that teaches him the wrong answer with no way to notice.
 *
 * The three options, weighed against the measured corpus rather than against
 * LaTeX in general:
 *
 *   1. KATEX (or MathJax). Correct for everything, and NOT AVAILABLE: it is
 *      ~280 kB of JS plus font files, there is no CDN in an offline app, and
 *      CLAUDE.md's first problem is battery on a phone. It would also be 280 kB
 *      to render, in total, fourteen distinct fragments.
 *   2. MATHML, which needs no library at all — Chrome has shipped MathML Core
 *      since 109 and Android Chrome is what he studies on. REJECTED, and the
 *      reason is structural: MathML elements only exist in the MathML namespace,
 *      which needs `createElementNS`, and the DOM port in `dom.ts` has FIVE
 *      operations and that is not one of them. `document.createElement("math")`
 *      makes an `HTMLUnknownElement`, which renders as a run of unstyled text —
 *      i.e. silently wrong output, exactly what rule 1 forbids. Widening the
 *      port to get MathML would cost the property that makes the sanitiser
 *      answerable.
 *   3. A TOTAL, TINY SUBSET renderer: HTML plus `<sup>`/`<sub>`, no dependency,
 *      no namespace, and a hard refusal for anything outside the subset. CHOSEN.
 *
 * ── WHAT THE SUBSET IS, MEASURED ─────────────────────────────────────────────
 *
 * Every construct the corpus actually uses, from the field values and card text:
 *
 *     \times   \div   \frac x3   \text{ヒット率}   log_2n   10^{-6}
 *     I   D   P   1   (I + D - 1)\times　P   \times(   -\text{ヒット率})
 *
 * Note the last two: they are UNBALANCED ON PURPOSE, because he split one formula
 * across cloze boundaries — `$\times(${{$1$}}$-\text{ヒット率})$`. A parser that
 * balanced parentheses would refuse a card that is perfectly well authored, so
 * this one balances BRACES (LaTeX syntax) and never parentheses (content).
 *
 * Anything with a command outside the table, an unbalanced brace, a `&`, a `\\`
 * or a missing argument is REFUSED as a whole fragment and rendered as its own
 * source text, marked `data-typeset="source"` — which is byte for byte what the
 * core renderer in `nodes.ts` already does, so the fallback is not a second
 * behaviour to maintain.
 */

import type { RenderElement } from "./dom.js";
import { CLASS, DATA, type NodeRenderers, type RenderContext } from "./nodes.js";

// ─── the table ───────────────────────────────────────────────────────────────

/**
 * Command -> character. One entry is one unambiguous substitution, which is the
 * only kind allowed in here: `\times` is ×, and there is nothing to get wrong.
 * Measured over the 28 RESOLVED fragments — see the header for why that is not
 * 29 — the command counts are `\div` 11, `\times` 7, `\frac` 1, `\text` 1,
 * plus one `^` and one `_` — so the symbol
 * table needs exactly two entries. `\cdot` and `\pm` are here anyway, and unit
 * tested, because adding a 1:1 substitution is a one-line verifiable change and a
 * table of two invites the next person to guess at a third instead.
 */
export const MATH_SYMBOLS: Readonly<Record<string, string>> = {
  times: "×",
  div: "÷",
  cdot: "⋅",
  pm: "±",
};

/** `\{` and friends: a backslash-escaped character is that character. */
const ESCAPABLE = new Set(["{", "}", "$", "%", "&", "#", "_", "^", "\\"]);

/** Commands that take arguments, handled by the parser rather than the table. */
const STRUCTURAL = new Set(["frac", "text"]);

// ─── the tree ────────────────────────────────────────────────────────────────

export type MathItem =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "symbol"; readonly command: string; readonly text: string }
  | { readonly kind: "sup"; readonly items: readonly MathItem[] }
  | { readonly kind: "sub"; readonly items: readonly MathItem[] }
  | { readonly kind: "upright"; readonly items: readonly MathItem[] }
  | { readonly kind: "group"; readonly items: readonly MathItem[] }
  | {
      readonly kind: "frac";
      readonly numerator: readonly MathItem[];
      readonly denominator: readonly MathItem[];
    };

export type MathParse =
  | { readonly kind: "typeset"; readonly items: readonly MathItem[] }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Parse a LaTeX fragment, delimiters already stripped by the template parser.
 *
 * Total: it either returns a tree it is sure of, or a refusal with a reason.
 * There is no "best effort" branch, because a best effort at a formula is how a
 * wrong formula gets on a card.
 */
export function parseMath(source: string): MathParse {
  const chars = [...source];
  let at = 0;

  const refusal = (reason: string): MathParse => ({ kind: "refused", reason });

  function skipSpaceAfterCommand(): void {
    // LaTeX swallows whitespace after a control word. `\times　P` is ×P.
    while (at < chars.length && /\s/.test(chars[at] ?? "")) at += 1;
  }

  function readCommand(): string | null {
    let name = "";
    while (at < chars.length && /[A-Za-z]/.test(chars[at] ?? "")) {
      name += chars[at];
      at += 1;
    }
    return name === "" ? null : name;
  }

  /** One argument: a `{…}` group, or the single next atom. */
  function parseArgument(): readonly MathItem[] | string {
    skipSpaceAfterCommand();
    if (at >= chars.length) return "argument missing";
    if (chars[at] === "{") {
      at += 1;
      const inner = parseItems(true);
      if (typeof inner === "string") return inner;
      if (chars[at] !== "}") return "unbalanced brace";
      at += 1;
      return inner.length === 0 ? "empty argument" : inner;
    }
    if (chars[at] === "}") return "argument missing";
    const single = parseAtom();
    if (typeof single === "string") return single;
    return single === null ? "argument missing" : [single];
  }

  /** One atom: an escape, a symbol, a structural command, or one character. */
  function parseAtom(): MathItem | null | string {
    const ch = chars[at];
    if (ch === undefined) return null;
    if (ch === "\\") {
      at += 1;
      const next = chars[at];
      if (next === undefined) return "trailing backslash";
      if (next === "\\") return "line break outside the subset";
      if (ESCAPABLE.has(next) && !/[A-Za-z]/.test(next)) {
        at += 1;
        return { kind: "text", text: next };
      }
      const name = readCommand();
      if (name === null) return `unsupported escape \\${next}`;
      if (STRUCTURAL.has(name)) {
        if (name === "text") {
          const inner = parseArgument();
          if (typeof inner === "string") return inner;
          return { kind: "upright", items: inner };
        }
        const numerator = parseArgument();
        if (typeof numerator === "string") return numerator;
        const denominator = parseArgument();
        if (typeof denominator === "string") return denominator;
        return { kind: "frac", numerator, denominator };
      }
      const symbol = MATH_SYMBOLS[name];
      if (symbol === undefined) return `unknown command \\${name}`;
      skipSpaceAfterCommand();
      return { kind: "symbol", command: name, text: symbol };
    }
    if (ch === "^" || ch === "_") {
      at += 1;
      const inner = parseArgument();
      if (typeof inner === "string") return inner;
      return { kind: ch === "^" ? "sup" : "sub", items: inner };
    }
    if (ch === "&") return "alignment outside the subset";
    if (ch === "$") return "nested delimiter";
    if (ch === "{") {
      // A bare group is transparent — grouping, not `	ext` — but its contents
      // still have to parse.
      at += 1;
      const inner = parseItems(true);
      if (typeof inner === "string") return inner;
      if (chars[at] !== "}") return "unbalanced brace";
      at += 1;
      return { kind: "group", items: inner };
    }
    at += 1;
    return { kind: "text", text: ch };
  }

  function parseItems(inGroup: boolean): MathItem[] | string {
    const items: MathItem[] = [];
    while (at < chars.length) {
      if (chars[at] === "}") {
        if (inGroup) return items;
        return "unbalanced brace";
      }
      const atom = parseAtom();
      if (typeof atom === "string") return atom;
      if (atom === null) break;
      // Runs of plain characters coalesce, so the DOM gets one text node per run.
      const last = items[items.length - 1];
      if (atom.kind === "text" && last !== undefined && last.kind === "text") {
        items[items.length - 1] = { kind: "text", text: last.text + atom.text };
      } else {
        items.push(atom);
      }
    }
    return items;
  }

  if (source.trim() === "") return refusal("empty fragment");
  const items = parseItems(false);
  if (typeof items === "string") return refusal(items);
  if (at !== chars.length) return refusal("unbalanced brace");
  return { kind: "typeset", items };
}

/** `10^{-6}` -> `10^-6`, for a log line or a plain-text export. */
export function mathPlainText(items: readonly MathItem[]): string {
  return items
    .map((item) => {
      switch (item.kind) {
        case "text":
          return item.text;
        case "symbol":
          return item.text;
        case "sup":
          return `^${mathPlainText(item.items)}`;
        case "sub":
          return `_${mathPlainText(item.items)}`;
        case "upright":
        case "group":
          return mathPlainText(item.items);
        case "frac":
          return `${mathPlainText(item.numerator)}/${mathPlainText(item.denominator)}`;
      }
    })
    .join("");
}

// ─── the renderer ────────────────────────────────────────────────────────────

/** Classes and attributes this module owns. */
export const MATH_CLASS = {
  operator: "hashigo-math-op",
  fraction: "hashigo-math-frac",
  numerator: "hashigo-math-num",
  denominator: "hashigo-math-den",
  slash: "hashigo-math-slash",
  upright: "hashigo-math-upright",
} as const;

export const MATH_DATA = {
  /** `subset` when typeset, `source` when refused. */
  typeset: "data-typeset",
  /** The LaTeX as authored. Kept on BOTH paths: nothing authored disappears. */
  latex: "data-latex",
  /** The refusal reason, on the source path only. */
  refused: "data-refused",
} as const;

export interface MathOptions {
  /**
   * A fragment fell outside the subset and was rendered as source. There is no
   * `RenderDiagnosticKind` for this — that union lives in `nodes.ts`, which this
   * module does not own — so refusals come back through a callback, which is
   * arguably where the decision belongs anyway.
   */
  readonly onRefused?: (source: string, reason: string, display: boolean) => void;
}

/**
 * A `math` renderer for `RenderSettings.renderers`.
 *
 * Opt-in on purpose. The core's default is verbatim source, and that default is
 * exactly this renderer's fallback, so installing it can only add typesetting
 * and can never take a formula away.
 */
export function mathRenderers<E extends RenderElement>(
  options: MathOptions = {},
): Partial<NodeRenderers<E>> {
  return {
    math(node, parent, context) {
      const element = context.element("span", CLASS.math);
      context.attribute(element, DATA.math, node.display ? "display" : "inline");
      context.attribute(element, MATH_DATA.latex, node.text);
      const parsed = parseMath(node.text);
      if (parsed.kind === "refused") {
        context.attribute(element, MATH_DATA.typeset, "source");
        context.attribute(element, MATH_DATA.refused, parsed.reason);
        // Verbatim, exactly as the core renderer would have done it.
        element.appendChild(context.verbatim(node.text));
        parent.appendChild(element);
        context.count("math:source");
        options.onRefused?.(node.text, parsed.reason, node.display);
        return;
      }
      context.attribute(element, MATH_DATA.typeset, "subset");
      renderItems(parsed.items, element, context);
      parent.appendChild(element);
      context.count("math:subset");
    },
  };
}

function renderItems<E extends RenderElement>(
  items: readonly MathItem[],
  parent: E,
  context: RenderContext<E>,
): void {
  for (const item of items) {
    switch (item.kind) {
      case "text": {
        // Verbatim: a formula's spaces are load-bearing and U+3000 is authored.
        parent.appendChild(context.verbatim(item.text));
        break;
      }
      case "symbol": {
        const span = context.element("span", MATH_CLASS.operator);
        span.appendChild(context.verbatim(item.text));
        parent.appendChild(span);
        break;
      }
      case "sup":
      case "sub": {
        const element = context.element(item.kind);
        renderItems(item.items, element, context);
        parent.appendChild(element);
        break;
      }
      case "group": {
        // Transparent: grouping is syntax, and syntax leaves no element behind.
        renderItems(item.items, parent, context);
        break;
      }
      case "upright": {
        const span = context.element("span", MATH_CLASS.upright);
        renderItems(item.items, span, context);
        parent.appendChild(span);
        break;
      }
      case "frac": {
        // `<sup>x</sup>⁄<sub>3</sub>`: UNSTYLED this reads x⁄3, which is correct.
        // A stacked fraction needs CSS, and a stylesheet that has not loaded must
        // never turn a fraction into "x3".
        const frac = context.element("span", MATH_CLASS.fraction);
        const numerator = context.element("sup", MATH_CLASS.numerator);
        renderItems(item.numerator, numerator, context);
        const slash = context.element("span", MATH_CLASS.slash);
        slash.appendChild(context.verbatim("⁄"));
        const denominator = context.element("sub", MATH_CLASS.denominator);
        renderItems(item.denominator, denominator, context);
        frac.appendChild(numerator);
        frac.appendChild(slash);
        frac.appendChild(denominator);
        parent.appendChild(frac);
        break;
      }
    }
  }
}
