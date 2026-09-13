/**
 * Regenerate the head-word clips so the audio agrees with the `型` label.
 *
 * `./speech.ts` carries the finding, the survey and the trap; this file is the
 * orchestration over the database and the store. Read that header first.
 *
 * ─── THE TWO FIELDS, AND WHY ONLY THOSE TWO ─────────────────────────────────
 *
 * `template_fields` stores the voice PER FIELD. Ten fields are `type = speech`
 * and only two of them speak the head word of a card that carries an accent
 * label: `単語 / Speech` and `言葉 / Speech`, both sourced from the card name.
 * That is the same pair decision 29 scopes `identify` to, and it is not a
 * coincidence — they are the templates that declare an `accent` field.
 *
 * The others are deliberately untouched: `Audio` on both templates speaks the
 * EXAMPLE SENTENCE, which the pipeline never annotates (several accent phrases;
 * a boundary heuristic that fails silently on `に引き換え`), and 数字 / 基本情報 /
 * New Vocab are not accent-labelled decks at all.
 *
 * ─── THE ORDER IS LOAD-BEARING ──────────────────────────────────────────────
 *
 * The field's voice is flipped LAST, after every clip exists.
 *
 * A card resolves its clip through `lookupGeneration`, whose identity includes
 * the voice. So the moment the field says `ja-JP-Neural2-C`, every card on that
 * template asks for a Neural2-C clip — and any word not yet regenerated has
 * none. Flipping first would take 3,852 cards silent for the length of the run,
 * and a crash mid-run would leave them that way. `app/main.ts`'s own settings
 * note says the same thing about `voice.default`: a non-empty value "misses all
 * 10,791 speech lookups at once".
 *
 * ─── NOTHING IS DELETED ─────────────────────────────────────────────────────
 *
 * The new clip is a NEW generation identity, so the Nanami payload is untouched
 * and still addressable. `retargetBlobRef` moves each card's reference, which
 * drops the old blob's refcount and stamps `unreferenced_at`; `sweepUnreferenced`
 * owns deletion and only after its grace period. So this is reversible by
 * flipping the two fields back — which is the whole reason it is safe to run on
 * four years of audio.
 */
import type { Db } from "../db/index.js";
import { putBlobRecord, retargetBlobRef } from "../import/blobs.js";
import { synthesise, VOICE, type SpeechRequest } from "./speech.js";
import { normaliseSourceText } from "../blobs/generation.js";
import { sha256Hex, type BlobStore } from "../blobs/index.js";
import { accentKey } from "./key.js";

/** The two fields that speak a head word on an accent-labelled template. */
export const WORD_FIELDS = [
  { template: "単語", field: "Speech" },
  { template: "言葉", field: "Speech" },
] as const;

export interface RespeakWord {
  readonly text: string;
  /** Null when no accent was derived — synthesised plain. See `speech.ts`. */
  readonly request: SpeechRequest | null;
  /**
   * Cards whose reference must follow the new blob.
   *
   * `fieldId` IS NULL IN THIS CORPUS AND THAT IS NOT A BUG TO FIX. The importer
   * records a generated clip as a card-CONTENT reference (`field_id = NULL`)
   * with the attachment filename as its key, so a card carries two speech refs —
   * the head word and the example sentence — told apart only by which blob they
   * point at. Matching on `field_id` finds neither, which is how the first
   * version of this moved 0 references while reporting success.
   */
  readonly refs: readonly { cardId: string; fieldId: string | null; refKey: string }[];
}

/**
 * Every distinct head word on those fields, with its accent and its references.
 *
 * A word with no accent row, or whose reading is not kana, comes back with a
 * null request rather than being skipped: skipping it would leave it with no
 * Neural2-C clip, and the voice flip at the end would silence it.
 */
export function respeakPlan(db: Db): RespeakWord[] {
  const fields = db
    .prepare(
      `SELECT tf.id AS fieldId, tf.template_id AS templateId
         FROM template_fields tf
         JOIN templates t ON t.id = tf.template_id
        WHERE tf.type = 'speech' AND tf.name = 'Speech'
          AND t.name IN (${WORD_FIELDS.map(() => "?").join(",")})`,
    )
    .all(...WORD_FIELDS.map((f) => f.template)) as { fieldId: string; templateId: string }[];

  // TWO NORMALISATIONS, AND THEY ARE NOT THE SAME ONE. Measured on this corpus:
  // six head words carry a U+200E between their characters (`準‎備`, `評‎価`,
  // `田‎‎植え`), and the importer filed BOTH their clip and their accent row under
  // the cleaned text. Joining on the raw column misses the accent AND files a
  // new blob under a string the app never asks for — a silent double failure.
  //
  //   normaliseSourceText   the blob's identity (decision 7: the RENDERED text)
  //   accentKey             the accent row's key (placeholders folded to `~`)
  const accents = new Map<string, { reading: string; accent: number }>();
  for (const row of db
    .prepare(
      `SELECT text, reading, accent_type AS accent FROM accents
        WHERE analyser = 'openjtalk' AND accent_type IS NOT NULL AND reading IS NOT NULL`,
    )
    .all() as { text: string; reading: string; accent: number }[]) {
    if (!accents.has(row.text)) accents.set(row.text, { reading: row.reading, accent: row.accent });
  }

  // Every speech reference on these templates, grouped by the text it speaks.
  // Keyed by the BLOB's `source_text`, which is the only thing that separates a
  // card's head-word clip from its example-sentence clip — see `RespeakWord.refs`.
  const refsByText = new Map<string, RespeakWord["refs"][number][]>();
  for (const row of db
    .prepare(
      `SELECT r.card_id AS cardId, r.field_id AS fieldId, r.ref_key AS refKey,
              b.source_text AS sourceText
         FROM blob_refs r
         JOIN blobs b ON b.hash = r.blob_hash
         JOIN cards c ON c.id = r.card_id
         JOIN templates t ON t.id = c.template_id
        WHERE b.kind = 'speech' AND b.source_text IS NOT NULL
          AND t.name IN (${WORD_FIELDS.map(() => "?").join(",")})`,
    )
    .all(...WORD_FIELDS.map((f) => f.template)) as {
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
  for (const { templateId } of fields) {
    // `card_field_values` where `field_id = 'name'`, NOT `cards.name`. 25 cards
    // on these templates are titled "Untitled card" with an empty head word, and
    // the column would have sent that English string to a Japanese TTS.
    const rows = db
      .prepare(
        `SELECT v.value AS text
           FROM cards c
           JOIN card_field_values v ON v.card_id = c.id AND v.field_id = 'name'
          WHERE c.template_id = ? AND v.value <> ''`,
      )
      .all(templateId) as { text: string }[];

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

/**
 * Words that would be synthesised to the SAME bytes as another word.
 *
 * Predictable before a single call is made: the audio is a function of
 * (reading, accent), so two words sharing both share a sha256 — and
 * `blobs.hash` is a PRIMARY KEY. See `respeakWord` for what that costs.
 *
 * Reported by `--dry` on purpose. The first full run found this the expensive
 * way: $0.15 spent, 3,850 clips made, 0 failures reported, and 161 cards silent.
 */
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
  /** Called after each word, for a progress line. */
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

/**
 * Synthesise and record one word. Returns the content address.
 *
 * RESUMABLE BY CONSTRUCTION. 3,852 calls is long enough to be interrupted, and
 * the generation identity is the cache: a word already regenerated is found by
 * `lookupGeneration` and costs nothing on a second run. That is why this asks
 * the database before it asks Google.
 */
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
  // PAYLOAD FIRST, THEN THE ROW, and the order is the crash-safety.
  //
  // A `blobs` row whose payload is missing is a card that resolves to silence,
  // and `lookupGeneration` would keep returning that address for ever — a
  // permanent cache hit on nothing. A payload with no row is invisible and
  // costs a few KB until the next store audit. Interrupting 3,852 calls is
  // likely enough that the failure mode has to be the harmless one.
  const address = sha256Hex(bytes);

  // ─── HOMOPHONES COLLIDE, AND THE SCHEMA CANNOT HOLD THEM ───────────────────
  //
  // `blobs.hash` is a PRIMARY KEY, so one payload carries ONE generation
  // identity — and `putBlobRecord` is `INSERT OR IGNORE`, so a second identity
  // for the same bytes is dropped without a word.
  //
  // Azure never hit this: it synthesised from the KANJI, so 仮定 and 家庭 were
  // different inputs and different audio. The kanji trap (see `speech.ts`)
  // forces synthesis from the READING, and `カテー` at accent 0 is one sound
  // however it is spelt. Measured on this corpus: 142 groups, 161 words that
  // would lose their row — 仮定/課程/家庭/過程, 合う/会う/遭う, 高価/硬貨/効果.
  //
  // A dropped row is a SILENT CARD, because `lookupGeneration` keys on
  // `source_text` and finds nothing. That is exactly what happened on the first
  // full run: 3,850 clips reported made, 0 failures, and 161 cards mute. So this
  // refuses rather than reporting a success it did not achieve.
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

/**
 * Flip the two fields onto the new voice.
 *
 * LAST. See the header: a card whose field asks for a voice it has no clip in
 * is a silent card, and that is the failure this ordering exists to prevent.
 */
export function adoptVoice(db: Db, voice: string = VOICE): number {
  const fields = db
    .prepare(
      `SELECT tf.template_id AS templateId, tf.id AS fieldId, tf.options AS options
         FROM template_fields tf
         JOIN templates t ON t.id = tf.template_id
        WHERE tf.type = 'speech' AND tf.name = 'Speech'
          AND t.name IN (${WORD_FIELDS.map(() => "?").join(",")})`,
    )
    .all(...WORD_FIELDS.map((f) => f.template)) as {
    templateId: string;
    fieldId: string;
    options: string;
  }[];
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

/** Move every card's reference onto the regenerated blob. */
export function moveRefs(db: Db, word: RespeakWord, hash: string): number {
  let moved = 0;
  for (const ref of word.refs) {
    if (retargetBlobRef(db, { cardId: ref.cardId, fieldId: ref.fieldId, refKey: ref.refKey }, hash)) {
      moved += 1;
    }
  }
  return moved;
}
