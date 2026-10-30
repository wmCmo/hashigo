/**
 * Refuse a cloud build of anything that is not a release — decision 59.
 *
 * Runs first in `npm run app:build:cloud`. The local and gate builds
 * (`app:build`) are not checked: they never reach a device he reviews on.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { refuseDeploy } from "./release-rules.js";

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const refusal = refuseDeploy({
  version,
  headTags: git("tag", "--points-at", "HEAD").split("\n").filter((tag) => tag !== ""),
  dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
});
if (refusal !== null) {
  console.error(`app:build:cloud refused: ${refusal}`);
  process.exit(1);
}
console.log(`release v${version} — building it for the cloud`);
