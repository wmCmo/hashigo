#!/usr/bin/env node
/**
 * EVERY GATE, ONE COMMAND, AND AN EXIT CODE THAT MEANS WHAT IT SAYS.
 *
 * `CLAUDE.md` documents six gates and no way to run them together. So they were run
 * by hand, in whatever order, and `npm run app:check` — called a REQUIRED gate in
 * that same file — was the one most often skipped, because it is the only one that
 * is not part of any other command's output.
 *
 * Chaining them by hand is worse than not chaining them. `npm test` exited 1 on a
 * fully passing run for months (see the note below), so `a && b && c` reported a
 * break that was not there, and the documented advice was "read the pass count" —
 * advice a `&&` cannot take.
 *
 * WHY THIS IS NOT A CI CONFIG. There is no remote (`git remote -v` is empty) and
 * pushing is not authorised, so a `.github/workflows/*.yml` would be a file that
 * never runs. This is the same idea aimed at the machine the work actually happens
 * on.
 *
 * THE ORDER IS DELIBERATE: cheapest and most likely to fail first, so a broken tree
 * is reported in seconds rather than after the 90-second suite. Sequential, not
 * parallel — the suite already saturates six workers, and racing a `tsc` against it
 * only makes both slower and the timings meaningless.
 *
 * ON THE TEST GATE'S EXIT CODE. birpc's RPC timeout is a hard-coded 60,000 ms
 * (`DEFAULT_TIMEOUT = 6e4`, `node_modules/vitest/dist/chunks/index.*.js`) and vitest
 * never overrides it, so ANY test file whose own wall time exceeds 60 s makes its
 * worker throw `Timeout calling "onTaskUpdate"`, which vitest counts as an unhandled
 * error and exits 1 on — with every test passing. That is what used to happen here,
 * to exactly the two files that ran over 60 s.
 *
 * This runner does NOT paper over it. If it sees that shape — zero failed tests, a
 * non-zero exit, and an `onTaskUpdate` timeout — it says so in those words and still
 * fails, because a suite that cannot report its own result is not a passing suite.
 * Pretending otherwise is how the original advice became a trap.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HAVE_DB = existsSync(resolve(ROOT, "build/hashigo.db"));
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

/**
 * ONE STRING, `shell: true`, AND BOTH HALVES OF THAT ARE FORCED.
 *
 * `spawnSync("npm.cmd", [...], { shell: false })` fails outright on Windows with
 * EINVAL — Node stopped allowing `.cmd`/`.bat` to be spawned without a shell in the
 * CVE-2024-27980 fix. And passing an ARRAY of args alongside `shell: true` earns
 * DEP0190, because the shell concatenates them without escaping. So the command is
 * one pre-composed string, which is safe here for the reason the deprecation cares
 * about: every one of them is a literal below, and none contains a space or any user
 * input.
 */
const GATES = [
  { name: "typecheck", why: "src/ compiles under the strict config", cmd: "npm run typecheck" },
  { name: "app:check", why: "app/ compiles under ITS OWN tsconfig", cmd: "npm run app:check" },
  { name: "spike:check", why: "the browser contract still holds", cmd: "npm run spike:check" },
  { name: "build", why: "dist/ compiles AND actually imports", cmd: "npm run build" },
  {
    // `app:check` is `tsc --noEmit` and is blind to every bundler hazard
    // `vite.app.config.ts` documents: the worker URL, the sqlite-wasm asset URL, the
    // OPFS paths. Those break at BUILD time, not at type-check time, and until this
    // was added the app was never built by any gate.
    name: "app:build",
    why: "app/ actually bundles — worker and wasm URLs resolve",
    cmd: "npm run app:build",
  },
  { name: "test", why: "the suite", cmd: "npm test" },
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
    // Captured rather than inherited so the test gate's summary can be parsed. Echoed
    // below either way, so nothing is hidden.
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ms = Date.now() - started;
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const plain = output.replace(/\[[0-9;]*m/g, "");

  let verdict = proc.status === 0 ? "PASS" : "FAIL";
  let detail = "";

  // THE FIRST VERSION OF THIS SCRIPT REPORTED SIX FALSE FAILURES, EACH IN 0.0s,
  // because spawn never launched (EINVAL) and nothing looked at `proc.error`. A gate
  // runner that cannot tell "the gate failed" from "the gate never ran" is worse than
  // no gate runner, so this case is loud and separate.
  if (proc.error) {
    verdict = "ERROR";
    detail = `the command never ran: ${proc.error.code ?? ""} ${proc.error.message}`;
    hardFailure = true;
    results.push({ name: gate.name, verdict, detail, ms });
    console.error(`    DID NOT RUN — ${detail}`);
    continue;
  }

  if (gate.name === "test") {
    // THE EXIT CODE OF `npm test` IS NOT USABLE, so this gate is decided by the
    // SUMMARY instead. That is not leniency — it is stricter in the way that matters:
    // a run must have finished (a summary line exists) and have zero failures. A
    // crash prints no summary and therefore cannot pass, which is what caught
    // `pool: "threads"` segfaulting on its third run.
    const passed = /Tests\s+(?:.*?\| )?(\d[\d,]*) passed/.exec(plain);
    const failed = /Tests\s+(\d[\d,]*) failed/.exec(plain);
    const files = /Test Files\s+(?:.*?\| )?(\d+) passed/.exec(plain);
    const skipped = /(\d[\d,]*) skipped/.exec(plain);
    const rpc = (plain.match(/Timeout calling "onTaskUpdate"/g) ?? []).length;

    const slow = [...plain.matchAll(/(test\/\S+\.test\.ts) \((\d+) tests?[^)]*\) (\d+)ms/g)]
      .map((m) => ({ file: m[1], ms: Number(m[3]) }))
      .filter((f) => f.ms > 60_000)
      .map((f) => `${f.file} (${(f.ms / 1000).toFixed(1)}s)`);

    if (passed === null) {
      // No summary at all: the process died. Segfault, OOM, or a killed worker.
      verdict = "FAIL";
      detail =
        `THE SUITE DID NOT FINISH — no summary line was printed, exit ${proc.status}` +
        (proc.status === 139 ? " (SIGSEGV)" : "") +
        `. This is a crash, not a failing test. Do not re-run and hope.`;
    } else if (failed !== null) {
      verdict = "FAIL";
      detail = `${files?.[1] ?? "?"} files, ${passed[1]} passed, ${failed[1]} FAILED`;
    } else {
      // Finished, nothing failed. Green — whatever the exit code says.
      verdict = "PASS";
      detail = `${files?.[1] ?? "?"} files, ${passed[1]} passed`;
      if (skipped) detail += `, ${skipped[1]} skipped`;
      if (rpc > 0) {
        detail +=
          `  [exit ${proc.status}: ${rpc} × onTaskUpdate timeout — birpc's ceiling is a` +
          ` hard-coded 60s and vitest does not expose it` +
          (slow.length > 0 ? `; over 60s: ${slow.join(", ")}` : "") +
          `. The suite passed; the runner could not say so.]`;
      }
    }
  }

  if (verdict === "FAIL") hardFailure = true;
  results.push({ name: gate.name, verdict, detail, ms });

  // Echo the tail on failure, the last line on success. The full output of six gates
  // is thousands of lines and nobody reads it when everything is green.
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
  console.log(`gates: all green${skipped > 0 ? ` (${skipped} skipped)` : ""}`);
}
process.exit(hardFailure ? 1 : 0);
