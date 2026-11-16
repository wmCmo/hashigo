import type { Db } from "../db/index.js";
import { putBlobRecord, retargetBlobRef } from "../import/blobs.js";
import { synthesise, VOICE, type SpeechRequest } from "./speech.js";
import { normaliseSourceText } from "../blobs/generation.js";
import { sha256Hex, type BlobStore } from "../blobs/index.js";
import { accentKey } from "./key.js";

const WORD_FIELDS_SQL = `
SELECT tf.id AS fieldId, tf.template_id AS templateId, tf.source_field_id AS sourceId
  FROM template_fields tf
  JOIN template_fields a ON a.template_id = tf.template_id AND a.type = 'accent'
 WHERE tf.type = 'speech'
   AND tf.source_field_id IS NOT NULL
   AND tf.source_field_id = a.source_field_id`;

export interface RespeakWord {
  readonly text: string;
  readonly request: SpeechRequest | null;
  readonly refs: readonly { cardId: string; fieldId: string | null; refKey: string }[];
}

export function respeakPlan(db: Db): RespeakWord[] {
  const fields = db.prepare(WORD_FIELDS_SQL).all() as {
    fieldId: string;
    templateId: string;
    sourceId: string;
  }[];
  const templateIds = [...new Set(fields.map((field) => field.templateId))];

  const accents = new Map<string, { reading: string; accent: number }>();
  for (const row of db
    .prepare(
      `SELECT text, reading, accent_type AS accent FROM accents
        WHERE analyser = 'openjtalk' AND accent_type IS NOT NULL AND reading IS NOT NULL`,
    )
    .all() as { text: string; reading: string; accent: number }[]) {
    if (!accents.has(row.text)) accents.set(row.text, { reading: row.reading, accent: row.accent });
  }

  const refsByText = new Map<string, RespeakWord["refs"][number][]>();
  for (const row of db
    .prepare(
      `SELECT r.card_id AS cardId, r.field_id AS fieldId, r.ref_key AS refKey,
              b.source_text AS sourceText
         FROM blob_refs r
         JOIN blobs b ON b.hash = r.blob_hash
         JOIN cards c ON c.id = r.card_id
        WHERE b.kind = 'speech' AND b.source_text IS NOT NULL
          AND c.template_id IN (${templateIds.map(() => "?").join(",") || "NULL"})`,
    )
    .all(...templateIds) as {
    cardId: string;
    fieldId: string | null;
    refKey: string;
    sourceText: string;
  }[]) {
    const held = refsByText.get(row.sourceText) ?? [];
    held.push({ cardId: row.cardId, fieldId: row.fieldId, refKey: row.refKey });
    refsByText.set(row.sourceText, held);
  }

  const words = new Map<string, RespeakWord>();
  for (const { templateId, sourceId } of fields) {
    const rows = db
      .prepare(
        `SELECT v.value AS text
           FROM cards c
           JOIN card_field_values v ON v.card_id = c.id AND v.field_id = ?
          WHERE c.template_id = ? AND v.value <> ''`,
      )
      .all(sourceId, templateId) as { text: string }[];

    for (const row of rows) {
      const source = normaliseSourceText(row.text);
      if (source === "" || words.has(source)) continue;
      words.set(source, {
        text: source,
        request: accents.get(accentKey(row.text)) ?? null,
        refs: refsByText.get(source) ?? [],
      });
    }
  }
  return [...words.values()];
}

export function collisions(plan: readonly RespeakWord[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const word of plan) {
    if (word.request === null) continue;
    const key = `${word.request.reading}/${word.request.accent}`;
    groups.set(key, [...(groups.get(key) ?? []), word.text]);
  }
  for (const [key, words] of groups) if (words.length < 2) groups.delete(key);
  return groups;
}

export interface RespeakOptions {
  readonly apiKey: string;
  readonly store: BlobStore;
  readonly voice?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly onWord?: (text: string, outcome: "made" | "cached" | "failed", detail?: string) => void;
}

export interface RespeakReport {
  made: number;
  cached: number;
  failed: number;
  annotated: number;
  plain: number;
  refsMoved: number;
  readonly failures: string[];
}

export async function respeakWord(
  db: Db,
  word: RespeakWord,
  options: RespeakOptions,
): Promise<{ hash: string; made: boolean }> {
  const voice = options.voice ?? VOICE;
  const identity = { sourceText: word.text, voice, lang: "ja-JP", options: "{}" };
  const held = db
    .prepare(
      `SELECT hash FROM blobs
        WHERE kind = 'speech' AND source_text = ? AND voice IS ? AND lang IS ? AND options = ?
          AND byte_size > 0 ORDER BY hash LIMIT 1`,
    )
    .get(word.text, voice, "ja-JP", "{}") as { hash: string } | undefined;
  if (held !== undefined) return { hash: held.hash, made: false };

  const bytes = await synthesise(word.text, word.request, {
    apiKey: options.apiKey,
    voice,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const address = sha256Hex(bytes);

  const clash = db
    .prepare(`SELECT source_text FROM blobs WHERE hash = ?`)
    .get(address) as { source_text: string | null } | undefined;
  if (clash !== undefined && clash.source_text !== word.text) {
    throw new Error(
      `identical audio to "${clash.source_text}" — same reading and accent, so ` +
        `the same bytes. \`blobs.hash\` is a PRIMARY KEY, so this word cannot get ` +
        `its own row and its cards would go silent.`,
    );
  }

  options.store.write(address, bytes);
  const { hash } = putBlobRecord(db, {
    hash: address,
    kind: "speech",
    mime: "audio/mpeg",
    byteSize: bytes.length,
    identity,
  });
  return { hash, made: true };
}

export function adoptVoice(db: Db, voice: string = VOICE): number {
  const words = db.prepare(WORD_FIELDS_SQL).all() as { fieldId: string; templateId: string }[];
  const readOptions = db.prepare(
    "SELECT options FROM template_fields WHERE template_id = ? AND id = ?",
  );
  const fields = words.map((word) => ({
    ...word,
    options: (readOptions.get(word.templateId, word.fieldId) as { options: string }).options,
  }));
  let changed = 0;
  for (const field of fields) {
    const parsed = JSON.parse(field.options) as Record<string, string>;
    if (parsed["voice"] === voice) continue;
    parsed["voice"] = voice;
    db.prepare(
      `UPDATE template_fields SET options = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE template_id = ? AND id = ?`,
    ).run(JSON.stringify(parsed), field.templateId, field.fieldId);
    changed += 1;
  }
  return changed;
}

export function moveRefs(db: Db, word: RespeakWord, hash: string): number {
  let moved = 0;
  for (const ref of word.refs) {
    if (retargetBlobRef(db, { cardId: ref.cardId, fieldId: ref.fieldId, refKey: ref.refKey }, hash)) {
      moved += 1;
    }
  }
  return moved;
}
