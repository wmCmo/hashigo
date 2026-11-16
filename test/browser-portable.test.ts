import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

const BROWSER_ENTRY_POINTS = [
  "src/schema/index.ts",
  "src/template/index.ts",
  "src/render/index.ts",
  "src/render/reveal.ts",
  "src/render/audio.ts",
  "src/blobs/generation.ts",
  "src/cards/index.ts",
  "src/session/index.ts",
  "src/review/index.ts",
  "src/backup/index.ts",
  "src/generate/index.ts",
  "src/scheduler/index.ts",
  "src/scheduler/policy.ts",
  "src/dashboard/metrics.ts",
  "src/dashboard/render.ts",
  "src/dashboard/glance.ts",
  "src/text/index.ts",
  "src/search/index.ts",
  "src/accent/store.ts",
  "src/fields/index.ts",
  "src/blobs/db.ts",
] as const;

const KNOWN_NODE_BOUND: readonly { entry: string; because: string }[] = [];

const SPECIFIER = /(?:^|[\n;])[ \t]*(?:import|export)\b(?![ \t]+type[ \t])[^;]*?\bfrom[ \t\n]*["']([^"']+)["']|(?:^|[\n;])[ \t]*import[ \t]*["']([^"']+)["']/g;

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const spec = match[1] ?? match[2];
    if (spec) found.push(spec);
  }
  return found;
}

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
      continue;
    }

    for (const spec of specifiersOf(source)) {
      if (spec.startsWith("node:")) {
        nodeImports.push({ file, spec, via });
        continue;
      }
      if (!spec.startsWith(".")) continue;
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
    const { nodeImports } = walk(entry);
    expect(
      nodeImports.length,
      `${entry} no longer reaches a node: import — move it into BROWSER_ENTRY_POINTS`,
    ).toBeGreaterThan(0);
  });

  it("actually walks, rather than failing open on a broken regex", () => {
    const union = new Set();
    for (const entry of BROWSER_ENTRY_POINTS) {
      for (const file of walk(entry).visited) union.add(file);
    }
    expect(union.size).toBeGreaterThan(BROWSER_ENTRY_POINTS.length * 2);

    const { nodeImports } = walk("src/db/open.ts");
    expect(nodeImports.some((n) => n.spec.startsWith("node:"))).toBe(true);
  });
});
