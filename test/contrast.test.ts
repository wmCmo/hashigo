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
