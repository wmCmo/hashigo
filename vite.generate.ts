/**
 * GENERATE ONE MISSING FIELD, FROM THE CARD IN FRONT OF HIM.
 *
 * Zach, 2026-09-14, on a 疑念 card whose emoji line was simply absent: *"i need
 * way to regenerate on the fly when something is missing, maybe some ui?"*
 *
 *     POST /generate/   {"kind","text","lang","voice","options"}  ->  {"text"}
 *
 * ─── THIS IS SERVER CODE BECAUSE THE KEY MAY NOT LEAVE THE LAPTOP ───────────
 *
 * Decision 18 says the TTS key never goes in the client. The reason is not
 * specific to TTS — a key in a bundle is a key on every device that ever loaded
 * the page — so `ANTHROPIC_API_KEY` is held to the same rule. It is read from
 * `.env` (gitignored) in the Vite process and never serialised into a response.
 *
 * The trust boundary is EXACTLY the one decision 33 already chose for sync: this
 * rides the same server his phone already reaches over `tailscale serve`, which
 * is tailnet-only and is the transport picked precisely because it does not put
 * his study history on the open internet. No new infrastructure, no second
 * secret, nothing deployed. When the laptop is not reachable the button fails
 * with a sentence, which is the same availability the sync dot already has.
 *
 * ─── IT WRITES TO `build/hashigo.db`, AND THAT IS THE LOAD-BEARING PART ─────
 *
 * The obvious implementation returns the text and lets the device keep it. That
 * would lose it, twice over:
 *
 *   * decision 33's payload carries reviews, tracks and flags — **not blobs**.
 *     Zach deferred blob delivery himself (*"Leave it — fixed on rebuild only"*),
 *     so a generation made on the phone never reaches the laptop.
 *   * `scripts/app-bootstrap.ts` rebuilds the device seed FROM `build/hashigo.db`.
 *     Anything that exists only in OPFS is gone at the next rebuild.
 *
 * So the server stores it in `build/hashigo.db` — which decision 41 made the
 * system of record — and the device caches its own copy so the card is right now
 * and stays right until the rebuild hands it back properly. One generation, two
 * writes, and the one that survives is on the laptop.
 *
 * ─── WHAT IT REFUSES ────────────────────────────────────────────────────────
 *
 * `speech` and `image`. Audio regeneration is deferred by a decision repeated to
 * five agents (*"i will regenerate my audio after we finished the app"*) and
 * would need Google's key as well — a second secret for a job nobody asked for.
 * `storeDescriptorText` refuses a non-text kind on its own; this refuses earlier
 * so no request is ever billed.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

import { openDatabase } from "./src/db/index.js";
import { resolveDescriptorText, storeDescriptorText } from "./src/generate/index.js";
import type { BlobKind } from "./src/schema/index.js";

const root = dirname(fileURLToPath(import.meta.url));
const CARD_DB = resolve(root, "build/hashigo.db");

/** Only these can be asked for. See "what it refuses". */
const ALLOWED: ReadonlySet<string> = new Set(["ai", "translate"]);

/**
 * A prompt longer than this is not one of ours.
 *
 * The longest generator input in the corpus is a 基本情報 example-sentence prompt
 * at 211 characters. 2,000 is an order of magnitude of headroom and still bounds
 * what an unattended endpoint on his tailnet can be made to spend.
 */
const MAX_PROMPT = 2_000;

/** Short by construction — an emoji line, a sentence. Never an essay. */
const MAX_TOKENS = 256;

interface Descriptor {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
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
    return `kind must be one of ${[...ALLOWED].join(", ")} — audio is deferred, see decision 29`;
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
  };
}

/**
 * The prompt IS the generator's own text, unchanged.
 *
 * Decision 7: a generator's input is the RENDERED text. `Describe a word 疑念
 * using emojis only` is what Mochi sent and what the identity is keyed on, so
 * anything prepended here would change the answer without changing the key —
 * a cache whose contents no longer match its label. The system prompt is the
 * only place to say "reply with the thing and nothing else", and it is outside
 * the identity because it is a property of THIS generator, not of the request.
 */
const SYSTEM =
  "You are filling one field of a Japanese flashcard. " +
  "Reply with the requested content only — no preamble, no quotes, no explanation, " +
  "no trailing period unless the content is a sentence that needs one.";

async function generate(descriptor: Descriptor, key: string, model: string): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });
  const message = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: [{ role: "user", content: descriptor.text }],
  });
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
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
      // Checked WHILE reading. Buffering first and checking after is how a size
      // cap becomes a way to exhaust memory — the same rule `syncMailbox` follows.
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

        // `.env` is read HERE rather than at module load, so a key added while
        // the server is up works without a restart — and so that a config with
        // no key still starts, which is every gate in this repo.
        if (existsSync(resolve(root, ".env")) && process.env["ANTHROPIC_API_KEY"] === undefined) {
          process.loadEnvFile(resolve(root, ".env"));
        }
        const key = process.env["ANTHROPIC_API_KEY"];
        if (key === undefined || key === "") {
          send(503, { error: "no ANTHROPIC_API_KEY — put it in .env on the laptop" });
          return;
        }
        if (!existsSync(CARD_DB)) {
          send(503, { error: `no ${CARD_DB} to store the generation in` });
          return;
        }

        const db = openDatabase(CARD_DB, { applySchema: false });
        try {
          // ALREADY THERE? A second device asking for the same missing field —
          // or a second tap — must not be a second bill, and must not return
          // DIFFERENT emoji for a card he has already seen filled.
          const cached = resolveDescriptorText(db, parsed);
          if (cached !== null && cached !== "") {
            send(200, { text: cached, cached: true });
            return;
          }
          const text = await generate(parsed, key, process.env["HASHIGO_MODEL"] ?? "claude-opus-5");
          if (text === "") {
            send(502, { error: "the model returned nothing" });
            return;
          }
          storeDescriptorText(db, parsed, text);
          send(200, { text, cached: false });
        } catch (cause) {
          // The message, not the stack: this reaches a phone as a line of status
          // text, and an API error already says what went wrong in one sentence.
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
