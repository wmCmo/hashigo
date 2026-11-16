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
    expect(splitMoras("イリョー")).toEqual(["イ", "リョ", "ー"]);
    expect(splitMoras("キョーカショ")).toEqual(["キョ", "ー", "カ", "ショ"]);
    expect(splitMoras("シズカ")).toEqual(["シ", "ズ", "カ"]);
  });

  it("keeps っ and ー as morae of their own, because they are", () => {
    expect(splitMoras("イッチャク")).toEqual(["イ", "ッ", "チャ", "ク"]);
    expect(splitMoras("ケッコー")).toEqual(["ケ", "ッ", "コ", "ー"]);
  });

  it("survives a leading small kana rather than dropping it", () => {
    expect(splitMoras("ャー")).toEqual(["ャ", "ー"]);
  });
});

describe("the yomigana string", () => {
  it("puts the drop AFTER the last high mora — 医療 is the case he reported", () => {
    expect(yomigana("イリョー", 1)).toBe("^イ!リョー");
  });

  it("gives 平板 no downstep at all, rather than a drop at position 0", () => {
    expect(yomigana("イズレ", 0)).toBe("^イズレ");
  });

  it("counts in MORAE, not characters", () => {
    expect(yomigana("キョーカショ", 3)).toBe("^キョーカ!ショ");
  });

  it("falls back to the flat form when the accent runs off the end", () => {
    expect(yomigana("イリョー", 9)).toBe("^イリョー");
    expect(yomigana("イリョー", -1)).toBe("^イリョー");
  });
});

describe("THE TRAP: kanji content silently discards the notation", () => {
  it("refuses a head word, loudly", () => {
    expect(() => speechSsml({ reading: "医療", accent: 1 })).toThrow(NotKanaError);
    expect(() => speechSsml({ reading: "医療", accent: 1 })).toThrow(/never the head word/);
  });

  it("does NOT fall back to plain text, which would rebuild the defect", () => {
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

describe("the pauses a sentence was written with", () => {
  it("spells `、` as a break, and leaves a word with no punctuation alone", () => {
    const ssml = pausedSsml("彼の略歴を見ると、彼は多くの異なる業界で経験を積んできたことがわかります。");
    expect(ssml).toBe(
      `<speak>彼の略歴を見ると、<break time="${COMMA_BREAK_MS}ms"/>彼は多くの異なる業界で経験を積んできたことがわかります。</speak>`,
    );
    expect(pausedSsml("略歴")).toBeNull();
    expect(pausedSsml("～なり～なり")).toBeNull();
  });

  it("does NOT break on trailing punctuation — the file already ends in silence", () => {
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
    expect(body!.audioConfig.audioEncoding).toBe("MP3");
  });

  it("carries the key in a HEADER, never the query string", async () => {
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
    const fetch = (async () => ({
      ok: true, status: 200, json: async () => ({}), text: async () => "",
    })) as unknown as typeof globalThis.fetch;
    await expect(synthesise("医療", null, { apiKey: "k", fetch })).rejects.toThrow(/no audioContent/);
  });
});

import {
  GOOGLE_VOICES,
  isCatalogueVoice,
  synthesisVoice,
  voicesFor,
} from "../src/generate/voices.js";
import { FILL_VOICE as GENERATE_FILL } from "../src/generate/speech.js";
import { VOICE as ACCENT_VOICE } from "../src/accent/speech.js";
import { optionsRefusal, patchOptions } from "../app/field-ops.js";

describe("the voice catalogue decides what can be SENT, not what can be looked up", () => {
  it("honours a catalogue voice as asked — the point of the picker", () => {
    expect(synthesisVoice("en-US-Neural2-J", "en-US")).toBe("en-US-Neural2-J");
  });

  it("an AZURE name Mochi stored is a lookup key only: the clip is made in the fill voice", () => {
    expect(isCatalogueVoice("en-US-AIGenerate1Neural")).toBe(false);
    expect(synthesisVoice("en-US-AIGenerate1Neural", "en-US")).toBe("en-US-Neural2-D");
    expect(synthesisVoice("ja-JP-NanamiNeural", "ja-JP")).toBe("ja-JP-Neural2-C");
  });

  it("offers an English field only English voices — the 130-clip bug, made unpickable", () => {
    const names = voicesFor("en-US").map((entry) => entry.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith("en-"))).toBe(true);
  });

  it("offers Japanese only Neural2 — the family that honours the accent notation", () => {
    for (const entry of voicesFor("ja-JP")) expect(entry.name).toMatch(/^ja-JP-Neural2-/);
  });

  it("every catalogue name is Google-shaped and its lang is read off the name", () => {
    for (const entry of GOOGLE_VOICES) {
      expect(entry.name.startsWith(`${entry.lang}-`)).toBe(true);
    }
  });

  it("the synthesiser and the filer name the SAME voice, by import", () => {
    expect(ACCENT_VOICE).toBe(GENERATE_FILL);
  });

  it("undo can put an Azure name back — a voice is shape-checked, not catalogue-checked", () => {
    const azure = '{"gender":"male","lang":"en-US","voice":"en-US-AIGenerate1Neural"}';
    const google = patchOptions(azure, { voice: "en-US-Neural2-J" });
    expect(optionsRefusal("speech", azure, google)).toBeNull();
    expect(optionsRefusal("speech", google, azure)).toBeNull();
    expect(optionsRefusal("speech", azure, patchOptions(azure, { voice: "nanami" }))).toMatch(
      /not a voice name/,
    );
  });
});
