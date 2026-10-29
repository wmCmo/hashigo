/**
 * A FIELD MATCHED BY NAME HAS ITS NAME WRITTEN ONCE.
 *
 * `読み` (decision 10) is found by name, not role, and until 2026-10-29 the name
 * was typed into three separate SQL strings. `src/fields/yomi.ts` owns it now;
 * this refuses the literal anywhere else in code, so a fourth copy cannot arrive
 * unnoticed and a rename stays a one-line change.
 *
 * The one other use of the word is a different thing: `src/text/parenthesis.ts`
 * and `scripts/reading-parse.ts` label a VERDICT about a parenthesis as "読み" —
 * a category, not a field lookup — so they are named here rather than rewritten.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const OWNER = "src/fields/yomi.ts";
const VERDICT_LABELS = new Set(["src/text/parenthesis.ts", "scripts/reading-parse.ts"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name).replace(/\\/g, "/");
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("the 読み field's name", () => {
  it("is written as a literal in one file only", () => {
    const offenders: string[] = [];
    for (const file of ["src", "app", "scripts", "cloud"].flatMap(files)) {
      if (file === OWNER || VERDICT_LABELS.has(file)) continue;
      // Code only: a comment may name the field, and most of them should.
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      if (/['"`]読み['"`]|= '読み'/.test(code)) offenders.push(file);
    }
    expect(offenders, `use YOMI_FIELD / yomiOf / yomiFieldId from ${OWNER}`).toEqual([]);
  });
});
