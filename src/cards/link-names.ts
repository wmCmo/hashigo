import type { SqliteHandle } from "../db/browser.js";
import { walkSides, type Side } from "../template/ast.js";

export type LinkNames = Readonly<Record<string, string>>;

export function linkTargetsOf(sides: readonly Side[]): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  walkSides(sides, (node) => {
    if (node.kind !== "wikiLink") return;
    if (seen.has(node.target)) return;
    seen.add(node.target);
    targets.push(node.target);
  });
  return targets;
}

export function linkNamesFor(db: SqliteHandle, sides: readonly Side[]): LinkNames {
  const targets = linkTargetsOf(sides);
  if (targets.length === 0) return {};
  const placeholders = targets.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, name FROM cards WHERE id IN (${placeholders})`)
    .all(...targets) as readonly { id: string; name: string | null }[];
  const names: Record<string, string> = {};
  for (const row of rows) {
    if (row.name === null || row.name.trim() === "") continue;
    names[row.id] = row.name;
  }
  return names;
}

export function tagPathsOf(sides: readonly Side[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  walkSides(sides, (node) => {
    if (node.kind !== "tag" || node.path === "") return;
    if (seen.has(node.path)) return;
    seen.add(node.path);
    paths.push(node.path);
  });
  return paths;
}

export function knownTagsFor(db: SqliteHandle, sides: readonly Side[]): string[] {
  const paths = tagPathsOf(sides);
  if (paths.length === 0) return [];
  const placeholders = paths.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT path FROM tags WHERE path IN (${placeholders})`)
    .all(...paths) as readonly { path: string }[];
  return rows.map((row) => row.path);
}
