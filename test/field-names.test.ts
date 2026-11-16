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
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      if (/['"`]読み['"`]|= '読み'/.test(code)) offenders.push(file);
    }
    expect(offenders, `use YOMI_FIELD / yomiOf / yomiFieldId from ${OWNER}`).toEqual([]);
  });
});
