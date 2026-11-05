/**
 * WHICH CHANGED FILES COULD MOVE THE TWO CORPUS TESTS — for `npm run gates -- --quick`.
 *
 * Zach, 2026-11-05: *"is running the gates necessary in this app? it takes so much
 * time"*. Measured that day: the suite is 85-94 s, and two files are ~80 s of it —
 * `dashboard.test.ts` and `roundtrip.test.ts` each re-import the whole Mochi corpus.
 * Everything else is ~25 s. Most commits (the editor, the review screen, sync UI)
 * cannot move either, so a quick gate skips them.
 *
 * ─── IT DECIDES BY FOLLOWING IMPORTS, NOT BY A LIST ─────────────────────────
 *
 * A hand-kept list of "the importer's directories" is the thing that goes stale:
 * the day `src/import` starts importing from `src/cards`, the list says a cards
 * change is safe and the quick gate passes a break. So this walks the two test
 * files' relative imports, transitively, and returns the set of source files they
 * can reach. A changed file in that set — or a change to the dependencies, the
 * exports or the oracle — means the quick gate refuses and runs everything.
 *
 * Text-level: `from "…"` and `import("…")` with a relative specifier, `.js`
 * resolved to the `.ts` beside it. It over-approximates (a type-only import counts),
 * which errs toward running the slow tests, the safe direction.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const CORPUS_TESTS = ["test/dashboard.test.ts", "test/roundtrip.test.ts"];

/** Changes outside `src/` that still feed the corpus tests. */
const ALWAYS_FULL = [/^package(-lock)?\.json$/, /^dashboard\.html$/, /^exports\//, /^vitest\.config\./, /^tsconfig/];

const SPECIFIER = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base.replace(/\.js$/, ".ts"), base, `${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  }
  return null;
}

/** Every repo-relative file the corpus tests can reach through relative imports. */
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

/** Files changed since the last commit, staged, unstaged or new. */
export function changedFiles(root) {
  const run = (cmd) =>
    execSync(cmd, { cwd: root, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  return [...new Set([...run("git diff --name-only HEAD"), ...run("git ls-files --others --exclude-standard")])];
}

/** The changed files that mean the corpus tests must run. Empty: safe to skip them. */
export function corpusTouched(root, changed = changedFiles(root)) {
  const reach = corpusReach(root);
  return changed.filter((file) => reach.has(file) || ALWAYS_FULL.some((pattern) => pattern.test(file)));
}
