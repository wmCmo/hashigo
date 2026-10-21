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
import type { SqliteHandle } from "../db/browser.js";
import { memoryDocument, renderSides } from "../render/index.js";
import type { BlobKind } from "../schema/index.js";
import { prepareCard } from "./mount.js";

/** One generation to make, with everything its identity is keyed on. */
export interface CardGap {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
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
    const present =
      request.kind === "speech"
        ? resolveAudioHash(db, cardId, { origin: "generator", request }) !== null
        : lookupGeneration(db, identity) !== null;
    if (present) continue;
    gaps.push({
      kind: request.kind,
      text: request.text,
      lang: request.lang,
      voice: request.voice,
      options: request.options,
    });
  }
  return gaps;
}
