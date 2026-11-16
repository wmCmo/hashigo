import type { SqliteHandle } from "../db/browser.js";
import { normaliseTagPath, tagPrefixes, tagRow } from "../import/tags.js";
import { parseContent } from "../template/index.js";
import { tagPathsOf } from "./link-names.js";

export function tagsInText(text: string): string[] {
  const out = new Set<string>();
  for (const raw of tagPathsOf(parseContent(text))) {
    const path = normaliseTagPath(raw);
    if (path !== "") out.add(path);
  }
  return [...out];
}

export function refreshCardTags(db: SqliteHandle, cardIds: Iterable<string>): number {
  const values = db.prepare("SELECT value FROM card_field_values WHERE card_id = ?");
  const putTag = db.prepare(
    "INSERT INTO tags (path, parent_path, name) VALUES (?, ?, ?) ON CONFLICT (path) DO NOTHING",
  );
  const putCardTag = db.prepare(
    "INSERT INTO card_tags (card_id, tag_path, manual) VALUES (?, ?, 0) ON CONFLICT DO NOTHING",
  );
  let added = 0;
  for (const cardId of new Set(cardIds)) {
    const paths = new Set<string>();
    for (const row of values.all(cardId) as { value: string }[]) {
      if (!row.value.includes("#")) continue;
      for (const path of tagsInText(row.value)) paths.add(path);
    }
    for (const path of paths) {
      for (const prefix of tagPrefixes(path)) {
        const tag = tagRow(prefix);
        putTag.run(tag.path, tag.parent_path, tag.name);
      }
      added += Number((putCardTag.run(cardId, path) as { changes?: number }).changes ?? 0);
    }
  }
  return added;
}
