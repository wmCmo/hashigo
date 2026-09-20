/**
 * GENERATE ONE MISSING FIELD, FROM THE CARD IN FRONT OF HIM.
 *
 * Zach, 2026-09-14, on a 疑念 card whose emoji line was simply absent: *"i need
 * way to regenerate on the fly when something is missing, maybe some ui?"*
 *
 *     POST /generate/   {"kind","text","lang","voice","options"}
 *       text kinds  ->  {"text"}
 *       speech      ->  {"hash","mime","audio"}   audio is base64 mp3
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
 * ─── SPEECH, ADDED 2026-09-15, AND WHAT THAT DOES AND DOES NOT OVERTURN ────
 *
 * Zach, on a 合理 card whose example sentence would not play: *"it won't let me
 * play the audio of the example sentence — do you think because it's missing?
 * then we need a way to regenerate it, like the emoji section we did."* It was
 * missing. **785 of 10,420 mounts (7.5%) resolve to nothing**, on 627 cards, and
 * 178 of those are mode-2 cards where decision 29 makes the clip the QUESTION.
 *
 * This header used to refuse `speech` outright, on the deferred-regeneration
 * decision repeated to five agents. **That decision is about REGENERATING clips
 * that exist** — swapping the voice on the corpus — and his reason for deferring
 * it was *"i have to re import anyway"*, which decision 41 retired on 2026-09-13.
 * Synthesising a clip that was never made is a different act, and he asked for it
 * directly. `image` is still refused: nobody has asked.
 *
 * **The second secret is real and stays server-side.** `GOOGLE_TTS_SECRET` is
 * read here exactly as `ANTHROPIC_API_KEY` is, in the Vite process, and reaches
 * no response — which is decision 18 observed rather than bent: the rule is that
 * the key never goes in the CLIENT, and a Node plugin is not the client.
 *
 * **The bytes come back in the response, and the text kinds do not do that.** A
 * clip's payload lives in the separate store, so the device cannot reconstruct
 * it from a descriptor the way it can re-derive text. Base64 costs 33% on a clip
 * that is p50 4.08 s — tens of kilobytes, once, on a tap he made.
 *
 * ─── WHAT IT REFUSES ────────────────────────────────────────────────────────
 *
 * `image`, and any kind not in `ALLOWED`. `storeDescriptorText` refuses a
 * non-text kind on its own; this refuses earlier so no request is ever billed.
 */
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
  fillVoiceFor,
  generateText,
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

/** Only these can be asked for. See "what it refuses". */
const ALLOWED: ReadonlySet<string> = new Set(["ai", "translate", "speech"]);

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
    return `kind must be one of ${[...ALLOWED].join(", ")}`;
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
 * THE PROMPT IS THE GENERATOR'S OWN TEXT, AND THE INSTRUCTION IS NOT.
 *
 * Decision 7: a generator's input is the RENDERED text. `Describe a word 疑念
 * using emojis only` is what Mochi sent and what the identity is keyed on, so
 * anything prepended to the user message would change the answer without
 * changing the key — a cache whose contents no longer match its label. The
 * system prompt is the only place to say what to do with it, and
 * `src/generate/llm.ts` owns that, per kind. It also owns the reason
 * `translate` needed one: without it the model echoed the Japanese back.
 */
/**
 * ONE CLIP, AND THE SAME THREE ANSWERS THE TEXT PATH GIVES.
 *
 * `cached` is not a nicety: a second tap, a second device, or the batch script
 * meeting a card the phone already filled must cost nothing and must return the
 * SAME bytes. The device needs them either way — its OPFS store has only what
 * the last seed rebuild put there — so a hit still sends the payload.
 *
 * The lookup and the write both key on `FILL_VOICE`, never on the voice the card
 * asked for. `src/cards/audio.ts` has the whole argument; the short version is
 * that the row must say who actually spoke.
 */
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
  // THE CARD'S OWN VOICE FIRST, THEN THE FILL — `audioHashCandidates`' order,
  // and this endpoint used to skip the first half entirely.
  //
  // ─── WHAT THAT COST, MEASURED 2026-09-18 ────────────────────────────────
  //
  // The device offers "generate audio" when IT cannot resolve a mount. That is a
  // statement about the seed subset, not about the corpus: `app-bootstrap`
  // spends its byte budget on each card's cheapest clip first, so **141 clips
  // (20 MiB) sit on the laptop and not in the seed** — 82 Nanami, 45
  // `en-US-AIGenerate1Neural`, 9 already at the fill voice. The laptop is
  // missing NOTHING: 0 of 11,591 speech rows lack a payload here.
  //
  // Keyed on `FILL_VOICE` alone, every one of those 141 presses missed a file
  // sitting on this disk, billed Google, and filed a SECOND clip — so an English
  // sentence came back in `ja-JP-Neural2-C`, which is the 130-row defect
  // `src/accent/speech.ts` already records, being manufactured one tap at a time.
  // Zach's report was `assiduous`: the right clip is 74,400 bytes, reads in
  // 0.5 ms, and was re-synthesised at ~300 ms into the wrong voice.
  //
  // The asked voice is tried FIRST rather than merely as well, because it is the
  // clip the card is actually for.
  // PER LANGUAGE since 2026-09-20 — see `fillVoiceFor`. An `en-US` descriptor now
  // falls back to the English voice, not the Japanese one.
  const fillVoice = fillVoiceFor(descriptor.lang);
  const wanted = descriptor.voice !== null && descriptor.voice !== fillVoice
    ? [descriptor.voice, fillVoice]
    : [fillVoice];
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
      // `readBlob` THROWS on a row whose payload is gone rather than returning
      // null, and 17 such rows already exist — Mochi lost the files and left the
      // rows. Caught, not propagated: falling through and synthesising it again
      // is strictly better than reporting a hit the caller cannot play.
      try {
        const bytes = readBlob(db, hit, opened.store);
        send(200, {
          hash: hit,
          mime: "audio/mpeg",
          audio: Buffer.from(bytes).toString("base64"),
          cached: true,
          // WHICH voice answered. A cache hit under the asked voice and one under
          // the fill are different facts about what he is about to hear, and the
          // whole reason this bug survived is that nothing said which it was.
          voice,
        });
        return;
      } catch {
        /* fall through and try the next voice, then make it */
      }
    }
    const key = process.env["GOOGLE_TTS_SECRET"] as string;
    // NO ACCENT NOTATION, ever, on anything reaching here. `src/accent/speech.ts`
    // settled that: a sentence has several accent phrases, the frontend has
    // context and handles them, and the boundary heuristic was measured to fail
    // SILENTLY on `に引き換え`. A head word reaching here is synthesised without
    // it for the same reason a word with no derived accent is — no notation
    // beats a guess (decision 8).
    //
    // THAT IS NOT THE SAME AS "plain text, never SSML", which this comment used
    // to say and which cost Zach a rushed clip on 2026-09-16. `synthesise` now
    // spells a sentence's WRITTEN pauses as `<break>`, because Google reads
    // straight through `、` — measured, 6.34 s against Azure's 7.92 s on the same
    // sentence, with no internal gap at all. A break needs no phrase boundary
    // guessed; it goes where he typed the comma.
    // WHAT IS SPOKEN IS NOT WHAT IS KEYED, and both halves are deliberate.
    //
    // `speakableText` removes what cannot be pronounced — markdown emphasis, and
    // generator tags the renderer never filled. The fill path used to hand the
    // RAW field value to Google, which is why 76 of his 130 mis-voiced clips read
    // asterisks aloud and 30 recited `<ai>Example sentence of plectrum</ai>`.
    // Decision 7's rule, applied where it had been skipped.
    //
    // The IDENTITY still uses `descriptor.text`, unchanged, because that is what
    // the card's mount will look up. A row keyed on the cleaned text could never
    // be found again. `source_text` is the generation's INPUT, not a transcript —
    // the same reason the accent notation is not in it either.
    const spoken = speakableText(descriptor.text);
    if (spoken === "") {
      send(422, {
        error:
          "there is nothing to speak here — this field is still an unresolved " +
          "generator, so the sentence has to be generated before it can be voiced.",
      });
      return;
    }
    const bytes = await synthesise(spoken, null, { apiKey: key, voice: fillVoice });
    const hash = storeGeneratedSpeech(
      db,
      opened.store,
      { text: descriptor.text, lang: descriptor.lang, options: descriptor.options },
      bytes,
    );
    send(200, {
      hash,
      mime: "audio/mpeg",
      audio: Buffer.from(bytes).toString("base64"),
      cached: false,
      // `FILL_VOICE`, and it is NOT necessarily the right language. Synthesising
      // an `en-US` text here speaks English through Japanese phonology — the
      // exact pairing `src/accent/speech.ts` documents 130 existing rows of.
      // The lookup above now spares the 45 English clips that already exist, so
      // this arm is reached only for a text nothing has ever spoken. **Choosing
      // an English fill voice is Zach's call, by ear** — he picked this one that
      // way — so this reports the mismatch rather than inventing a second voice.
      voice: fillVoice,
      // Still reported, because `fillVoiceFor` falls back to Japanese for a
      // language it has no entry for — so this now means "nobody has chosen a
      // voice for this language yet", which is the case worth surfacing.
      mismatch:
        descriptor.lang !== null && !descriptor.lang.startsWith(fillVoice.slice(0, 2))
          ? `spoken by ${fillVoice} although the card says ${descriptor.lang}`
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
        // ─── WHICH PROVIDER, AND THEREFORE WHICH SECRET ───────────────────
        //
        // ONE GUARD PER KIND, not one guard for both. A speech request refused
        // for a missing ANTHROPIC key would name the wrong secret, and the wrong
        // secret is the worst possible error message to read on a phone.
        //
        // **A text field prefers OLLAMA when the daemon answers**, because Zach
        // has it running and it costs nothing (2026-09-15). That needs NO key —
        // so the Anthropic guard must not fire for a request that was never
        // going to be billed. `HASHIGO_LLM=anthropic` forces the other way.
        // Whichever served it comes back in the response, because a provider
        // that changes silently is a quality change nobody can trace.
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

        const db = openDatabase(CARD_DB, { applySchema: false });
        try {
          if (parsed.kind === "speech") {
            await speech(db, parsed, send);
            return;
          }
          // ALREADY THERE? A second device asking for the same missing field —
          // or a second tap — must not be a second bill, and must not return
          // DIFFERENT emoji for a card he has already seen filled.
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
