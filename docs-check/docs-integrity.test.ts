import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

function read(name: string): string {
  return readFileSync(join(ROOT, name), "utf8");
}

function numbers(markdown: string): number[] {
  return [...markdown.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
}

function claudeDecisionSection(): string {
  const text = read("CLAUDE.md");
  const start = text.indexOf("## Decisions — the current design");
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
    const found = numbers(read("DECISIONS.md"));
    expect(found.length).toBeGreaterThan(20);
    expect(found).toEqual(Array.from({ length: found.length }, (_, i) => i + 1));
  });

  it("both files carry the SAME number of decisions", () => {
    const index = numbers(claudeDecisionSection());
    const reasons = numbers(read("DECISIONS.md"));
    expect(
      reasons.length,
      `CLAUDE.md has ${index.length} decisions, DECISIONS.md has ${reasons.length} — ` +
        "every decision needs its WHY, and every WHY needs an index line",
    ).toBe(index.length);
  });

  it("the highest-numbered decisions are still THERE, not just numbered", () => {
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
    const claude = read("CLAUDE.md");
    expect(claude).toContain("ON A `Reading = true` CARD");
    expect(claude, "the amendment warning is what a fresh session reads first").toMatch(
      /AMENDED 2026-08-23/,
    );
  });
});
