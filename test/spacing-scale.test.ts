/**
 * THE SPACING SCALE IS ENFORCED — the same rule as `./type-scale.test.ts`, for
 * padding, margin and gap.
 *
 * Measured 2026-10-29: 31 distinct px values across ~400 declarations (6, 7, 9,
 * 10, 11, 13, 14, 15, 17, 18 …) while `design-system/tokens.json` named eight
 * steps. They now name `--space-N`; this stops the 32nd.
 *
 * What may stay a raw px, and why: 0; 1-3px, which are optical nudges (a chip's
 * 2px padding — snapping it to 4 makes every chip taller); a negative margin,
 * which is a deliberate offset; and 100px or more, which is a layout reserve (the
 * room left under the review screen for its controls), not spacing.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync("app/style.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = JSON.parse(readFileSync("design-system/tokens.json", "utf8")) as {
  spacing: { tokens: { name: string; value: string }[] };
};

const PROPERTY = /(?<![\w-])((?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|bottom|left|right|inline|block))?):\s*([^;}\n]+)/g;

function allowed(px: number): boolean {
  return px === 0 || (px > 0 && px <= 3) || px < 0 || px >= 100;
}

describe("the spacing scale", () => {
  it("leaves no raw px spacing outside the allowed kinds", () => {
    const found: string[] = [];
    let declarations = 0;
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (rule[1] as string).trim().replace(/\s+/g, " ");
      for (const decl of (rule[2] as string).matchAll(PROPERTY)) {
        declarations += 1;
        for (const px of (decl[2] as string).matchAll(/(-?\d+(?:\.\d+)?)px\b/g)) {
          if (!allowed(Number(px[1]))) found.push(`${decl[1]}: ${(decl[2] as string).trim()}  ${selector}`);
        }
      }
    }
    expect(declarations, "the parser found no spacing — it broke").toBeGreaterThan(200);
    expect(found, "name a --space-N step (or say why in this file)").toEqual([]);
  });

  it("declares exactly the design system's steps", () => {
    const declared = [...css.matchAll(/--(space-\d+):\s*([^;]+);/g)].map((m) => [m[1], (m[2] as string).trim()]);
    const system = tokens.spacing.tokens.map((t) => [t.name, t.value]);
    expect(declared).toEqual(system);
  });

  it("names only steps that exist", () => {
    const declared = new Set([...css.matchAll(/--(space-\d+):/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\(--(space-\d+)\)/g)].map((m) => m[1]));
    expect([...used].filter((step) => !declared.has(step))).toEqual([]);
  });
});
