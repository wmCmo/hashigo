/**
 * `npm test`, with an exit code that means what it says.
 *
 * Vitest exits 1 on a fully passing run of this suite — see `./test-verdict.mjs`
 * for why, and for why the summary is a STRICTER check than the exit code rather
 * than a lenient one. This runs vitest, streams every byte of its output through
 * unchanged, and then decides.
 *
 * Everything after `npm test` is passed through, so `npm test -- test/glance.test.ts`
 * and `npm test -- --reporter=verbose` work as they did.
 *
 * `npm run test:raw` is the unfiltered vitest, for when the exit code itself is the
 * thing under investigation.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { testVerdict } from "./test-verdict.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

// Captured rather than inherited, because the summary has to be read — and echoed
// as it arrives so nothing is hidden and a long run does not look hung.
const proc = spawnSync("npx", ["vitest", "run", ...args], {
  cwd: ROOT,
  encoding: "utf8",
  shell: true,
  // 256 MiB, NOT the 1 MiB default. A failing corpus run prints every assertion's
  // diff and overruns it; spawnSync then dies with ENOBUFS and this wrapper —
  // whose whole job is to read the SUMMARY — reported "vitest never ran" instead
  // of the failures. The verdict rule is stricter than the exit code precisely so
  // a run that produced no summary cannot pass, and a truncated capture is exactly
  // that case. Seen 2026-09-08, on the re-import that made 77 tests fail at once.
  maxBuffer: 256 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
});

const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
process.stdout.write(output);

if (proc.error) {
  // A command that never ran is not a suite that failed, and `status` cannot tell
  // them apart — a spawn that dies with EINVAL leaves it null.
  console.error(`\nvitest never ran: ${proc.error.code ?? ""} ${proc.error.message}`);
  process.exit(2);
}

const verdict = testVerdict(output, proc.status);
console.log(`\n${verdict.ok ? "PASS" : "FAIL"}  ${verdict.detail}`);
process.exit(verdict.ok ? 0 : 1);
