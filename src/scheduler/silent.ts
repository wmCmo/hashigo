/**
 * SILENT CARDS — the ones he can review where he cannot speak.
 *
 * Zach, 2026-10-16: *"sometimes when im outside i may not be able to speak or do
 * shadowing, so i need a mode that i can review all the cards that has no audio,
 * although i believe that that's just the kanji cards"*.
 *
 * **He is nearly right, and the exceptions are why this reads the TEMPLATE rather
 * than a list of deck names.** Measured over the live cards 2026-10-16: 漢字
 * (1,614) and Synonym (8) render no clip at all; 敬語 (17) declares no speech
 * field but its BODY carries an inline `<speech>`, so a field-type check alone
 * would have called it silent; and 302 template-less cards are silent while 33
 * carry an inline `<speech>` or an attached clip. A rule keyed on "漢字" would get
 * all three wrong.
 *
 * A card is SILENT when nothing on it can sound:
 *
 *   * its template neither references a `speech` field (`<<Speech>>`, in any
 *     spacing or section form — `referencedNames` is the lexer the renamer uses)
 *     nor carries an inline `<speech>`; and
 *   * its own content carries no inline `<speech>`; and
 *   * no clip is attached to it (`blob_refs` to a speech or audio blob).
 *
 * **A speech field that is referenced but EMPTY still counts as audible.** 23
 * 基本情報 cards have no clip yet; they are audio cards with a gap, not silent
 * cards, and a silent session that served them would be serving the gap.
 */

import type { SqliteHandle } from "../db/browser.js";
import { referencedNames } from "../template/rename.js";

const INLINE_SPEECH = /<speech[\s>/]/i;

/** Does a template body sound anything? Pure — the database half is below. */
export function templateSpeaks(content: string, speechFields: Iterable<string>): boolean {
  if (INLINE_SPEECH.test(content)) return true;
  const names = referencedNames(content);
  for (const field of speechFields) if (names.has(field.trim())) return true;
  return false;
}

/** The ids of every template whose body can sound. Everything else is silent. */
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

/**
 * The SQL that keeps only silent cards, over the queue's `c` alias.
 *
 * `audible` comes from `audibleTemplateIds`. It is passed in rather than read here
 * because the queue builds its filters without a handle, and because a session
 * reads it once for both halves of the plan.
 */
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
