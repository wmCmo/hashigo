/**
 * The accent notation that finally reaches the audio.
 *
 * ZACH, 2026-09-13: *"i noticed that some audio pitch aren't accurate — like
 * 医療 is labeled as 頭高 but the audio isn't, you can check"*.
 *
 * Checked. The cause was systemic: **not one speech blob in the corpus carries
 * accent notation** — every `options` is `{}` or a gender hint across all 7,409
 * ja-JP clips — so the audio has always been Azure's unaided guess from the
 * kanji, and the 3,816 derived `型` labels never influenced it. A 362-clip
 * stratified survey measured 5.5% of 頭高 clips with no audible downstep.
 *
 * The tests below are shaped around the ONE failure mode that cannot be caught
 * downstream: Google accepts a request whose `<phoneme>` content is kanji,
 * returns 200, and DISCARDS the notation. Measured on 医療 with the real key —
 * the annotated-with-kanji response was byte-identical (sha256 `e01c0aba…`) to
 * sending no notation at all. Nothing in the response says so. If this module
 * ever falls back to plain text instead of throwing, the corpus regenerates
 * itself back to exactly the audio he complained about, and every blob row
 * claims the accent was applied.
 */
import { describe, expect, it } from "vitest";

import {
  COMMA_BREAK_MS,
  NotKanaError,
  SENTENCE_BREAK_MS,
  VOICE,
  isKana,
  languageOf,
  pausedSsml,
  speechSsml,
  splitMoras,
  synthesise,
  yomigana,
} from "../src/accent/speech.js";

describe("morae, which is the unit an accent counts in", () => {
  it("binds small kana to the mora before them", () => {
    // `キョ` is ONE mora. Counting `キ` and `ョ` separately puts the downstep a
    // position late on every word containing one — and 医療 (イリョー) is one.
    expect(splitMoras("イリョー")).toEqual(["イ", "リョ", "ー"]);
    expect(splitMoras("キョーカショ")).toEqual(["キョ", "ー", "カ", "ショ"]);
    expect(splitMoras("シズカ")).toEqual(["シ", "ズ", "カ"]);
  });

  it("keeps っ and ー as morae of their own, because they are", () => {
    expect(splitMoras("イッチャク")).toEqual(["イ", "ッ", "チャ", "ク"]);
    expect(splitMoras("ケッコー")).toEqual(["ケ", "ッ", "コ", "ー"]);
  });

  it("survives a leading small kana rather than dropping it", () => {
    // Nothing to bind to. It must still be a mora, not vanish.
    expect(splitMoras("ャー")).toEqual(["ャ", "ー"]);
  });
});

describe("the yomigana string", () => {
  it("puts the drop AFTER the last high mora — 医療 is the case he reported", () => {
    // accent_type 1 under `position_basis = accent-position`: イ is high, the
    // rest is low. Decision 6 — the basis is why this is not off by one.
    expect(yomigana("イリョー", 1)).toBe("^イ!リョー");
  });

  it("gives 平板 no downstep at all, rather than a drop at position 0", () => {
    expect(yomigana("イズレ", 0)).toBe("^イズレ");
  });

  it("counts in MORAE, not characters", () => {
    // 教科書 キョーカショ is 中高 3: キョ ー カ high, ショ low. Counting
    // characters would put the `!` after `ー`.
    expect(yomigana("キョーカショ", 3)).toBe("^キョーカ!ショ");
  });

  it("falls back to the flat form when the accent runs off the end", () => {
    // The safe direction: a `!` past the end is a malformed request, and flat is
    // what he already has.
    expect(yomigana("イリョー", 9)).toBe("^イリョー");
    expect(yomigana("イリョー", -1)).toBe("^イリョー");
  });
});

describe("THE TRAP: kanji content silently discards the notation", () => {
  it("refuses a head word, loudly", () => {
    // Measured with the real API: annotating 医療 with 医療 as the element
    // content returned a file byte-identical to sending no notation. A 200, no
    // warning, and audio that contradicts the label on the card.
    expect(() => speechSsml({ reading: "医療", accent: 1 })).toThrow(NotKanaError);
    expect(() => speechSsml({ reading: "医療", accent: 1 })).toThrow(/never the head word/);
  });

  it("does NOT fall back to plain text, which would rebuild the defect", () => {
    // The tempting repair. It would regenerate the corpus back to Azure-quality
    // audio while every blob row claimed the accent had been applied — the same
    // wrong sound, now with provenance saying it was fixed.
    let threw = false;
    try {
      speechSsml({ reading: "静か", accent: 1 });
    } catch {
      threw = true;
    }
    expect(threw, "a kanji reading produced SSML instead of throwing").toBe(true);
  });

  it("accepts both kana, the long mark, and the placeholder tilde", () => {
    expect(isKana("イリョー")).toBe(true);
    expect(isKana("しずか")).toBe(true);
    expect(isKana("〜ようものなら")).toBe(true);
    expect(isKana("医療")).toBe(false);
    expect(isKana("イリョー medical")).toBe(false);
  });

  it("puts the READING in the element, not the word", () => {
    expect(speechSsml({ reading: "イリョー", accent: 1 })).toBe(
      '<speak><phoneme alphabet="yomigana" ph="^イ!リョー">イリョー</phoneme></speak>',
    );
  });
});

/**
 * ─── THE PAUSES HE WROTE ────────────────────────────────────────────────────
 *
 * Zach, 2026-09-16, on the 略歴 example sentence the fill had just made: *"i
 * think the generated audio was speaking without pausing on comma or natural
 * pausing section"*. Decoded and measured against Mochi's Azure clip of the very
 * same sentence: Azure 7.92 s with gaps at 2.06 s and 4.50 s, Google Neural2-C
 * 6.34 s with NO internal gap at all. Wrapping it in `<speak>` unchanged came
 * back byte-identical, so the break has to be spelled out.
 */
describe("the pauses a sentence was written with", () => {
  it("spells `、` as a break, and leaves a word with no punctuation alone", () => {
    const ssml = pausedSsml("彼の略歴を見ると、彼は多くの異なる業界で経験を積んできたことがわかります。");
    expect(ssml).toBe(
      `<speak>彼の略歴を見ると、<break time="${COMMA_BREAK_MS}ms"/>彼は多くの異なる業界で経験を積んできたことがわかります。</speak>`,
    );
    // THE PROPERTY THAT KEEPS 9,907 WORD CLIPS BYTE-FOR-BYTE WHAT THEY WERE.
    expect(pausedSsml("略歴")).toBeNull();
    expect(pausedSsml("～なり～なり")).toBeNull();
  });

  it("does NOT break on trailing punctuation — the file already ends in silence", () => {
    // A break at the very end adds nothing but dead time, and on a mode-2 card
    // (decision 29) the clip IS the question, so the tail is time before he can
    // answer. Measured tails: 700-900 ms already.
    expect(pausedSsml("略歴。")).toBeNull();
    expect(pausedSsml("本当ですか？")).toBeNull();
    expect(pausedSsml("「そうだね」")).toBeNull();
  });

  it("breaks longer at a sentence end that the text continues past", () => {
    const ssml = pausedSsml("そうだ。行こう。");
    expect(ssml).toBe(`<speak>そうだ。<break time="${SENTENCE_BREAK_MS}ms"/>行こう。</speak>`);
    expect(SENTENCE_BREAK_MS).toBeGreaterThan(COMMA_BREAK_MS);
  });

  it("escapes the text, because this is markup now and a card may hold an `&`", () => {
    const ssml = pausedSsml("A & B、<C>");
    expect(ssml).toContain("A &amp; B、");
    expect(ssml).toContain("&lt;C&gt;");
    expect(ssml).not.toMatch(/<C>/u);
  });

  it("sends it as SSML, and an accent request still wins", async () => {
    const seen: Array<{ input: { text?: string; ssml?: string } }> = [];
    const fetch = (async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body) as { input: { text?: string } });
      return {
        ok: true,
        status: 200,
        json: async () => ({ audioContent: Buffer.from("audio").toString("base64") }),
        text: async () => "",
      };
    }) as unknown as typeof globalThis.fetch;

    await synthesise("彼の略歴を見ると、彼は…", null, { apiKey: "k", fetch });
    expect(seen[0]?.input.ssml).toContain(`<break time="${COMMA_BREAK_MS}ms"/>`);
    expect(seen[0]?.input.text).toBeUndefined();

    // An annotated word is kana by construction and cannot carry punctuation, so
    // the two paths cannot both fire — but the order is pinned rather than
    // reasoned about, because a `<phoneme>` losing to a `<break>` would be the
    // silent no-op this module exists to prevent.
    await synthesise("医療", { reading: "イリョー", accent: 1 }, { apiKey: "k", fetch });
    expect(seen[1]?.input.ssml).toContain("^イ!リョー");
    expect(seen[1]?.input.ssml).not.toContain("break");
  });
});

describe("the request itself", () => {
  const ok = (audio: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ audioContent: audio }),
    text: async () => "",
  });

  it("sends SSML when there is an accent and plain TEXT when there is none", async () => {
    // A word with no derived accent — the 60 placeholder patterns where the rule
    // refused — is synthesised plain. No notation beats a guessed one.
    const seen: unknown[] = [];
    const fetch = (async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body));
      return ok(Buffer.from("audio").toString("base64"));
    }) as unknown as typeof globalThis.fetch;

    await synthesise("医療", { reading: "イリョー", accent: 1 }, { apiKey: "k", fetch });
    await synthesise("～なり～なり", null, { apiKey: "k", fetch });

    expect((seen[0] as { input: { ssml?: string } }).input.ssml).toContain("^イ!リョー");
    expect((seen[1] as { input: { text?: string } }).input.text).toBe("～なり～なり");
    expect((seen[1] as { input: { ssml?: string } }).input.ssml).toBeUndefined();
  });

  it("derives the language from the voice, so the two cannot disagree", async () => {
    // They DID disagree: `languageCode` was pinned to `ja-JP` beside whatever
    // voice was asked for, so the 2026-09-16 fill spoke 130 en-US texts with the
    // Japanese voice. Both halves of the row were individually truthful.
    let body: { voice: { languageCode: string; name: string } } | null = null;
    const fetch = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return ok(Buffer.from("audio").toString("base64"));
    }) as unknown as typeof globalThis.fetch;
    await synthesise("gulls", null, { apiKey: "k", fetch, voice: "en-US-Neural2-D" });
    expect(body!.voice).toEqual({ languageCode: "en-US", name: "en-US-Neural2-D" });
    expect(languageOf(VOICE)).toBe("ja-JP");
  });

  it("uses the voice settled by measurement, and asks for mp3", async () => {
    let body: { voice: { name: string }; audioConfig: { audioEncoding: string } } | null = null;
    const fetch = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return ok(Buffer.from("audio").toString("base64"));
    }) as unknown as typeof globalThis.fetch;
    await synthesise("医療", { reading: "イリョー", accent: 1 }, { apiKey: "k", fetch });
    expect(body!.voice.name).toBe(VOICE);
    expect(VOICE).toBe("ja-JP-Neural2-C");
    // mp3 matches every existing clip and what the store sniffs.
    expect(body!.audioConfig.audioEncoding).toBe("MP3");
  });

  it("carries the key in a HEADER, never the query string", async () => {
    // A `?key=` lands in server logs, proxy logs and shell history.
    let url = "", headers: Record<string, string> = {};
    const fetch = (async (u: string, init: { headers: Record<string, string> }) => {
      url = u;
      headers = init.headers;
      return ok(Buffer.from("a").toString("base64"));
    }) as unknown as typeof globalThis.fetch;
    await synthesise("医療", null, { apiKey: "SECRET", fetch });
    expect(url).not.toContain("SECRET");
    expect(headers["x-goog-api-key"]).toBe("SECRET");
  });

  it("throws with the server's own words rather than an empty clip", async () => {
    const fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"Invalid SSML"}}',
      json: async () => ({}),
    })) as unknown as typeof globalThis.fetch;
    await expect(synthesise("医療", null, { apiKey: "k", fetch })).rejects.toThrow(/400.*Invalid SSML/);
  });

  it("refuses a 200 that carries no audio", async () => {
    // A zero-byte clip written into the store would become a permanent cache
    // hit — `lookupGeneration` already excludes `byte_size > 0` because Mochi
    // left ten of them behind.
    const fetch = (async () => ({
      ok: true, status: 200, json: async () => ({}), text: async () => "",
    })) as unknown as typeof globalThis.fetch;
    await expect(synthesise("医療", null, { apiKey: "k", fetch })).rejects.toThrow(/no audioContent/);
  });
});
