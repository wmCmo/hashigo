import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const distDir = join(root, "dist");

const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify-only");
const noClean = args.includes("--no-clean") || verifyOnly;

const FAULTS = new Set(["skip-copy"]);
const fault = process.env.HASHIGO_BUILD_FAULT ?? "";
if (fault !== "" && !FAULTS.has(fault)) {
  console.error(
    `hashigo-build: unknown HASHIGO_BUILD_FAULT=${JSON.stringify(fault)}. ` +
      `Known: ${[...FAULTS].join(", ")}. Refusing to build rather than guess.`,
  );
  process.exit(2);
}

const die = (message, code = 1) => {
  console.error(`\nhashigo-build: FAILED — ${message}\n`);
  process.exit(code);
};

const step = (name) => console.log(`hashigo-build: ${name}`);

function collect(dir, extension) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...collect(path, extension));
    else if (entry.endsWith(extension)) found.push(path);
  }
  return found.sort();
}

if (!noClean && existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
  step("cleaned dist/");
}

if (!verifyOnly) {
  step("tsc -p tsconfig.build.json");
  const tsc = spawnSync(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.build.json")],
    { cwd: root, stdio: "inherit" },
  );
  if (tsc.error) die(`could not run tsc: ${tsc.error.message}`);
  if (tsc.status !== 0) die(`tsc exited ${tsc.status}`, tsc.status ?? 1);
}

if (!verifyOnly) {
  if (fault === "skip-copy") {
    console.warn("hashigo-build: HASHIGO_BUILD_FAULT=skip-copy — NOT copying .sql (fault injection)");
  } else {
    const sqlFiles = collect(srcDir, ".sql");
    if (sqlFiles.length === 0) die("no .sql found under src/ — the copy step has nothing to do, which is wrong");
    for (const source of sqlFiles) {
      const target = join(distDir, relative(srcDir, source));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    step(`copied ${sqlFiles.length} .sql file(s) into dist/`);
  }
}

step("verifying dist/");
const verifier = spawnSync(process.execPath, [join(root, "scripts", "verify-dist.mjs")], {
  cwd: root,
  encoding: "utf8",
});
if (verifier.error) die(`could not run the verifier: ${verifier.error.message}`);
if (verifier.stdout) process.stdout.write(verifier.stdout);
if (verifier.stderr) process.stderr.write(verifier.stderr);

if (verifier.status !== 0) {
  die(`dist/ is not usable — see the checks above. (verifier exited ${verifier.status})`, verifier.status ?? 1);
}
if (!/^hashigo-build: VERIFIED /m.test(verifier.stdout ?? "")) {
  die(
    "the verifier exited 0 without printing its VERIFIED sentinel — it did not finish. " +
      "Most likely an emitted module called process.exit() while being imported.",
  );
}

console.log("hashigo-build: OK — dist/ compiled, complete, and importable");
