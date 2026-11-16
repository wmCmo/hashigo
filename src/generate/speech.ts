import { generationIdentity } from "../blobs/generation.js";
import { sha256Hex } from "../blobs/sha256.js";
import type { BlobStore } from "../blobs/store.js";
import type { SqliteHandle } from "../db/browser.js";

export const FILL_VOICE = "ja-JP-Neural2-C";

const FILL_VOICES: Readonly<Record<string, string>> = {
  ja: FILL_VOICE,
  en: "en-US-Neural2-D",
};

export function fillVoiceFor(lang: string | null | undefined): string {
  if (typeof lang !== "string" || lang === "") return FILL_VOICE;
  return FILL_VOICES[lang.slice(0, 2).toLowerCase()] ?? FILL_VOICE;
}

const SPEECH_MIME = "audio/mpeg";

export interface SpeechDescriptor {
  readonly text: string;
  readonly lang: string | null;
  readonly voice?: string | null;
  readonly options: Readonly<Record<string, string>>;
}

export function storeGeneratedSpeech(
  db: SqliteHandle,
  store: BlobStore,
  descriptor: SpeechDescriptor,
  bytes: Uint8Array,
): string {
  if (bytes.length === 0) {
    throw new Error("refusing to store an empty clip");
  }
  const identity = generationIdentity({
    kind: "speech",
    text: descriptor.text,
    voice: descriptor.voice ?? fillVoiceFor(descriptor.lang),
    lang: descriptor.lang,
    options: descriptor.options,
  });
  const hash = sha256Hex(bytes);
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
