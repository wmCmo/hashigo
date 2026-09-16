/**
 * THE ACCENT PIPELINE FINALLY REACHING THE AUDIO.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Zach, 2026-09-13: *"i noticed that some audio pitch aren't accurate — like
 * 医療 is labeled as 頭高 but the audio isn't"*.
 *
 * He was right, and the cause is systemic rather than a bad clip. Measured
 * across the whole corpus that day: **not one speech blob carries accent
 * notation.** Every `options` value is `{}` or a gender hint, on all 7,409
 * ja-JP Nanami clips. So the audio is Azure's unaided frontend prediction from
 * the KANJI, and the 3,816 `型` labels this project derived have never had any
 * influence on it. Where Azure guessed differently from OpenJTalk, the card now
 * shows a label its own audio contradicts — which is worse than showing no
 * label, because decision 29 has him promoting cards to `Reading = true` on the
 * strength of that label.
 *
 * A 362-clip stratified survey put a number on it: **5.5% of 頭高 clips have no
 * audible downstep** (6 of 110; ~75 of 1,372, 95% CI 27-158). The survey also
 * validated itself — 尾高 clips measured identical to 平板 (-1.6 vs -2.2
 * semitones), which is exactly what decision 27 predicts, since a 尾高 word's
 * downstep lands on a particle that is never spoken.
 *
 * ─── THE TRAP, PROVEN RATHER THAN INHERITED ─────────────────────────────────
 *
 * `CLAUDE.md` has always said Google ignores the notation when the element
 * contains kanji. That is now measured, on 医療, with the key this module uses:
 *
 *     plain text 医療                     sha256 e01c0aba…
 *     yomigana ph, KANJI element content  sha256 e01c0aba…   ← THE SAME FILE
 *     yomigana ph, KANA element content   sha256 d6e6e56e…
 *
 * Byte for byte identical. Google accepted the request, returned 200, and threw
 * the notation away. There is no error to catch — which is why `speechSsml`
 * REFUSES to build a request whose content is not kana, rather than trusting a
 * caller to remember. A silent no-op here would reproduce the exact defect this
 * module exists to remove, and nothing downstream could detect it.
 *
 * ─── WHAT IS DELIBERATELY NOT ANNOTATED ─────────────────────────────────────
 *
 * Isolated words only. `notes/pitch-accent-pipeline.md` settled this: a sentence
 * has several accent phrases, the frontend has context and handles them well,
 * and annotating one means getting every phrase boundary right — a heuristic
 * measured to fail SILENTLY on `に引き換え`. A word with no derived accent (the
 * 60 placeholder patterns like `～なり～なり`, where the rule refused) is
 * synthesised plain, for the same reason: no notation beats a guess.
 */

/** Small kana bind to the mora before them; `っ` and `ー` are morae of their own. */
const COMBINING = "ゃゅょャュョぁぃぅぇぉァィゥェォ";

/**
 * Split kana into MORAE, which is the unit an accent position counts in.
 *
 * `キョ` is one mora and `キ` + `ョ` is two, so a naive `[...reading]` puts the
 * downstep one position late on every word containing a small kana — 1,034 of
 * 3,242 bases in this corpus mix kanji and kana and many carry one.
 */
export function splitMoras(reading: string): string[] {
  const out: string[] = [];
  for (const ch of reading) {
    if (COMBINING.includes(ch) && out.length > 0) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/**
 * Build Google's `yomigana` phoneme string.
 *
 * `^` opens the accent phrase and `!` FOLLOWS the mora carrying the drop. The
 * position is `accents.accent_type` under `position_basis = 'accent-position'`
 * — the last HIGH mora, 1-based (decision 6: name the basis or the number is
 * not a fact). 平板 is 0 and gets no `!` at all, which is correct rather than a
 * missing case: it has no downstep inside the word.
 *
 * An accent past the end of the reading yields the unaccented form. That is the
 * safe direction — a `!` placed off the end would be a malformed request, and a
 * flat rendering of a word is what Azure already gives him.
 */
export function yomigana(reading: string, accent: number): string {
  const morae = splitMoras(reading);
  if (accent <= 0 || accent > morae.length) return `^${morae.join("")}`;
  return `^${morae.slice(0, accent).join("")}!${morae.slice(accent).join("")}`;
}

/** Katakana, hiragana, the long mark, and the marks a reading may carry. */
const KANA = /^[ぁ-ゟ゠-ヿーー〜～\s]+$/u;

export function isKana(text: string): boolean {
  return KANA.test(text);
}

export class NotKanaError extends Error {
  constructor(readonly text: string) {
    super(
      `refusing to annotate "${text}": Google DISCARDS <phoneme alphabet="yomigana"> ` +
        `when the element content is not kana, silently and with a 200. Pass the ` +
        `reading, never the head word.`,
    );
    this.name = "NotKanaError";
  }
}

export interface SpeechRequest {
  /** The kana the notation is built from, and the element's content. */
  readonly reading: string;
  /** `accents.accent_type`; 0 for 平板. */
  readonly accent: number;
}

/**
 * The SSML for one annotated word.
 *
 * THROWS on non-kana content rather than falling back to plain text. A fallback
 * would produce exactly the audio this module exists to replace, and would
 * produce it under a blob row claiming the accent had been applied.
 */
export function speechSsml(request: SpeechRequest): string {
  if (!isKana(request.reading)) throw new NotKanaError(request.reading);
  const ph = yomigana(request.reading, request.accent);
  return `<speak><phoneme alphabet="yomigana" ph="${ph}">${request.reading}</phoneme></speak>`;
}

// ─── the pauses a sentence was written with ──────────────────────────────────

/**
 * GOOGLE DOES NOT PAUSE AT `、`, AND THAT IS MEASURED, NOT SUSPECTED.
 *
 * Zach, 2026-09-16, on the 略歴 example sentence: *"i think the generated audio
 * was speaking without pausing on comma or natural pausing section"*. He is
 * right, and the same sentence in Mochi's Azure clip is the control:
 *
 *     彼の略歴を見ると、彼は多くの異なる業界で経験を積んできたことがわかります。
 *     Azure ja-JP-NanamiNeural   7.92 s   gaps at 2.06 s (120 ms), 4.50 s (100 ms)
 *     Google Neural2-C, plain    6.34 s   NO internal gap at all
 *
 * Measured by decoding both and taking a 20 ms RMS envelope, gaps being runs
 * under 2% of peak. **`<speak>` alone changes nothing** — wrapping the identical
 * text in SSML returned a byte-identical 50,688-byte file. The comma has to be
 * spelled as a break or Neural2-C reads straight through it.
 *
 *     <break time="200ms"/>   6.62 s   1.58 s (220 ms), 3.72 s (80 ms)
 *     <break time="400ms"/>   6.84 s   1.58 s (420 ms)
 *     <s> per sentence        7.01 s   1.68 s (400 ms)
 *
 * **200 ms, because the second gap is the point.** Nanami's own comma pause is
 * 120 ms, so 400 is already theatrical beside the thing he has shadowed for four
 * years — and the 200 ms request is the one that also brought back a SECOND
 * phrase break at 3.72 s that the plain reading did not have. Asking for the
 * pause he wrote changes how the model phrases the rest, which is the *"natural
 * pausing section"* half of his sentence.
 *
 * The sentence break is 400 ms on Google's own showing: `<s>` per sentence, the
 * markup that exists to mean exactly this, measured 400 ms at that boundary.
 *
 * ─── WHY THIS IS NOT THE SSML THE HEADER REFUSES ────────────────────────────
 *
 * That refusal is about ACCENT NOTATION on a sentence — `<phoneme>` needs every
 * accent-phrase boundary right and was measured to fail silently on `に引き換え`.
 * This needs no boundary at all: a break goes where HE typed a comma. It is the
 * same argument as decision 44 for `---` — the punctuation is authored, and a
 * renderer that ignores it is overruling the author.
 *
 * Nothing reaches here that has no such punctuation, so the 9,907 word clips are
 * byte-for-byte what they were: `pausedSsml` returns null and the plain path
 * runs. **1,681 of 11,588 speech texts carry a `、`**; 45 carry a sentence end
 * that is not the last character.
 */
export const COMMA_BREAK_MS = 200;
export const SENTENCE_BREAK_MS = 400;

/** `、，` pause; `。！？` also pause, but only where the text continues after them. */
const COMMA = /[、，]/u;
const SENTENCE_END = /[。．！？!?]/u;

function escapeXml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

/**
 * The sentence as SSML with its written pauses spelled out — or null when it has
 * none, which is every isolated word and is why this cannot change those clips.
 *
 * TRAILING punctuation gets no break. A break at the very end buys nothing but
 * silence at the end of a file that already has 700-900 ms of it, and on a
 * mode-2 card (decision 29) the clip IS the question, so a longer tail is dead
 * time before he can answer.
 */
export function pausedSsml(text: string): string | null {
  const characters = [...text];
  let out = "";
  let broke = false;
  for (let i = 0; i < characters.length; i += 1) {
    const ch = characters[i] as string;
    out += escapeXml(ch);
    // Anything after this that is not more punctuation or space — otherwise the
    // break lands inside `。」` or at the end and does nothing but pad the file.
    const rest = characters.slice(i + 1).join("");
    if (rest.trim() === "") continue;
    if (COMMA.test(ch)) {
      out += `<break time="${COMMA_BREAK_MS}ms"/>`;
      broke = true;
    } else if (SENTENCE_END.test(ch) && !SENTENCE_END.test(characters[i + 1] as string)) {
      out += `<break time="${SENTENCE_BREAK_MS}ms"/>`;
      broke = true;
    }
  }
  return broke ? `<speak>${out}</speak>` : null;
}

// ─── the call ────────────────────────────────────────────────────────────────

/**
 * Decision 18: THE KEY NEVER GOES IN THE CLIENT. This module is Node-only and
 * is reached from the CLI; nothing in `app/` imports it.
 */
export const ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";

/** Settled by measurement 2026-08-20 — see the TTS section of `CLAUDE.md`. */
export const VOICE = "ja-JP-Neural2-C";

export interface SynthesiseOptions {
  readonly apiKey: string;
  readonly voice?: string;
  /** `mp3` matches every existing clip and the store's sniffing. */
  readonly encoding?: "MP3" | "LINEAR16";
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * One word, one clip.
 *
 * `input` is SSML when the word has a derived accent and plain text when it does
 * not — see the header on why a guess is worse than nothing.
 *
 * A SENTENCE takes a third path: no accent notation, but its written pauses
 * spelled as `<break>`, because Google reads straight through `、` otherwise.
 * `pausedSsml` carries that measurement. The three are mutually exclusive and
 * ordered — an annotated word is kana and cannot contain punctuation.
 *
 * The key travels in `x-goog-api-key`, NOT `?key=`: a query string lands in
 * server logs, proxy logs and shell history, and a header does not.
 */
export async function synthesise(
  text: string,
  request: SpeechRequest | null,
  options: SynthesiseOptions,
): Promise<Uint8Array> {
  const paused = request === null ? pausedSsml(text) : null;
  const input =
    request !== null
      ? { ssml: speechSsml(request) }
      : paused === null
        ? { text }
        : { ssml: paused };
  const call = options.fetch ?? globalThis.fetch;
  const response = await call(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "x-goog-api-key": options.apiKey,
    },
    body: JSON.stringify({
      input,
      voice: { languageCode: "ja-JP", name: options.voice ?? VOICE },
      audioConfig: { audioEncoding: options.encoding ?? "MP3" },
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`text:synthesize answered ${response.status} — ${detail.slice(0, 200)}`);
  }
  const body = (await response.json()) as { audioContent?: string };
  if (typeof body.audioContent !== "string" || body.audioContent === "") {
    throw new Error(`text:synthesize returned no audioContent for "${text}"`);
  }
  return Uint8Array.from(Buffer.from(body.audioContent, "base64"));
}
