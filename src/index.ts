/**
 * Entry point, and DELIBERATELY only the identity. Every stage's public surface
 * is a SUBPATH export instead — `hashigo/schema`, `hashigo/import`,
 * `hashigo/template`, `hashigo/render`, `hashigo/search`, `hashigo/blobs`,
 * `hashigo/db`, `hashigo/dashboard`, `hashigo/text`, `hashigo/scheduler/*` — all
 * 13 of them checked importable by `scripts/build.mjs`.
 *
 * A barrel here would re-export `./db`, which loads `better-sqlite3`, a native
 * Node addon. Any browser bundle that touched `hashigo` would then pull it in
 * and fail, and the browser is where this ships. So this file stays two consts;
 * the docstring used to promise re-exports that were never added, which is a
 * worse defect than the missing barrel because it reads as an oversight.
 */
export const APP_NAME = "hashigo";
export const APP_NAME_JA = "梯子";
