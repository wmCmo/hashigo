#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import { testVerdict } from "./test-verdict.mjs";
import { CORPUS_TESTS, corpusTouched } from "./corpus-deps.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HAVE_DB = existsSync(resolve(ROOT, "build/hashigo.db"));
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

let quick = process.argv.includes("--quick");
let quickNote = "";
if (quick) {
  const touched = corpusTouched(ROOT);
  if (touched.length > 0) {
    quick = false;
    quickNote = `quick REFUSED — ${touched.slice(0, 3).join(", ")}${touched.length > 3 ? ` (+${touched.length - 3})` : ""} feed the corpus tests, so they run`;
  } else {
    quickNote = `quick — ${CORPUS_TESTS.join(" and ")} skipped: nothing changed can reach them`;
  }
  console.log(`gates: ${quickNote}`);
}
const TEST_CMD = quick ? `npm test -- ${CORPUS_TESTS.map((file) => `--exclude ${file}`).join(" ")}` : "npm test";

const GATES = [
  { name: "typecheck", why: "src/ compiles under the strict config", cmd: "npm run typecheck" },
  { name: "app:check", why: "app/ compiles under ITS OWN tsconfig", cmd: "npm run app:check" },
  { name: "build", why: "dist/ compiles AND actually imports", cmd: "npm run build" },
  {
    name: "app:build",
    why: "app/ actually bundles — worker and wasm URLs resolve",
    cmd: "npm run app:build",
  },
  { name: "test", why: quick ? "the suite, minus the two corpus re-imports" : "the suite", cmd: TEST_CMD },
  {
    name: "blobs:paths",
    why: "no absolute path anywhere in the database",
    cmd: "npm exec vite-node src/blobs/cli.ts -- --db build/hashigo.db paths",
    skip: !HAVE_DB,
    skipWhy: "build/hashigo.db is absent — run `npm run import` first",
  },
];

const selected = only.length === 0 ? GATES : GATES.filter((g) => only.includes(g.name));
if (selected.length === 0) {
  console.error(`gates: no gate matches ${only.join(", ")}`);
  console.error(`gates: known gates are ${GATES.map((g) => g.name).join(", ")}`);
  process.exit(2);
}

const results = [];
let hardFailure = false;

for (const gate of selected) {
  if (gate.skip) {
    results.push({ name: gate.name, verdict: "SKIP", detail: gate.skipWhy, ms: 0 });
    console.log(`\n─── ${gate.name}: SKIPPED — ${gate.skipWhy}`);
    continue;
  }

  console.log(`\n─── ${gate.name} — ${gate.why}`);
  const started = Date.now();
  const proc = spawnSync(gate.cmd, {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ms = Date.now() - started;
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const plain = output.replace(/\[[0-9;]*m/g, "");

  let verdict = proc.status === 0 ? "PASS" : "FAIL";
  let detail = "";

  if (proc.error) {
    verdict = "ERROR";
    detail = `the command never ran: ${proc.error.code ?? ""} ${proc.error.message}`;
    hardFailure = true;
    results.push({ name: gate.name, verdict, detail, ms });
    console.error(`    DID NOT RUN — ${detail}`);
    continue;
  }

  if (gate.name === "test") {
    const result = testVerdict(output, proc.status);
    verdict = result.ok ? "PASS" : "FAIL";
    detail = result.detail;
  }

  if (verdict === "FAIL") hardFailure = true;
  results.push({ name: gate.name, verdict, detail, ms });

  const lines = plain.trimEnd().split("\n");
  if (verdict === "FAIL") {
    console.log(lines.slice(-40).join("\n"));
  } else {
    console.log(`    ${detail || lines.at(-1)?.trim() || "ok"}  (${(ms / 1000).toFixed(1)}s)`);
  }
}

const width = Math.max(...results.map((r) => r.name.length));
console.log(`\n${"═".repeat(72)}`);
for (const r of results) {
  const mark =
    r.verdict === "PASS" ? "PASS" : r.verdict === "SKIP" ? "SKIP" : r.verdict === "ERROR" ? "!ERR" : "FAIL";
  const secs = r.ms === 0 ? "     " : `${(r.ms / 1000).toFixed(1).padStart(5)}s`;
  console.log(`  ${mark}  ${r.name.padEnd(width)}  ${secs}  ${r.detail}`);
}
console.log("═".repeat(72));

const failed = results.filter((r) => r.verdict === "FAIL" || r.verdict === "ERROR").map((r) => r.name);
if (failed.length > 0) {
  console.log(`gates: FAILED — ${failed.join(", ")}`);
} else {
  const skipped = results.filter((r) => r.verdict === "SKIP").length;
  console.log(`gates: all green${skipped > 0 ? ` (${skipped} skipped)` : ""}${quickNote === "" ? "" : ` — ${quickNote}`}`);
}
process.exit(hardFailure ? 1 : 0);
