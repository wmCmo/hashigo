/**
 * MAKE A RELEASE — decision 59. Every deploy is one.
 *
 *     npm run release -- patch                       # fixes only
 *     npm run release -- minor "what he can now do"  # a milestone
 *     npm run release -- patch --dry                 # say what it would do
 *
 * Bumps `package.json` and `package-lock.json`, commits `release: vX.Y.Z`, and
 * makes an annotated tag whose message lists every commit since the last release
 * (`scripts/release-rules.ts` has the rules and the reasons). It does not push and
 * does not deploy; it prints both commands. `npm run app:build:cloud` refuses any
 * commit that is not a release, so the version in Settings is always one of these.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import {
  CONTRACTS,
  contractValue,
  formatVersion,
  nextVersion,
  parseVersion,
  refuseBump,
  releaseNotes,
  type Bump,
} from "./release-rules.js";

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// vite-node may pass the `--` npm puts before the arguments through; it is not one.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const bump = args[0] as Bump | undefined;
const dry = args.includes("--dry");
const summary = args.slice(1).find((arg) => !arg.startsWith("--")) ?? "";
if (bump !== "patch" && bump !== "minor" && bump !== "major") {
  console.error('usage: npm run release -- patch | minor "what is new" [--dry]');
  process.exit(2);
}
if (bump !== "patch" && summary.trim() === "") {
  console.error(`a ${bump} is a milestone: say what it is — npm run release -- ${bump} "what he can now do"`);
  process.exit(2);
}
if (git("status", "--porcelain", "--untracked-files=no") !== "") {
  console.error("commit or stash first: a release is a commit, and it must be exactly what is tagged.");
  process.exit(1);
}

const pkg = readFileSync("package.json", "utf8");
const current = parseVersion((JSON.parse(pkg) as { version: string }).version);
const previous = `v${formatVersion(current)}`;
try {
  git("rev-parse", "--verify", `refs/tags/${previous}`);
} catch {
  console.error(`package.json says ${formatVersion(current)} but there is no tag ${previous} to measure from.`);
  process.exit(1);
}

const contracts = CONTRACTS.map(({ name, file }) => {
  let before: number | null = null;
  try {
    before = contractValue(git("show", `${previous}:${file}`), name);
  } catch {
    before = null;
  }
  return { name, before, now: contractValue(readFileSync(file, "utf8"), name) };
});
const refusal = refuseBump({ bump, contracts, confirmedMajor: args.includes("--one-point-oh"), current });
if (refusal !== null) {
  console.error(`refused: ${refusal}`);
  process.exit(1);
}

const next = nextVersion(current, bump);
const version = formatVersion(next);
const subjects = git("log", "--no-merges", "--format=%s", `${previous}..HEAD`)
  .split("\n")
  .filter((line) => line !== "");
const notes = releaseNotes(next, summary, subjects);

console.log(`${formatVersion(current)} -> ${version} (${bump}), ${subjects.length} commit(s) since ${previous}`);
console.log(notes);
if (dry) {
  console.log("DRY RUN — nothing written.");
  process.exit(0);
}

// The version line only, so the files keep their formatting.
const swap = (file: string, count: number): void => {
  let text = readFileSync(file, "utf8");
  for (let i = 0; i < count; i += 1) {
    text = text.replace(`"version": "${formatVersion(current)}"`, `"version": "${version}"`);
  }
  writeFileSync(file, text);
};
swap("package.json", 1);
swap("package-lock.json", 2); // the root and `packages[""]`

git("add", "package.json", "package-lock.json");
git("commit", "-m", `release: v${version}${summary.trim() === "" ? "" : ` — ${summary.trim()}`}`);
execFileSync("git", ["tag", "-a", `v${version}`, "-F", "-"], { input: notes, stdio: ["pipe", "inherit", "inherit"] });

console.log(`made release v${version}. Next:`);
console.log(`  git push origin HEAD:main; git push origin v${version}`);
console.log("  npm run app:build:cloud; cd cloud/app; npx wrangler@4 deploy");
