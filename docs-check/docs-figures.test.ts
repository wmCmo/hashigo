import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = ["CLAUDE.md", "RELEASE.md", "DECISIONS.md", "app/README.md", "cloud/README.md"] as const;

function read(name: string): string {
  return readFileSync(join(ROOT, name), "utf8");
}

function liveHalf(name: string): string {
  const text = read(name);
  const cut = text.indexOf("## The record below this line is HISTORY");
  return cut === -1 ? text : text.slice(0, cut);
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

const CODE_GLOBS = ["src", "app", "test", "scripts"] as const;

function codeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) out.push(rel);
    }
  };
  for (const top of CODE_GLOBS) walk(top);
  return out;
}

function resolveRef(dir: string, ref: string): string {
  const parts = dir.split("/");
  for (const segment of ref.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

describe("claims inside code comments", () => {
  it("every file path a comment points at exists", () => {
    const missing: string[] = [];
    for (const file of codeFiles()) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const dir = file.slice(0, file.lastIndexOf("/"));
      for (const m of text.matchAll(/`([\w./-]+\.(?:ts|md|sql|py|mjs|json|jsonl|html|css))`/g)) {
        const ref = m[1]!;
        if (!ref.includes("/") && !ref.startsWith(".")) continue;
        if (ref.startsWith("build/") || ref.startsWith("dist/") || ref.startsWith("exports/")) {
          continue;
        }
        if (ref.startsWith(".") && !(file.startsWith("src/") || file.startsWith("app/"))) continue;
        const target = ref.startsWith(".") ? resolveRef(dir, ref) : ref;
        if (!existsSync(join(ROOT, target))) missing.push(`${file} -> ${ref}`);
      }
    }
    expect(missing, `comments point at files that do not exist: ${missing.join(" · ")}`).toEqual([]);
  });

  it("every `npm run <script>` a comment names is a real script", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const missing: string[] = [];
    for (const file of codeFiles()) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const m of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
        if (!(m[1]! in pkg.scripts)) missing.push(`${file} -> npm run ${m[1]}`);
      }
    }
    expect(missing, `comments name scripts that do not exist: ${missing.join(" · ")}`).toEqual([]);
  });

  it("every decision number cited in code is one that exists", () => {
    const real = [...read("DECISIONS.md").matchAll(/^(\d+)\. /gm)].length;
    const bad: string[] = [];
    for (const file of codeFiles()) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const m of text.matchAll(/[Dd]ecision (\d+)/g)) {
        const n = Number(m[1]);
        if (n < 1 || n > real) bad.push(`${file} -> decision ${n} (there are ${real})`);
      }
    }
    expect(bad, `code cites decisions that do not exist: ${bad.join(" · ")}`).toEqual([]);
  });

  it("no comment states a superseded corpus figure as a present fact", () => {
    const SUPERSEDED: readonly (readonly [string, string])[] = [
      ["102,020", "103,110"],
      ["102,021", "103,111"],
      ["58,937", "59,514"],
      ["43,083", "43,596"],
      ["92,994", "94,025"],
      ["9,026", "9,085"],
      ["13,392", "13,393"],
    ];
    const HISTORICAL: readonly { file: string; contains: string; why: string }[] = [
      {
        file: "src/dashboard/render.ts",
        contains: "THIS TILE USED TO CONTRADICT",
        why: "narrates the defect: the two artefacts bucketed the same reviews and disagreed",
      },
      {
        file: "src/import/entities.ts",
        contains: "review records lose their track",
        why: "a verbatim SPEC quote; the current figure is stated beside it",
      },
      {
        file: "app/db.worker.ts",
        contains: "went on reporting",
        why: "the bug: the page served the August seed's total after the re-import",
      },
      {
        file: "test/roundtrip.test.ts",
        contains: "UNCHANGED ACROSS THE RE-IMPORT",
        why: "compares the old rate with the new one; both figures are the point",
      },
      {
        file: "scripts/app-bootstrap.ts",
        contains: "THE SEED MANIFEST",
        why: "same bug as db.worker.ts, from the writing side",
      },
    ];

    const exempt = (file: string, text: string): boolean =>
      HISTORICAL.some((e) => e.file === file && text.includes(e.contains));

    const stale: string[] = [];
    const used = new Set<string>();
    for (const file of codeFiles()) {
      for (const block of commentBlocks(readFileSync(join(ROOT, file), "utf8"))) {
        for (const e of HISTORICAL) {
          if (e.file === file && block.text.includes(e.contains)) used.add(e.contains);
        }
        if (exempt(file, block.text)) continue;
        for (const [old, now] of SUPERSEDED) {
          if (block.text.includes(old)) {
            stale.push(`${file}:${block.line} says ${old} (current: ${now})`);
          }
        }
      }
    }
    expect(
      stale,
      `comments state superseded corpus figures as present fact — update the figure, ` +
        `or add an exemption saying why the old one belongs there:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);

    const dead = HISTORICAL.filter((e) => !used.has(e.contains)).map((e) => `${e.file}: "${e.contains}"`);
    expect(dead, `exemptions that match no comment — delete them:\n  ${dead.join("\n  ")}`).toEqual(
      [],
    );
  });
});

function commentBlocks(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let cur: { line: number; parts: string[] } | null = null;
  for (const [i, raw] of lines.entries()) {
    const t = raw.trim();
    let content: string | null = null;
    if (inBlock) {
      content = t.replace(/^\*+\s?/, "").replace(/\*\/.*$/, "");
      if (t.includes("*/")) inBlock = false;
    } else if (t.startsWith("//")) {
      content = t.slice(2);
    } else if (t.startsWith("/*")) {
      content = t.replace(/^\/\*+\s?/, "").replace(/\*\/.*$/, "");
      if (!t.includes("*/")) inBlock = true;
    }
    if (content === null) {
      if (cur !== null) out.push({ line: cur.line, text: cur.parts.join(" ") });
      cur = null;
      continue;
    }
    cur ??= { line: i + 1, parts: [] };
    cur.parts.push(content);
  }
  if (cur !== null) out.push({ line: cur.line, text: cur.parts.join(" ") });
  return out;
}

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

