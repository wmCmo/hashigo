import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../app/style.css", import.meta.url), "utf8");

const GROUNDS = ["--paper", "--paper-sunk", "--card"] as const;

const ON_INSTEAD: Record<string, readonly string[]> = {
  "--card": ["--indigo", "--indigo-deep", "--danger"],
  "--on-live": ["--vermilion"],
};

const NOT_BODY_TEXT: Record<string, string> = {
  "--hair": "1px rules and borders only — 1.29:1 by design, never text",
  "--edge": "border value. As 10-12px text it measured 2.02:1 on dark; all 13 " +
    "such uses were moved to --muted on 2026-09-12",
  "--vermilion": "3.47:1 on paper — the mark's top rung and the focus ring, " +
    "which are large/non-text. --danger is its text-safe sibling",
  "--focus": "alias of --vermilion; an outline, not text",
  "--indigo-deep": "hover/pressed state of a filled button, measured against " +
    "--card as its own foreground, not against paper",
};

function tokensIn(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of block.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) {
    map.set(m[1] as string, (m[2] as string).trim());
  }
  return map;
}

function blockAfter(marker: string): string {
  const at = css.indexOf(marker);
  expect(at, `could not find ${marker} in app/style.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open, i);
    }
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

const light = tokensIn(blockAfter(":root {"));
const darkExplicit = tokensIn(blockAfter(':root[data-theme="dark"]'));
const dark = new Map([...light, ...darkExplicit]);

function resolve(name: string, table: Map<string, string>, seen = new Set<string>()): string {
  expect(seen.has(name), `circular var chain at ${name}`).toBe(false);
  seen.add(name);
  const value = table.get(name);
  expect(value, `${name} is used but never defined`).toBeDefined();
  const v = (value as string).trim();
  const ref = /^var\((--[a-z-]+)\)$/.exec(v);
  if (ref) return resolve(ref[1] as string, table, seen);
  expect(v, `${name} resolves to ${v}, which is not a hex colour`).toMatch(/^#[0-9a-f]{6}$/i);
  return v;
}

const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const ratio = (a: string, b: string): number => {
  const x = luminance(a);
  const y = luminance(b);
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
};

function foregroundTokens(): string[] {
  const found = new Set<string>();
  for (const m of css.matchAll(/(?<!-)\bcolor:\s*var\((--[a-z-]+)\)/g)) {
    found.add(m[1] as string);
  }
  return [...found].sort();
}

describe("every foreground token clears AA on every ground, in both themes", () => {
  const themes: [string, Map<string, string>][] = [
    ["light", light],
    ["dark", dark],
  ];

  for (const [themeName, table] of themes) {
    it(`${themeName}: no text colour is unreadable on paper, sunk or card`, () => {
      const bad: string[] = [];
      for (const token of foregroundTokens()) {
        if (token in NOT_BODY_TEXT) continue;
        const fg = resolve(token, table);
        for (const ground of ON_INSTEAD[token] ?? GROUNDS) {
          const bg = resolve(ground, table);
          const r = ratio(fg, bg);
          if (r < 4.5) {
            bad.push(`${token} (${fg}) on ${ground} (${bg}) = ${r.toFixed(2)}:1`);
          }
        }
      }
      expect(bad, `these fail AA for small text in ${themeName}:\n  ${bad.join("\n  ")}`).toEqual(
        [],
      );
    });
  }

  it("no exception names a token that no longer exists", () => {
    const gone = Object.keys(NOT_BODY_TEXT).filter((t) => !light.has(t));
    expect(gone, `exceptions naming tokens that are gone: ${gone.join(", ")}`).toEqual([]);
  });

  it("the tokens banned from being text really are not text anywhere", () => {
    const used = new Set(foregroundTokens());
    for (const token of ["--hair", "--edge", "--vermilion", "--focus"]) {
      expect(
        used.has(token),
        `${token} is being used as a text colour: ${NOT_BODY_TEXT[token]}`,
      ).toBe(false);
    }
  });
});

describe("the state colours survived the repoint that broke them", () => {
  it("success and failure are not the same colour", () => {
    for (const [name, table] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const good = resolve("--good", table);
      const danger = resolve("--danger", table);
      expect(good, `--good and --danger are identical in ${name}`).not.toBe(danger);
    }
  });

  it("`--ok` and `--no` still mean success and failure, not indigo", () => {
    for (const table of [light, dark]) {
      expect(resolve("--ok", table)).toBe(resolve("--good", table));
      expect(resolve("--no", table)).toBe(resolve("--danger", table));
      expect(resolve("--ok", table)).not.toBe(resolve("--indigo", table));
      expect(resolve("--no", table)).not.toBe(resolve("--indigo", table));
    }
  });

  it("the answer verdict keeps a NON-COLOUR signal, because the pair is isoluminant", () => {
    const good = resolve("--good", light);
    const danger = resolve("--danger", light);
    expect(ratio(good, danger)).toBeLessThan(1.6);

    const correct = /input\[data-answer="correct"\]\s*\{([^}]*)\}/.exec(css);
    const incorrect = /input\[data-answer="incorrect"\]\s*\{([^}]*)\}/.exec(css);
    expect(correct?.[1], "the correct verdict lost its non-colour signal").toMatch(/box-shadow/);
    expect(incorrect?.[1], "the incorrect verdict lost its non-colour signal").toMatch(
      /box-shadow/,
    );
    expect(correct?.[1]).not.toBe(incorrect?.[1]);
  });

  it("the create button is a primary action, not a success state", () => {
    const rule = /\.newcard-submit\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/background:\s*var\(--indigo\)/);
    expect(rule?.[1]).not.toMatch(/var\(--ok/);
  });
});

describe("look-ahead says how to get out of it", () => {
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("../app/main.ts", import.meta.url), "utf8");

  it("the peek banner carries a real exit control", () => {
    const banner = /<div id="peek"[\s\S]*?<\/div>/.exec(html);
    expect(banner, "#peek is not in index.html").not.toBeNull();
    expect(banner?.[0], "the look-ahead banner has no exit button").toMatch(/id="peekback"/);
  });

  it("the exit returns to the session cursor, not one step back", () => {
    const handler = /el\("peekback"\)\.addEventListener\([\s\S]{0,220}?\}\);/.exec(main);
    expect(handler, "#peekback is never wired up").not.toBeNull();
    expect(handler?.[0]).toMatch(/showSessionCard/);
  });

  it("grading a card he arrowed to sends the OFFSET, so it cannot hit the wrong one", () => {
    const call = /ask<"answer">\(\{[\s\S]{0,200}?\}\)/.exec(main);
    expect(call, "the grade call is gone").not.toBeNull();
    expect(call?.[0], "the grade no longer carries the offset").toMatch(/offset:\s*peekOffset/);
  });

  it("only BACKWARD grading is locked — those cards are already answered", () => {
    expect(main).toMatch(/const behind = peekOffset < 0/);
    expect(main).toMatch(/forgotButton\.disabled = behind/);
    expect(main).toMatch(/rememberedButton\.disabled = behind/);
  });

  it("a refused grade is said out loud, never a silent no-op", () => {
    expect(main).toMatch(/reply\.refused !== null/);
    expect(main).toMatch(/REFUSAL\[reply\.refused\]/);
  });

  it("a disabled grade button does not look pressable", () => {
    const rule = /\.bar button\[disabled\]\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1], ".bar button[disabled] is gone").toBeDefined();
    expect(rule?.[1]).toMatch(/background:\s*none/);
    expect(rule?.[1]).toMatch(/cursor:\s*not-allowed/);
  });
});

describe("text that lands on a FILLED ground, not on paper", () => {
  const ON_FILL: readonly [string, string, string][] = [
    ["--card", "--indigo", "a filled button's own label"],
    ["--card", "--indigo-deep", "a filled button's label, pressed"],
    ["--card", "--danger", "the record button's label while the mic is open"],
    ["--on-live", "--vermilion", "the replay disc's icon on the ruri fill (decision 57)"],
    ["--ink", "--sunk", "a recessed row: deck rows, palette rows, menu rows"],
    ["--muted", "--sunk", "the subtitle on those rows — deck path, card count"],
    ["--muted", "--paper-sunk", "the cloze mask's own text"],
    ["--indigo", "--sunk", "a link or a pressed operation button"],
  ];

  for (const [themeName, table] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`${themeName}: every foreground on a filled ground clears AA`, () => {
      const bad: string[] = [];
      for (const [fg, bg, where] of ON_FILL) {
        const r = ratio(resolve(fg, table), resolve(bg, table));
        if (r < 4.5) bad.push(`${fg} on ${bg} = ${r.toFixed(2)}:1 — ${where}`);
      }
      expect(bad, `these fail AA on a filled ground in ${themeName}:\n  ${bad.join("\n  ")}`)
        .toEqual([]);
    });
  }

  it("the keycap hints take the colour of what they sit in, rather than a fixed token", () => {
    for (const name of ["kbd", "kbd-inline"]) {
      const rules = [...css.matchAll(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`, "g"))]
        .map((m) => m[1] as string)
        .join("\n");
      expect(rules, `.${name} has no rule at all`).not.toBe("");
      expect(rules, `.${name} must not pin a colour token`).not.toMatch(/color:\s*var\(/);
    }
    expect(css).toMatch(/\.kbd\s*\{[^}]*color:\s*inherit/);
  });

  it("the 0.85 hint floor is checked against the ground, not inherited as a number", () => {
    const over = (fg: string, bg: string, alpha: number): string => {
      const [f, b] = [parseInt(fg.slice(1), 16), parseInt(bg.slice(1), 16)];
      const mix = (shift: number): number =>
        Math.round(alpha * ((f >> shift) & 255) + (1 - alpha) * ((b >> shift) & 255));
      return `#${[16, 8, 0].map((s) => mix(s).toString(16).padStart(2, "0")).join("")}`;
    };
    const ground = resolve("--danger", dark);
    const faded = ratio(over(resolve("--card", dark), ground, 0.85), ground);
    expect(faded, `0.85 over --danger in dark is ${faded.toFixed(2)}:1`).toBeLessThan(4.5);
    expect(
      css,
      "the armed record button's hint is back on the 0.85 floor, which does not " +
        "clear AA on --danger in dark",
    ).toMatch(/\.op\.arm \.kbd-inline \{[^}]*opacity:\s*1/);
    expect(ratio(resolve("--card", dark), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it("decision 19: a keycap hint never renders where there is no keyboard", () => {
    const guarded = /@media \(hover: hover\) and \(pointer: fine\) \{([\s\S]*?)\n\}/g;
    const inside = [...css.matchAll(guarded)].map((m) => m[1] as string).join("\n");
    for (const name of ["kbd", "kbd-inline"]) {
      expect(inside, `.${name} is not behind the pointer query`).toMatch(
        new RegExp(`\\.${name}\\s*\\{`),
      );
    }
  });

  it("the hairline token is never a surface UNDER TEXT", () => {
    const SURFACE_OK: Record<string, string> = {
      ".fetchtrack": "a progress track — a bar, with no text on it",
      ".progressbar": "the session's progress track — a bar, with no text on it",
      ".tree-more": "the ⋯ chip must stand out FROM a deck row whose own hover " +
        "ground is --sunk, and its only text is --ink at 9.21:1",
    };
    const TRACKS = new Set(Object.keys(SURFACE_OK));
    const offenders: string[] = [];
    for (const m of css.matchAll(/([^{}]+)\{([^}]*background:\s*var\(--line\)[^}]*)\}/g)) {
      const selector = (m[1] as string).split("\n").pop()?.trim() ?? "";
      const head = selector.split(",")[0]?.trim() ?? "";
      if ([...TRACKS].some((track) => selector.includes(track))) continue;
      offenders.push(head);
    }
    expect(
      offenders,
      `--line is a hairline, not a surface. These paint with it:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("every block element the renderer emits has a rule behind the reset", () => {
  const nodes = readFileSync(new URL("../src/render/nodes.ts", import.meta.url), "utf8");

  const NO_RULE_NEEDED: Record<string, string> = {
    span: "inline, and every variant carries its own hashigo- class",
    a: "styled by .hashigo-card-link / .hashigo-link",
    img: ".hashigo-image",
    audio: ".hashigo-audio",
    video: ".hashigo-video",
    ruby: "styled through ruby/rt rules and data-ruby-align",
    rt: "same",
    rb: "same",
    br: "no box",
    section: ".hashigo-side is the section",
    div: ".hashigo-card is the root div",
    canvas: ".hashigo-draw",
    input: ".hashigo-input",
    code: ".hashigo-code — inline, and 0 code fences exist in the corpus",
    pre: "0 code fences in the corpus; .hashigo-code covers the inline form",
    thead: "a grouping box with no painting of its own",
    tbody: "same",
    tr: "same — the borders live on th/td",
    hr: ".hashigo-rule",
    em: "inline",
    strong: "inline",
    del: "inline",
    sup: "inline",
    sub: "inline",
    h1: "the renderer maps headings into h4 on a card",
    h2: "same",
    h3: "same",
    h5: "same",
    h6: "same",
  };

  it("emits nothing that lands on browser defaults", () => {
    const emitted = new Set<string>();
    for (const call of nodes.matchAll(/\bcontext\.element\(([^)]*)\)/g)) {
      for (const arg of (call[1] as string).matchAll(/"([a-z0-9]+)"/g)) {
        const tag = arg[1] as string;
        if (!tag.startsWith("hashigo-")) emitted.add(tag);
      }
    }
    expect(emitted.size, "found no emitted elements — the pattern stopped matching").toBeGreaterThan(
      8,
    );
    expect(emitted.has("ol")).toBe(true);
    expect(emitted.has("table")).toBe(true);

    const unstyled: string[] = [];
    for (const tag of [...emitted].sort()) {
      if (tag in NO_RULE_NEEDED) continue;
      const rule = new RegExp(`\\.hashigo-side\\s+(?:[^{,]*,\\s*)*${tag}\\b`);
      if (!rule.test(css)) unstyled.push(tag);
    }
    expect(
      unstyled,
      "these are emitted onto a card and land on `* { margin: 0; padding: 0 }` " +
        `with nothing behind it:\n  ${unstyled.join("\n  ")}`,
    ).toEqual([]);
  });

  it("a list marker sits INSIDE the text column", () => {
    const rule = /\.hashigo-side ol,\s*\.hashigo-side ul \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule, "no rule for lists on a card").not.toBe("");
    const padding = /padding-left:\s*([\d.]+)em/.exec(rule)?.[1];
    expect(padding, "list padding must be in em, so it tracks the type size").toBeDefined();
    expect(Number(padding)).toBeGreaterThanOrEqual(1);
  });

  it("a table on a card has cell padding and rules", () => {
    const cells = /\.hashigo-side th,\s*\.hashigo-side td \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(cells, "no rule for table cells on a card").not.toBe("");
    expect(cells).toMatch(/padding:/);
    expect(cells).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(/\.hashigo-side table \{([^}]*)\}/.exec(css)?.[1]).toMatch(
      /border-collapse:\s*collapse/,
    );
  });
});

describe("every position: fixed rule has an answer for the rail", () => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

  interface Rule {
    readonly selector: string;
    readonly decls: Map<string, string>;
  }

  const rules: Rule[] = [];
  for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] as string).trim();
    if (selector.startsWith("@")) continue;
    const decls = new Map<string, string>();
    for (const part of (match[2] as string).split(";")) {
      const at = part.indexOf(":");
      if (at === -1) continue;
      decls.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
    for (const one of selector.split(",")) rules.push({ selector: one.trim(), decls });
  }

  const OVERLAY: Record<string, string> = {
    ".layer":
      "a preview's scrim must cover the rail — a modal that leaves the deck " +
      "list clickable behind it is not modal",
    ".sidebar-scrim":
      "never shows at this width; the composition block hides it because the " +
      "rail is permanent and has nothing to dismiss",
    ".selection-newcard":
      "placed by script at the selection's getBoundingClientRect, a viewport " +
      "box that already sits right of the rail — an offset would move it twice",
  };

  const RAIL = ".sidebar";

  it("classifies, and knows of no fixed rule it cannot place", () => {
    const fixed = rules.filter((rule) => rule.decls.get("position") === "fixed");
    expect(fixed.length, "no position: fixed rules found — the parser broke").toBeGreaterThan(4);

    const unplaced: string[] = [];
    for (const rule of fixed) {
      if (rule.selector === RAIL) continue;
      if (rule.selector in OVERLAY) continue;
      const left = rule.decls.get("left") ?? rule.decls.get("inset");
      if (left === undefined && rule.decls.has("right")) continue;
      const offset = rules.some(
        (other) =>
          other.selector === rule.selector &&
          [...other.decls.values()].some((value) => value.includes("--rail-w")),
      );
      if (offset) continue;
      unplaced.push(rule.selector);
    }

    expect(
      unplaced,
      "these are `position: fixed` and say nothing about the rail, so at " +
        "≥1024px they sit under it. Give each one an offset, or an entry in " +
        `OVERLAY with the reason it covers the rail:\n  ${unplaced.join("\n  ")}`,
    ).toEqual([]);
  });

  it("names no overlay that has stopped being one", () => {
    const fixed = new Set(
      rules.filter((rule) => rule.decls.get("position") === "fixed").map((rule) => rule.selector),
    );
    const stale = Object.keys(OVERLAY).filter((selector) => !fixed.has(selector));
    expect(stale, `OVERLAY names selectors that are no longer fixed: ${stale.join(", ")}`).toEqual(
      [],
    );
  });

  it("offsets the two that need it, and centres the toast rather than shifting it", () => {
    const desktop = /@media \(min-width: 1024px\) \{([\s\S]*)\}/.exec(css)?.[1] ?? "";
    expect(desktop, "no ≥1024px block in the stylesheet").not.toBe("");
    expect(desktop).toMatch(/\.footer \{[^}]*left:\s*var\(--rail-w\)/);
    expect(desktop).toMatch(/\.say \{[^}]*left:\s*calc\(50% \+ var\(--rail-w\) \/ 2\)/);
    expect(desktop).toMatch(/\.say \{[^}]*max-width:\s*calc\(100% - var\(--rail-w\)/);
  });

  it("lines the footer's controls up with the card column, DERIVED not retyped", () => {
    const mainRule = /\.review main \{([^}]*)\}/.exec(css)?.[1] ?? "";
    const box = Number(/max-width:\s*(\d+)px/.exec(mainRule)?.[1]);
    const side = /padding:\s*\S+\s+(\S+)/.exec(mainRule)?.[1] ?? "";
    const token = /^var\(--(space-\d+)\)$/.exec(side)?.[1];
    const pad = Number(
      token === undefined
        ? /^(\d+)px$/.exec(side)?.[1]
        : new RegExp(`--${token}:\\s*(\\d+)px`).exec(css)?.[1],
    );
    expect(box, "cannot read the card column's width").toBeGreaterThan(0);
    expect(pad, "cannot read the card column's padding").toBeGreaterThan(0);

    const desktop = /@media \(min-width: 1024px\) \{([\s\S]*)\}/.exec(css)?.[1] ?? "";
    const inset = /([^{}]+)\{[^}]*padding-inline:\s*max\([^,]+,\s*calc\(\(100% - (\d+)px\)/.exec(
      desktop,
    );
    for (const row of [".ops", ".shadowbar", ".bar"]) {
      expect(inset?.[1] ?? "", `${row} is not inset to the card column`).toContain(row);
    }
    const used = Number(inset?.[2]);
    expect(
      used,
      `the footer insets to ${used}px but the card's text column is ` +
        `${box - pad * 2}px (${box} box − 2 × ${pad} padding). The reveal button ` +
        `no longer agrees with the text above it.`,
    ).toBe(box - pad * 2);
  });

  it("keeps every card operation reachable as a real control", () => {
    const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
    const main = readFileSync(new URL("../app/main.ts", import.meta.url), "utf8");
    expect(html, "the card ⋯ handle is gone").toMatch(/id="opmore"/);
    const menu = /function openCardMenu\([\s\S]*?\n\}/.exec(main)?.[0] ?? "";
    expect(menu, "openCardMenu is gone").not.toBe("");
    for (const op of ["pin", "archive", "delete"]) {
      expect(menu, `${op} is not reachable from the card menu`).toMatch(
        new RegExp(`"${op}"|'${op}'`),
      );
    }
    expect(html, "undo left the operation row").toMatch(/id="opundo"/);
    expect(menu, "undo was put in the menu").not.toMatch(/runUndo/);
  });

  it("the theme override agrees with the stylesheet in three separate places", () => {
    const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
    const theme = readFileSync(new URL("../app/theme.ts", import.meta.url), "utf8");

    const key = /THEME_KEY = "([^"]+)"/.exec(theme)?.[1];
    expect(key, "app/theme.ts no longer exports a key").toBeDefined();
    expect(html, `the inline script does not read ${String(key)}`).toContain(
      `localStorage.getItem("${String(key)}")`,
    );

    const chrome = /CHROME = \{ light: "(#[0-9A-Fa-f]{6})", dark: "(#[0-9A-Fa-f]{6})" \}/.exec(
      theme,
    );
    expect(chrome, "app/theme.ts no longer declares CHROME").not.toBeNull();
    expect((chrome?.[1] ?? "").toLowerCase()).toBe(resolve("--paper", light).toLowerCase());
    expect((chrome?.[2] ?? "").toLowerCase()).toBe(resolve("--paper", dark).toLowerCase());

    for (const colour of [chrome?.[1], chrome?.[2]]) {
      expect(html, `the inline script does not force ${String(colour)}`).toContain(
        String(colour),
      );
    }
  });

  it("the stylesheet can actually be overruled in BOTH directions", () => {
    expect(css, "a forced light cannot overrule a dark device").toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/,
    );
    expect(css, "a forced dark cannot overrule a light device").toMatch(
      /:root\[data-theme="dark"\] \{/,
    );
  });

  it("contributes nothing to the layout until the rail stands", () => {
    expect(/:root \{[\s\S]*?--rail-w:\s*0px;/.exec(css)).not.toBeNull();
  });
});

describe("the drawing canvas is measured, so its box must not lie", () => {
  function properties(selector: string): string[] {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `${selector} has no rule in app/style.css`).toBeGreaterThan(-1);
    const open = css.indexOf("{", at);
    return css
      .slice(open + 1, css.indexOf("}", open))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";")
      .map((declaration) => declaration.split(":")[0]?.trim().toLowerCase() ?? "")
      .filter((name) => name !== "");
  }

  it("declares no border and no padding — both move the box it is measured by", () => {
    const declared = properties(".hashigo-draw");
    const forbidden = declared.filter(
      (name) => name === "border" || name.startsWith("border-") || name === "padding" || name.startsWith("padding-"),
    );
    expect(
      forbidden,
      `.hashigo-draw declares ${forbidden.join(", ")}. That makes ` +
        "getBoundingClientRect (the border box, which attachDraw measures and " +
        "pointOf offsets from) disagree with the canvas's own drawing surface " +
        "(the content box), so strokes land off the finger. Use outline.",
    ).toEqual([]);
  });

  it("still HAS a frame — the repair was not simply deleting the border", () => {
    expect(properties(".hashigo-draw")).toContain("outline");
  });
});

describe("card text wraps even when nothing offers a break", () => {
  function declarations(selector: string): Map<string, string> {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `${selector} has no rule in app/style.css`).toBeGreaterThan(-1);
    const open = css.indexOf("{", at);
    const out = new Map<string, string>();
    for (const part of css
      .slice(open + 1, css.indexOf("}", open))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      out.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim().toLowerCase());
    }
    return out;
  }

  it("breaks a run that would otherwise overflow the column", () => {
    expect(declarations(".hashigo-side").get("overflow-wrap")).toBe("break-word");
  });

  it("does NOT reach for `anywhere`, which would break ordinary words too", () => {
    const wrap = declarations(".hashigo-side").get("overflow-wrap");
    expect(wrap).not.toBe("anywhere");
  });

  it("leaves white-space alone — the fault was never a nowrap", () => {
    expect(declarations(".hashigo-side").has("white-space")).toBe(false);
  });
});
