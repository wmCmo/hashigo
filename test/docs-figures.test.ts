import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/schema/index.js";

/**
 * THE DOCS' *DURABLE* FIGURES ARE ACCURATE. THE *VOLATILE* ONES ROT, SILENTLY.
 *
 * `test/docs-integrity.test.ts` watches the decision NUMBERING, because a markdown
 * formatter renumbered it once. This file watches the FIGURES, because nothing did.
 *
 * The distinction is worth stating, because it was measured rather than assumed
 * (2026-08-25, against `build/hashigo.db` and the real export):
 *
 *   decision 27  2,092 平板 + 56 尾高 = 2,148 of 3,830    EXACT (1965+127, 48+8)
 *   decision 29  692 / 2,785 / 392 / 3,177 / 3,869        EXACT, every one
 *   accents      3,850 openjtalk · 3,015 unidic · 33 manual   EXACT
 *   corpus       7,716 cards · 102,020 reviews            EXACT
 *   85 path references across the four top-level docs      ALL EXIST
 *
 * So this is not a suite that distrusts the documentation. Those numbers are
 * derived from data that does not move, by people who measured them, and they have
 * held. What rots is the handful of figures that change every time someone adds a
 * test, an export subpath, or a decision — and those are exactly the figures a cold
 * session uses to decide whether it is looking at a current file or a stale one.
 *
 * Caught on the day this file was written, by these assertions:
 *   - CLAUDE.md and NEXT.md both said `757 passed`. The real count was 767.
 *   - NEXT.md said "There are 22 decisions". There were 31.
 *
 * Neither is dangerous on its own. Together they are the thing that makes a reader
 * stop trusting the file, and once that trust goes the accurate 95% goes with it.
 *
 * WHAT THIS DOES NOT DO. It does not check prose, reasoning, or any figure derived
 * from the corpus — those need `exports/` and a built database, they are already
 * pinned by the suites that measure them, and they do not drift. It checks the
 * figures that a routine change invalidates, plus every path and npm script the
 * docs tell you to use. Nothing here needs the corpus, so it all runs in a bare
 * clone.
 */

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = ["CLAUDE.md", "NEXT.md", "DECISIONS.md", "app/README.md"] as const;

function read(name: string): string {
  return readFileSync(join(ROOT, name), "utf8");
}

/**
 * NEXT.md keeps everything below this heading as a deliberate record of what was
 * true at the time, so its figures are allowed to be old. Only the live half is
 * held to the present. CLAUDE.md has no such split; all of it is live.
 */
function liveHalf(name: string): string {
  const text = read(name);
  if (name !== "NEXT.md") return text;
  const cut = text.indexOf("## The record below this line is HISTORY");
  expect(cut, "NEXT.md lost its HISTORY boundary — the live/record split is gone").toBeGreaterThan(
    -1,
  );
  return text.slice(0, cut);
}

describe("the figures a routine change invalidates", () => {
  it("every stated test-file count is the real number of test files", () => {
    const real = countTestFiles();
    const claims = [...liveHalf("CLAUDE.md").matchAll(/(\d+) files, [\d,]+ passed/g)].map((m) =>
      Number(m[1]),
    );
    const nextClaims = [...liveHalf("NEXT.md").matchAll(/(\d+) files \/ [\d,]+ passed/g)].map((m) =>
      Number(m[1]),
    );
    const all = [...claims, ...nextClaims];
    expect(all.length, "no test-file-count claim found — did the phrasing change?").toBeGreaterThan(
      0,
    );
    for (const claimed of all) {
      expect(
        claimed,
        `a doc claims ${claimed} test files; there are ${real}. Update the docs or this test.`,
      ).toBe(real);
    }
  });

  it("every stated passing-test count agrees with every other one", () => {
    // The absolute number cannot be checked without running the suite, and running
    // the suite from inside the suite is not a thing. What CAN be checked is that
    // the live documents agree with each other — the failure that actually happened
    // was CLAUDE.md and NEXT.md drifting apart from the truth together, but they
    // have also drifted apart from EACH OTHER before (734 vs 757).
    const counts = new Set<number>();
    for (const doc of ["CLAUDE.md", "NEXT.md"]) {
      for (const m of liveHalf(doc).matchAll(/([\d,]{3,}) passed/g)) {
        counts.add(Number(m[1]!.replace(/,/g, "")));
      }
    }
    expect(
      [...counts],
      `the live docs quote ${counts.size} different passing-test counts: ${[...counts].join(", ")}`,
    ).toHaveLength(1);
  });

  it("the stated SCHEMA_VERSION is the real one", () => {
    const claims = [...read("CLAUDE.md").matchAll(/`SCHEMA_VERSION` is \*\*(\d+)\*\*/g)].map((m) =>
      Number(m[1]),
    );
    expect(claims.length, "CLAUDE.md no longer states SCHEMA_VERSION").toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(SCHEMA_VERSION);
  });

  it("the stated export-subpath count is the real one", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    const real = Object.keys(pkg.exports).filter((k) => k !== "./package.json").length;
    const claims = [...read("CLAUDE.md").matchAll(/\((\d+) export subpaths\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(claims.length, "CLAUDE.md no longer states the export-subpath count").toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(real);
  });

  it("any stated decision count is the real one", () => {
    const real = [...read("DECISIONS.md").matchAll(/^(\d+)\. /gm)].length;
    // Deliberately scans the WHOLE of NEXT.md, history included: "There are N
    // decisions; read them before proposing anything" is an instruction to the
    // reader wherever it sits, and a low N means a cold session under-reads.
    const claims = [
      ...`${read("CLAUDE.md")}\n${read("NEXT.md")}`.matchAll(
        /There are (\d+) decisions|all (\d+) decisions/g,
      ),
    ].map((m) => Number(m[1] ?? m[2]));
    for (const claimed of claims) {
      expect(
        claimed,
        `a doc says there are ${claimed} decisions; DECISIONS.md has ${real}`,
      ).toBe(real);
    }
  });
});

describe("everything the docs tell you to run or open", () => {
  it("every file path mentioned in the top-level docs exists", () => {
    // The largest class of documentation rot, and the cheapest to catch: a doc
    // pointing at a file that was renamed or deleted. Measured clean at 85 distinct
    // paths on 2026-08-25 — this keeps it that way.
    const missing: string[] = [];
    for (const doc of DOCS) {
      for (const m of read(doc).matchAll(/`([\w./-]+\.(?:ts|md|py|sql|mjs|html|json|jsonl|css))`/g)) {
        const path = m[1]!;
        if (!path.includes("/")) continue; // a bare filename is prose, not a pointer
        if (path.startsWith("dist/") || path.startsWith("build/")) continue; // generated
        if (path.startsWith("exports/")) continue; // gitignored, 657 MB of audio
        if (!existsSync(join(ROOT, path))) missing.push(`${doc} -> ${path}`);
      }
    }
    expect(missing, `docs point at files that do not exist:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("every `npm run <script>` mentioned in the docs is a real script", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const missing: string[] = [];
    for (const doc of DOCS) {
      for (const m of read(doc).matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
        const script = m[1]!;
        if (!(script in pkg.scripts)) missing.push(`${doc} -> npm run ${script}`);
      }
    }
    expect(missing, `docs name scripts that do not exist:\n  ${missing.join("\n  ")}`).toEqual([]);
  });
});

/**
 * Counted from disk rather than imported from a manifest on purpose: a manifest is
 * one more thing to forget to update, which is the bug this file exists to catch.
 */
function countTestFiles(): number {
  return readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.ts")).length;
}
