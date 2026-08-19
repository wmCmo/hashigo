/**
 * `npm run build` — compile, copy the non-TypeScript sources tsc ignores, then
 * REFUSE to exit 0 unless the result can actually be imported.
 *
 *   clean dist/  ->  tsc -p tsconfig.build.json  ->  copy src/**\/*.sql  ->  verify
 *
 * Why a clean first: tsc never deletes. A file removed from src/ lingers in
 * dist/ forever, and the verifier's byte-identity check would be comparing
 * against a file that no longer has a source.
 *
 * Why copy the .sql rather than inline it into the TypeScript — the two options,
 * weighed:
 *
 *   Inlining (generate a `.ts` holding the DDL as a string literal, import it)
 *   is the right end state, because the browser/OPFS target has no filesystem
 *   and a bundler cannot honour `readFileSync`. But it does not buy that today:
 *   `src/schema/index.ts` opens with a top-level, unconditional
 *   `import { readFileSync } from "node:fs"`, so a browser bundler has to
 *   resolve `node:fs` whether or not the call still happens. Inlining the SQL
 *   while that import stands moves zero of the browser problem, and it requires
 *   editing a module this build script does not own.
 *
 *   Copying is honest about what exists: a Node library whose schema lives in
 *   .sql files. It is three lines and it makes the artefact work.
 *
 * So: copy now, and put the weight on the GATE instead of on the mechanism. The
 * verifier's central assertion (check F) is that `dist/schema/index.js` serves
 * exactly the DDL in `src/schema/*.sql` — an assertion about the module's
 * exports, not about files on disk. It keeps its full meaning on the day stage
 * 0.5 deletes the `node:fs` import and inlines the SQL for the bundler; the copy
 * step goes away and the gate does not move.
 *
 *   node scripts/build.mjs               full build
 *   node scripts/build.mjs --verify-only re-check dist/ without rebuilding
 *   node scripts/build.mjs --no-clean    incremental; skip the dist/ wipe
 *
 * Fault injection, so the gate itself is testable rather than merely asserted:
 * `HASHIGO_BUILD_FAULT=skip-copy` performs the compile and skips the copy —
 * i.e. reproduces exactly the broken build this replaces — and the build must
 * fail. Any other value is rejected, so a typo cannot silently disable a step.
 */
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

/** Every file under `dir` ending in `extension`, recursively. */
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

// ─── 1. clean ────────────────────────────────────────────────────────────────
if (!noClean && existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
  step("cleaned dist/");
}

// ─── 2. compile ──────────────────────────────────────────────────────────────
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

// ─── 3. copy what tsc ignores ────────────────────────────────────────────────
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

// ─── 4. verify, in a child, and demand proof of completion ───────────────────
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
/**
 * The exit code is not sufficient on its own. The verifier imports every emitted
 * module, and an imported module with a top-level `process.exit(0)` would end
 * the verifier early with a success code and nothing checked. So success has to
 * be claimed explicitly, on the last line of stdout.
 */
if (!/^hashigo-build: VERIFIED /m.test(verifier.stdout ?? "")) {
  die(
    "the verifier exited 0 without printing its VERIFIED sentinel — it did not finish. " +
      "Most likely an emitted module called process.exit() while being imported.",
  );
}

console.log("hashigo-build: OK — dist/ compiled, complete, and importable");
