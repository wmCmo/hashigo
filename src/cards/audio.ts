/**
 * The other half of the audio path: an address in, bytes out.
 *
 * `src/render/audio.ts` owns everything about STARTING a sound — when it is
 * allowed to (only on a cloze reveal, never on side entry), which element gets
 * which clip, and the object-URL lifecycle. It deliberately never learns where
 * bytes live: it takes an injected `AudioResolver` and says so in its header,
 * "no fetching, no hashing, no database". This file is that injection, backed by
 * the real store.
 *
 * ─── THE TWO ADDRESSES ARE NOT THE SAME LOOKUP ──────────────────────────────
 *
 * `AudioAddress` has two shapes because the corpus has two, and the split is
 * lopsided in a way worth knowing before writing either arm. Measured over all
 * 7,716 cards: **94 of the 95 `<audio>` elements are generator slots** and
 * exactly ONE is an authored attachment. So 617.9 MiB of speech is addressed by
 * generation identity, not by anything in the card's text.
 *
 *   * `generator` — `generationIdentity(descriptor)` then `lookupGeneration`.
 *     `GenerationDescriptor` maps onto `GenerationRequest` field for field, and
 *     the text must be handed over RAW: normalisation belongs to
 *     `generationIdentity` and doing it twice produces a different key.
 *   * `attachment` — `blob_refs.ref_key`. **THE CARD ID COMES FROM THE CLOSURE,
 *     NOT THE ADDRESS.** `AudioAddress` carries only `key`, and `ref_key` is a
 *     bare filename which is unique per card and not globally: two cards can
 *     both reference `uVQp0iMb.mp3`. A resolver that queried by `ref_key` alone
 *     would be right on this corpus by luck and wrong the first time a filename
 *     repeated. Hence `cardAudioResolver(db, cardId)` rather than a free
 *     function.
 *
 * ─── TWO HANDLES, AND WHICH KINDS NEED THE SECOND ───────────────────────────
 *
 * `readBlob` reads `blobs.bytes` when the row carries its payload inline and
 * falls back to the store otherwise. Which kinds are which is measured, and it
 * is NOT "speech versus the rest":
 *
 *     kind         rows    inline    size
 *     ai         15,958    15,958     1.1 MiB
 *     speech     10,791         0   617.9 MiB
 *     translate   7,749     7,749     0.4 MiB
 *     furigana    3,233     3,233     0.1 MiB
 *     file           15         0     0.5 MiB
 *     image          10         0     6.2 MiB
 *     dictionary      7         7     0.0 MiB
 *
 * The text kinds are fully inline; speech, file and image are not — 10,816
 * payloads in the store against 26,947 in the rows. So a caller that wants audio
 * MUST pass a store, and one that only wants furigana or a translation does not.
 * Passing none is legal and yields null for a payload that lives outside, which
 * is the honest answer rather than a crash: `missing` is a state this corpus
 * genuinely has (Mochi lost 17 payloads whose rows survive).
 *
 * ─── A MISS IS null, NOT A THROW ────────────────────────────────────────────
 *
 * `AudioResolver` is documented as returning "bytes for an address, or null when
 * the store has none", and a review session must not die because one clip was
 * never generated. 312 field slots in the corpus have a clip of the right kind
 * whose text does not match, 35 were never generated at all, and 159 have no
 * resolvable input — every one of those is a null here and a silent, unplayable
 * element in the UI, which is exactly what it should be.
 */

import type { BlobStore } from "../blobs/store.js";
import { BlobMissingError } from "../blobs/store.js";
import { generationIdentity, lookupGeneration } from "../blobs/generation.js";
import { readBlob } from "../blobs/db.js";
import type { SqliteHandle } from "../db/browser.js";
import type { AudioAddress } from "../render/audio.js";
import type { BlobPayload } from "../blobs/url.js";

/**
 * The synchronous half of `AudioResolver`.
 *
 * `AudioResolver` allows a promise because the browser build will put the blob
 * database in a Worker. This one never returns one, and saying so in the type is
 * worth a line: `src/render/audio.ts` notes that a synchronous resolution "is
 * handled synchronously all the way to `play()`, which matters — a play that
 * happens in the same task as the user's gesture never meets an autoplay
 * policy." A caller that has this type knows it is on that path. It is assignable
 * to `AudioResolver`, and a test asserts that rather than leaving it to a reader.
 */
export type SyncAudioResolver = (address: AudioAddress) => BlobPayload | null;

/** `blob_refs` is keyed per card, so the resolver is built per card. */
export interface CardAudioOptions {
  /**
   * Where the payload bytes live when the row does not carry them. Required for
   * speech, file and image; unnecessary for the text kinds. Null means "inline
   * only", and an out-of-line address then resolves to null rather than
   * throwing.
   */
  readonly store?: BlobStore | null;
}

const SELECT_ATTACHMENT = `
SELECT b.hash AS hash, b.mime AS mime
  FROM blob_refs r
  JOIN blobs b ON b.hash = r.blob_hash
 WHERE r.card_id = ? AND r.ref_key = ?
 ORDER BY b.hash
 LIMIT 1`;

const SELECT_MIME = `SELECT mime FROM blobs WHERE hash = ?`;

/** The mime a payload carries, or the generic fallback. */
function mimeFor(db: SqliteHandle, hash: string): string {
  const row = db.prepare(SELECT_MIME).get(hash) as { mime: string } | undefined;
  return row?.mime ?? "application/octet-stream";
}

/**
 * Resolve an address to a hash. Exported because "did this card's audio resolve
 * at all" is a question worth asking without reading 617.9 MiB to answer it —
 * a session-preflight or a coverage sweep wants the hash and not the bytes.
 */
export function resolveAudioHash(
  db: SqliteHandle,
  cardId: string,
  address: AudioAddress,
): string | null {
  if (address.origin === "attachment") {
    const row = db.prepare(SELECT_ATTACHMENT).get(cardId, address.key) as
      | { hash: string; mime: string }
      | undefined;
    return row?.hash ?? null;
  }
  const request = address.request;
  return lookupGeneration(
    db,
    generationIdentity({
      kind: request.kind,
      // RAW. `generationIdentity` normalises, and normalising here as well
      // produces a different key and therefore a permanent miss.
      text: request.text,
      voice: request.voice,
      lang: request.lang,
      options: request.options,
    }),
  );
}

/**
 * An `AudioResolver` for one card, over the real store.
 *
 * Synchronous by design where it can be. `src/render/audio.ts` notes that a
 * synchronous return "is handled synchronously all the way to `play()`, which
 * matters — a play that happens in the same task as the user's gesture never
 * meets an autoplay policy." Under Node and against a same-thread OPFS handle
 * this is that path. A worker-backed browser build wraps this in its own
 * promise-returning shim rather than making this one async for everybody.
 */
export function cardAudioResolver(
  db: SqliteHandle,
  cardId: string,
  options: CardAudioOptions = {},
): SyncAudioResolver {
  const store = options.store ?? null;
  return (address: AudioAddress): BlobPayload | null => {
    const hash = resolveAudioHash(db, cardId, address);
    if (hash === null) return null;
    try {
      return { hash, bytes: readBlob(db, hash, store), mime: mimeFor(db, hash) };
    } catch (cause) {
      // A row whose payload is nowhere is a real state of this corpus — Mochi
      // lost 17 of them — and a review session must not end because one clip is
      // gone. Anything else is a bug and is rethrown.
      if (cause instanceof BlobMissingError) return null;
      throw cause;
    }
  };
}
