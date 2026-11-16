import type BetterSqlite3 from "better-sqlite3";

import type { BrowserDb, SqliteHandle, SqliteStatement } from "../src/db/browser.js";

declare const nodeDatabase: BetterSqlite3.Database;
declare const nodeStatement: BetterSqlite3.Statement;
declare const browserDatabase: BrowserDb;

export const nodeSatisfiesContract: SqliteHandle = nodeDatabase;
export const nodeStatementSatisfiesContract: SqliteStatement = nodeStatement;

export const browserSatisfiesContract: SqliteHandle = browserDatabase;
export const browserStatementSatisfiesContract: SqliteStatement = browserDatabase.prepare("SELECT 1");

function countCards(db: SqliteHandle): number {
  return Number(db.prepare("SELECT count(*) FROM cards").pluck().get());
}

export const bothWork: readonly number[] = [countCards(nodeDatabase), countCards(browserDatabase)];
