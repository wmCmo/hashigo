import { fillVoiceFor } from "./speech.js";

export interface CatalogueVoice {
  readonly name: string;
  readonly lang: string;
  readonly label: string;
}

function voice(name: string, label: string): CatalogueVoice {
  const [language, region] = name.split("-");
  return { name, lang: `${language}-${region}`, label };
}

export const GOOGLE_VOICES: readonly CatalogueVoice[] = [
  voice("ja-JP-Neural2-C", "Neural2-C · male — his pick by ear, 2026-08-20"),
  voice("ja-JP-Neural2-D", "Neural2-D · male"),
  voice("ja-JP-Neural2-B", "Neural2-B · female"),
  voice("en-US-Neural2-D", "Neural2-D · male"),
  voice("en-US-Neural2-J", "Neural2-J · male"),
  voice("en-US-Studio-Q", "Studio-Q · male"),
  voice("en-US-Chirp3-HD-Charon", "Chirp3-HD Charon · male"),
  voice("en-US-Neural2-F", "Neural2-F · female"),
  voice("en-US-Neural2-C", "Neural2-C · female"),
];

const BY_NAME = new Map(GOOGLE_VOICES.map((entry) => [entry.name, entry]));

export function isCatalogueVoice(name: string | null | undefined): boolean {
  return typeof name === "string" && BY_NAME.has(name);
}

export function catalogueVoice(name: string | null | undefined): CatalogueVoice | null {
  return typeof name === "string" ? (BY_NAME.get(name) ?? null) : null;
}

export function voicesFor(lang: string | null | undefined): CatalogueVoice[] {
  if (typeof lang !== "string" || lang === "") return [...GOOGLE_VOICES];
  const prefix = lang.slice(0, 2).toLowerCase();
  return GOOGLE_VOICES.filter((entry) => entry.lang.slice(0, 2).toLowerCase() === prefix);
}

export function synthesisVoice(asked: string | null | undefined, lang: string | null | undefined): string {
  return isCatalogueVoice(asked) ? (asked as string) : fillVoiceFor(lang);
}

export function sampleLine(lang: string): string {
  return lang.slice(0, 2).toLowerCase() === "ja"
    ? "橋を渡ってから、箸でご飯を食べました。"
    : "She was assiduous in her studies, and it showed.";
}
