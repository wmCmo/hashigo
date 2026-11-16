import { describe, expect, it } from "vitest";

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
