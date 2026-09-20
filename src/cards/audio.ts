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
import { fillVoiceFor } from "../generate/speech.js";

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
 * ─── THE GAP-FILL VOICE, AND WHY THE FALLBACK IS THIS NARROW ────────────────
 *
 * Zach, 2026-09-15, on a 合理 card whose example sentence would not play:
 * *"it won't let me play the audio of the example sentence — do you think
 * because it's missing? then we need a way to regenerate it."* It was missing:
 * **785 of 10,420 mounts (7.5%) resolve to nothing**, on 627 cards — 576 example
 * sentences and 209 head words, and **178 of those head words are on mode-2
 * cards, where decision 29 makes the clip the QUESTION.** Those cards ask
 * nothing at all.
 *
 * Filling one is not as simple as synthesising it, because **the voice lives on
 * the FIELD, not the card** (`src/accent/respeak-cli.ts` found this the hard
 * way). Every 単語 card asks for `ja-JP-NanamiNeural`, and this project's settled
 * voice is Google's `ja-JP-Neural2-C` — Zach's own choice by ear, re-confirmed
 * 2026-09-15. That leaves three ways to fill a gap and two of them are bad:
 *
 *   * **Store the Google bytes under the Nanami identity.** The card plays, and
 *     `blobs.voice` now says Nanami for 785 rows that Nanami never made. The
 *     survey in `src/accent/speech.ts` ("all 7,409 ja-JP Nanami clips") becomes
 *     wrong, silently, and nothing downstream can tell.
 *   * **Adopt Neural2-C on the field**, which is what `respeak` does on a clean
 *     whole run. That unreferences all 4,359 existing sentence clips and makes
 *     every 単語 card silent until the whole corpus is re-synthesised — the
 *     regeneration Zach has deferred five times.
 *   * **Store it honestly and let the RESOLVER bridge the gap.** That is this.
 *
 * The blob records `ja-JP-Neural2-C`, because Neural2-C made it. A mount asking
 * for Nanami misses, and only then is the same text looked up under the fill
 * voice. Nothing lies and no existing card changes: a card whose Nanami clip
 * exists hits on the first lookup and never reaches here.
 *
 * **It is ONE named voice and not "any voice", which is what keeps
 * `respeak`'s safety property alive.** That command refuses to adopt a voice
 * while any word is missing its clip, precisely so those cards go SILENT and the
 * mistake is loud. A resolver that accepted any voice would quietly serve the
 * old Nanami clip instead and hide it. After an adoption the mount asks for
 * Neural2-C, the fallback looks for Neural2-C, and a missing one is still
 * missing — silent, loudly, exactly as before.
 *
 * The string itself comes from `src/generate/speech.ts`, the half that WRITES
 * these rows. Two copies of one voice name is exactly the drift that makes a
 * cache miss permanently and silently: the reader and the writer have to be
 * looking at the same characters or the fallback never fires.
 */
export { FILL_VOICE, fillVoiceFor } from "../generate/speech.js";

/**
 * EVERY hash this address could legitimately play, best first.
 *
 * ─── WHY THIS IS A LIST AND NOT ONE ANSWER — 2026-09-16 ─────────────────────
 *
 * Zach, over a 略歴 card: *"is it just me or nothing happens when you click the
 * generate buttons"*. It was not just him, and the button was not the fault.
 *
 * The asked voice HIT and the bytes were not there. `blobs` and the payload
 * store are two different files, and a device carries every ROW (the card seed
 * is whole) while carrying only the payloads `app-bootstrap` had budget for —
 * which takes each card's CHEAPEST clip first (decision 34). The 2026-09-16 fill
 * gave that sentence a second, smaller `ja-JP-Neural2-C` row, so the seed
 * shipped the 50 KB Neural2-C payload and left the 158 KB Nanami one behind. The
 * card asks for Nanami, the Nanami ROW is right there, the fallback below never
 * ran, and `cardAudioResolver` turned the missing payload into `null`.
 *
 * **That made the gap unrepairable, which is the part that reached him.** He
 * pressed "generate audio", the laptop answered, the worker filed the bytes
 * under the fill voice correctly — and the next lookup hit the same dead Nanami
 * row again. The button vanished and came back: nothing happens, for ever.
 *
 * So a single "the" hash is the wrong shape. Resolution is a preference order,
 * and only the caller holding the store can say which entry is real.
 */
export function audioHashCandidates(
  db: SqliteHandle,
  cardId: string,
  address: AudioAddress,
): string[] {
  if (address.origin === "attachment") {
    const row = db.prepare(SELECT_ATTACHMENT).get(cardId, address.key) as
      | { hash: string; mime: string }
      | undefined;
    return row === undefined ? [] : [row.hash];
  }
  const request = address.request;
  const asked = generationIdentity({
    kind: request.kind,
    // RAW. `generationIdentity` normalises, and normalising here as well
    // produces a different key and therefore a permanent miss.
    text: request.text,
    voice: request.voice,
    lang: request.lang,
    options: request.options,
  });
  const hit = lookupGeneration(db, asked);
  const found = hit === null ? [] : [hit];
  // Speech only, and only when the card asked for some OTHER voice. See above.
  // PER LANGUAGE since 2026-09-20 — an English card falling back to the Japanese
  // fill voice is what made 130 English clips audible in Japanese. `ja` still
  // resolves to the same constant, so no Japanese clip changes address.
  const fillVoice = fillVoiceFor(asked.lang);
  if (request.kind !== "speech" || asked.voice === fillVoice) return found;
  const fill = lookupGeneration(db, { ...asked, voice: fillVoice });
  if (fill === null || fill === hit) return found;
  found.push(fill);
  return found;
}

/**
 * Resolve an address to a hash. Exported because "did this card's audio resolve
 * at all" is a question worth asking without reading 617.9 MiB to answer it —
 * a session-preflight or a coverage sweep wants the hash and not the bytes.
 *
 * THE PREFERRED one, which is the question those callers are asking: on the
 * laptop every row has its payload (measured 2026-09-16: 0 of 11,613 without),
 * so "is there a row" and "can it play" are the same question there. They come
 * apart on a DEVICE, and `cardAudioResolver` is where that is answered.
 */
export function resolveAudioHash(
  db: SqliteHandle,
  cardId: string,
  address: AudioAddress,
): string | null {
  return audioHashCandidates(db, cardId, address)[0] ?? null;
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
    for (const hash of audioHashCandidates(db, cardId, address)) {
      try {
        return { hash, bytes: readBlob(db, hash, store), mime: mimeFor(db, hash) };
      } catch (cause) {
        // A row whose payload is nowhere is a real state of this corpus — Mochi
        // lost 17 of them, and a device carries rows it has no bytes for by
        // design. A review session must not end because one clip is gone, and
        // it must not stop at the FIRST gone one either: `continue` is what
        // makes the fill voice reachable behind a Nanami row with no payload,
        // and therefore what makes "generate audio" able to repair anything.
        // Anything else is a bug and is rethrown.
        if (cause instanceof BlobMissingError) continue;
        throw cause;
      }
    }
    return null;
  };
}
