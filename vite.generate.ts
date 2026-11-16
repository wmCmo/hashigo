import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

import { synthesise } from "./src/accent/speech.js";
import { speakableText } from "./src/text/index.js";
import { defaultStoreDatabase, openBlobStoreDatabase } from "./src/blobs/index.js";
import { generationIdentity, lookupGeneration } from "./src/blobs/generation.js";
import { readBlob } from "./src/blobs/db.js";
import { openDatabase } from "./src/db/index.js";
import {
  catalogueVoice,
  fillVoiceFor,
  generateText,
  sampleLine,
  synthesisVoice,
  OLLAMA_HOST,
  OLLAMA_MODEL,
  ollamaReachable,
  resolveDescriptorText,
  storeDescriptorText,
  storeGeneratedSpeech,
  type LlmProvider,
} from "./src/generate/index.js";
import type { BlobKind } from "./src/schema/index.js";

const root = dirname(fileURLToPath(import.meta.url));
const CARD_DB = resolve(root, "build/hashigo.db");

const ALLOWED: ReadonlySet<string> = new Set(["ai", "translate", "speech"]);

const MAX_PROMPT = 2_000;

const MAX_TOKENS = 256;

interface Descriptor {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly preview: boolean;
}

function parse(body: string): Descriptor | string {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return "body is not JSON";
  }
  const kind = raw["kind"];
  const text = raw["text"];
  if (typeof kind !== "string" || !ALLOWED.has(kind)) {
    return `kind must be one of ${[...ALLOWED].join(", ")}`;
  }
  const preview = raw["preview"] === true;
  if (preview) {
    if (kind !== "speech") return "only speech can be previewed";
    const asked = catalogueVoice(typeof raw["voice"] === "string" ? raw["voice"] : null);
    if (asked === null) return "preview needs a voice from the catalogue";
    return {
      kind: "speech",
      text: sampleLine(asked.lang),
      lang: asked.lang,
      voice: asked.name,
      options: {},
      preview: true,
    };
  }
  if (typeof text !== "string" || text.trim() === "") return "text is required";
  if (text.length > MAX_PROMPT) return `text over ${MAX_PROMPT} characters`;
  const options = raw["options"];
  return {
    kind: kind as BlobKind,
    text,
    lang: typeof raw["lang"] === "string" ? raw["lang"] : null,
    voice: typeof raw["voice"] === "string" ? raw["voice"] : null,
    options:
      options !== null && typeof options === "object"
        ? (options as Record<string, string>)
        : {},
    preview: false,
  };
}

async function speech(
  db: ReturnType<typeof openDatabase>,
  descriptor: Descriptor,
  send: (status: number, body: unknown) => void,
): Promise<void> {
  const under = (voice: string | null) =>
    generationIdentity({
      kind: "speech",
      text: descriptor.text,
      voice,
      lang: descriptor.lang,
      options: descriptor.options,
    });
  const fillVoice = fillVoiceFor(descriptor.lang);
  const madeWith = synthesisVoice(descriptor.voice, descriptor.lang);
  const wanted = [descriptor.voice, madeWith, fillVoice].filter(
    (voice, index, all): voice is string => voice !== null && all.indexOf(voice) === index,
  );
  const storeFile = defaultStoreDatabase(CARD_DB);
  if (!existsSync(storeFile)) {
    send(503, { error: `no payload store at ${storeFile}` });
    return;
  }
  const opened = openBlobStoreDatabase(storeFile, { mustExist: true, create: false });
  try {
    for (const voice of wanted) {
      const hit = lookupGeneration(db, under(voice));
      if (hit === null) continue;
      try {
        const bytes = readBlob(db, hit, opened.store);
        send(200, {
          hash: hit,
          mime: "audio/mpeg",
          audio: Buffer.from(bytes).toString("base64"),
          cached: true,
          voice,
        });
        return;
      } catch {
      }
    }
    const key = process.env["GOOGLE_TTS_SECRET"] as string;
    const spoken = speakableText(descriptor.text);
    if (spoken === "") {
      send(422, {
        error:
          "there is nothing to speak here — this field is still an unresolved " +
          "generator, so the sentence has to be generated before it can be voiced.",
      });
      return;
    }
    const bytes = await synthesise(spoken, null, { apiKey: key, voice: madeWith });
    const hash = storeGeneratedSpeech(
      db,
      opened.store,
      { text: descriptor.text, lang: descriptor.lang, voice: madeWith, options: descriptor.options },
      bytes,
    );
    send(200, {
      hash,
      mime: "audio/mpeg",
      audio: Buffer.from(bytes).toString("base64"),
      cached: false,
      voice: madeWith,
      mismatch:
        descriptor.lang !== null && !descriptor.lang.startsWith(madeWith.slice(0, 2))
          ? `spoken by ${madeWith} although the card says ${descriptor.lang}`
          : undefined,
    });
  } finally {
    opened.close();
  }
}

export function generateOnDemand(): Plugin {
  const handler = (
    request: { url?: string | undefined; method?: string | undefined; on: Function },
    response: {
      statusCode: number;
      setHeader(name: string, value: string | number): void;
      end(body?: string): void;
    },
    next: () => void,
  ): void => {
    const url = request.url ?? "";
    if (!url.startsWith("/generate/")) {
      next();
      return;
    }

    const send = (status: number, body: unknown): void => {
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify(body));
    };

    if ((request.method ?? "GET").toUpperCase() !== "POST") {
      send(405, { error: "POST only" });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    request.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > 64 * 1024) {
        aborted = true;
        send(413, { error: "body too large" });
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      if (aborted) return;
      void (async () => {
        const parsed = parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof parsed === "string") {
          send(400, { error: parsed });
          return;
        }

        if (existsSync(resolve(root, ".env")) && process.env["ANTHROPIC_API_KEY"] === undefined) {
          process.loadEnvFile(resolve(root, ".env"));
        }
        const forced = process.env["HASHIGO_LLM"];
        const host = process.env["OLLAMA_HOST"] ?? OLLAMA_HOST;
        let provider: LlmProvider = "anthropic";
        if (parsed.kind !== "speech") {
          provider =
            forced === "anthropic"
              ? "anthropic"
              : forced === "ollama" || (await ollamaReachable(host))
                ? "ollama"
                : "anthropic";
        }
        const needs =
          parsed.kind === "speech"
            ? "GOOGLE_TTS_SECRET"
            : provider === "anthropic"
              ? "ANTHROPIC_API_KEY"
              : null;
        const key = needs === null ? "" : process.env[needs];
        if (needs !== null && (key === undefined || key === "")) {
          send(503, { error: `no ${needs} — put it in .env on the laptop` });
          return;
        }
        if (!existsSync(CARD_DB)) {
          send(503, { error: `no ${CARD_DB} to store the generation in` });
          return;
        }

        if (parsed.preview) {
          try {
            const bytes = await synthesise(parsed.text, null, {
              apiKey: key as string,
              voice: parsed.voice as string,
            });
            send(200, {
              mime: "audio/mpeg",
              audio: Buffer.from(bytes).toString("base64"),
              voice: parsed.voice,
              text: parsed.text,
            });
          } catch (cause) {
            send(502, { error: (cause as Error).message });
          }
          return;
        }

        const db = openDatabase(CARD_DB, { applySchema: false });
        try {
          if (parsed.kind === "speech") {
            await speech(db, parsed, send);
            return;
          }
          const cached = resolveDescriptorText(db, parsed);
          if (cached !== null && cached !== "") {
            send(200, { text: cached, cached: true });
            return;
          }
          const model =
            provider === "ollama"
              ? (process.env["HASHIGO_OLLAMA_MODEL"] ?? OLLAMA_MODEL)
              : (process.env["HASHIGO_MODEL"] ?? "claude-opus-5");
          const text = await generateText(parsed, {
            provider,
            apiKey: key,
            model,
            host,
            maxTokens: MAX_TOKENS,
          });
          if (text === "") {
            send(502, { error: `${model} returned nothing` });
            return;
          }
          storeDescriptorText(db, parsed, text);
          send(200, { text, cached: false, provider, model });
        } catch (cause) {
          send(502, { error: (cause as Error).message });
        } finally {
          db.close();
        }
      })();
    });
  };

  return {
    name: "hashigo-generate-on-demand",
    configureServer(server) {
      server.middlewares.use(handler as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler as never);
    },
  };
}
