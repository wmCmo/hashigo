/**
 * The proof that "callers do not branch" is true rather than claimed — checked by
 * `npm run typecheck`, which covers `test/`.
 *
 * MOVED HERE FROM `spike/` 2026-10-27, and its own gate (`spike:check`) dropped.
 * Measured first, not assumed: a method added to `SqliteHandle` and implemented
 * only by the browser handle turned `typecheck` red with 667 errors and
 * `app:check` with 3, because scripts and tests hand better-sqlite3 databases to
 * contract-typed functions everywhere. The gate caught nothing the others did not;
 * the explicit assertions below are kept because they name the property.
 *
 * `SqliteHandle` / `SqliteStatement` in `src/db/browser.ts` are the surface both
 * halves of `src/db` provide. This file asserts, through tsc and nothing else,
 * that **better-sqlite3's own `Database` and `Statement` satisfy them**. If
 * someone widens the browser adapter's contract beyond what better-sqlite3 can
 * do, this stops compiling — which is the moment to find out, not stage 7.
 *
 * It is not a vitest test on purpose: the suite's count is a published figure
 * (321 passed / 1 skipped) and a type-only assertion has no runtime to test.
 * Nothing here executes; there are no values at all.
 */

import type BetterSqlite3 from "better-sqlite3";

import type { BrowserDb, SqliteHandle, SqliteStatement } from "../src/db/browser.js";

declare const nodeDatabase: BetterSqlite3.Database;
declare const nodeStatement: BetterSqlite3.Statement;
declare const browserDatabase: BrowserDb;

/** Node's handle is usable everywhere portable code expects the contract. */
export const nodeSatisfiesContract: SqliteHandle = nodeDatabase;
export const nodeStatementSatisfiesContract: SqliteStatement = nodeStatement;

/** And so is the browser's. */
export const browserSatisfiesContract: SqliteHandle = browserDatabase;
export const browserStatementSatisfiesContract: SqliteStatement = browserDatabase.prepare("SELECT 1");

/**
 * The point of all that: one function body, typed against the contract, run
 * against either handle without a branch or a cast.
 */
function countCards(db: SqliteHandle): number {
  return Number(db.prepare("SELECT count(*) FROM cards").pluck().get());
}

export const bothWork: readonly number[] = [countCards(nodeDatabase), countCards(browserDatabase)];
