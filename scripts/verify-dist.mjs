import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const distDir = join(root, "dist");

const isEntryPoint = (path) => path.endsWith(`${sep}cli.js`) || path.endsWith("/cli.js");

const failures = [];
const fail = (check, message) => failures.push(`[${check}] ${message}`);
const posix = (path) => relative(root, path).split("\\").join("/");

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

if (!existsSync(distDir)) {
  console.error(`hashigo-build: FAILED [A] no dist/ at ${distDir}. Run the build first.`);
  process.exit(1);
}
const emitted = collect(distDir, [".js"]);
if (emitted.length === 0) {
  console.error(`hashigo-build: FAILED [A] dist/ exists but emitted no .js files.`);
  process.exit(1);
}

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

for (const stale of collect(distDir, [".sql"])) {
  const origin = join(srcDir, relative(distDir, stale));
  if (!existsSync(origin)) fail("C", `${posix(stale)} has no source at ${posix(origin)} — stale dist.`);
}

for (const js of emitted) {
  const types = `${js.slice(0, -3)}.d.ts`;
  if (!existsSync(types)) fail("D", `${posix(js)} emitted without ${posix(types)} — incomplete emit.`);
}

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

const schemaModule = join(distDir, "schema", "sources.js");
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

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = new Set();
const exportSubpaths = Object.keys(manifest.exports).filter((k) => k !== "./package.json").length;
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
    `${declared.size} declared dist targets resolve (${exportSubpaths} export subpaths)`,
);
