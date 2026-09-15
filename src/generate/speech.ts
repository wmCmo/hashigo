/**
 * FILING A CLIP THIS PROJECT MADE, under an identity that tells the truth.
 *
 * ─── WHY THIS IS NOT IN `./store.ts` ────────────────────────────────────────
 *
 * That file throws on any non-text kind, with the words *"nothing here may write
 * audio"*. The guard is worth keeping literally true, so the audio counterpart
 * lives beside it rather than inside it. The two differ in more than a `mime`
 * anyway: a text generation carries its bytes INLINE in `blobs.bytes`, and a
 * clip does not — the payload goes to the separate store (`blob_payloads`, a
 * second file in the same pool) and `blobs` keeps metadata only. Two writes, two
 * places, one hash.
 *
 * ─── THE VOICE IS THE PRODUCING VOICE, ALWAYS ───────────────────────────────
 *
 * Zach, 2026-09-15, on a 合理 card whose example sentence would not play:
 * *"do you think because it's missing? then we need a way to regenerate it."*
 * **785 of 10,420 mounts resolve to nothing** — see `src/cards/audio.ts`, which
 * carries the measurement and the reasoning.
 *
 * The card asks for `ja-JP-NanamiNeural`, because the voice lives on the FIELD.
 * These bytes come from Google `ja-JP-Neural2-C`. **The row records Neural2-C**,
 * and `resolveAudioHash` bridges the difference by looking under the fill voice
 * after the asked one misses. Writing the Nanami identity here instead would
 * make every one of these rows claim a provenance it does not have, and the
 * 7,409-clip voice survey in `src/accent/speech.ts` would be wrong with nothing
 * able to notice.
 *
 * BROWSER-PORTABLE: `SqliteHandle` and `BlobStore`, no `node:` import. The bytes
 * arrive as a `Uint8Array` from wherever the caller got them — the Vite plugin
 * that holds the API key on the laptop, or the worker filing the laptop's answer
 * into this device's own store.
 */
import { generationIdentity } from "../blobs/generation.js";
import { sha256Hex } from "../blobs/sha256.js";
import type { BlobStore } from "../blobs/store.js";
import type { SqliteHandle } from "../db/browser.js";

/** Every clip this project synthesises. Zach's own choice, by ear, 2026-08-20. */
export const FILL_VOICE = "ja-JP-Neural2-C";

/** Matches every existing speech row in the corpus, and the store's sniffing. */
const SPEECH_MIME = "audio/mpeg";

export interface SpeechDescriptor {
  /** The generator's input — the RENDERED text (decision 7), raw and unnormalised. */
  readonly text: string;
  readonly lang: string | null;
  readonly options: Readonly<Record<string, string>>;
}

/**
 * Write one clip, and return its content address.
 *
 * Idempotent in both halves: `ON CONFLICT DO NOTHING` on the row, and
 * `BlobStore.write` is documented idempotent on an address it already holds. So
 * a second tap, or a second device asking for the same gap, costs one SELECT.
 *
 * `refcount` is 1 for the reason `storeDescriptorText` gives: a generator mount
 * is addressed by generation identity and has no `blob_refs` row, so nothing
 * else will ever count this reference. A row left at 0 is one
 * `sweepUnreferenced` away from deleting the clip out from under the card.
 */
export function storeGeneratedSpeech(
  db: SqliteHandle,
  store: BlobStore,
  descriptor: SpeechDescriptor,
  bytes: Uint8Array,
): string {
  if (bytes.length === 0) {
    // `lookupGeneration` requires `byte_size > 0`, to keep Mochi's 10 zero-byte
    // failures from becoming permanent cache hits. A row written here with no
    // bytes could never be read and could never be replaced.
    throw new Error("refusing to store an empty clip");
  }
  const identity = generationIdentity({
    kind: "speech",
    text: descriptor.text,
    voice: FILL_VOICE,
    lang: descriptor.lang,
    options: descriptor.options,
  });
  // DERIVED HERE, never taken from the caller — the same rule
  // `storeDescriptorText` follows for the identity: a round trip that computes
  // both ends itself cannot be closed wrongly.
  const hash = sha256Hex(bytes);
  // THE PAYLOAD FIRST. A row whose bytes are not yet in the store is a cache hit
  // that resolves to a `BlobMissingError`; the other order is merely a payload
  // nothing points at yet, which the next write finds already present.
  store.write(hash, bytes);
  db.prepare(
    `INSERT INTO blobs (hash, kind, mime, byte_size, source_text, voice, lang, options, refcount)
     VALUES (?, 'speech', ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (hash) DO NOTHING`,
  ).run(
    hash,
    SPEECH_MIME,
    bytes.length,
    identity.sourceText,
    identity.voice,
    identity.lang,
    identity.options,
  );
  return hash;
}
