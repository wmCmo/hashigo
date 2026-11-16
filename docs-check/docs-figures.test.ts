import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = ["CLAUDE.md", "RELEASE.md", "DECISIONS.md", "app/README.md", "cloud/README.md"] as const;

function read(name: string): string {
  return readFileSync(join(ROOT, name), "utf8");
}

describe("the figures a routine change invalidates", () => {
  it("any stated decision count is the real one", () => {
    const real = [...read("DECISIONS.md").matchAll(/^(\d+)\. /gm)].length;
    const claims = [
      ...`${read("CLAUDE.md")}\n${read("RELEASE.md")}`.matchAll(/(\d+)\s+decisions\b/g),
    ].map((m) => Number(m[1]));
    for (const claimed of claims) {
      expect(
        claimed,
        `a doc says there are ${claimed} decisions; DECISIONS.md has ${real}`,
      ).toBe(real);
    }
  });
});

const COUNT_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

describe("headings that count their own lists", () => {
  it("never state a number that the list below them contradicts", () => {
    const wrong: string[] = [];
    for (const doc of DOCS) {
      const lines = read(doc).split("\n");
      for (const [i, line] of lines.entries()) {
        const m = /^(?:#{2,4} |\*\*)(two|three|four|five|six|seven|eight|nine|ten)\s+\w+/i.exec(
          line.trim(),
        );
        if (m === null) continue;
        const claimed = COUNT_WORDS[m[1]!.toLowerCase()]!;
        let items = 0;
        let blanks = 0;
        for (const next of lines.slice(i + 1)) {
          if (next.trim() === "") {
            if (items > 0 && ++blanks > 1) break;
            continue;
          }
          if (/^#{2,4} /.test(next)) break;
          if (/^(\* |\d+\. )/.test(next)) {
            items += 1;
            blanks = 0;
            continue;
          }
          if (/^\s/.test(next) && items > 0) continue;
          break;
        }
        if (items > 0 && items !== claimed) {
          wrong.push(`${doc}:${i + 1} "${line.trim().slice(0, 60)}" counts ${claimed}, list has ${items}`);
        }
      }
    }
    expect(wrong, `headings disagree with the list under them:\n  ${wrong.join("\n  ")}`).toEqual(
      [],
    );
  });
});

describe("everything the docs tell you to run or open", () => {
  it("every file path mentioned in the top-level docs exists", () => {
    const missing: string[] = [];
    for (const doc of DOCS) {
      for (const m of read(doc).matchAll(/`([\w./-]+\.(?:ts|md|py|sql|mjs|html|json|jsonl|css))`/g)) {
        const path = m[1]!;
        if (!path.includes("/")) continue;
        if (path.startsWith("dist/") || path.startsWith("build/")) continue;
        if (path.startsWith("exports/")) continue;
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

