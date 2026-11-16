export interface LlmDescriptor {
  readonly kind: string;
  readonly text: string;
  readonly options: Readonly<Record<string, string>>;
}

const BASE =
  "You are filling one field of a Japanese flashcard. " +
  "Reply with the requested content only — no preamble, no quotes, no explanation, " +
  "no trailing period unless the content is a sentence that needs one.";

export function systemPrompt(descriptor: LlmDescriptor): string {
  if (descriptor.kind !== "translate") return BASE;
  const from = descriptor.options["from"] ?? "ja";
  const to = descriptor.options["to"] ?? "en";
  return (
    `${BASE} The user's message is text in ${from}. ` +
    `Translate it into ${to} and output only the translation.`
  );
}

export function stripThinking(text: string): string {
  return text
    .replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/i, "")
    .replace(/<(thinking_mode|reasoning_effort)>[^<]*<\/\1>/gi, "")
    .trim();
}

const EMOJI_PROMPT = /using\s+emojis?\b/i;
const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const EMOJI_JOINER = /^[\s+=＋→⇒\-–—,、・|/]$/u;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export function isEmojiPrompt(prompt: string): boolean {
  return EMOJI_PROMPT.test(prompt);
}

export function emojiOnly(text: string): string {
  const parts = [...graphemes.segment(text)].map((part) => part.segment);
  const start = parts.findIndex((part) => EMOJI_GRAPHEME.test(part));
  if (start < 0) return "";
  const run: string[] = [];
  for (const part of parts.slice(start)) {
    if (EMOJI_GRAPHEME.test(part)) run.push(part);
    else if (EMOJI_JOINER.test(part) && !(part.includes("\n") && run.at(-1)?.includes("\n"))) run.push(part);
    else break;
  }
  return run.join("").replace(/[\s+=＋→⇒\-–—,、・|/]+$/u, "").trim();
}

export function cleanGenerated(prompt: string, text: string): string {
  const clean = stripThinking(text);
  return isEmojiPrompt(prompt) ? emojiOnly(clean) : clean;
}

const JAPANESE_SENTENCE_PROMPT = /sentence using (.+?) in Japanese/i;

export function sentenceProblem(prompt: string, text: string): string | null {
  const asked = JAPANESE_SENTENCE_PROMPT.exec(prompt);
  if (asked === null) return null;
  const word = (asked[1] ?? "").normalize("NFKC").trim();
  const sentence = text.normalize("NFKC");
  if (word === "" || /[\s/・,、()「」[\]|'"。～〜~….A-Z]/u.test(word) || /^[\x00-\x7F]+$/.test(word)) return null;
  if (/[a-z]{2,}/.test(sentence)) return "wrote an English word into the sentence";
  const stem = word.replace(/[ぁ-ゟ]+$/u, "");
  if (stem === "") return null;
  return sentence.includes(stem) ? null : `left ${word} out of its own sentence`;
}

export type LlmProvider = "ollama" | "anthropic" | "gemini";

export interface LlmOptions {
  readonly provider: LlmProvider;
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly host?: string | undefined;
  readonly maxTokens: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly effort?: AnthropicEffort | undefined;
  readonly onUsage?: ((usage: { input: number; output: number }) => void) | undefined;
}

export type AnthropicEffort = "low" | "medium" | "high";

export const OLLAMA_HOST = "http://127.0.0.1:11434";
export const OLLAMA_MODEL = "qwen3:8b";

export const OLLAMA_MIN_PREDICT = 2_048;

export async function ollamaReachable(
  host: string = OLLAMA_HOST,
  call: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  try {
    const response = await call(`${host}/api/tags`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function viaOllama(descriptor: LlmDescriptor, options: LlmOptions): Promise<string> {
  const call = options.fetch ?? globalThis.fetch;
  const response = await call(`${options.host ?? OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      system: systemPrompt(descriptor),
      prompt: descriptor.text,
      stream: false,
      think: false,
      options: { num_predict: Math.max(options.maxTokens, OLLAMA_MIN_PREDICT) },
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ollama answered ${response.status} — ${detail.slice(0, 200)}`);
  }
  const body = (await response.json()) as {
    response?: string;
    thinking?: string;
    done_reason?: string;
  };
  const text = stripThinking(body.response ?? "");
  if (text === "" && (body.done_reason === "length" || (body.thinking ?? "") !== "")) {
    throw new Error(
      `${options.model} spent its whole token budget thinking (done_reason=${body.done_reason ?? "?"}) — raise num_predict`,
    );
  }
  return text;
}

const ANTHROPIC_MIN_TOKENS = 2048;
const ANTHROPIC_MIN_TOKENS_THINKING = 8192;

async function viaAnthropic(descriptor: LlmDescriptor, options: LlmOptions): Promise<string> {
  const key = options.apiKey;
  if (key === undefined || key === "") throw new Error("no ANTHROPIC_API_KEY");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });
  const effort = options.effort ?? "low";
  const message = await client.messages.create({
    model: options.model,
    max_tokens: Math.max(options.maxTokens, effort === "low" ? ANTHROPIC_MIN_TOKENS : ANTHROPIC_MIN_TOKENS_THINKING),
    output_config: { effort },
    system: systemPrompt(descriptor),
    messages: [{ role: "user", content: descriptor.text }],
  });
  options.onUsage?.({ input: message.usage.input_tokens, output: message.usage.output_tokens });
  return stripThinking(
    message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
  );
}

export const GEMINI_THINKING_LEVEL = "HIGH";
const GEMINI_MIN_TOKENS = 8_192;
export const GEMINI_TIMEOUT_MS = 45_000;
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";

async function viaGemini(descriptor: LlmDescriptor, options: LlmOptions): Promise<string> {
  const key = options.apiKey;
  if (key === undefined || key === "") throw new Error("no GEMINI_API_KEY");
  const call = options.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(GEMINI_TIMEOUT_MS);
  const response = await call(`${GEMINI_API}/${encodeURIComponent(options.model)}:generateContent`, {
    method: "POST",
    signal: timeout,
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt(descriptor) }] },
      contents: [{ role: "user", parts: [{ text: descriptor.text }] }],
      generationConfig: {
        maxOutputTokens: Math.max(options.maxTokens, GEMINI_MIN_TOKENS),
        thinkingConfig: { thinkingLevel: GEMINI_THINKING_LEVEL },
      },
    }),
  }).catch((cause: unknown) => {
    if (timeout.aborted) throw new Error(`${options.model} gave no answer in ${GEMINI_TIMEOUT_MS / 1000} s`);
    throw cause;
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`gemini answered ${response.status} — ${detail.slice(0, 200)}`);
  }
  const body = (await response.json()) as {
    candidates?: {
      finishReason?: string;
      content?: { parts?: { text?: string; thought?: boolean }[] };
    }[];
    promptFeedback?: { blockReason?: string };
  };
  const blocked = body.promptFeedback?.blockReason;
  if (blocked !== undefined) throw new Error(`${options.model} refused the prompt (blockReason=${blocked})`);
  const candidate = body.candidates?.[0];
  const finish = candidate?.finishReason ?? "none";
  if (finish !== "STOP") {
    throw new Error(`${options.model} did not finish (finishReason=${finish}) — nothing is stored`);
  }
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? "")
    .join("");
  return stripThinking(text).trim();
}

export async function generateText(
  descriptor: LlmDescriptor,
  options: LlmOptions,
): Promise<string> {
  if (options.provider === "ollama") return await viaOllama(descriptor, options);
  if (options.provider === "gemini") return await viaGemini(descriptor, options);
  return await viaAnthropic(descriptor, options);
}
