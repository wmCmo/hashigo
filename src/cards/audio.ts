import type { BlobStore } from "../blobs/store.js";
import { BlobMissingError } from "../blobs/store.js";
import { generationIdentity, lookupGenerations } from "../blobs/generation.js";
import { readBlob } from "../blobs/db.js";
import type { SqliteHandle } from "../db/browser.js";
import type { AudioAddress } from "../render/audio.js";
import type { BlobPayload } from "../blobs/url.js";
import { fillVoiceFor } from "../generate/speech.js";

export type SyncAudioResolver = (address: AudioAddress) => BlobPayload | null;

export interface CardAudioOptions {
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

function mimeFor(db: SqliteHandle, hash: string): string {
  const row = db.prepare(SELECT_MIME).get(hash) as { mime: string } | undefined;
  return row?.mime ?? "application/octet-stream";
}

export { FILL_VOICE, fillVoiceFor } from "../generate/speech.js";

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
    text: request.text,
    voice: request.voice,
    lang: request.lang,
    options: request.options,
  });
  const found = lookupGenerations(db, asked);
  const fillVoice = fillVoiceFor(asked.lang);
  if (request.kind !== "speech" || asked.voice === fillVoice) return found;
  for (const fill of lookupGenerations(db, { ...asked, voice: fillVoice })) {
    if (!found.includes(fill)) found.push(fill);
  }
  return found;
}

export function resolveAudioHash(
  db: SqliteHandle,
  cardId: string,
  address: AudioAddress,
): string | null {
  return audioHashCandidates(db, cardId, address)[0] ?? null;
}

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
        if (cause instanceof BlobMissingError) continue;
        throw cause;
      }
    }
    return null;
  };
}
