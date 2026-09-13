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
  NotKanaError,
  VOICE,
  isKana,
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
