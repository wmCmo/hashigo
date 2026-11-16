import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync("app/style.css", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

const SPACE = new Map(
  [...css.matchAll(/--(space-\d+):\s*(-?\d+)px;/g)].map((m) => [m[1] as string, Number(m[2])]),
);

function declarations(selector: string): [string, string][] {
  const out: [string, string][] = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (rule[1] as string).split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (!selectors.includes(selector)) continue;
    for (const decl of (rule[2] as string).matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) {
      out.push([decl[1] as string, (decl[2] as string).trim()]);
    }
  }
  return out;
}

function px(value: string): number {
  const v = value.trim();
  if (v === "0") return 0;
  const raw = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  if (raw) return Number(raw[1]);
  const step = /^var\(--(space-\d+)\)$/.exec(v);
  if (step) return SPACE.get(step[1] as string) ?? Number.NaN;
  const negative = /^calc\(-1 \* var\(--(space-\d+)\)\)$/.exec(v);
  if (negative) return -(SPACE.get(negative[1] as string) ?? Number.NaN);
  return Number.NaN;
}

function sides(value: string): [string, string, string, string] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  const [t, r = t, b = t, l = r] = parts as [string, string?, string?, string?];
  return [t, r as string, b as string, l as string];
}

function box(selector: string, kind: "margin" | "padding", side: "left" | "top" | "bottom"): number {
  let value = Number.NaN;
  for (const [prop, raw] of declarations(selector)) {
    if (prop === kind) {
      const [t, , b, l] = sides(raw);
      value = px(side === "left" ? l : side === "top" ? t : b);
    } else if (prop === `${kind}-inline` && side === "left") {
      value = px(sides(raw)[0]);
    } else if (prop === `${kind}-${side}`) {
      value = px(raw);
    }
  }
  return value;
}

function last(selector: string, property: string): string | undefined {
  return declarations(selector).filter(([p]) => p === property).at(-1)?.[1];
}

describe("edges that are meant to line up", () => {
  it("the parser resolves the spacing scale", () => {
    expect(SPACE.get("space-4")).toBe(16);
    expect(box(".tpl-field", "padding", "left")).toBe(16);
  });

  it("search: the input, its result rows and the foot start their text on one edge", () => {
    const input = box(".palette-input", "margin", "left") + box(".palette-input", "padding", "left");
    const row = box(".palette-row", "margin", "left") + box(".palette-row", "padding", "left");
    const foot = box(".palette-foot", "padding", "left");
    expect([input, row, foot]).toEqual([row, row, row]);
    expect(Number.isNaN(row)).toBe(false);
  });

  it("template editor: a field's name starts where its tile's content does", () => {
    const name = box(".tpl-field .tpl-name", "margin", "left") + box("input.edit-input", "padding", "left");
    expect(name).toBe(0);
  });

  it("template editor: 'add a field' spans the field tiles, not the sidebar's inset", () => {
    expect(last(".layer-body > .tree-add", "margin-inline")).toBe("0");
    expect(last(".layer-body > .tree-add", "width")).toBe("100%");
  });

  it("sidebar: the new-card form is inset like the rows above it", () => {
    const rowInset = box(".sidebar-action", "margin", "left");
    expect(rowInset).toBe(8);
    expect(box(".newcard-host", "padding", "left")).toBe(rowInset);
  });

  it("dashboard: every deck's bar sits in one shared column", () => {
    expect(last(".glance-decks", "display")).toBe("grid");
    expect(last(".glance-decks", "grid-template-columns")).toMatch(/\d+px auto$/);
    expect(last(".glance-deck", "grid-template-columns")).toBe("subgrid");
    expect(last(".glance-deck", "grid-column")).toBe("1 / -1");
  });

  it("dialogs: the first field sits as far below the paragraph as the next field below it", () => {
    const between = box(".confirm-panel .edit-row", "padding", "top") + box(".confirm-panel .edit-row", "padding", "bottom");
    const first = box(".confirm-panel p + .edit-row", "padding", "top");
    expect(first).toBe(between);
    expect(first).toBeGreaterThan(0);
  });

  it("done screen: the ladder's ink starts on the heading's edge", () => {
    const width = px(last(".climb-mark", "width") ?? "");
    const ink = (11 / 100) * width;
    expect(Math.abs(ink + box(".climb-mark", "margin", "left"))).toBeLessThanOrEqual(1);
  });
});
