/**
 * `npm run docs:check` — the checks that READ THE DOCS, kept out of `npm test` and
 * the gates. Zach, 2026-11-14: *"i feel like no code should break when the doc
 * changes"*. They report a dead path, an unknown script or a renumbered decision
 * list; they never block a commit or a release.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["docs-check/**/*.test.ts"],
  },
});
