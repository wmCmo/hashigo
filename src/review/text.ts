/**
 * Filling the text generators — the half of "stage 9" that was never wired.
 *
 * ─── THE BUG THIS EXISTS FOR, AND IT IS EVERY CARD ──────────────────────────
 *
 * Reported by Zach 2026-09-12, from his phone: *"the sentence is literally not
 * there"*. He was right, and the first answer he got was wrong — the data WAS
 * present, which is not the same claim as "it renders".
 *
 * `src/render/nodes.ts` is explicit about the contract:
 *
 *   > ai / translate / dictionary: the children are the PROMPT. Nothing visible
 *   > until stage 9 writes the output into this element.
 *
 * So the renderer emits `<span class="hashigo-generator hashigo-ai"
 * data-state="pending">` with nothing inside, records a `GeneratorMount` holding
 * the descriptor and an `output` element, and waits. For `speech` and `image` the
 * mount layer fills it — that is the audio. **For text generators nothing ever
 * did.** Measured over 400 cards before this module existed:
 *
 *     ai          575   empty
 *     translate   236   empty
 *     speech      470   mounted (audio worked)
 *     furigana     78   base text shown, <rt> empty
 *
 *     367 of 400 cards carried at least one empty text generator
 *
 * 297 of 300 単語 cards had a `例文` side whose element still held the PROMPT —
 * "Example sentence using 皇居 in Japanese (Don't translate)" — with the sentence
 * sitting resolvable in the database the whole time.
 *
 * ─── WHY FILLING IS A SEPARATE STEP, AND NOT PART OF THE RENDER ─────────────
 *
 * The renderer is browser-side and has no database; the store is in the worker.
 * So this splits the way audio already does: the page collects what the render
 * produced, asks the worker once for all of it, and writes the answers back.
 * One message per card, not one per generator.
 *
 * ─── FURIGANA IS DELIBERATELY NOT FILLED HERE ───────────────────────────────
 *
 * `furigana` is a text kind and its `output` is the `<rt>`, so it would fill with
 * one more line. It is left alone because its content is the READING, and on a
 * `Reading = true` card the reading is the ANSWER (decisions 20 and 29). The
 * template happens to wrap it in a cloze today, so filling it would probably be
 * safe — "probably" is not the standard for the one rule this app cannot get
 * wrong. A separate change, with the reveal tests re-run against it.
 */

import { DATA } from "../render/index.js";
import type {
  GeneratorMount,
  RenderDocument,
  RenderElement,
  RenderResult,
} from "../render/index.js";

/** The kinds this module writes. NOT `furigana` — see the header. */
const FILLABLE = new Set(["ai", "translate", "dictionary"]);

export interface TextSlot {
  /** Stable within one mounted card; what the fill map is keyed on. */
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  /** RAW resolved input — the prompt. The worker turns this into an identity. */
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
}

/**
 * Every generator slot on this card that wants TEXT written into it.
 *
 * `media === null` is the guard that keeps this away from audio: a `speech`
 * generator carries a `MediaMount` and must never be touched here. The hard rule
 * (audio never plays on entry for a produce card) lives in `audioController`, and
 * nothing in this file can reach it — but the guard means nothing in this file
 * can reach the media ELEMENT either, which is the stronger statement.
 */
export function textSlots<E extends RenderElement>(result: RenderResult<E>): {
  readonly slots: readonly TextSlot[];
  readonly mounts: readonly GeneratorMount<E>[];
} {
  const slots: TextSlot[] = [];
  const mounts: GeneratorMount<E>[] = [];
  for (const mount of result.generations) {
    if (mount.media !== null) continue;
    if (mount.output === null) continue;
    if (mount.request === null) continue;
    if (!FILLABLE.has(mount.name)) continue;
    slots.push({
      id: slots.length,
      name: mount.name,
      kind: mount.request.kind,
      text: mount.request.text,
      lang: mount.request.lang,
      voice: mount.request.voice,
      options: mount.request.options,
    });
    mounts.push(mount);
  }
  return { slots, mounts };
}

/**
 * Write the resolved text in. Returns how many slots were filled.
 *
 * A slot with no generation is left `pending` rather than emptied to `""`: the
 * two states are different facts — "nothing has been generated for this" versus
 * "this generated an empty string" — and `[data-state]` is what a stylesheet or a
 * diagnostic can tell them apart by.
 */
export function fillTextSlots<E extends RenderElement>(
  mounts: readonly GeneratorMount<E>[],
  texts: readonly (string | null)[],
  document: RenderDocument<E>,
): number {
  let filled = 0;
  mounts.forEach((mount, index) => {
    const text = texts[index];
    if (text === undefined || text === null || text === "") return;
    const output = mount.output;
    if (output === null) return;
    output.appendChild(document.createTextNode(text));
    // `ready` rather than removing the attribute: the element keeps saying what
    // it is, which is what makes "575 ai generators, 575 ready" countable.
    mount.element.setAttribute(DATA.state, "ready");
    filled += 1;
  });
  return filled;
}
