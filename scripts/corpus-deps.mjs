import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const CORPUS_TESTS = ["test/dashboard.test.ts", "test/roundtrip.test.ts"];

const ALWAYS_FULL = [/^package(-lock)?\.json$/, /^dashboard\.html$/, /^exports\//, /^vitest\.config\./, /^tsconfig/];

const SPECIFIER = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base.replace(/\.js$/, ".ts"), base, `${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  }
  return null;
}

export function corpusReach(root) {
  const seen = new Set();
  const queue = CORPUS_TESTS.map((file) => resolve(root, file));
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER)) {
      const next = resolveSpecifier(file, match[1]);
      if (next !== null && !seen.has(next)) queue.push(next);
    }
  }
  return new Set([...seen].map((file) => relative(root, file).replace(/\\/g, "/")));
}

export function changedFiles(root) {
  const run = (cmd) =>
    execSync(cmd, { cwd: root, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  return [...new Set([...run("git diff --name-only HEAD"), ...run("git ls-files --others --exclude-standard")])];
}

export function corpusTouched(root, changed = changedFiles(root)) {
  const reach = corpusReach(root);
  return changed.filter((file) => reach.has(file) || ALWAYS_FULL.some((pattern) => pattern.test(file)));
}
