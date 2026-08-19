/**
 * Prove that `dist/` is a package that can actually be imported.
 *
 * `tsc` emits JavaScript and nothing else. `src/schema/index.ts` reads its DDL
 * from `schema.sql` next to itself at import time, so a `tsc`-only build shipped
 * `dist/schema/index.js` with no SQL beside it and threw on the first line —
 * while `npm run build` exited 0. A build that goes green on an artefact nobody
 * can import is worse than no build at all, because CI believes it.
 *
 * So the build does not get to claim success on the strength of an exit code.
 * This runs after the copy step and asserts, in order:
 *
 *   A  dist/ exists and holds emitted JavaScript
 *   B  every src/ *.sql has a BYTE-IDENTICAL twin in dist/ (a stale copy from an
 *      older schema would otherwise pass an existence check while shipping the
 *      wrong DDL)
 *   C  no orphan .sql in dist/ that no longer exists in src/
 *   D  every emitted .js has its .d.ts beside it — catches a half-finished emit
 *   E  every emitted module IMPORTS, for real, in this process (bar the CLIs,
 *      which execute on import — see `isEntryPoint`)
 *   F  dist/schema/index.js really does expose the DDL, and it is the same DDL
 *      that is in src/
 *   G  every path package.json advertises (main, types, exports) exists
 *
 * Check F is deliberately written against the module's exports rather than
 * against the copied files, so it keeps its meaning when stage 0.5 stops reading
 * SQL from disk and inlines it for the browser bundle instead.
 *
 *   node scripts/verify-dist.mjs
 *
 * Checks accumulate rather than short-circuit, so one run tells you everything
 * that is wrong with the artefact. Exits non-zero if anything is. On success the
 * last line of stdout is the sentinel `hashigo-build: VERIFIED ...`, which `build.mjs`
 * requires — an exit code alone is forgeable by any module that calls
 * `process.exit(0)` while being imported.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const distDir = join(root, "dist");

/**
 * Emitted modules that RUN when imported instead of just defining things.
 *
 * `src/dashboard/cli.ts` and `src/blobs/cli.ts` both end in a bare
 * `main(process.argv.slice(2))` with no `import.meta.main` guard, so importing
 * either one starts a CLI — and `blobs/cli.js` calls `process.exit(2)` on
 * "no command given", which kills whatever imported it. Check E therefore skips
 * them.
 *
 * The rule is the repo's own naming convention rather than a hand-kept list,
 * because a list rots the moment somebody adds a CLI: any emitted `cli.js` is
 * treated as an entry point. Little coverage is lost — a CLI's own imports are
 * every other module in dist/, and those are each imported directly — but the
 * gap is real, so at least one must exist or the rule is covering nothing and
 * says so.
 */
const isEntryPoint = (path) => path.endsWith(`${sep}cli.js`) || path.endsWith("/cli.js");

const failures = [];
const fail = (check, message) => failures.push(`[${check}] ${message}`);
const posix = (path) => relative(root, path).split("\\").join("/");

/** Every file under `dir` with one of `extensions`, recursively, sorted. */
function collect(dir, extensions) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...collect(path, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) found.push(path);
  }
  return found.sort();
}

// ─── A. there is something to check ──────────────────────────────────────────
if (!existsSync(distDir)) {
  console.error(`hashigo-build: FAILED [A] no dist/ at ${distDir}. Run the build first.`);
  process.exit(1);
}
const emitted = collect(distDir, [".js"]);
if (emitted.length === 0) {
  console.error(`hashigo-build: FAILED [A] dist/ exists but emitted no .js files.`);
  process.exit(1);
}

// ─── B. the SQL really is beside the JS, byte for byte ───────────────────────
const sqlSources = collect(srcDir, [".sql"]);
if (sqlSources.length === 0) fail("B", "no .sql files under src/ — has the schema moved?");
for (const source of sqlSources) {
  const target = join(distDir, relative(srcDir, source));
  if (!existsSync(target)) {
    fail("B", `${posix(target)} is missing. tsc does not copy .sql; the copy step did not run.`);
    continue;
  }
  if (!readFileSync(source).equals(readFileSync(target))) {
    fail("B", `${posix(target)} differs from ${posix(source)} — stale copy, wrong DDL would ship.`);
  }
}

// ─── C. no orphan SQL left over from an older layout ─────────────────────────
for (const stale of collect(distDir, [".sql"])) {
  const origin = join(srcDir, relative(distDir, stale));
  if (!existsSync(origin)) fail("C", `${posix(stale)} has no source at ${posix(origin)} — stale dist.`);
}

// ─── D. the emit is complete ─────────────────────────────────────────────────
for (const js of emitted) {
  const types = `${js.slice(0, -3)}.d.ts`;
  if (!existsSync(types)) fail("D", `${posix(js)} emitted without ${posix(types)} — incomplete emit.`);
}

// ─── E. every module imports ─────────────────────────────────────────────────
const entryPoints = emitted.filter(isEntryPoint);
if (entryPoints.length === 0) {
  fail("E", "no dist/**/cli.js found — the entry-point skip rule now covers nothing. Check it.");
}
let importedCount = 0;
for (const js of emitted) {
  if (isEntryPoint(js)) continue;
  try {
    const module = await import(pathToFileURL(js).href);
    if (Object.keys(module).length === 0) {
      fail("E", `${posix(js)} imported but exports nothing — dead file, or a failed emit.`);
    }
    importedCount += 1;
  } catch (error) {
    fail("E", `${posix(js)} THREW on import: ${error?.message ?? error}`);
  }
}

// ─── F. the schema module hands back the schema ──────────────────────────────
const schemaModule = join(distDir, "schema", "index.js");
if (!existsSync(schemaModule)) {
  fail("F", `${posix(schemaModule)} does not exist.`);
} else {
  try {
    const schema = await import(pathToFileURL(schemaModule).href);
    const expected = {
      SCHEMA_SQL: join(srcDir, "schema", "schema.sql"),
      VIEWS_SQL: join(srcDir, "schema", "views.sql"),
    };
    for (const [name, source] of Object.entries(expected)) {
      const value = schema[name];
      if (typeof value !== "string" || value.length === 0) {
        fail("F", `${name} is not a non-empty string (got ${typeof value}).`);
      } else if (existsSync(source) && value !== readFileSync(source, "utf8")) {
        fail("F", `${name} does not match ${posix(source)} — the module is serving different DDL.`);
      }
    }
    if (typeof schema.schemaSql === "function") {
      const whole = schema.schemaSql();
      if (typeof whole !== "string" || !whole.includes("CREATE TABLE")) {
        fail("F", "schemaSql() did not return DDL containing CREATE TABLE.");
      }
    } else {
      fail("F", "schemaSql is not exported as a function.");
    }
  } catch (error) {
    fail("F", `importing the schema module threw: ${error?.message ?? error}`);
  }
}

// ─── G. package.json points at files that exist ──────────────────────────────
/**
 * `main`, `types` and every target in `exports` are promises the package makes
 * to whoever imports it. A promise aimed at a file tsc never emitted is the same
 * class of bug as the missing .sql: nothing fails until someone tries to use it.
 */
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = new Set();
const claim = (value) => {
  if (typeof value === "string") {
    if (value.startsWith("./dist/")) declared.add(value);
  } else if (value && typeof value === "object") {
    for (const nested of Object.values(value)) claim(nested);
  }
};
claim(manifest.main);
claim(manifest.types);
claim(manifest.exports);
for (const target of [...declared].sort()) {
  const path = join(root, target);
  if (!existsSync(path)) {
    fail("G", `package.json declares ${target}, which the build did not emit.`);
  }
}

// ─── report ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nhashigo-build: FAILED — ${failures.length} problem(s) in dist/\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    `\nThe build produced an artefact that does not work. Exiting non-zero on purpose:\n` +
      `an exit-0 build over a broken package is how this shipped last time.\n`,
  );
  process.exit(1);
}

console.log(
  `hashigo-build: VERIFIED ${importedCount} modules imported, ` +
    `${entryPoints.length} CLI(s) skipped, ${sqlSources.length} .sql byte-identical, ` +
    `${emitted.length} .js with types, ` +
    `${declared.size} package.json entry points resolve`,
);
