/**
 * THE TYPE SCALE IS ENFORCED, NOT SUGGESTED.
 *
 * Zach, 2026-10-29, after another project counted its own drift: `app/style.css`
 * had 126 font-size declarations over 41 distinct values in px, rem and em
 * (0.72rem, 0.74rem, 0.76rem, 0.78rem, 12.5px, …), each picked in the moment,
 * while `design-system/tokens.json` already named the steps. They now all name a
 * `--fs-*` step, and this is what stops the 42nd value arriving.
 *
 * Two halves: no raw size outside the deliberate exceptions, and every step is a
 * size the design system itself names — so the stylesheet cannot quietly grow a
 * scale of its own beside the system's.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync("app/style.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = JSON.parse(readFileSync("design-system/tokens.json", "utf8")) as {
  type: { groups: { styles: { fontSize: string; usage?: string }[] }[] };
};

/**
 * Where a raw size is RIGHT, each with its reason. A new entry needs one too.
 */
const EXEMPT: readonly (readonly [RegExp, string])[] = [
  [/\.hashigo-/, "card content: sized against the card's own text (decisions 35, 57)"],
  [/ruby/, "furigana: a fraction of the word it annotates, with a floor"],
  [/wordmark/, "the brand mark: sized to the logo, not to the interface"],
  [/(^|[\s,])\.replay\b/, "the play disc's icon, sized to the 60px disc"],
];

/** A size relative to its own line (inline code, a glyph) is not an interface step. */
const RELATIVE = /^[\d.]+em$/;

interface Decl {
  readonly selector: string;
  readonly value: string;
}

function fontSizes(): Decl[] {
  const out: Decl[] = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (rule[1] as string).trim().replace(/\s+/g, " ");
    for (const decl of (rule[2] as string).matchAll(/font-size:\s*([^;}\n]+)/g)) {
      out.push({ selector, value: (decl[1] as string).trim() });
    }
  }
  return out;
}

describe("the type scale", () => {
  it("leaves no raw interface font-size", () => {
    const sizes = fontSizes();
    expect(sizes.length, "the parser found no font-size — it broke").toBeGreaterThan(50);
    const raw = sizes.filter(
      ({ selector, value }) =>
        !value.startsWith("var(--fs-") &&
        !RELATIVE.test(value) &&
        !EXEMPT.some(([pattern]) => pattern.test(selector)),
    );
    expect(
      raw.map(({ selector, value }) => `${value}  ${selector}`),
      "name a --fs-* step, or add the selector to EXEMPT with its reason",
    ).toEqual([]);
  });

  it("names only steps the stylesheet declares", () => {
    const declared = new Set([...css.matchAll(/--fs-([a-z]+):/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\(--fs-([a-z]+)\)/g)].map((m) => m[1]));
    expect([...used].filter((step) => !declared.has(step))).toEqual([]);
  });

  it("is made of sizes the design system names", () => {
    const styles = tokens.type.groups.flatMap((group) => group.styles);
    const named = new Set(styles.map((style) => style.fontSize));
    // `label` names chips at 11px in its usage rather than as a style of its own.
    for (const style of styles) for (const px of style.usage?.match(/\d+px/g) ?? []) named.add(px);
    const steps = [...css.matchAll(/--fs-([a-z]+):\s*([^;]+);/g)].map((m) => [m[1], (m[2] as string).trim()]);
    expect(steps.length).toBeGreaterThan(5);
    expect(steps.filter(([, size]) => !named.has(size as string))).toEqual([]);
  });
});
