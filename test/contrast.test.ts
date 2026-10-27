/**
 * Every colour this app puts text in, measured — in BOTH themes.
 *
 * ─── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * Decision 32 repointed the palette at the token layer, which is what made a
 * 268-rule restyle tractable. It also made one mistake possible and then made
 * it: `--ok` was repointed to `var(--card)` for the two grade buttons, but
 * `--ok` was never only the grade buttons — it was also the create button, the
 * boot log, the edit status and the ANSWER VERDICT on the 数字 deck. Near-white
 * text on paper. Zach found it because the create button vanished entirely;
 * everything else had gone quiet rather than invisible, which is worse.
 *
 * A token can be repointed in one line and break twenty rules in surfaces
 * nobody has open. `app/style.css`'s own header has said from the beginning that
 * contrast here is a CORRECTNESS constraint rather than a preference — every
 * grey in that file carries a Japanese reading at some point, and a low-contrast
 * furigana at 12px on a phone in daylight is not a readable card.
 *
 * So: resolve the token table for light and dark, and require every token that
 * is ever used as a foreground to clear AA on every ground it could land on.
 * The exceptions are named, with the reason, and there are three.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../app/style.css", import.meta.url), "utf8");

// ─── the three grounds most things sit on ───────────────────────────────────
const GROUNDS = ["--paper", "--paper-sunk", "--card"] as const;

/**
 * Foregrounds that do NOT land on the paper grounds, with where they do land.
 *
 * `--card` is the label on a FILLED button and nothing else — verified: every
 * `color: var(--card)` in the stylesheet sits in a rule that also sets a solid
 * `background`. Indigo for the grade and reveal buttons; `--danger` since
 * 2026-09-12 for `record` while the microphone is open, which is the one state
 * here that must not be mistakable for a button that is merely selected.
 * Checking `--card` against paper would be checking a pairing that never occurs,
 * and would force a wrong "fix".
 */
const ON_INSTEAD: Record<string, readonly string[]> = {
  "--card": ["--indigo", "--indigo-deep", "--danger"],
  // Decision 57: the replay disc's icon, and it sits on the ruri fill only.
  "--on-live": ["--vermilion"],
};

/**
 * Tokens that are deliberately NOT AA-for-small-text, each for a stated reason.
 * Adding to this list is a decision; it should need a sentence.
 */
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

/** Parse one `:root`-ish block into a token map. */
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

/** Resolve a token through any chain of `var()` to a literal hex. */
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

/** Every token the stylesheet ever assigns to `color:`. */
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
    // The list is prose as much as code: an entry for a deleted token is a
    // reason nobody can check. It does NOT require the token to be a
    // foreground — `--hair`, `--edge` and `--vermilion` are on the list
    // precisely because they must never be one.
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
    // The regression: repointing these at the primary colour removed the signal
    // from the answer verdict, the boot log and every `.danger` control.
    for (const table of [light, dark]) {
      expect(resolve("--ok", table)).toBe(resolve("--good", table));
      expect(resolve("--no", table)).toBe(resolve("--danger", table));
      expect(resolve("--ok", table)).not.toBe(resolve("--indigo", table));
      expect(resolve("--no", table)).not.toBe(resolve("--indigo", table));
    }
  });

  it("the answer verdict keeps a NON-COLOUR signal, because the pair is isoluminant", () => {
    // Measured: --good and --danger sit at ~1.00:1 against each other in light,
    // which is by construction (both are the same AA distance from the same
    // grounds). A deuteranope cannot separate them by hue OR by lightness, so
    // the border treatment is what actually carries the verdict.
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
    // It read `--ok` from when that meant green, and went invisible when `--ok`
    // was repointed. It is solid indigo now, like `remembered`.
    const rule = /\.newcard-submit\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/background:\s*var\(--indigo\)/);
    expect(rule?.[1]).not.toMatch(/var\(--ok/);
  });
});

/**
 * A dead-end state has to name its exit.
 *
 * Reported by Zach 2026-09-12: he tapped the right arrow, landed in look-ahead,
 * and found `remembered` did nothing. The banner said what could NOT be done and
 * said nothing about how to leave — and `remembered`, being a solid fill at 0.4
 * opacity, still looked pressable. Two separate failures adding up to "the app
 * is broken".
 *
 * The grading lock itself is CORRECT and must stay: grading while the offset is
 * not zero would write a grade against a different card from the one on screen,
 * which is silent corruption of the study history. So the fix is the exit and
 * the affordance, never the lock.
 */
describe("look-ahead says how to get out of it", () => {
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("../app/main.ts", import.meta.url), "utf8");

  it("the peek banner carries a real exit control", () => {
    const banner = /<div id="peek"[\s\S]*?<\/div>/.exec(html);
    expect(banner, "#peek is not in index.html").not.toBeNull();
    expect(banner?.[0], "the look-ahead banner has no exit button").toMatch(/id="peekback"/);
  });

  it("the exit returns to the session cursor, not one step back", () => {
    // One tap out from ANY offset. Stepping back with the arrow costs as many
    // presses as he took forward, which is the wrong shape for "get me out".
    const handler = /el\("peekback"\)\.addEventListener\([\s\S]{0,220}?\}\);/.exec(main);
    expect(handler, "#peekback is never wired up").not.toBeNull();
    expect(handler?.[0]).toMatch(/showSessionCard/);
  });

  it("grading a card he arrowed to sends the OFFSET, so it cannot hit the wrong one", () => {
    // The old safety property was "grading is locked while the offset is not
    // zero". That was protecting a real hazard — `answer()` writes to
    // `plan[cursor]` — but by disabling the app rather than fixing the cause.
    // Zach, 2026-09-12: "not stuck like this". The property is now stronger: the
    // offset travels with the grade and `answerAt` swaps the target into the
    // cursor, so the card he read IS the card graded. If this regresses, a grade
    // lands on a different card than the one on screen — silently.
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
    // A silent no-op is exactly what made the old look-ahead read as broken.
    expect(main).toMatch(/reply\.refused !== null/);
    expect(main).toMatch(/REFUSAL\[reply\.refused\]/);
  });

  it("a disabled grade button does not look pressable", () => {
    // It was `opacity: 0.4` on a solid fill, which still reads as a button.
    const rule = /\.bar button\[disabled\]\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1], ".bar button[disabled] is gone").toBeDefined();
    expect(rule?.[1]).toMatch(/background:\s*none/);
    expect(rule?.[1]).toMatch(/cursor:\s*not-allowed/);
  });
});

// ─── text on a FILLED ground, which is where the check had a hole ───────────

/**
 * ZACH, 2026-09-12, over a screenshot of the reveal button under his cursor:
 * *"`space` is a little hard to read don't you think? is there any other place
 * that suffers like this?"*
 *
 * He was right, and the honest answer to the second half was yes — including one
 * worse than the one he found.
 *
 * **WHY THE EXISTING TESTS ABOVE COULD NOT SEE IT.** They check every foreground
 * token against the three PAPER grounds. That is the right check for a card, and
 * it is blind to the case where an element paints itself a non-paper background
 * and its CHILDREN keep their own colour. `.kbd` was `var(--muted)` — a grey
 * chosen against paper — sitting inside buttons that fill solid indigo:
 *
 *     --muted on --indigo         1.76:1 light   1.05:1 dark
 *     --muted on --indigo-deep    2.31:1 light   1.50:1 dark
 *
 * 1.05:1 is the same luminance. Not dim — gone. And `.ok` (remembered) is a
 * solid fill AT REST, so its `j` hint failed permanently, not only under a
 * cursor; his screenshot happened to catch the hover case on `reveal`.
 *
 * A third, found by the same sweep and unrelated to keycaps: `.menu-item i` and
 * `.link-item i` are `--muted` subtitles on rows whose hover background was
 * `var(--line)` — the HAIRLINE token used as a surface — at 4.04:1 in light.
 * `.link-item i` is the deck path, which is how he tells two cards with the same
 * head word apart.
 *
 * So this block pins the pairings that actually occur on a filled ground, and
 * two structural rules that stop the class coming back rather than the instance.
 */
describe("text that lands on a FILLED ground, not on paper", () => {
  /** Foreground, ground, and where the pairing occurs. All measured, not guessed. */
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
    // THE STRUCTURAL HALF, and it is the one with teeth. Any fixed colour is
    // wrong for at least one of the grounds `.kbd` lands on, because it lands on
    // paper AND on solid indigo — so the rule is `inherit`, and a future control
    // that fills in some new state cannot reintroduce the defect.
    for (const name of ["kbd", "kbd-inline"]) {
      const rules = [...css.matchAll(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`, "g"))]
        .map((m) => m[1] as string)
        .join("\n");
      expect(rules, `.${name} has no rule at all`).not.toBe("");
      expect(rules, `.${name} must not pin a colour token`).not.toMatch(/color:\s*var\(/);
    }
    // And `.kbd` really does say inherit somewhere, rather than simply omitting
    // colour — omitting it would pass the check above and still be correct, but
    // saying it is what makes the intent survive the next edit.
    expect(css).toMatch(/\.kbd\s*\{[^}]*color:\s*inherit/);
  });

  it("the 0.85 hint floor is checked against the ground, not inherited as a number", () => {
    // DECISION 38 MEASURED 0.85 AGAINST INDIGO. That is where it came from, and
    // it does not travel: `record` fills `--danger`, which is LIGHTER than
    // indigo in dark mode, so the same 0.85 composites to under AA there. The
    // rule opts that one button out, and this is the arithmetic that says why —
    // if someone "tidies" the opt-out away, the number below fails first.
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
    // Full strength does clear it, which is the reason the opt-out is 1 and not
    // some other number.
    expect(ratio(resolve("--card", dark), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it("decision 19: a keycap hint never renders where there is no keyboard", () => {
    // `.kbd-inline` had NO rule at all, so it showed on his phone — naming keys
    // that device does not have. Both forms must be behind the pointer query.
    const guarded = /@media \(hover: hover\) and \(pointer: fine\) \{([\s\S]*?)\n\}/g;
    const inside = [...css.matchAll(guarded)].map((m) => m[1] as string).join("\n");
    for (const name of ["kbd", "kbd-inline"]) {
      expect(inside, `.${name} is not behind the pointer query`).toMatch(
        new RegExp(`\\.${name}\\s*\\{`),
      );
    }
  });

  it("the hairline token is never a surface UNDER TEXT", () => {
    // `--line` / `--hair` are declared "1px rules and borders only" by
    // NOT_BODY_TEXT above. Using one as a background is the same category error
    // from the other side, and it is what put a --muted subtitle at 4.04:1.
    //
    // The exceptions are named with their reason, the way NOT_BODY_TEXT is.
    // Adding one should need a sentence.
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

// ─── the reset zeroes everything; what puts it back? ────────────────────────

/**
 * ZACH, 2026-09-12, over a 意味 side reading `1. moving out (to)` / `2. transfer
 * (to a new post)`: *"the definition padding is still weird"*.
 *
 * There was no list rule AT ALL. `* { padding: 0 }` at the top of `style.css` is
 * correct and deliberate — but a list with no padding still renders its markers
 * `outside`, so the `1.` and `2.` hung to the LEFT of the text column, into the
 * card's own padding, aligned with nothing else on the card. **1,424 field values
 * in the corpus are lists**, so that was most 意味 sides.
 *
 * The same reset had also left `<table>` with zero cell padding and no borders —
 * one card, which rendered as run-together text — and `<pre>` bare, which nothing
 * uses (0 code fences in the corpus).
 *
 * So the rule is structural, and it reads the RENDERER rather than a list written
 * here: every block element `src/render/nodes.ts` can emit must have a
 * `.hashigo-side` rule behind it. A renderer that learns a new element fails this
 * until the stylesheet catches up, which is the only moment anyone would think to
 * look.
 */
describe("every block element the renderer emits has a rule behind the reset", () => {
  const nodes = readFileSync(new URL("../src/render/nodes.ts", import.meta.url), "utf8");

  /**
   * Inline elements and structural wrappers that inherit everything they need.
   * Each is named because "it does not need a rule" is a claim, not an omission.
   */
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
    // Every tag name inside a `context.element(...)` call — which covers both the
    // literal form and the ternary one (`node.ordered ? "ol" : "ul"`). Scoped to
    // the call, so that unrelated string ternaries elsewhere in the file cannot
    // masquerade as elements; an earlier version matched `"image"` and `"inline"`
    // out of a media-kind ternary and reported them as unstyled.
    for (const call of nodes.matchAll(/\bcontext\.element\(([^)]*)\)/g)) {
      for (const arg of (call[1] as string).matchAll(/"([a-z0-9]+)"/g)) {
        const tag = arg[1] as string;
        // `element(tag, className)` — a class name is not an element.
        if (!tag.startsWith("hashigo-")) emitted.add(tag);
      }
    }
    expect(emitted.size, "found no emitted elements — the pattern stopped matching").toBeGreaterThan(
      8,
    );
    // The two the bug was about must be in there, or this test proves nothing.
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
    // The actual defect: with no padding and `list-style-position: outside`, the
    // marker paints left of the content box — outside the column every other
    // block on the card lines up with.
    const rule = /\.hashigo-side ol,\s*\.hashigo-side ul \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule, "no rule for lists on a card").not.toBe("");
    const padding = /padding-left:\s*([\d.]+)em/.exec(rule)?.[1];
    expect(padding, "list padding must be in em, so it tracks the type size").toBeDefined();
    expect(Number(padding)).toBeGreaterThanOrEqual(1);
  });

  it("a table on a card has cell padding and rules", () => {
    // One card in the corpus, and it rendered as run-together text.
    const cells = /\.hashigo-side th,\s*\.hashigo-side td \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(cells, "no rule for table cells on a card").not.toBe("");
    expect(cells).toMatch(/padding:/);
    expect(cells).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(/\.hashigo-side table \{([^}]*)\}/.exec(css)?.[1]).toMatch(
      /border-collapse:\s*collapse/,
    );
  });
});

// ─── the rail takes room out of the layout; `position: fixed` does not know ──

/**
 * ZACH, 2026-09-12, on a mockup another session had built: *"what about the rest
 * of the aestheticness of the design that we don't have yet?"* The answer turned
 * out to be measurable — `app/style.css` had NO width breakpoint above 640px, so
 * the review screen was a phone column stretched across a laptop. The fix is a
 * standing rail at ≥1024px, and `body { padding-left: var(--rail-w) }` carries
 * everything in normal flow.
 *
 * IT CANNOT CARRY `position: fixed`, WHICH RESOLVES AGAINST THE VIEWPORT. Those
 * rules have to be handled one at a time — and they do NOT all want the same
 * thing, which is the reason this is a classification and not an allowlist:
 * `.layer` is `inset: 0` precisely so a preview's scrim covers the rail, and a
 * modal that leaves the deck list live behind it is not modal.
 *
 * ─── THIS TEST EXISTS BECAUSE THE ENUMERATION WAS ALREADY WRONG ─────────────
 *
 * The first draft of the change listed `.banner`, `.sidebar-scrim` and `#layers`
 * as needing the offset — `.banner` is not even positioned — and gave `.say` a
 * formula that ignored both `left: 50%` and a `max-width` measured against the
 * viewport. Four of five entries wrong before a line was written. A new fixed
 * element added later would land under the rail in silence.
 *
 * `contain: layout` on a stage wrapper was the alternative, and it needs no test
 * at all: fixed descendants resolve against the stage instead. Rejected — it
 * confines `.layer` too, with no way to opt out.
 */
describe("every position: fixed rule has an answer for the rail", () => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

  interface Rule {
    readonly selector: string;
    readonly decls: Map<string, string>;
  }

  const rules: Rule[] = [];
  for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] as string).trim();
    // An at-rule prelude (`@media …`) reaches here only when its block is empty,
    // which is not a rule. Nested blocks are matched innermost-first, so the
    // rules inside a media query arrive with their own selector and no prelude.
    if (selector.startsWith("@")) continue;
    const decls = new Map<string, string>();
    for (const part of (match[2] as string).split(";")) {
      const at = part.indexOf(":");
      if (at === -1) continue;
      decls.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
    for (const one of selector.split(",")) rules.push({ selector: one.trim(), decls });
  }

  /** Selectors that deliberately span the whole viewport, rail included. */
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

  /** The rail itself. Offsetting it by its own width is the obvious own-goal. */
  const RAIL = ".sidebar";

  it("classifies, and knows of no fixed rule it cannot place", () => {
    const fixed = rules.filter((rule) => rule.decls.get("position") === "fixed");
    // If the parser stops finding rules this test passes while measuring nothing.
    expect(fixed.length, "no position: fixed rules found — the parser broke").toBeGreaterThan(4);

    const unplaced: string[] = [];
    for (const rule of fixed) {
      if (rule.selector === RAIL) continue;
      if (rule.selector in OVERLAY) continue;
      // Anchored to the right edge, which the rail cannot reach. `.replay` is
      // this, and decision 23 keeps it in that corner on both surfaces.
      const left = rule.decls.get("left") ?? rule.decls.get("inset");
      if (left === undefined && rule.decls.has("right")) continue;
      // Offset: SOME rule for this selector speaks `--rail-w`. It lives in the
      // media query rather than here, which is why this looks at every rule for
      // the selector and not only at the fixed one.
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
    // `.say` is the one the first draft got wrong: `left: 50%` is the VIEWPORT's
    // middle and `max-width: 100%` its width, so a flat `left: var(--rail-w)`
    // would have pushed it off-centre and left it too wide.
    const desktop = /@media \(min-width: 1024px\) \{([\s\S]*)\}/.exec(css)?.[1] ?? "";
    expect(desktop, "no ≥1024px block in the stylesheet").not.toBe("");
    expect(desktop).toMatch(/\.footer \{[^}]*left:\s*var\(--rail-w\)/);
    expect(desktop).toMatch(/\.say \{[^}]*left:\s*calc\(50% \+ var\(--rail-w\) \/ 2\)/);
    expect(desktop).toMatch(/\.say \{[^}]*max-width:\s*calc\(100% - var\(--rail-w\)/);
  });

  it("lines the footer's controls up with the card column, DERIVED not retyped", () => {
    // `.ops` and `.bar` are flex rows of `flex: 1` children, which is right on a
    // phone where the row IS the thumb target and wrong at 1110px: four buttons
    // split it into 267px each and `reveal` becomes a slab floating under a
    // 720px card. They are inset to the card's own text column instead.
    //
    // THE NUMBER IS READ OUT OF `main` RATHER THAN TRUSTED. Two places holding
    // the same measure is how the controls end up a few pixels off the text
    // above them — visible, and unattributable to any one change.
    const mainRule = /\.review main \{([^}]*)\}/.exec(css)?.[1] ?? "";
    const box = Number(/max-width:\s*(\d+)px/.exec(mainRule)?.[1]);
    const pad = Number(/padding:\s*\d+px\s+(\d+)px/.exec(mainRule)?.[1]);
    expect(box, "cannot read the card column's width").toBeGreaterThan(0);
    expect(pad, "cannot read the card column's padding").toBeGreaterThan(0);

    const desktop = /@media \(min-width: 1024px\) \{([\s\S]*)\}/.exec(css)?.[1] ?? "";
    const inset = /([^{}]+)\{[^}]*padding-inline:\s*max\([^,]+,\s*calc\(\(100% - (\d+)px\)/.exec(
      desktop,
    );
    // EVERY footer row, not only the two that existed when this was written. A
    // row left out sits at the window's width under a column of text — which is
    // how the shadowing row would have landed if this only named `.ops` and
    // `.bar`.
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
    // Zach's rule is that every 操作 on the desktop exists on mobile AS A BUTTON,
    // not only as a shortcut — so moving pin/archive/delete behind `⋯` is only
    // legal while the handle and its menu both exist. If the menu ever loses one,
    // that operation becomes desktop-keyboard-only and he cannot do it on the
    // phone, which is where he reviews.
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
    // UNDO STAYS OUT. It is the safety net, and the thing you reach for when
    // something has already gone wrong does not belong behind two taps.
    expect(html, "undo left the operation row").toMatch(/id="opundo"/);
    expect(menu, "undo was put in the menu").not.toMatch(/runUndo/);
  });

  it("the theme override agrees with the stylesheet in three separate places", () => {
    // FOUR LINES OF THE THEME LIVE IN `index.html`'s <head>, inline, because
    // `main.ts` is a module script and runs too late to stop the boot screen
    // flashing the wrong ground. Duplication bought on purpose — so the three
    // copies are pinned against each other here rather than trusted.
    const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
    const theme = readFileSync(new URL("../app/theme.ts", import.meta.url), "utf8");

    // 1. the storage key.
    const key = /THEME_KEY = "([^"]+)"/.exec(theme)?.[1];
    expect(key, "app/theme.ts no longer exports a key").toBeDefined();
    expect(html, `the inline script does not read ${String(key)}`).toContain(
      `localStorage.getItem("${String(key)}")`,
    );

    // 2. the chrome colours ARE `--paper` in each theme. `<meta>` cannot read a
    //    custom property — the phone paints its chrome before any CSS resolves —
    //    so these are hand-copied, which is exactly why they need checking.
    const chrome = /CHROME = \{ light: "(#[0-9A-Fa-f]{6})", dark: "(#[0-9A-Fa-f]{6})" \}/.exec(
      theme,
    );
    expect(chrome, "app/theme.ts no longer declares CHROME").not.toBeNull();
    expect((chrome?.[1] ?? "").toLowerCase()).toBe(resolve("--paper", light).toLowerCase());
    expect((chrome?.[2] ?? "").toLowerCase()).toBe(resolve("--paper", dark).toLowerCase());

    // 3. and the inline script forces the same two.
    for (const colour of [chrome?.[1], chrome?.[2]]) {
      expect(html, `the inline script does not force ${String(colour)}`).toContain(
        String(colour),
      );
    }
  });

  it("the stylesheet can actually be overruled in BOTH directions", () => {
    // The media block is guarded `:not([data-theme="light"])` so a forced light
    // wins on a dark device, and `[data-theme="dark"]` exists so a forced dark
    // wins on a light one. Only one of the two is obvious; a stylesheet with the
    // media block alone would make the picker work in one direction and silently
    // not the other.
    expect(css, "a forced light cannot overrule a dark device").toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/,
    );
    expect(css, "a forced dark cannot overrule a light device").toMatch(
      /:root\[data-theme="dark"\] \{/,
    );
  });

  it("contributes nothing to the layout until the rail stands", () => {
    // The whole design: one token, zero by default, so every `--rail-w` above is
    // correct at phone width without a second media query to keep in step.
    expect(/:root \{[\s\S]*?--rail-w:\s*0px;/.exec(css)).not.toBeNull();
  });
});

/**
 * ─── THE DRAWING CANVAS MAY NOT CARRY A BORDER OR PADDING ───────────────────
 *
 * Not a style rule — a correctness one, and it has already cost a real defect.
 *
 * `attachDraw` sizes the backing store from `getBoundingClientRect()` and
 * `pointOf` offsets every point from `rect.left/top`. Both are the BORDER box; a
 * canvas draws into its CONTENT box. With this file's global
 * `box-sizing: border-box`, a 1px border made the two disagree — measured live on
 * a real 漢字 card, rect 498x400 against a content box of 496x398 — so every
 * stroke was scaled by 498/496 and displaced one CSS pixel up and left of the
 * finger, drifting about 2px by the bottom of the canvas.
 *
 * `draw.ts`'s header names the fix ("give the canvas no border and no padding,
 * draw the frame on a wrapper instead") and `outline` supplies it without a
 * wrapper, because an outline participates in no layout at all.
 *
 * This reads the STYLESHEET rather than trusting that comment, because the border
 * was added later by someone who had no reason to know any of the above.
 */
describe("the drawing canvas is measured, so its box must not lie", () => {
  /**
   * The PROPERTY NAMES a rule declares.
   *
   * Names rather than a regex over the text, deliberately: the first version of
   * this built a `new RegExp` from a template literal, the backslashes did not
   * survive being written to disk, and the test passed with the very border it
   * exists to forbid. A guard that cannot fail is worse than no guard, so this
   * splits on `;` and compares strings, which has nothing to escape.
   */
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
    // Every longhand and shorthand that adds to the box. `outline` is absent
    // from this list on purpose: it is the one frame that costs no space.
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

// ─── a run with no break opportunity still has to break ─────────────────────

/**
 * ZACH, 2026-09-18, over 習慣 on his phone: *"this is outrageous lol"*.
 *
 * The card's emoji line was `🔄🕰️` followed by `🔁` twenty-nine times, and it ran
 * clean off the screen — the whole page scrolled sideways, header included.
 *
 * MEASURED IN CHROMIUM at 375px rather than guessed: the `<h4>` holding it
 * reported `scrollWidth` **1709** inside a **317px** card. Nothing in the
 * stylesheet was setting `nowrap` — every element in the chain computed
 * `white-space: normal` and `overflow-wrap: normal`, and that is the whole
 * story. `normal` means "break only where a break is allowed", and a wall of
 * emoji offers nowhere. Adding `overflow-wrap: break-word` to `.hashigo-side`
 * took the same element to **317**.
 *
 * SO THIS IS NOT AN EMOJI RULE. It is the general one: any long unbreakable run
 * — a URL, a pasted token, a Latin word longer than the column — did this, and
 * the emoji case is only the one he happened to meet.
 *
 * The content behind it is a separate fault and is NOT fixed by this: **250 of
 * the 17,228 `ai` generations are one character repeated**, 35 of them to the
 * 128-character ceiling, and 246 of those arrived with the 2026-09-08 Mochi
 * import rather than being made here. 習慣's own ends mid-emoji on a lone high
 * surrogate. Regenerating is his call and comes after the app is finished.
 */
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
    // Both repair the measured case. `anywhere` also participates in intrinsic
    // sizing and will split a Latin word mid-word when a narrower line would
    // have done, so it buys nothing here and costs the typography.
    const wrap = declarations(".hashigo-side").get("overflow-wrap");
    expect(wrap).not.toBe("anywhere");
  });

  it("leaves white-space alone — the fault was never a nowrap", () => {
    // Stated because the obvious wrong repair is `white-space: normal !important`
    // somewhere, chasing a nowrap that does not exist. Every element in the
    // measured chain already computed `normal`.
    expect(declarations(".hashigo-side").has("white-space")).toBe(false);
  });
});
