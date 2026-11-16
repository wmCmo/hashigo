import type { SqliteHandle } from "../db/browser.js";
import { referencedNames } from "../template/rename.js";

const INLINE_SPEECH = /<speech[\s>/]/i;

export function templateSpeaks(content: string, speechFields: Iterable<string>): boolean {
  if (INLINE_SPEECH.test(content)) return true;
  const names = referencedNames(content);
  for (const field of speechFields) if (names.has(field.trim())) return true;
  return false;
}

export function audibleTemplateIds(db: SqliteHandle): string[] {
  const templates = db.prepare("SELECT id, content FROM templates").all() as {
    id: string;
    content: string | null;
  }[];
  const speech = db
    .prepare("SELECT template_id, name FROM template_fields WHERE type = 'speech'")
    .all() as { template_id: string; name: string }[];
  const byTemplate = new Map<string, string[]>();
  for (const row of speech) {
    const list = byTemplate.get(row.template_id) ?? [];
    list.push(row.name);
    byTemplate.set(row.template_id, list);
  }
  return templates
    .filter((t) => templateSpeaks(t.content ?? "", byTemplate.get(t.id) ?? []))
    .map((t) => t.id);
}

export function silentCardFilter(audible: readonly string[]): {
  readonly sql: string;
  readonly params: unknown[];
} {
  const templates =
    audible.length === 0
      ? ""
      : ` AND (c.template_id IS NULL OR c.template_id NOT IN (${audible.map(() => "?").join(", ")}))`;
  return {
    sql:
      templates +
      ` AND instr(lower(coalesce(c.content, '')), '<speech') = 0` +
      ` AND NOT EXISTS (SELECT 1 FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash` +
      ` WHERE r.card_id = c.id AND (b.kind = 'speech' OR b.mime LIKE 'audio/%'))`,
    params: [...audible],
  };
}
