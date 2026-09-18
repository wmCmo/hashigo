import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/schema/index.js";

/**
 * THE DOCS' *DURABLE* FIGURES ARE ACCURATE. THE *VOLATILE* ONES ROT, SILENTLY.
 *
 * `test/docs-integrity.test.ts` watches the decision NUMBERING, because a markdown
 * formatter renumbered it once. This file watches the FIGURES, because nothing did.
 *
 * THE DISTINCTION IS THE POINT, and it was measured rather than assumed: the figures
 * derived from data that does not move — the accent splits, the corpus totals, the
 * decision-29 card counts — were checked against `build/hashigo.db` and were exact.
 * This is not a suite that distrusts the documentation.
 *
 * What rots is the handful of figures that change every time someone adds a test, an
 * export subpath, or a decision. Those are exactly the figures a cold session uses to
 * decide whether it is reading a current file or a stale one, and a wrong one is not
 * dangerous by itself — it is dangerous because it stops the reader trusting the
 * accurate 95% around it.
 *
 * WHAT THIS DOES NOT DO. It does not check prose, reasoning, or any figure derived
 * from the corpus — those need `exports/` and a built database, they are already
 * pinned by the suites that measure them, and they do not drift. It checks the
 * figures that a routine change invalidates, plus every path and npm script the
 * docs tell you to use. Nothing here needs the corpus, so it all runs in a bare
 * clone.
 */

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = ["CLAUDE.md", "NEXT.md", "DECISIONS.md", "app/README.md"] as const;

function read(name: string): string {
  return readFileSync(join(ROOT, name), "utf8");
}

/**
 * The half of a document that is held to the PRESENT.
 *
 * A document may keep a record of what was true at the time below a HISTORY heading,
 * and those figures are allowed to be old. Nothing carries one today — NEXT.md's moved
 * to `notes/archive/next-history.md` — so in practice every figure is held to the
 * present, which is the stricter reading.
 *
 * The boundary is honoured rather than forbidden because someone may reasonably start
 * a new record, and gating on its ABSENCE would be a gate on formatting rather than on
 * truth.
 */
function liveHalf(name: string): string {
  const text = read(name);
  const cut = text.indexOf("## The record below this line is HISTORY");
  return cut === -1 ? text : text.slice(0, cut);
}

describe("the figures a routine change invalidates", () => {
  it("every stated test-file count is the real number of test files", () => {
    const real = countTestFiles();
    const claims = [...liveHalf("CLAUDE.md").matchAll(/(\d+) files, [\d,]+ passed/g)].map((m) =>
      Number(m[1]),
    );
    const nextClaims = [...liveHalf("NEXT.md").matchAll(/(\d+) files \/ [\d,]+ passed/g)].map((m) =>
      Number(m[1]),
    );
    const all = [...claims, ...nextClaims];
    expect(all.length, "no test-file-count claim found — did the phrasing change?").toBeGreaterThan(
      0,
    );
    for (const claimed of all) {
      expect(
        claimed,
        `a doc claims ${claimed} test files; there are ${real}. Update the docs or this test.`,
      ).toBe(real);
    }
  });

  it("every stated passing-test count agrees with every other one", () => {
    // The absolute number cannot be checked without running the suite, and running
    // the suite from inside the suite is not a thing. What CAN be checked is that
    // the live documents agree with each other — the failure that actually happened
    // was CLAUDE.md and NEXT.md drifting apart from the truth together, but they
    // have also drifted apart from EACH OTHER before (734 vs 757).
    const counts = new Set<number>();
    for (const doc of ["CLAUDE.md", "NEXT.md"]) {
      for (const m of liveHalf(doc).matchAll(/([\d,]{3,}) passed/g)) {
        counts.add(Number(m[1]!.replace(/,/g, "")));
      }
    }
    expect(
      [...counts],
      `the live docs quote ${counts.size} different passing-test counts: ${[...counts].join(", ")}`,
    ).toHaveLength(1);
  });

  it("the stated SCHEMA_VERSION is the real one", () => {
    const claims = [...read("CLAUDE.md").matchAll(/`SCHEMA_VERSION` is \*\*(\d+)\*\*/g)].map((m) =>
      Number(m[1]),
    );
    expect(claims.length, "CLAUDE.md no longer states SCHEMA_VERSION").toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(SCHEMA_VERSION);
  });

  it("the stated export-subpath count is the real one", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    const real = Object.keys(pkg.exports).filter((k) => k !== "./package.json").length;
    const claims = [...read("CLAUDE.md").matchAll(/\((\d+) export subpaths\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(claims.length, "CLAUDE.md no longer states the export-subpath count").toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(real);
  });

  it("any stated decision count is the real one", () => {
    const real = [...read("DECISIONS.md").matchAll(/^(\d+)\. /gm)].length;
    // Deliberately scans the WHOLE of NEXT.md, history included: "There are N
    // decisions; read them before proposing anything" is an instruction to the
    // reader wherever it sits, and a low N means a cold session under-reads.
    // Deliberately broad. The first version of this matched only "There are N
    // decisions" and "all N decisions", and missed `the 29 decisions` sitting in
    // NEXT.md's own orientation table — the one line a cold session reads to find out
    // what CLAUDE.md is. A narrow regex on a gate is worse than no gate, because the
    // green tick is then evidence of nothing.
    const claims = [
      ...`${read("CLAUDE.md")}\n${read("NEXT.md")}`.matchAll(/(\d+)\s+decisions\b/g),
    ].map((m) => Number(m[1]));
    for (const claimed of claims) {
      expect(
        claimed,
        `a doc says there are ${claimed} decisions; DECISIONS.md has ${real}`,
      ).toBe(real);
    }
  });
});

/**
 * THE SAME CHECKS, OVER CODE COMMENTS — WHERE MOST OF THE PROSE ACTUALLY LIVES.
 *
 * This file was written to stop documentation rotting, and then read four markdown
 * files. Measured 2026-08-26, that is a small fraction of the surface:
 *
 *   48 markdown files          122,320 words     gated: 4 files
 *   11,354 comment lines       35.9% of code     gated: nothing
 *     ...342 of them carrying a measured figure  gated: nothing
 *
 * A comment is worse than a document for this, not better. Nobody greps comments when
 * renaming a file, no reviewer reads all 11,354, and they carry the same volatile
 * figures — "3,850 openjtalk", "102,020 reviews", "12.07 statements per graded card" —
 * with none of the "every status figure lives in NEXT.md" discipline the docs have.
 *
 * It found one on the first run: `src/db/browser.ts` pointed at a
 * browser-portable test file whose name was missing its ".test" segment, where four
 * other files spelled the same path correctly. (Written without the literal path,
 * because this file is scanned too and quoting a broken path would fail its own gate —
 * which is itself the check working.)
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK: prose, reasoning, or any measurement that needs
 * the corpus to verify. Those are pinned by the suites that produce them. This is the
 * cheap half — that a path exists, that a script exists, that a decision number is real
 * — which is also the half that rots when someone renames something.
 */
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

/**
 * A relative ref, resolved the way a reader resolves it.
 *
 * `..` IS THE POINT. The first version of this stripped a leading `./` with
 * `slice(2)` and nothing else, so a comment in `src/dashboard/` pointing at
 * `../scheduler/predicates.ts` — a file that plainly exists — was reported as
 * missing. That is the same false-miss failure the caller's own comment warns
 * about, one directory up, and a cross-directory reference is exactly what a
 * module wants to write when it borrows a definition from another one.
 */
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
    // Relative paths resolve against the file that mentions them, which is what a
    // reader does. A first version resolved everything against the repo root and
    // reported 24 false misses — a gate with false positives gets deleted.
    const missing: string[] = [];
    for (const file of codeFiles()) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const dir = file.slice(0, file.lastIndexOf("/"));
      for (const m of text.matchAll(/`([\w./-]+\.(?:ts|md|sql|py|mjs|json|jsonl|html|css))`/g)) {
        const ref = m[1]!;
        if (!ref.includes("/") && !ref.startsWith(".")) continue; // a bare name is prose
        if (ref.startsWith("build/") || ref.startsWith("dist/") || ref.startsWith("exports/")) {
          continue; // generated or gitignored
        }
        // A RELATIVE ref is only unambiguous inside src/ and app/, where `./x.ts`
        // means the sibling module. In a test file it usually names the module UNDER
        // TEST instead — `test/dashboard.test.ts` says `./labels.ts` and means
        // `src/dashboard/labels.ts`. Guessing there would produce false misses, and a
        // gate that cries wolf gets deleted by the next person to hit it.
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
    // CLAUDE.md: "Numbering is cited across `src/`, `test/` and the notes — never
    // renumber, only append." `docs-integrity` protects the list's shape; nothing
    // protected the CITATIONS, which are the reason the shape matters. 23 sites cite
    // decision 29 alone.
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

  /**
   * A SUPERSEDED CORPUS FIGURE IS A CLAIM ABOUT NOW, UNLESS IT SAYS OTHERWISE.
   *
   * This file's own header declined to check corpus-derived figures, on the reasoning
   * that they "do not drift" and are "already pinned by the suites that measure them".
   * **Both halves of that were wrong, and the cost was measured 2026-09-14: the
   * 2026-09-08 re-import moved the totals and left 16 comments stating the old ones as
   * present fact** — including three that sat next to an assertion of the new one.
   * `test/glance.test.ts` said "102,020 reviews" on the line directly above
   * `expect(g.allTime.reviews).toBe(103_110)`, and `test/reviews.test.ts` printed a
   * test NAME claiming 102,020 for a body asserting 103,110. The suites pinned the
   * numbers and nothing pinned the sentences about them.
   *
   * They do not drift CONTINUOUSLY, which is what made the reasoning plausible. They
   * step, rarely, and every mention goes stale in one commit — the worst shape for a
   * figure that nobody re-greps.
   *
   * **A historical mention is legitimate**, and naming them individually is the only
   * thing that works. "The page went on reporting 102,020 reviews from the August
   * seed" is exactly right. The first version of this gate tried to RECOGNISE such a
   * sentence — a date, or a phrase like "used to", anywhere in the same block — and it
   * had NO TEETH, measured by injection: reverting `src/scheduler/day.ts` to the old
   * figure left the suite green, because that block quotes the example instant
   * `2026-08-23T00:00:00+09:00` and the date pattern matched it. This codebase is full
   * of example dates, so any pattern loose enough to clear the honest sites clears
   * most of the dishonest ones too. An exemption table cannot be tripped by accident.
   *
   * Only COMMENTS are scanned. A superseded figure in code is either an assertion,
   * which its own suite owns, or a deliberate reference constant.
   *
   * **THE GENERAL VERSION WAS TRIED AND MEASURED AND IS NOT VIABLE.** "Every
   * comma-formatted figure in a test file's comments also appears in that file's
   * code" would have caught every one of today's finds without a hand-maintained
   * list — and over the 45 test files it reports 134 of 207 figures as misses, a
   * 65% false-positive rate. Almost all of them are honest: a comment saying the
   * corpus holds 8,690 wiki-links inside a file that asserts something else about
   * them is not a stale figure. A list that has to be appended to is the weaker
   * mechanism and it is the one that can be trusted to go off for a reason.
   */
  it("no comment states a superseded corpus figure as a present fact", () => {
    // Pairs of [superseded, current]. Append when the corpus steps again; never
    // delete a row, or the check silently stops covering that figure.
    const SUPERSEDED: readonly (readonly [string, string])[] = [
      ["102,020", "103,110"],
      ["102,021", "103,111"], // the total plus the one a test grades
      ["58,937", "59,514"],
      ["43,083", "43,596"],
      ["92,994", "94,025"],
      ["9,026", "9,085"],
      ["13,392", "13,393"],
    ];
    // The comments that state an old figure ON PURPOSE. Keyed on a phrase from the
    // block rather than a line number, so an edit above it cannot silently move the
    // exemption onto a different comment. Every entry says why.
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
      {
        file: "test/docs-figures.test.ts",
        contains: "A SUPERSEDED CORPUS FIGURE IS A CLAIM ABOUT NOW",
        why: "this gate's own header quotes what it caught",
      },
      {
        file: "test/docs-figures.test.ts",
        contains: "THE SAME CHECKS, OVER CODE COMMENTS",
        why: "a dated 2026-08-26 survey of the prose surface",
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

    // An exemption that matches nothing is a licence nobody is using, and it would
    // keep a future stale figure quiet if the phrase ever drifted back into a file.
    const dead = HISTORICAL.filter((e) => !used.has(e.contains)).map((e) => `${e.file}: "${e.contains}"`);
    expect(dead, `exemptions that match no comment — delete them:\n  ${dead.join("\n  ")}`).toEqual(
      [],
    );
  });
});

/**
 * Contiguous runs of comment lines, with the line the run starts on.
 *
 * A BLOCK rather than a line, because the marker that makes a figure historical is
 * usually a sentence or two above it — `db.worker.ts` dates its bug narrative in the
 * opening line and quotes the old total nine lines down.
 */
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

/**
 * A HEADING THAT COUNTS ITS OWN LIST IS A CLAIM, AND IT DESYNCS SILENTLY.
 *
 * Appending to a list is the one edit that never makes you re-read its title, so a
 * heading that counts its own items drifts the moment the list grows — and two in the
 * auto-loaded file had.
 *
 * The repair is to drop the numeral rather than to correct it, since the next append
 * would desync a corrected one just the same. This keeps it dropped.
 */
const COUNT_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

describe("headings that count their own lists", () => {
  it("never state a number that the list below them contradicts", () => {
    const wrong: string[] = [];
    for (const doc of DOCS) {
      const lines = read(doc).split("\n");
      for (const [i, line] of lines.entries()) {
        // A heading or a bolded lead-in that opens with a spelled-out count.
        const m = /^(?:#{2,4} |\*\*)(two|three|four|five|six|seven|eight|nine|ten)\s+\w+/i.exec(
          line.trim(),
        );
        if (m === null) continue;
        const claimed = COUNT_WORDS[m[1]!.toLowerCase()]!;
        // Count ONLY the list immediately below — the contiguous block, where a
        // bullet may wrap onto indented continuation lines and a single blank line
        // may separate items.
        //
        // The first version counted every bullet up to the next `##`, which made
        // DECISIONS.md's prose lead-ins ("**Two ways to build it wrong.**") report
        // "counts 2, list has 20" by sweeping up four later paragraphs. A gate with
        // false positives gets deleted by the next person to hit it, so the bound
        // matters more than the reach.
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
          // An indented line continues the bullet above it; anything else at column
          // zero has ended the list.
          if (/^\s/.test(next) && items > 0) continue;
          break;
        }
        // Zero means the phrase was prose, not a list header — not this test's business.
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
    // The largest class of documentation rot, and the cheapest to catch: a doc
    // pointing at a file that was renamed or deleted. Measured clean at 85 distinct
    // paths on 2026-08-25 — this keeps it that way.
    const missing: string[] = [];
    for (const doc of DOCS) {
      for (const m of read(doc).matchAll(/`([\w./-]+\.(?:ts|md|py|sql|mjs|html|json|jsonl|css))`/g)) {
        const path = m[1]!;
        if (!path.includes("/")) continue; // a bare filename is prose, not a pointer
        if (path.startsWith("dist/") || path.startsWith("build/")) continue; // generated
        if (path.startsWith("exports/")) continue; // gitignored, 657 MB of audio
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

/**
 * Counted from disk rather than imported from a manifest on purpose: a manifest is
 * one more thing to forget to update, which is the bug this file exists to catch.
 */
function countTestFiles(): number {
  return readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.ts")).length;
}
