/**
 * WHAT A CARD STILL NEEDS GENERATED — one card's gaps, by generation identity.
 *
 * `scripts/fill-generations.ts` walked the whole corpus with exactly this logic on
 * 2026-09-15 to fill what Mochi never made. Zach, 2026-10-21, after adding his
 * 漢検 cards by hand and finding an example-sentence side that said
 * `<<Translate>>` until he tapped "generate": *"those things that automatically
 * generates should also be created when we created the card, no need to wait for
 * users to click it"*. The app now asks the same question of ONE card, so the
 * per-card sweep lives here and the script's corpus sweep is a loop over it.
 *
 * ─── WHY IT RENDERS RATHER THAN READING FIELDS ──────────────────────────────
 *
 * Decision 7: a generator's input is the RENDERED text. 単語's `Translate` reads
 * `例文`, which is itself an `ai` generation, so its request does not exist until
 * the sentence does. `prepareCard` resolves chained fields from the store, which
 * makes this a function of what is stored NOW: call it again after filling and
 * the next link of the chain appears. The caller loops; this stays one pass.
 *
 * ─── PRESENCE IS ASKED THROUGH THE SHIPPING RESOLVERS ───────────────────────
 *
 * `resolveAudioHash` for speech — the rule the review screen plays by, card voice
 * first and the fill voice after — and `lookupGeneration` for text. The script's
 * header records what a hand-rolled copy cost: every one of 10,461 clips read as
 * absent and the dry run priced $2.65 of re-synthesis instead of $0.40.
 *
 * `furigana` is never a gap here. The Worker cannot make one, and a reading is
 * the thing being drilled — decision 8's line. A card's own `読み` covers it
 * (`app/reading-override.ts`).
 */

import { generationIdentity, lookupGeneration } from "../blobs/generation.js";
import { resolveAudioHash } from "../cards/audio.js";
import { resolveDescriptorText } from "../generate/store.js";
import type { SqliteHandle } from "../db/browser.js";
import { memoryDocument, renderSides } from "../render/index.js";
import type { BlobKind } from "../schema/index.js";
import { prepareCard } from "./mount.js";
import { ACCENT_FIELD_TYPE } from "./mode.js";
import { yomiOf } from "../fields/yomi.js";
import { accentOfLabel, isKana } from "../accent/speech.js";

/** One generation to make, with everything its identity is keyed on. */
export interface CardGap {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  /**
   * HOW TO SAY the head word: its 読み and 型's accent, for the voice's
   * `yomigana` notation. NOT part of the clip's identity — the key stays
   * `text/voice/lang/options`, so no stored clip looks missing because of it.
   * See `wordPronunciation`.
   */
  readonly pronounce?: Pronunciation;
}

/** A word's reading and accent position, as `speechSsml` takes them. */
export interface Pronunciation {
  readonly reading: string;
  readonly accent: number;
}

/**
 * HOW THE HEAD WORD'S CLIP MAY BE MADE — decision 67, 2026-11-13.
 *
 * Zach, on 数隻: *"it was saying かずせき lol"*. The automatic fill (decision 62)
 * sent the voice plain text, so Google guessed the reading — 165 word clips were
 * made that way, the reading only ever sent on a REDO. And a reading alone is not
 * enough: *"it wouldn't know the accent between 塔 and 問う"*. So, for the clip of
 * the head word on a card whose template runs the accent drill (`型`):
 *
 *   - `waiting`: the word has kanji and no 読み yet. The laptop's helper fills
 *     読み and 型 in one pass (decision 56); a clip made before it is a guess
 *     kept forever, which is how 数隻 became かずせき. Not made — it stays a
 *     gap, and the next showing after the helper makes it.
 *   - `pronounce`: 読み (or a kana head word) and 型's accent — the SSML the
 *     batch pipeline always used. With no usable 型 (decision 22's six, a
 *     multi-phrase label) the request text is still the kana 読み (decision
 *     10), so the READING is right and only the contour is the voice's.
 *
 * Null for every other clip: sentences carry no accent notation (the TTS rule).
 */
export function wordPronunciation(
  db: SqliteHandle,
  cardId: string,
  text: string,
): { readonly waiting: true } | { readonly waiting: false; readonly pronounce?: Pronunciation } | null {
  const card = db
    .prepare(
      `SELECT c.name AS name,
              (SELECT v.value FROM card_field_values v
                 JOIN template_fields f ON f.template_id = c.template_id AND f.id = v.field_id
                WHERE v.card_id = c.id AND f.type = ? LIMIT 1) AS label,
              EXISTS (SELECT 1 FROM template_fields f WHERE f.template_id = c.template_id AND f.type = ?) AS drilled
         FROM cards c WHERE c.id = ?`,
    )
    .get(ACCENT_FIELD_TYPE, ACCENT_FIELD_TYPE, cardId) as
    | { name: string; label: string | null; drilled: number }
    | undefined;
  if (card === undefined || Number(card.drilled) !== 1) return null;
  const name = card.name.trim();
  const yomi = yomiOf(db, cardId);
  const spoken = text.trim();
  if (spoken !== name && spoken !== yomi) return null; // not the head word's clip
  const reading = yomi ?? (isKana(name) ? name : null);
  if (reading === null) return { waiting: true };
  const accent = accentOfLabel(card.label ?? "", reading);
  return accent === null ? { waiting: false } : { waiting: false, pronounce: { reading, accent } };
}

/** The kinds the Worker can make. Furigana is deliberately not one — see the header. */
export const FILLABLE_KINDS: ReadonlySet<string> = new Set(["ai", "translate", "speech"]);

/**
 * Every generation this card renders and nothing has made yet, deduplicated by
 * identity (two mounts asking for the same sentence are one call, and for speech
 * one payment). Forward direction: the reverse track renders the same requests
 * in a different side order.
 */
export function cardGaps(
  db: SqliteHandle,
  cardId: string,
  kinds: ReadonlySet<string> = FILLABLE_KINDS,
): CardGap[] {
  const prepared = prepareCard({ db, cardId, direction: "forward" });
  if (prepared === null) return [];
  const out = renderSides(prepared.sides, { document: memoryDocument() });
  const seen = new Set<string>();
  const gaps: CardGap[] = [];
  for (const generation of out.generations) {
    const request = generation.request;
    if (request === null || !kinds.has(request.kind)) continue;
    if (String(request.text).trim() === "") continue;
    const identity = generationIdentity({
      kind: request.kind,
      text: request.text,
      voice: request.voice,
      lang: request.lang,
      options: request.options,
    });
    const key = JSON.stringify(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    // Text through the CLEANING resolver (2026-11-06): an emoji line stored with no
    // emoji in it is not there — `resolveDescriptorText` answers null for it, so it
    // is a gap and gets made again. `lookupGeneration` alone would call it present.
    const present =
      request.kind === "speech"
        ? resolveAudioHash(db, cardId, { origin: "generator", request }) !== null
        : lookupGeneration(db, identity) !== null && resolveDescriptorText(db, request) !== null;
    if (present) continue;
    const word = request.kind === "speech" ? wordPronunciation(db, cardId, String(request.text)) : null;
    if (word?.waiting === true) continue; // the helper's 読み first — see `wordPronunciation`
    gaps.push({
      kind: request.kind,
      text: request.text,
      lang: request.lang,
      voice: request.voice,
      options: request.options,
      ...(word?.waiting === false && word.pronounce !== undefined ? { pronounce: word.pronounce } : {}),
    });
  }
  return gaps;
}
