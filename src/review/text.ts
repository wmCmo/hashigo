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
 * ─── FURIGANA IS FILLED, BUT ONLY BEHIND A MASK — AND "PROBABLY" WAS WRONG ──
 *
 * This header used to say furigana was left alone because its content is the
 * READING, which on a `Reading = true` card is the ANSWER (decisions 20 and 29),
 * and that "the template happens to wrap it in a cloze today, so filling it would
 * probably be safe". Zach found the cost of that caution, 2026-09-12: an unfilled
 * `<rt>` is an EMPTY `<rt>`, and the stylesheet draws an em dash over any empty
 * reading — so the head word on every reverse 単語 card wore a floating dash.
 * *"why is the text coming out like that bro😭"*
 *
 * **And "probably" was wrong.** Measured over the real corpus, both directions:
 * **6,754 furigana mounts, 42 outside a cloze, and all 42 on `produce` cards** —
 * precisely the leak the caution was about, on 21 real cards. A rule of "the
 * template wraps it" would have shipped the answer on the question side of those.
 *
 * So the guard is structural and measured rather than a claim about templates:
 * **`mount.inCloze`**, recorded by the renderer while it builds the cloze's answer
 * subtree. Behind a mask, the reading is revealed by the same tap that reveals
 * everything else on the side; outside one, it stays `pending` and this module
 * does not touch it.
 *
 * **The guard is on furigana ALONE, and that asymmetry is load-bearing rather
 * than untidy.** Applying it to all four kinds would be a neater sentence and
 * would undo the fix that came before it: 単語's example sentence is an `ai`
 * generator in a `<blockquote>` with no cloze anywhere near it, so a blanket
 * `inCloze` rule makes it invisible again. The distinction is what the card ASKS
 * him for — the reading is the exercise on 692 cards, a translation is never the
 * exercise on any — so only the reading needs to stay behind the mask.
 */

import { DATA } from "../render/index.js";
import type {
  GeneratorMount,
  RenderDocument,
  RenderElement,
  RenderResult,
} from "../render/index.js";
import type { RubyMount } from "../render/ruby.js";

/** The kinds this module writes. */
const FILLABLE = new Set(["ai", "translate", "dictionary", "furigana"]);

/**
 * Kinds whose output is the ANSWER, so they may only be written behind a mask.
 *
 * One entry, and it is not a placeholder for a future list: `furigana` produces
 * the reading, which decisions 20 and 29 make the exercise on 692 cards. See the
 * header for why the other three are deliberately NOT in here.
 */
const ANSWER_KINDS = new Set(["furigana"]);

/**
 * A slot and, when it is a furigana, the `<ruby>` that owns it.
 *
 * The ruby is carried rather than looked up at fill time because only the RENDER
 * knows it: `furiganaSupport` is what built the multi-run skeleton, and the
 * generator mount alone cannot say which `<rt>` belongs to which run.
 */
export interface FillTarget<E extends RenderElement = RenderElement> {
  readonly mount: GeneratorMount<E>;
  readonly ruby: RubyMount<E> | null;
}

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
export function textSlots<E extends RenderElement>(
  result: RenderResult<E>,
  rubies: readonly RubyMount<E>[] = [],
): {
  readonly slots: readonly TextSlot[];
  readonly mounts: readonly FillTarget<E>[];
} {
  const slots: TextSlot[] = [];
  const mounts: FillTarget<E>[] = [];
  const rubyFor = new Map<GeneratorMount<E>, RubyMount<E>>();
  for (const ruby of rubies) rubyFor.set(ruby.generator as GeneratorMount<E>, ruby);
  for (const mount of result.generations) {
    if (mount.media !== null) continue;
    if (mount.output === null) continue;
    if (mount.request === null) continue;
    if (!FILLABLE.has(mount.name)) continue;
    // The reading, outside a mask, on the side that asks him to produce it. 42 of
    // 6,754 mounts over the real corpus, every one on a `produce` card.
    if (ANSWER_KINDS.has(mount.name) && !mount.inCloze) continue;
    slots.push({
      id: slots.length,
      name: mount.name,
      kind: mount.request.kind,
      text: mount.request.text,
      lang: mount.request.lang,
      voice: mount.request.voice,
      options: mount.request.options,
    });
    mounts.push({ mount, ruby: rubyFor.get(mount) ?? null });
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
  targets: readonly FillTarget<E>[],
  texts: readonly (string | null)[],
  document: RenderDocument<E>,
): number {
  let filled = 0;
  targets.forEach(({ mount, ruby }, index) => {
    const text = texts[index];
    if (text === undefined || text === null || text === "") return;
    const output = mount.output;
    if (output === null) return;
    if (ruby !== null) {
      // A furigana goes through the ruby, never straight into an `<rt>`. See
      // `readingOf` for what the stored form actually is.
      const reading = readingOf(text);
      if (reading === "") return;
      ruby.annotate(reading);
    } else {
      output.appendChild(document.createTextNode(text));
    }
    // `ready` rather than removing the attribute: the element keeps saying what
    // it is, which is what makes "575 ai generators, 575 ready" countable.
    mount.element.setAttribute(DATA.state, "ready");
    filled += 1;
  });
  return filled;
}

/** `X(Y)` — Mochi's bracket annotation, both bracket widths. */
const ANNOTATION = /[^（(）)]+[（(]([^）)]*)[）)]/gu;

/**
 * The READING alone, out of what a `furigana` generation actually stores.
 *
 * ─── THE TRAP, FOUND BY RENDERING IT ────────────────────────────────────────
 *
 * A furigana generation does NOT hold a reading. It holds the input text with
 * Mochi's bracket annotation written into it — the value filed under `野菜` is
 * `野菜(やさい)`, and under `あり得る` it is `あり得(え)る`. Appending that into an
 * `<rt>` puts "野菜(やさい)" over 野菜, which is what the first version of this
 * did and what the browser showed.
 *
 * So the annotation is unwrapped back to a plain reading — `野菜(やさい)` → やさい,
 * `あり得(え)る` → ありえる — and `RubyMount.annotate` re-derives the alignment
 * against the run skeleton. Going through `alignFurigana` rather than trusting
 * the brackets is deliberate: it REFUSES a split it cannot make unambiguously
 * and falls back to one annotation over the whole base, where reading the
 * brackets positionally would place a wrong one silently. A coarse annotation is
 * acceptable; a wrong one is not.
 *
 * Text with no annotation at all comes back unchanged, which is right for the
 * all-kana case (`ひとり` generates `ひとり`).
 */
export function readingOf(annotated: string): string {
  ANNOTATION.lastIndex = 0;
  if (!ANNOTATION.test(annotated)) return annotated.trim();
  ANNOTATION.lastIndex = 0;
  return annotated.replace(ANNOTATION, (_whole, reading: string) => reading).trim();
}
