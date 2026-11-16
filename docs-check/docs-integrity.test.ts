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

describe("the decision numbering, which is cited by number across the repo", () => {
  it("DECISIONS.md is 1..N, sequential, no duplicates, no gaps", () => {
    const found = numbers(read("DECISIONS.md"));
    expect(found.length).toBeGreaterThan(20);
    expect(found).toEqual(Array.from({ length: found.length }, (_, i) => i + 1));
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
});
