/**
 * Stage 1 — the DDL text itself, loaded from disk. NODE ONLY, ON PURPOSE.
 *
 * WHY THIS IS A SEPARATE MODULE FROM `./index.ts`.  It used to live there, and
 * that made `src/schema/index.ts` import `node:fs` and CALL it at module scope.
 * Because the schema module is where the enumerations live, eleven value imports
 * reach it -- `src/template/resolve.ts`, `src/scheduler/policy.ts`,
 * `src/scheduler/schedule.ts`, `src/generate/fields.ts`, `src/generate/voice.ts`,
 * `src/dashboard/metrics.ts` and more -- so *every one of those subsystems threw
 * at module load in a browser worker*, for a filesystem read none of them wanted.
 * `notes/archive/browser-feasibility.md` measured the template engine, the renderer and
 * the metrics as "already browser-ready"; that sentence was false for exactly
 * this reason, and splitting the file is what makes it true.
 *
 * So the rule is: **enumerations, types and transforms go in `./index.ts` and
 * that file stays free of every Node import. Anything that touches I/O goes
 * here.** If you are about to add an import of `node:*` to `./index.ts`, add it
 * to this file instead.
 *
 * THE BROWSER DOES NOT GET A PORT OF THIS, and does not need one yet. A browser
 * build needs DDL only when it CREATES a database from scratch; both spikes open
 * an existing file with `applySchema: false`. When the shell does need it, the
 * seam is a sibling `sources.browser.ts` using the bundler text import already
 * in production in `spike/db.worker.ts` (`import sql from "./schema.sql?raw"`) --
 * which is a Vite specifier and cannot go in a shared path, because `dist/` is
 * plain `tsc` output that Node imports directly (`scripts/verify-dist.mjs`).
 * That is the same shape as `src/blobs/node.ts`, which is a declared seam rather
 * than an omission.
 *
 * `schema.sql` and `views.sql` remain the single authority. They are read, never
 * duplicated into a TypeScript string: `.gitattributes` pins LF precisely so the
 * DDL cannot exist twice with two different hashes.
 */

import { readFileSync } from "node:fs";

function readSql(fileName: string): string {
  const url = new URL(fileName, import.meta.url);
  try {
    return readFileSync(url, "utf8");
  } catch (cause) {
    // Loud on purpose. `tsc` does not copy .sql files, so `dist/schema/` has the
    // compiled module and no SQL beside it. Whatever builds for distribution
    // must copy src/schema/*.sql next to the emitted module -- `npm run build`
    // does, and `scripts/verify-dist.mjs` asserts the copies are byte-identical.
    throw new Error(
      `schema source ${fileName} not found next to this module (${url.pathname}). ` +
        `The build must copy src/schema/*.sql alongside the emitted JS, or inline it.`,
      { cause },
    );
  }
}

export const SCHEMA_SQL = readSql("schema.sql");
export const VIEWS_SQL = readSql("views.sql");

/** In application order: tables and triggers first, then the views over them. */
export const SCHEMA_SOURCES: readonly { readonly name: string; readonly sql: string }[] = [
  { name: "schema.sql", sql: SCHEMA_SQL },
  { name: "views.sql", sql: VIEWS_SQL },
];

/** The whole schema as one script, for tooling that wants a single string. */
export function schemaSql(): string {
  return SCHEMA_SOURCES.map((source) => source.sql).join("\n");
}
