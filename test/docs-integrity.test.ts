import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE DECISION NUMBERING IS LOAD-BEARING, AND NOTHING WAS WATCHING IT.
 *
 * `CLAUDE.md` says it outright — "Numbering is cited across `src/`, `test/` and the
 * notes — never renumber, only append" — and 2026-08-23 it was renumbered anyway,
 * by a markdown formatter rather than by a person. Zach pressed Alt+Shift+F over
 * the docs, which is a completely reasonable thing to do to a markdown file, and
 * his editor rewrote `20.` `21.` `22.` `23.` as `1.` `2.` `3.` `4.` and then every
 * later entry as `1.` — because an ordered list interrupted by prose is, to a
 * formatter, several lists that each restart.
 *
 * **The damage was invisible to every gate.** `npm test` passed. `npm run
 * typecheck` passed. `npm run build` passed. Ten settled decisions had lost their
 * identities and the only reason it was caught is that someone happened to read
 * `git diff` before committing. That is not a control, that is luck.
 *
 * Nobody had told him not to format the docs, and telling him not to is a bad
 * fix: it makes a routine editor keystroke into a landmine and relies on memory
 * forever. So this test exists instead. Formatting the docs is now allowed to be
 * a mistake, because it is a CAUGHT mistake.
 *
 * WHAT THIS DOES NOT DO. It does not check that the decisions are correct, or that
 * the two files say the same thing about any decision — only that the numbers are
 * intact, sequential, and agree in count. That is the property a formatter breaks.
 */

const ROOT = resolve(import.meta.dirname, "..");

function read(name: string): string {
  return readFileSync(join(ROOT, name), "utf8");
}

/**
 * Top-level numbered items. Anchored to column 0 on purpose: a renumbered list
 * gets INDENTED by the formatter (` 1.` with a leading space), so requiring the
 * digit at the start of the line is itself part of the check — and the numbers
 * inside a decision's body are indented, so they are correctly ignored.
 */
function numbers(markdown: string): number[] {
  return [...markdown.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
}

/** CLAUDE.md has another numbered list (the four problems), so scope to the index. */
function claudeDecisionSection(): string {
  const text = read("CLAUDE.md");
  const start = text.indexOf("## Decisions that are settled");
  expect(start, "CLAUDE.md lost its decisions heading").toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("the decision numbering, which is cited by number across the repo", () => {
  it("CLAUDE.md's index is 1..N, sequential, no duplicates, no gaps", () => {
    const found = numbers(claudeDecisionSection());
    expect(found.length, "CLAUDE.md's decision index is empty — did a heading move?")
      .toBeGreaterThan(20);
    expect(found).toEqual(Array.from({ length: found.length }, (_, i) => i + 1));
  });

  it("DECISIONS.md is 1..N, sequential, no duplicates, no gaps", () => {
    // The exact failure of 2026-08-23: entries 20-29 became 1,2,3,4,1,1,1,1,1,1.
    // Note this file's 3-6 are NOT bold, so the pattern must not require `**`.
    const found = numbers(read("DECISIONS.md"));
    expect(found.length).toBeGreaterThan(20);
    expect(found).toEqual(Array.from({ length: found.length }, (_, i) => i + 1));
  });

  it("both files carry the SAME number of decisions", () => {
    // Appending to one and forgetting the other is the human version of this bug.
    const index = numbers(claudeDecisionSection());
    const reasons = numbers(read("DECISIONS.md"));
    expect(
      reasons.length,
      `CLAUDE.md has ${index.length} decisions, DECISIONS.md has ${reasons.length} — ` +
        "every decision needs its WHY, and every WHY needs an index line",
    ).toBe(index.length);
  });

  it("the highest-numbered decisions are still THERE, not just numbered", () => {
    // A formatter that truncated rather than renumbered would pass the checks
    // above with a shorter list. Anchor the newest few by content, since those
    // are the ones a fresh session is most likely to be missing.
    const decisions = read("DECISIONS.md");
    for (const anchor of [
      "`型` renders on SIDE 1 for `言葉` cards",
      "NO PARTICLE beside the word",
      "displays the way it was inputted",
      "CONDITIONAL on `Reading`",
    ]) {
      expect(decisions, `DECISIONS.md lost: ${anchor}`).toContain(anchor);
    }
  });

  it("the hard rule still says it is CONDITIONAL, not absolute", () => {
    // The most dangerous single sentence in the repo to get wrong. It was absolute
    // until 2026-08-23 and an agent acting on the old form would delete the
    // exercise on 692 cards, or ship autoplay on the 692 that must never have it.
    const claude = read("CLAUDE.md");
    expect(claude).toContain("ON A `Reading = true` CARD");
    expect(claude, "the amendment warning is what a fresh session reads first").toMatch(
      /AMENDED 2026-08-23/,
    );
  });
});
