import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { testVerdict } from "./test-verdict.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

const proc = spawnSync("npx", ["vitest", "run", ...args], {
  cwd: ROOT,
  encoding: "utf8",
  shell: true,
  maxBuffer: 256 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
});

const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
process.stdout.write(output);

if (proc.error) {
  console.error(`\nvitest never ran: ${proc.error.code ?? ""} ${proc.error.message}`);
  process.exit(2);
}

const verdict = testVerdict(output, proc.status);
console.log(`\n${verdict.ok ? "PASS" : "FAIL"}  ${verdict.detail}`);
process.exit(verdict.ok ? 0 : 1);
