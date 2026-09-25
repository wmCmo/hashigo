/**
 * THE VOICES THIS PROJECT CAN ACTUALLY SPEAK WITH — Google's, and only these.
 *
 * Zach, 2026-09-17: *"for the `<<Example>>` in my english deck, it's the speech
 * generation right? but i can't even select voice or language there, which result
 * in it generating the japanese speech instead"*. Stage D of fields-as-modules.
 *
 * ─── TWO KINDS OF VOICE NAME LIVE IN THIS DATABASE ──────────────────────────
 *
 * Every speech field Mochi exported names an AZURE voice — `ja-JP-NanamiNeural`,
 * `en-US-AIGenerate1Neural`. Those names are right for LOOKING UP the ~11,000
 * clips Mochi made, and impossible to SEND anywhere: the only synthesiser this
 * project owns is Google's, whose `en-US` list (fetched 2026-09-20) is
 * `Casual · Chirp · Chirp3 · Neural2 · News · Polyglot · Standard · Studio ·
 * Wavenet` with no `AIGenerate1Neural` in it. So a field's stored voice is a
 * LOOKUP key first, and a synthesis target only when it is one of the names
 * below. `synthesisVoice` is where that decision is made, once.
 *
 * ─── WHY THIS IS A SHORTLIST AND NOT GOOGLE'S WHOLE CATALOGUE ───────────────
 *
 * For Japanese, the voice is a CORRECTNESS choice before it is a taste one:
 * `Neural2` honours `<phoneme alphabet="yomigana">` and `Chirp3-HD` changes its
 * output per notation without matching the patterns (CLAUDE.md, TTS section). A
 * picker that offered Chirp3 for Japanese would offer a wrong accent drilled.
 * For English there is no accent notation in play, so the list is the four he
 * auditioned on 2026-09-20 plus two female Neural2 voices so the choice is not
 * one-gendered by omission.
 *
 * It is also the server's ALLOWLIST: `vite.generate.ts` refuses a preview in any
 * voice not listed here, exactly as `ALLOWED` gates `kind`, so an unattended
 * endpoint on his tailnet cannot be made to bill an arbitrary voice.
 *
 * NO NODE IMPORTS — the editor, the worker and the middleware all read this.
 */

import { fillVoiceFor } from "./speech.js";

export interface CatalogueVoice {
  /** Google's voice name, exactly as the API takes it. */
  readonly name: string;
  /** BCP-47 locale, read off the name — Google names every voice `<lang>-<region>-…`. */
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

/** True when this project can synthesise with the name. */
export function isCatalogueVoice(name: string | null | undefined): boolean {
  return typeof name === "string" && BY_NAME.has(name);
}

/** The catalogue entry, or null. */
export function catalogueVoice(name: string | null | undefined): CatalogueVoice | null {
  return typeof name === "string" ? (BY_NAME.get(name) ?? null) : null;
}

/**
 * The voices a field of this language may switch to.
 *
 * Matched on the LANGUAGE (`en` of `en-US`), not the full tag, for `fillVoiceFor`'s
 * reason. A field with no language gets the whole list — nothing can be said
 * about it, and hiding voices would be a guess.
 */
export function voicesFor(lang: string | null | undefined): CatalogueVoice[] {
  if (typeof lang !== "string" || lang === "") return [...GOOGLE_VOICES];
  const prefix = lang.slice(0, 2).toLowerCase();
  return GOOGLE_VOICES.filter((entry) => entry.lang.slice(0, 2).toLowerCase() === prefix);
}

/**
 * THE VOICE A NEW CLIP IS ACTUALLY MADE WITH, given what the field asks for.
 *
 * A catalogue name is honoured as asked — that is the point of the picker. Any
 * other name (every Azure name Mochi stored) cannot be sent to Google, so the
 * clip is made in the language's fill voice, which is exactly what the fill path
 * did before stage D. The row records whoever really spoke.
 */
export function synthesisVoice(asked: string | null | undefined, lang: string | null | undefined): string {
  return isCatalogueVoice(asked) ? (asked as string) : fillVoiceFor(lang);
}

/**
 * A short line to audition a voice with. Fixed per language, so "hear it" costs
 * one synthesis and never touches a card.
 *
 * The Japanese one carries the minimal pair the whole accent pipeline exists for
 * (橋 and 箸), because that is what a Japanese voice is being judged on here.
 */
export function sampleLine(lang: string): string {
  return lang.slice(0, 2).toLowerCase() === "ja"
    ? "橋を渡ってから、箸でご飯を食べました。"
    : "She was assiduous in her studies, and it showed.";
}
