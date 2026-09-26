/**
 * `/generate/` ON CLOUDFLARE — the laptop's `vite.generate.ts`, off the laptop.
 *
 * Zach, 2026-09-26: *"and let's tackle those two while im reviewing?"* — the
 * two things still tied to the laptop after sync moved. This is the first: a
 * "generate audio" or "generate" press on his phone reaches Google and Anthropic
 * from here, over plain internet, so it works on the apartment wifi that cannot
 * carry the tunnel, and with the laptop asleep.
 *
 * ─── DECISION 18, KEPT RATHER THAN BENT ─────────────────────────────────────
 *
 * The keys are Worker SECRETS (`wrangler secret put`), which is exactly where
 * decision 18 always said they would live: *"proxied through the stage-11
 * Worker"*. They reach no response and never the client.
 *
 * ─── SAME REQUEST, SAME REPLY, SAME CACHE KEY ───────────────────────────────
 *
 * The body and the reply are the laptop endpoint's, field for field, so the
 * page cannot tell which one answered. The identity is `generationIdentity`
 * from `src/blobs/generation.ts` — the laptop's own function, imported, not
 * retyped — so a clip made here files under the key a card will look up.
 *
 * ─── WHAT IT CANNOT DO THAT THE LAPTOP COULD, AND WHAT COVERS IT ───────────
 *
 * The laptop answered a press from `build/hashigo.db` first — the 141 clips on
 * the laptop that the seed did not carry. This side has no corpus, so a press
 * for one of those is synthesised again. Cheap (one short clip), and only for
 * clips the seed skipped.
 *
 * And the laptop WROTE every generation into `build/hashigo.db`, the system of
 * record (decision 41), so it survived the next seed rebuild. Here every
 * generation is kept in KV under `gen:<key>`, and
 * `scripts/cloud-generated-pull.ts` files them into the laptop database. Until
 * it runs, a generation lives on the device that asked and in KV — never only
 * on the device.
 *
 * Text goes to Anthropic. The laptop preferred Ollama, which is free and runs on
 * the laptop; there is no laptop here. Short emoji lines and sentences cost
 * fractions of a cent.
 */

import { generationIdentity, generationKey } from "../../../src/blobs/generation.js";
import { sha256Hex } from "../../../src/blobs/sha256.js";
import { synthesise } from "../../../src/accent/speech.js";
import { generateText } from "../../../src/generate/llm.js";
import { fillVoiceFor } from "../../../src/generate/speech.js";
import { catalogueVoice, sampleLine, synthesisVoice } from "../../../src/generate/voices.js";
import { speakableText } from "../../../src/text/index.js";
import type { BlobKind } from "../../../src/schema/index.js";
import type { KvLike } from "./mailbox.js";

export interface GenerateEnv {
  readonly MAILBOX: KvLike;
  readonly GOOGLE_TTS_SECRET?: string;
  readonly ANTHROPIC_API_KEY?: string;
  /** Same default as the laptop's `HASHIGO_MODEL`. */
  readonly HASHIGO_MODEL?: string;
}

/** Only these can be asked for — the laptop's `ALLOWED`. */
const ALLOWED: ReadonlySet<string> = new Set(["ai", "translate", "speech"]);
const MAX_PROMPT = 2_000;
const MAX_TOKENS = 256;
const DEFAULT_MODEL = "claude-opus-5";
export const GEN_PREFIX = "gen:";

interface Descriptor {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly preview: boolean;
}

/** What `gen:<key>` holds — enough for the laptop to file it exactly. */
export interface GeneratedRecord {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  /** Speech: the voice that REALLY spoke. Text: null. */
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly createdAt: string;
  /** Speech only, base64. */
  readonly audio?: string;
  readonly mime?: string;
  /** Text kinds only. */
  readonly output?: string;
}

export function parse(raw: unknown): Descriptor | string {
  if (raw === null || typeof raw !== "object") return "body is not a JSON object";
  const body = raw as Record<string, unknown>;
  const kind = body["kind"];
  if (typeof kind !== "string" || !ALLOWED.has(kind)) {
    return `kind must be one of ${[...ALLOWED].join(", ")}`;
  }
  if (body["preview"] === true) {
    if (kind !== "speech") return "only speech can be previewed";
    const asked = catalogueVoice(typeof body["voice"] === "string" ? body["voice"] : null);
    if (asked === null) return "preview needs a voice from the catalogue";
    return { kind: "speech", text: sampleLine(asked.lang), lang: asked.lang, voice: asked.name, options: {}, preview: true };
  }
  const text = body["text"];
  if (typeof text !== "string" || text.trim() === "") return "text is required";
  if (text.length > MAX_PROMPT) return `text over ${MAX_PROMPT} characters`;
  const options = body["options"];
  return {
    kind: kind as BlobKind,
    text,
    lang: typeof body["lang"] === "string" ? body["lang"] : null,
    voice: typeof body["voice"] === "string" ? body["voice"] : null,
    options: options !== null && typeof options === "object" ? (options as Record<string, string>) : {},
    preview: false,
  };
}

function keyFor(descriptor: Descriptor, voice: string | null): string {
  return (
    GEN_PREFIX +
    generationKey(
      generationIdentity({
        kind: descriptor.kind,
        text: descriptor.text,
        voice,
        lang: descriptor.lang,
        options: descriptor.options,
      }),
    )
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

async function read(env: GenerateEnv, key: string): Promise<GeneratedRecord | null> {
  const raw = await env.MAILBOX.get(key, "text");
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as GeneratedRecord;
  } catch {
    return null;
  }
}

/** Answer one generation request. Returns [status, body]. */
export async function generate(
  descriptor: Descriptor,
  env: GenerateEnv,
  deps: {
    readonly synthesise?: typeof synthesise;
    readonly generateText?: typeof generateText;
  } = {},
): Promise<[number, unknown]> {
  const speak = deps.synthesise ?? synthesise;
  const write = deps.generateText ?? generateText;

  if (descriptor.kind === "speech") {
    const key = env.GOOGLE_TTS_SECRET ?? "";
    if (key === "") return [503, { error: "no GOOGLE_TTS_SECRET on the Worker" }];
    const madeWith = synthesisVoice(descriptor.voice, descriptor.lang);

    if (descriptor.preview) {
      const bytes = await speak(descriptor.text, null, { apiKey: key, voice: madeWith });
      return [200, { mime: "audio/mpeg", audio: toBase64(bytes), voice: madeWith, text: descriptor.text }];
    }

    // The card's own voice, then the voice this would be made in, then the fill —
    // the laptop's order, over the clips THIS side has made.
    const fill = fillVoiceFor(descriptor.lang);
    for (const voice of [descriptor.voice, madeWith, fill].filter(
      (entry, index, all): entry is string => entry !== null && all.indexOf(entry) === index,
    )) {
      const hit = await read(env, keyFor(descriptor, voice));
      if (hit?.audio !== undefined) {
        const bytes = fromBase64(hit.audio);
        return [200, { hash: sha256Hex(bytes), mime: hit.mime ?? "audio/mpeg", audio: hit.audio, cached: true, voice }];
      }
    }

    // What is spoken is not what is keyed — the laptop's rule, for its reasons.
    const spoken = speakableText(descriptor.text);
    if (spoken === "") {
      return [
        422,
        {
          error:
            "there is nothing to speak here — this field is still an unresolved " +
            "generator, so the sentence has to be generated before it can be voiced.",
        },
      ];
    }
    const bytes = await speak(spoken, null, { apiKey: key, voice: madeWith });
    const audio = toBase64(bytes);
    const record: GeneratedRecord = {
      kind: "speech",
      text: descriptor.text,
      lang: descriptor.lang,
      voice: madeWith,
      options: descriptor.options,
      createdAt: new Date().toISOString(),
      audio,
      mime: "audio/mpeg",
    };
    await env.MAILBOX.put(keyFor(descriptor, madeWith), JSON.stringify(record));
    return [
      200,
      {
        hash: sha256Hex(bytes),
        mime: "audio/mpeg",
        audio,
        cached: false,
        voice: madeWith,
        mismatch:
          descriptor.lang !== null && !descriptor.lang.startsWith(madeWith.slice(0, 2))
            ? `spoken by ${madeWith} although the card says ${descriptor.lang}`
            : undefined,
      },
    ];
  }

  // Text kinds. ALREADY THERE? A second press or a second device must not be a
  // second bill, and must not return different emoji for a card he has seen.
  const textKey = keyFor(descriptor, descriptor.voice);
  const cached = await read(env, textKey);
  if (cached?.output !== undefined && cached.output !== "") return [200, { text: cached.output, cached: true }];

  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  if (apiKey === "") return [503, { error: "no ANTHROPIC_API_KEY on the Worker" }];
  const model = env.HASHIGO_MODEL ?? DEFAULT_MODEL;
  const output = await write(descriptor, { provider: "anthropic", apiKey, model, maxTokens: MAX_TOKENS });
  if (output === "") return [502, { error: `${model} returned nothing` }];
  const record: GeneratedRecord = {
    kind: descriptor.kind,
    text: descriptor.text,
    lang: descriptor.lang,
    voice: descriptor.voice,
    options: descriptor.options,
    createdAt: new Date().toISOString(),
    output,
  };
  await env.MAILBOX.put(textKey, JSON.stringify(record));
  return [200, { text: output, cached: false, provider: "anthropic", model }];
}
