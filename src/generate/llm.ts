/**
 * WHICH MODEL FILLS A TEXT FIELD, AND WHAT IT IS ACTUALLY ASKED.
 *
 * ─── ZACH, 2026-09-15 ───────────────────────────────────────────────────────
 *
 * *"instead of a couple $, can we use ollama instead? i have qwen ready on my
 * machine lol"*
 *
 * He is right that the money is avoidable, and right that this is the field to
 * spend a local model on. **All 1,182 missing `ai` generations are the EMOJI
 * LINE** — measured, not assumed; zero example sentences are missing. A wrong
 * emoji is cosmetic. Compare that with a wrong furigana reading, which is the
 * thing being drilled and where decision 8 says a guess is worse than nothing —
 * which is exactly why furigana is NOT filled by any model at all, but from the
 * 336 readings the accent pipeline already derived.
 *
 * Measured on his machine, `qwen3:8b`, real prompts from the corpus:
 *
 *     Describe a word 参考にする using emojis only   ->  📖💡✨      2.1 s
 *     Describe a word おっとり using emojis only     ->  🐢🍃💧      0.1 s
 *     Describe a word あれこれ using emojis only     ->  🌀🌀🌀🌀🌀  93.3 s (cold load)
 *
 * The first call pays for loading the weights; after that it is faster than the
 * network round trip it replaces. `あれこれ` ("this and that") came out as five
 * identical swirls — weak, not wrong, and the honest summary of this trade.
 *
 * ─── `think: false` IS LOAD-BEARING FOR QWEN3 ──────────────────────────────
 *
 * Qwen3 is a thinking model and Ollama returns the reasoning in the response
 * unless told otherwise. A card whose emoji line is a paragraph of deliberation
 * is worse than an empty one. The flag is set, AND `stripThinking` runs anyway,
 * because the flag is a request and the tag is a fact: another model, or another
 * Ollama version, can put one there regardless.
 *
 * ─── THE TRANSLATE PROMPT WAS BROKEN, AND THIS IS WHERE IT IS FIXED ────────
 *
 * `vite.generate.ts` sent `descriptor.text` as the entire user message under one
 * generic system prompt. That is correct for `ai`, where **the text IS the
 * instruction** (`Describe a word 疑念 using emojis only` is what Mochi sent and
 * what the identity is keyed on — decision 7). It is wrong for `translate`,
 * where the text is just a Japanese sentence and nothing anywhere says to
 * translate it. Measured, the same day the bug was found:
 *
 *     sent as it was    努力してこそ、成功をつかむことができる。
 *     came back         努力してこそ、成功をつかむことができる。   <- echoed
 *     with an instruction   Only through effort can one grasp success.
 *
 * It had never been exercised: he tested the button on emoji, and translate is
 * 129 of 2,446 gaps. **The instruction goes in the SYSTEM prompt, never in the
 * user message**, because the user message is the identity's `source_text` —
 * prepending to it would change the answer without changing the key, producing a
 * cache whose contents no longer match its label.
 *
 * The language pair comes from `options` (`{"from":"ja","to":"en"}` on 単語's
 * `Translate` field), not from a guess about the script.
 */

/** What a caller must tell us to fill one field. */
export interface LlmDescriptor {
  readonly kind: string;
  readonly text: string;
  readonly options: Readonly<Record<string, string>>;
}

/**
 * Shared by every kind. The trailing-period clause exists because an emoji line
 * with a full stop after it looks like a sentence that failed.
 */
const BASE =
  "You are filling one field of a Japanese flashcard. " +
  "Reply with the requested content only — no preamble, no quotes, no explanation, " +
  "no trailing period unless the content is a sentence that needs one.";

/**
 * The system prompt for one request.
 *
 * `ai` gets nothing added: its user message is already a full instruction, and
 * anything said here would be a second opinion about a prompt Mochi wrote.
 */
export function systemPrompt(descriptor: LlmDescriptor): string {
  if (descriptor.kind !== "translate") return BASE;
  const from = descriptor.options["from"] ?? "ja";
  const to = descriptor.options["to"] ?? "en";
  return (
    `${BASE} The user's message is text in ${from}. ` +
    `Translate it into ${to} and output only the translation.`
  );
}

/**
 * Remove a reasoning block a thinking model emitted anyway.
 *
 * Deliberately tolerant of an UNCLOSED tag: a response truncated at the token
 * limit mid-thought would otherwise be stored whole, and a field holding half a
 * monologue is the worst of the three outcomes (empty, right, or plausible
 * rubbish). An unclosed `<think>` therefore takes everything after it.
 *
 * ALSO THE CONTROL TAGS A HOSTED MODEL ECHOES. 2026-10-21, 左遷's emoji line came
 * back from the Worker as `<thinking_mode>auto</thinking_mode>\n\n
 * <reasoning_effort>medium</reasoning_effort>👔📉🏢➡️🏝️😞`, was cached in KV and
 * rendered on the card as is — 1 of the 54 cloud text generations at the time.
 * They are settings, not content, so each pair goes and what follows stays.
 */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .replace(/<(thinking_mode|reasoning_effort)>[^<]*<\/\1>/gi, "")
    .trim();
}

export type LlmProvider = "ollama" | "anthropic";

export interface LlmOptions {
  readonly provider: LlmProvider;
  /** Anthropic only. Never read for Ollama, which needs no secret at all. */
  readonly apiKey?: string | undefined;
  readonly model: string;
  /** Ollama's base URL. Defaults to the daemon's own default. */
  readonly host?: string | undefined;
  readonly maxTokens: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Default when nothing names one. His machine has it; it costs nothing to run. */
export const OLLAMA_HOST = "http://127.0.0.1:11434";
export const OLLAMA_MODEL = "qwen3:8b";

/**
 * A LOCAL REASONING MODEL SPENDS THE SAME BUDGET ON THINKING AS ON ANSWERING.
 *
 * `MAX_TOKENS` is 256 in `vite.generate.ts` and that is right for Anthropic,
 * where the answer IS the output — "an emoji line, a sentence". Ollama counts
 * reasoning tokens against `num_predict`, and Ollama returns the reasoning in a
 * SEPARATE `thinking` field, so a model that deliberates past the cap stops with
 * `done_reason: "length"` and an EMPTY `response`. Measured on gpt-oss:20b,
 * 2026-09-15, translating 彼なら彼で、自分のやり方があるんだよ。:
 *
 *     num_predict=256    eval=256  done=length  response=""
 *     num_predict=2048   eval=421  done=stop    response="When it comes to him,
 *                                                he's his own person…"
 *
 * Two of three sentences in the first batch run came back empty for exactly
 * this. The reasoning is FREE here — it is his own GPU, and the only cost is
 * seconds — so the floor is generous. It bounds a runaway, nothing more; the
 * answer stays short because the system prompt says so, not because the budget
 * cuts it off.
 */
export const OLLAMA_MIN_PREDICT = 2_048;

/**
 * Is a local daemon actually there?
 *
 * Asked before every batch and once per server start, never per request: the
 * answer decides where the money goes, and discovering it mid-run would mean a
 * run that is half local and half billed with nothing recording which was which.
 */
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
      // RAW, and this is decision 7 rather than laziness: the user message is
      // the generator's own rendered input and is what the identity is keyed on.
      prompt: descriptor.text,
      stream: false,
      think: false,
      // The caller's budget is for the ANSWER; the floor covers the thinking
      // that shares it. See `OLLAMA_MIN_PREDICT`.
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
  // NAME THE CAUSE. "returned nothing" sent a first batch run looking at the
  // model when the answer was the token budget, and the two are fixed
  // differently. `thinking` present with `response` empty is the same story from
  // the other side: it deliberated and never got to the answer.
  if (text === "" && (body.done_reason === "length" || (body.thinking ?? "") !== "")) {
    throw new Error(
      `${options.model} spent its whole token budget thinking (done_reason=${body.done_reason ?? "?"}) — raise num_predict`,
    );
  }
  return text;
}

async function viaAnthropic(descriptor: LlmDescriptor, options: LlmOptions): Promise<string> {
  const key = options.apiKey;
  if (key === undefined || key === "") throw new Error("no ANTHROPIC_API_KEY");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });
  const message = await client.messages.create({
    model: options.model,
    max_tokens: options.maxTokens,
    system: systemPrompt(descriptor),
    messages: [{ role: "user", content: descriptor.text }],
  });
  return stripThinking(
    message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
  );
}

/** One field, one answer, from whichever provider the caller chose. */
export async function generateText(
  descriptor: LlmDescriptor,
  options: LlmOptions,
): Promise<string> {
  return options.provider === "ollama"
    ? await viaOllama(descriptor, options)
    : await viaAnthropic(descriptor, options);
}
