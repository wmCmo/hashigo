import { readFileSync } from "node:fs";

function readSql(fileName: string): string {
  const url = new URL(fileName, import.meta.url);
  try {
    return readFileSync(url, "utf8");
  } catch (cause) {
    throw new Error(
      `schema source ${fileName} not found next to this module (${url.pathname}). ` +
        `The build must copy src/schema/*.sql alongside the emitted JS, or inline it.`,
      { cause },
    );
  }
}

export const SCHEMA_SQL = readSql("schema.sql");
export const VIEWS_SQL = readSql("views.sql");

export const SCHEMA_SOURCES: readonly { readonly name: string; readonly sql: string }[] = [
  { name: "schema.sql", sql: SCHEMA_SQL },
  { name: "views.sql", sql: VIEWS_SQL },
];

export function schemaSql(): string {
  return SCHEMA_SOURCES.map((source) => source.sql).join("\n");
}
