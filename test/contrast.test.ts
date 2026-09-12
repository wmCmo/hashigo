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
 * `color: var(--card)` in the stylesheet sits in a rule that also sets
 * `background: var(--indigo)`. Checking it against paper would be checking a
 * pairing that never occurs, and would force a wrong "fix".
 */
const ON_INSTEAD: Record<string, readonly string[]> = {
  "--card": ["--indigo", "--indigo-deep"],
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
