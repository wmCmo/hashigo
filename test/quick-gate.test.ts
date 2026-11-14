import { describe, expect, it } from "vitest";

/**
 * `npm run gates -- --quick` skips the two corpus re-imports only when nothing
 * changed can reach them (2026-11-05, `scripts/corpus-deps.mjs`). The reach is
 * walked from the tests' imports, so it is pinned by what it must and must not
 * contain rather than by a list.
 */
describe("the quick gate's reach", () => {
  it("covers the importer, its parser and the oracle, and not the editor", async () => {
    const { corpusTouched } = (await import("../scripts/corpus-deps.mjs")) as {
      corpusTouched: (root: string, changed: string[]) => string[];
    };
    const root = process.cwd();
    for (const file of ["src/import/entities.ts", "src/template/parse.ts", "test/roundtrip.test.ts", "package.json", "dashboard.html"]) {
      expect(corpusTouched(root, [file]), file).toEqual([file]);
    }
    for (const file of ["app/main.ts", "app/template-editor.ts", "src/cards/tags.ts"]) {
      expect(corpusTouched(root, [file]), file).toEqual([]);
    }
  });
});
