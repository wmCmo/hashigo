import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE BROWSER-PORTABILITY PIN.
 *
 * `notes/browser-feasibility.md` measured that "the FSRS-6 port, the whole
 * template engine, the whole renderer pipeline and all the metrics are already
 * browser-ready", and called that the expensive part being free. That sentence
 * then went false and nothing noticed: `src/schema/index.ts` grew a
 * `import { readFileSync } from "node:fs"` and CALLED it at module scope, and
 * because the schema module is where the enumerations live, eleven value imports
 * reach it. Template, renderer, scheduler, generate and the dashboard metrics
 * were all unimportable in a worker, for a filesystem read none of them wanted.
 *
 * A single-file assertion would not have caught it, because the offending import
 * was not in any of those files. So this walks the actual transitive closure of
 * relative imports and fails on the first `node:` specifier it reaches.
 *
 * WHAT THIS DOES NOT CLAIM. Reaching zero `node:` imports is necessary for a
 * module to load in a worker, not sufficient — a bare specifier resolving to a
 * Node-only dependency (`better-sqlite3`) is equally fatal, which is why
 * `src/db/open.ts` is NOT an entry point here and `src/db/browser.ts` exists as
 * its sibling. This pins the property that regressed, and says so.
 */

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Entry points a browser worker must be able to import. Deliberately NOT
 * `src/db/open.ts` (better-sqlite3), `src/import/*` (node:crypto, node:fs) or
 * any `cli.ts` — those are declared Node-only seams, listed as such in
 * `notes/browser-feasibility.md` section 5.
 */
const BROWSER_ENTRY_POINTS = [
  "src/schema/index.ts",
  "src/template/index.ts",
  "src/render/index.ts",
  "src/render/reveal.ts",
  "src/render/audio.ts",
  "src/blobs/generation.ts",
  "src/cards/index.ts",
  "src/generate/index.ts",
  "src/scheduler/index.ts",
  "src/scheduler/policy.ts",
  "src/dashboard/metrics.ts",
  "src/text/index.ts",
  "src/search/index.ts",
  "src/accent/store.ts",
  "src/blobs/db.ts",
] as const;

/**
 * STILL NODE-BOUND, KNOWN, AND PINNED SO THE LIST CANNOT GROW QUIETLY.
 *
 * EMPTY as of 2026-08-22, and the entry that used to be here is worth keeping in
 * the record because the fix was not the one three documents predicted.
 *
 * `src/generate/index.ts` was listed, because `src/generate/store.ts`
 * value-imported `generationKey` from `src/import/blobs.ts`, whose digest was
 * `node:crypto`. `notes/browser-feasibility.md` §5 called the remedy "the one
 * genuinely invasive change" — `crypto.subtle.digest` is ASYNC, so the key, the
 * resolver and everything above them would change signature — and two sessions
 * carried that forward as the plan.
 *
 * It was obsolete. `src/blobs/sha256.ts` is a synchronous, dependency-free
 * SHA-256 written for exactly this, already the default digest of
 * `SqliteBlobStore`, already agreeing with `node:crypto` bit for bit on all
 * 10,816 corpus payloads. So the key moved to `src/blobs/generation.ts`, kept
 * its signature, and nothing above it changed at all.
 *
 * If something has to be added back here, say WHY in the same detail — the
 * entry above cost more to believe than it did to fix.
 */
const KNOWN_NODE_BOUND: readonly { entry: string; because: string }[] = [];

/**
 * `import ... from "x"`, `export ... from "x"`, and bare `import "x"`.
 *
 * TWO THINGS THIS HAS TO GET RIGHT, both learned by getting them wrong.
 *
 * NEWLINES. A first version used `[^;\n]*?`, which cannot span lines — so the
 * multi-line `export { a, b, c } from "./x.js"` barrels in `src/text/index.ts`
 * and `src/search/index.ts` were invisible and those entry points "passed" while
 * walking nothing. `[^;]*?` spans lines and still stops at a statement end.
 *
 * COMMENTS. Doc comments here contain real-looking specifiers — `src/db/browser.ts`
 * lines 13 and 300 both show `import schemaSql from "../schema/schema.sql?raw"`
 * inside prose. Rather than strip comments (which mangles `https://` inside string
 * literals), the statement is anchored to a line start followed only by spaces or
 * tabs: a comment line begins with `*` or `//`, neither of which is whitespace, so
 * commented specifiers never match.
 *
 * TYPE-ONLY IMPORTS ARE NOT IMPORTS. `import type { Db } from "../db/index.js"`
 * is erased by the compiler and emits nothing at runtime, so it cannot drag
 * `better-sqlite3` into a worker — and counting it flagged `src/accent/store.ts`
 * and `src/dashboard/metrics.ts` falsely on the first run. The lookahead excludes
 * a `type` keyword directly after `import`/`export` and nothing else: an inline
 * `import { type Db, gradeFor }` still emits a real import for `gradeFor`, so it
 * must keep counting. Getting this distinction right IS the test — "does this
 * module pull Node code at load" is exactly the question, and an erased import
 * does not.
 */
const SPECIFIER = /(?:^|[\n;])[ \t]*(?:import|export)\b(?![ \t]+type[ \t])[^;]*?\bfrom[ \t\n]*["']([^"']+)["']|(?:^|[\n;])[ \t]*import[ \t]*["']([^"']+)["']/g;

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const spec = match[1] ?? match[2];
    if (spec) found.push(spec);
  }
  return found;
}

/** `./foo.js` in source is `./foo.ts` on disk — this repo emits ESM specifiers. */
function toDisk(fromFile: string, spec: string): string {
  const base = join(dirname(fromFile), spec);
  return base.replace(/\.js$/, ".ts");
}

interface Walk {
  readonly nodeImports: { file: string; spec: string; via: readonly string[] }[];
  readonly visited: Set<string>;
}

function walk(entry: string): Walk {
  const nodeImports: { file: string; spec: string; via: readonly string[] }[] = [];
  const visited = new Set<string>();
  const queue: { file: string; via: readonly string[] }[] = [{ file: entry, via: [] }];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const { file, via } = next;
    if (visited.has(file)) continue;
    visited.add(file);

    let source: string;
    try {
      source = readFileSync(join(ROOT, file), "utf8");
    } catch {
      // A specifier that does not resolve to a .ts file is not this test's
      // business — typecheck owns that. Skipping keeps the failure message
      // about Node imports rather than about resolution.
      continue;
    }

    for (const spec of specifiersOf(source)) {
      if (spec.startsWith("node:")) {
        nodeImports.push({ file, spec, via });
        continue;
      }
      if (!spec.startsWith(".")) continue; // bare specifier: see the header
      queue.push({ file: toDisk(file, spec), via: [...via, file] });
    }
  }
  return { nodeImports, visited };
}

describe("browser portability", () => {
  it("keeps src/schema/index.ts free of every Node import", () => {
    const source = readFileSync(join(ROOT, "src/schema/index.ts"), "utf8");
    const offenders = specifiersOf(source).filter((s) => s.startsWith("node:"));
    expect(
      offenders,
      "src/schema/index.ts must stay Node-free — the DDL loader lives in ./sources.ts",
    ).toEqual([]);
  });

  it("keeps the DDL text loader Node-only, so the split is real and not cosmetic", () => {
    // The other half of the same invariant. If this file ever stops importing
    // node:fs, the split has been undone from the other end and index.ts is
    // about to grow the import back.
    const source = readFileSync(join(ROOT, "src/schema/sources.ts"), "utf8");
    expect(specifiersOf(source)).toContain("node:fs");
  });

  it.each(BROWSER_ENTRY_POINTS)("%s reaches no node: import transitively", (entry) => {
    const { nodeImports, visited } = walk(entry);
    expect(visited.has(entry), `${entry} was never read`).toBe(true);
    const described = nodeImports.map(
      (n) => `${n.file} imports ${n.spec}${n.via.length > 0 ? ` (via ${n.via.join(" -> ")})` : ""}`,
    );
    expect(described, `${entry} is not importable in a browser worker`).toEqual([]);
  });

  it.each(KNOWN_NODE_BOUND)("$entry is STILL Node-bound — $because", ({ entry }) => {
    // Asserted in the positive direction on purpose. If someone lands the async
    // key change, this test fails and forces the entry to move up into
    // BROWSER_ENTRY_POINTS rather than the fix going unnoticed.
    const { nodeImports } = walk(entry);
    expect(
      nodeImports.length,
      `${entry} no longer reaches a node: import — move it into BROWSER_ENTRY_POINTS`,
    ).toBeGreaterThan(0);
  });

  it("actually walks, rather than failing open on a broken regex", () => {
    // Every green test above is vacuous if the walk stops resolving imports or
    // stops recognising node: specifiers. Two independent checks:
    //
    //   depth  - the union of the browser walks must reach well past its entry
    //            points. A regex that matches nothing gives exactly one file per
    //            entry, which is how the multi-line `export {...} from` blind
    //            spot in the first version of this file was caught.
    //   teeth  - a walk over a module that IS Node-only must report.
    const union = new Set();
    for (const entry of BROWSER_ENTRY_POINTS) {
      for (const file of walk(entry).visited) union.add(file);
    }
    expect(union.size).toBeGreaterThan(BROWSER_ENTRY_POINTS.length * 2);

    const { nodeImports } = walk("src/db/open.ts");
    expect(nodeImports.some((n) => n.spec.startsWith("node:"))).toBe(true);
  });
});
