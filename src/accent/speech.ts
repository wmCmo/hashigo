import { FILL_VOICE } from "../generate/speech.js";

const COMBINING = "ゃゅょャュョぁぃぅぇぉァィゥェォ";

export function splitMoras(reading: string): string[] {
  const out: string[] = [];
  for (const ch of reading) {
    if (COMBINING.includes(ch) && out.length > 0) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

export function yomigana(reading: string, accent: number): string {
  const morae = splitMoras(reading);
  if (accent <= 0 || accent > morae.length) return `^${morae.join("")}`;
  return `^${morae.slice(0, accent).join("")}!${morae.slice(accent).join("")}`;
}

export function accentOfLabel(label: string, reading: string): number | null {
  const text = label.trim();
  const morae = splitMoras(reading.trim()).length;
  if (morae === 0) return null;
  if (text === "平板") return 0;
  if (text === "頭高") return 1;
  if (text === "尾高") return morae;
  const middle = /^中高\s*\((\d+)\)$/.exec(text);
  if (middle === null) return null;
  const at = Number(middle[1]);
  return at >= 2 && at < morae ? at : null;
}

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
  readonly reading: string;
  readonly accent: number;
}

export function speechSsml(request: SpeechRequest): string {
  if (!isKana(request.reading)) throw new NotKanaError(request.reading);
  const ph = yomigana(request.reading, request.accent);
  return `<speak><phoneme alphabet="yomigana" ph="${ph}">${request.reading}</phoneme></speak>`;
}

export const COMMA_BREAK_MS = 200;
export const SENTENCE_BREAK_MS = 400;

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

export interface Reading {
  readonly base: string;
  readonly alias: string;
}

export function pausedSsml(text: string, readings: readonly Reading[] = []): string | null {
  const usable = readings
    .filter((reading) => reading.base !== "" && reading.alias !== "" && text.includes(reading.base))
    .sort((a, b) => b.base.length - a.base.length);
  const characters = [...text];
  let out = "";
  let broke = false;
  for (let i = 0; i < characters.length; i += 1) {
    const ahead = characters.slice(i).join("");
    const reading = usable.find((entry) => ahead.startsWith(entry.base));
    if (reading !== undefined) {
      out += `<sub alias="${escapeXml(reading.alias)}">${escapeXml(reading.base)}</sub>`;
      i += [...reading.base].length - 1;
      broke = true;
      continue;
    }
    const ch = characters[i] as string;
    out += escapeXml(ch);
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

export const ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";

export const VOICE = FILL_VOICE;

export function languageOf(voice: string): string {
  const parts = voice.split("-");
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "ja-JP";
}

export interface SynthesiseOptions {
  readonly apiKey: string;
  readonly voice?: string;
  readonly encoding?: "MP3" | "LINEAR16";
  readonly fetch?: typeof globalThis.fetch;
  readonly readings?: readonly Reading[];
}

export async function synthesise(
  text: string,
  request: SpeechRequest | null,
  options: SynthesiseOptions,
): Promise<Uint8Array> {
  const paused = request === null ? pausedSsml(text, options.readings ?? []) : null;
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
      voice: { languageCode: languageOf(options.voice ?? VOICE), name: options.voice ?? VOICE },
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
