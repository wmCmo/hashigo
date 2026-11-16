import type { RenderElement } from "./dom.js";
import { CLASS, DATA, type NodeRenderers, type RenderContext } from "./nodes.js";

export const MATH_SYMBOLS: Readonly<Record<string, string>> = {
  times: "×",
  div: "÷",
  cdot: "⋅",
  pm: "±",
};

const ESCAPABLE = new Set(["{", "}", "$", "%", "&", "#", "_", "^", "\\"]);

const STRUCTURAL = new Set(["frac", "text"]);

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

export function parseMath(source: string): MathParse {
  const chars = [...source];
  let at = 0;

  const refusal = (reason: string): MathParse => ({ kind: "refused", reason });

  function skipSpaceAfterCommand(): void {
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

export const MATH_CLASS = {
  operator: "hashigo-math-op",
  fraction: "hashigo-math-frac",
  numerator: "hashigo-math-num",
  denominator: "hashigo-math-den",
  slash: "hashigo-math-slash",
  upright: "hashigo-math-upright",
} as const;

export const MATH_DATA = {
  typeset: "data-typeset",
  latex: "data-latex",
  refused: "data-refused",
} as const;

export interface MathOptions {
  readonly onRefused?: (source: string, reason: string, display: boolean) => void;
}

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
