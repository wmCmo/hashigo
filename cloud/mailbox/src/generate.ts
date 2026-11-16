import { generationIdentity, generationKey } from "../../../src/blobs/generation.js";
import { sha256Hex } from "../../../src/blobs/sha256.js";
import { isKana, splitMoras, synthesise, type SpeechRequest } from "../../../src/accent/speech.js";
import { cleanGenerated, generateText, isEmojiPrompt, sentenceProblem, type AnthropicEffort } from "../../../src/generate/llm.js";
import { fillVoiceFor } from "../../../src/generate/speech.js";
import { catalogueVoice, sampleLine, synthesisVoice } from "../../../src/generate/voices.js";
import { speakableText } from "../../../src/text/index.js";
import type { BlobKind } from "../../../src/schema/index.js";
import type { KvLike } from "./mailbox.js";

export interface GenerateEnv {
  readonly MAILBOX: KvLike;
  readonly GOOGLE_TTS_SECRET?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly HASHIGO_MODEL?: string;
  readonly GEMINI_API_KEY?: string;
  readonly HASHIGO_GEMINI_MODEL?: string;
}

const GEMINI_MODEL = "gemini-3.6-flash";

export interface TextProvider {
  readonly provider: "gemini" | "anthropic";
  readonly apiKey: string;
  readonly model: string;
}

export function textProviders(env: GenerateEnv): readonly TextProvider[] {
  const chain: TextProvider[] = [];
  const anthropic = env.ANTHROPIC_API_KEY ?? "";
  if (anthropic !== "") chain.push({ provider: "anthropic", apiKey: anthropic, model: env.HASHIGO_MODEL ?? DEFAULT_MODEL });
  const gemini = env.GEMINI_API_KEY ?? "";
  if (gemini !== "") chain.push({ provider: "gemini", apiKey: gemini, model: env.HASHIGO_GEMINI_MODEL ?? GEMINI_MODEL });
  return chain;
}

export function textProvider(env: GenerateEnv): TextProvider | null {
  return textProviders(env)[0] ?? null;
}

const ALLOWED: ReadonlySet<string> = new Set(["ai", "translate", "speech"]);
const MAX_PROMPT = 2_000;
const MAX_TOKENS = 256;
const DEFAULT_MODEL = "claude-sonnet-5-5";
export const GEN_PREFIX = "gen:";

interface Descriptor {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly preview: boolean;
  readonly force: boolean;
  readonly readings: readonly { readonly base: string; readonly alias: string }[];
  readonly pronounce: SpeechRequest | null;
  readonly replaces: string | null;
}

export interface GeneratedRecord {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly audio?: string;
  readonly mime?: string;
  readonly output?: string;
  readonly replaces?: string;
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
    return {
      kind: "speech",
      text: sampleLine(asked.lang),
      lang: asked.lang,
      voice: asked.name,
      options: {},
      preview: true,
      force: false,
      readings: [],
      pronounce: null,
      replaces: null,
    };
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
    force: body["force"] === true,
    readings: parseReadings(body["readings"]),
    pronounce: kind === "speech" ? parsePronounce(body["pronounce"]) : null,
    replaces:
      typeof body["replaces"] === "string" && /^[0-9a-f]{64}$/.test(body["replaces"]) ? body["replaces"] : null,
  };
}

function parsePronounce(raw: unknown): SpeechRequest | null {
  if (raw === null || typeof raw !== "object") return null;
  const { reading, accent } = raw as { reading?: unknown; accent?: unknown };
  if (typeof reading !== "string" || typeof accent !== "number" || !Number.isInteger(accent)) return null;
  const kana = reading.trim();
  if (kana === "" || kana.length > 40 || !isKana(kana)) return null;
  if (accent < 0 || accent > splitMoras(kana).length) return null;
  return { reading: kana, accent };
}

function parseReadings(raw: unknown): { base: string; alias: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is { base: string; alias: string } =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { base?: unknown }).base === "string" &&
        typeof (entry as { alias?: unknown }).alias === "string",
    )
    .map((entry) => ({ base: entry.base.trim(), alias: entry.alias.trim() }))
    .filter((entry) => entry.base !== "" && entry.alias !== "" && entry.base.length <= 40 && entry.alias.length <= 80)
    .slice(0, 5);
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

    const fill = fillVoiceFor(descriptor.lang);
    for (const voice of (descriptor.force ? [] : [descriptor.voice, madeWith, fill]).filter(
      (entry, index, all): entry is string => entry !== null && all.indexOf(entry) === index,
    )) {
      const hit = await read(env, keyFor(descriptor, voice));
      if (hit?.audio !== undefined) {
        const bytes = fromBase64(hit.audio);
        return [200, { hash: sha256Hex(bytes), mime: hit.mime ?? "audio/mpeg", audio: hit.audio, cached: true, voice }];
      }
    }

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
    const bytes = await speak(spoken, descriptor.pronounce, { apiKey: key, voice: madeWith, readings: descriptor.readings });
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
      ...(descriptor.replaces === null ? {} : { replaces: descriptor.replaces }),
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

  const textKey = keyFor(descriptor, descriptor.voice);
  const cached = await read(env, textKey);
  if (cached?.output !== undefined && cached.output !== "") {
    const clean = cleanGenerated(descriptor.text, cached.output);
    if (clean !== cached.output && clean !== "") {
      await env.MAILBOX.put(textKey, JSON.stringify({ ...cached, output: clean }));
    }
    if (clean !== "") return [200, { text: clean, cached: true }];
  }

  const chain = textProviders(env);
  if (chain.length === 0) return [503, { error: "no GEMINI_API_KEY or ANTHROPIC_API_KEY on the Worker" }];
  const effort = probeEffort(descriptor.options);
  const usage = { input: 0, output: 0 };
  const probing = isProbe(descriptor.options);
  const failures: string[] = [];
  let output = "";
  let used: TextProvider | null = null;
  chain: for (const candidate of chain) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const made = await write(descriptor, {
          provider: candidate.provider,
          apiKey: candidate.apiKey,
          model: candidate.model,
          maxTokens: MAX_TOKENS,
          ...(effort === undefined ? {} : { effort }),
          ...(probing
            ? {
                onUsage: (counted: { input: number; output: number }) => {
                  usage.input += counted.input;
                  usage.output += counted.output;
                },
              }
            : {}),
        });
        const clean = cleanGenerated(descriptor.text, made);
        if (clean === "") {
          failures.push(
            isEmojiPrompt(descriptor.text) ? `${candidate.model} returned no emoji` : `${candidate.model} returned nothing`,
          );
          break;
        }
        const problem = sentenceProblem(descriptor.text, clean);
        if (problem === null) {
          output = clean;
          used = candidate;
          break chain;
        }
        failures.push(`${candidate.model} ${problem}`);
      } catch (cause) {
        failures.push((cause as Error).message);
        break;
      }
    }
  }
  if (used === null) {
    const message = failures.length === 1 ? (failures[0] as string) : failures.join(" · then ");
    if (failures.length === 1 && /returned no emoji|returned nothing/.test(message)) return [502, { error: message }];
    throw new Error(message);
  }
  const { provider, model } = used;
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
  return [200, { text: output, cached: false, provider, model, ...(probing ? { usage } : {}) }];
}

function isProbe(options: Readonly<Record<string, string>>): boolean {
  const probe = options["probe"];
  return typeof probe === "string" && probe !== "";
}

export function probeEffort(options: Readonly<Record<string, string>>): AnthropicEffort | undefined {
  if (!isProbe(options)) return undefined;
  const asked = options["effort"];
  return asked === "low" || asked === "medium" || asked === "high" ? asked : undefined;
}
