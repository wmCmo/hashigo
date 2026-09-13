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
 * The key travels in `x-goog-api-key`, NOT `?key=`: a query string lands in
 * server logs, proxy logs and shell history, and a header does not.
 */
export async function synthesise(
  text: string,
  request: SpeechRequest | null,
  options: SynthesiseOptions,
): Promise<Uint8Array> {
  const input = request === null ? { text } : { ssml: speechSsml(request) };
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
