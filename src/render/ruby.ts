/**
 * Stage 4 — `<furigana>` as real `<ruby>`/`<rt>`, and the alignment that puts a
 * reading over the character it belongs to.
 *
 * WHAT THE CORE ALREADY DOES, AND WHY IT IS NOT ENOUGH. `nodes.ts` renders
 * `<furigana>X</furigana>` as `<ruby>X<rt class="hashigo-reading"></rt></ruby>`:
 * one base, one empty annotation for stage 9 to fill. Correct HTML, and the right
 * default — but for a word with a kana tail it produces
 *
 *     <ruby>巡る<rt>めぐる</rt></ruby>       →      めぐる
 *                                                  巡る
 *
 * which puts る over る and めぐ over 巡. Japanese typography — and every
 * dictionary Zach reads — writes 巡(めぐ)る: the annotation belongs to the KANJI
 * RUN alone. `alignFurigana` is that split; `furiganaSupport` is the renderer
 * that emits it.
 *
 * THE SKELETON IS BUILT BEFORE THE READING IS KNOWN, and that is the whole
 * design. 3,502 furigana elements render over the corpus and not one of them has
 * a reading yet — the reading is generated (`furigana 3,255` generations in the
 * export) and arrives later, from stage 9's cache. The DOM port in `dom.ts` has
 * five operations and `removeChild` is not one of them, so a `<ruby>` cannot be
 * restructured after the fact. Therefore:
 *
 *   * the base is split into kana / kanji / other RUNS at render time, which
 *     needs the base only, and one `<rt>` is emitted per run;
 *   * `RubyMount.annotate(reading)` aligns the reading to those runs and appends
 *     text into the `<rt>`s that belong to kanji runs.
 *
 * Identical output whether the reading is known at render time or an hour later,
 * for every reading that aligns. The one case the two differ on is a REFUSAL, and
 * it differs because positional ruby pairing cannot be undone: known up front, a
 * refused reading gets a one-base one-`<rt>` ruby (the core's shape, and correct);
 * arriving late against a multi-run skeleton it is recorded in `data-reading` and
 * NOT placed, because placing it would annotate one run with the whole word.
 *
 * ANNOTATING A HIDDEN CLOZE MUST NOT REVEAL IT. In the 単語 template the ruby is
 * authored inside a cloze — `{{<furigana><< 単語 >></furigana>}}` — because the
 * reading is the thing being recalled. Filling an `<rt>` therefore touches the
 * `<rt>` and NOTHING else: no `data-state` on the cloze, no `hidden` removed.
 * `test/japanese-render.test.ts` pins that, hidden and revealed.
 *
 * A COARSE ANNOTATION IS ACCEPTABLE; A WRONG ONE IS NOT. `alignFurigana` refuses
 * rather than guesses — an interior kana run that occurs twice in the reading is
 * ambiguous, and an ambiguous split is silently WRONG data on a card he trusts.
 * It falls back to one annotation over the whole base, which is exactly what the
 * core renderer would have produced. Every refusal names its reason.
 *
 * `data-resolved` gets its first use here. `DATA.resolved` is declared in
 * `nodes.ts` and was unused; a generator that has been filled needs to stop
 * looking pending without inventing a fourth `MountState`, so the pair to style
 * is `[data-state="pending"]:not([data-resolved])`.
 */

import type { BlobKind } from "../schema/index.js";
import type { ElementNode, Inline, Node } from "../template/index.js";
import { plainText } from "../template/index.js";
import { stripInvisible } from "../text/index.js";
import type { RenderElement } from "./dom.js";
import {
  CLASS,
  DATA,
  defaultRenderers,
  type GeneratorMount,
  type NodeRenderers,
  type RenderContext,
} from "./nodes.js";

// ─── kana ────────────────────────────────────────────────────────────────────

/** Hiragana, katakana, the prolonged-sound mark, the iteration marks, halfwidth. */
export function isKana(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x3041 && code <= 0x3096) || // hiragana
    (code >= 0x309d && code <= 0x309f) || // ゝ ゞ ゟ
    (code >= 0x30a1 && code <= 0x30fa) || // katakana
    (code >= 0x30fc && code <= 0x30ff) || // ー ヽ ヾ ヿ
    (code >= 0xff66 && code <= 0xff9d) // halfwidth katakana, ｰ included
  );
}

/** CJK ideographs, plus 々 and 〆, which behave as kanji inside a word. */
export function isKanji(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0x3400 && code <= 0x4dbf) || // extension A
    (code >= 0xf900 && code <= 0xfaff) || // compatibility ideographs
    code === 0x3005 || // 々
    code === 0x3006 // 〆
  );
}

/**
 * Katakana to hiragana, code point for code point.
 *
 * LENGTH-PRESERVING BY CONSTRUCTION, which the aligner depends on: it searches
 * the folded reading and then slices the ORIGINAL, so the two must index alike.
 * 漢字's `Reading` is katakana (ミツ, on 1,660 cards) while the kana inside a
 * 単語 word is hiragana, so without folding, 見る against ミル would not align.
 */
export function toHiragana(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // ヷヸヹヺ (0x30F7-0x30FA) have no hiragana form; ー must stay put.
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
  }
  return out;
}

// ─── runs ────────────────────────────────────────────────────────────────────

export type RunKind =
  /** Needs an annotation. */
  | "kanji"
  /** Reads itself: it must be FOUND in the reading, and is never annotated. */
  | "kana"
  /** ～, latin, punctuation. Annotated never, matched never, skipped. */
  | "other";

export interface BaseRun {
  readonly text: string;
  readonly kind: RunKind;
}

/** Split a base into maximal runs of one kind. `～に引き換え` gives six. */
export function baseRuns(base: string): BaseRun[] {
  const runs: BaseRun[] = [];
  for (const ch of base) {
    const kind: RunKind = isKanji(ch) ? "kanji" : isKana(ch) ? "kana" : "other";
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) {
      runs[runs.length - 1] = { text: last.text + ch, kind };
    } else {
      runs.push({ text: ch, kind });
    }
  }
  return runs;
}

// ─── alignment ───────────────────────────────────────────────────────────────

export interface RubySegment {
  readonly base: string;
  readonly kind: RunKind;
  /** The reading for this run, or null when the run reads itself. */
  readonly reading: string | null;
}

export type AlignmentKind =
  /** One reading per kanji run, every kana run matched. */
  | "segmented"
  /** One reading over the whole base: coarse, and never wrong. */
  | "whole"
  /** The base already IS its reading (all kana). Nothing to annotate. */
  | "none";

export interface RubyAlignment {
  readonly kind: AlignmentKind;
  readonly segments: readonly RubySegment[];
  /** Why it is not `segmented`. Empty when it is. */
  readonly reason: string;
}

/**
 * Split `reading` across the kanji runs of `base`.
 *
 * The rules, in the order they bite:
 *
 *   1. an all-kana base whose folded form equals the folded reading -> `none`;
 *      annotating すずらん with すずらん is noise on the card.
 *   2. a kana run must be FOUND in the reading. The first anchors at the start,
 *      a trailing one at the end, an interior one at its first occurrence after
 *      the cursor — and if it occurs again later, that is ambiguous, and refused.
 *   3. every kanji run must get at least one character, and the reading must be
 *      consumed exactly.
 *   4. anything else -> `whole`, with a reason.
 *
 * Comparison is on the katakana-folded forms; the segments carry slices of the
 * reading exactly as authored.
 */
export function alignFurigana(base: string, reading: string): RubyAlignment {
  const runs = baseRuns(base);
  const folded = toHiragana(reading);
  const whole = (reason: string): RubyAlignment => ({
    kind: "whole",
    segments: [{ base, kind: "kanji", reading }],
    reason,
  });

  if (base === "" || reading === "") return whole("empty base or reading");
  if (!runs.some((run) => run.kind === "kanji")) {
    return toHiragana(base) === folded
      ? { kind: "none", segments: [], reason: "base already reads itself" }
      : whole("no kanji run to annotate");
  }

  const segments: RubySegment[] = [];
  let cursor = 0;
  let pending: BaseRun | null = null;
  const lastIndex = runs.length - 1;

  for (const [index, run] of runs.entries()) {
    if (run.kind === "kanji") {
      if (pending !== null) return whole("two kanji runs with nothing between them");
      pending = run;
      continue;
    }
    if (run.kind === "other") {
      // 〜 and latin carry no sound the reading records, so they consume nothing.
      // Owed kanji plus a non-kana boundary has no unambiguous split; refuse.
      if (pending !== null) return whole(`kanji run ${pending.text} bounded by ${run.text}`);
      segments.push({ base: run.text, kind: "other", reading: null });
      continue;
    }
    const needle = toHiragana(run.text);
    let at: number;
    if (pending === null) {
      // Nothing owed: this kana must sit exactly at the cursor.
      if (!folded.startsWith(needle, cursor)) return whole(`kana run ${run.text} not at the cursor`);
      at = cursor;
    } else if (index === lastIndex) {
      // Trailing kana: anchor to the END, which is unambiguous by construction.
      at = folded.length - needle.length;
      if (!folded.endsWith(needle) || at < cursor + 1) {
        return whole(`trailing kana run ${run.text} does not end the reading`);
      }
    } else {
      at = folded.indexOf(needle, cursor + 1);
      if (at < 0) return whole(`kana run ${run.text} not found in the reading`);
      if (folded.indexOf(needle, at + 1) >= 0) {
        return whole(`kana run ${run.text} occurs more than once: ambiguous`);
      }
    }
    if (pending !== null) {
      const take = reading.slice(cursor, at);
      if (take === "") return whole(`no reading left for ${pending.text}`);
      segments.push({ base: pending.text, kind: "kanji", reading: take });
      pending = null;
    }
    segments.push({ base: run.text, kind: "kana", reading: null });
    cursor = at + needle.length;
  }

  if (pending !== null) {
    const take = reading.slice(cursor);
    if (take === "") return whole(`no reading left for ${pending.text}`);
    segments.push({ base: pending.text, kind: "kanji", reading: take });
    cursor = reading.length;
  }
  if (cursor !== reading.length) return whole("reading longer than the base accounts for");
  return { kind: "segmented", segments, reason: "" };
}

/** `巡(めぐ)る`. The projection a plain-text export or a log line wants. */
export function rubyPlainText(alignment: RubyAlignment): string {
  return alignment.segments
    .map((part) => (part.reading === null ? part.base : `${part.base}(${part.reading})`))
    .join("");
}

// ─── the renderer ────────────────────────────────────────────────────────────

/** Attributes this module owns. `DATA.resolved` is shared, and used here first. */
export const RUBY_DATA = {
  /** The full reading, as handed to `annotate`. */
  reading: "data-reading",
  /** `segmented` | `whole` | `none` — how it was aligned. */
  align: "data-ruby-align",
  /** How many base runs, so CSS and a test can see the skeleton without walking. */
  runs: "data-ruby-runs",
} as const;

export interface RubyRun<E extends RenderElement = RenderElement> {
  readonly run: BaseRun;
  /** The `<rt>` for this run. Present for every run; empty unless annotated. */
  readonly rt: E;
}

export interface RubyMount<E extends RenderElement = RenderElement> {
  /** The `<ruby>`. */
  readonly element: E;
  /** The base text, invisible marks stripped — exactly what was annotated. */
  readonly base: string;
  readonly runs: readonly RubyRun<E>[];
  /** The core's generator mount, so stage 9 sees this ruby like any generation. */
  readonly generator: GeneratorMount<E>;
  readonly side: number;
  readonly ordinal: number;
  readonly reading: string | null;
  readonly alignment: RubyAlignment | null;
  /**
   * Align `reading` to the runs and fill the `<rt>`s. Idempotent: a second call
   * returns the first alignment and changes nothing, because text already
   * appended cannot be taken back through a five-operation port.
   */
  annotate(reading: string): RubyAlignment;
}

export interface FuriganaOptions {
  /**
   * The reading for a base, when it is already known — stage 9's cache goes
   * here. Returning null, undefined or "" leaves the skeleton pending, which is
   * what the whole corpus does today.
   */
  readonly reading?: (base: string) => string | null | undefined;
  /** Called once per ruby, after any render-time annotation. */
  readonly onRuby?: (mount: RubyMount) => void;
}

export interface FuriganaSupport<E extends RenderElement = RenderElement> {
  /** Merge into `RenderSettings.renderers`. Overrides `element` only. */
  readonly renderers: Partial<NodeRenderers<E>>;
  /** Every ruby this support rendered, in document order. */
  readonly rubies: readonly RubyMount<E>[];
  /** Annotate every ruby whose base the map names. Returns how many were filled. */
  annotate(readings: ReadonlyMap<string, string>): number;
}

/**
 * A `furigana`-aware `element` renderer, plus the mounts it produces.
 *
 * One support object per render — it collects mounts. Anything that is not a
 * `<furigana>` over plain text is delegated to the core's `element` renderer
 * untouched, so `<speech>`, `<ai>`, `<draw>`, `<span style>` and the
 * inert-unknown path keep behaving exactly as `nodes.ts` says they do.
 */
export function furiganaSupport<E extends RenderElement>(
  options: FuriganaOptions = {},
): FuriganaSupport<E> {
  const fallback = defaultRenderers<E>().element;
  const rubies: RubyMount<E>[] = [];

  const renderers: Partial<NodeRenderers<E>> = {
    element(node, parent, context) {
      if (node.name !== "furigana" || node.selfClosing || !isPlainText(node.children)) {
        fallback(node, parent, context);
        return;
      }
      renderFurigana(node, parent, context, rubies, options);
    },
  };

  return {
    renderers,
    rubies,
    annotate(readings): number {
      let filled = 0;
      for (const ruby of rubies) {
        const reading = readings.get(ruby.base);
        if (reading === undefined || reading === "") continue;
        ruby.annotate(reading);
        filled += 1;
      }
      return filled;
    },
  };
}

/**
 * True when every child is a `text` node — the only shape runs can be cut from.
 *
 * A `<furigana>` wrapping a wiki-link or a cloze cannot be split into runs
 * without flattening the markup inside it, so it goes to the core renderer and
 * gets the single whole-base `<rt>`. Measured over the corpus: of 3,502 furigana
 * elements, 3,492 are plain text and 10 are EMPTY — `<furigana></furigana>`,
 * because the field they annotate is blank on those cards — and an empty base has
 * no runs to make a skeleton from, so the core's one-empty-`<rt>` output is the
 * right answer for it. No link-bearing furigana exists yet; the guard is there so
 * that the day one is authored, it renders rather than loses its link.
 */
function isPlainText(children: readonly Inline[]): boolean {
  return children.length > 0 && children.every((child) => child.kind === "text");
}

function renderFurigana<E extends RenderElement>(
  node: ElementNode,
  parent: E,
  context: RenderContext<E>,
  rubies: RubyMount<E>[],
  options: FuriganaOptions,
): void {
  // RAW for the generation request (`generationIdentity` normalises, and must be
  // handed the same string the core would have handed it), stripped for display.
  const raw = plainText(node.children as readonly Node[]);
  const base = stripInvisible(raw);
  const element = context.element("ruby", `${CLASS.generator} hashigo-furigana`);
  context.attribute(element, DATA.generator, "furigana");
  context.attribute(element, DATA.state, "pending");
  // The core counts every element it renders as `element:<name>`; this renderer
  // stands in for it, so it has to keep the census whole. Without this line the
  // corpus census loses all 3,502 furigana and nothing says where they went.
  context.count("element:furigana");

  // WHICH SKELETON. `<ruby>` pairs positionally, so a base split into runs can
  // never be re-joined into one annotation later — the port has no removeChild.
  // When the reading is already known, the alignment therefore chooses the shape:
  // a refusal (or an all-kana base) gets ONE base and ONE `<rt>`, which is the
  // core's shape and is right for a whole-base reading; only a real segmentation
  // gets the run skeleton. When the reading is NOT known — all 3,502 of them
  // today — the run skeleton is the only one that can still be segmented, and a
  // late refusal is reported rather than mis-placed. See `annotate`.
  const upfront = options.reading?.(base);
  const known = upfront === null || upfront === undefined || upfront === "" ? null : upfront;
  const upfrontAlignment = known === null ? null : alignFurigana(base, known);
  const runs =
    upfrontAlignment !== null && upfrontAlignment.kind !== "segmented"
      ? [{ text: base, kind: "kanji" as const }]
      : baseRuns(base);
  const mountedRuns: RubyRun<E>[] = [];
  for (const run of runs) {
    context.appendText(element, run.text);
    // Every base run gets its own <rt>, the empty ones included: ruby pairing is
    // positional, so a base run with no <rt> after it swallows the NEXT run's
    // annotation. An empty <rt> is how 巡(めぐ)る stays 巡(めぐ)る.
    const rt = context.element("rt", CLASS.reading);
    element.appendChild(rt);
    mountedRuns.push({ run, rt });
  }
  context.attribute(element, RUBY_DATA.runs, String(runs.length));
  parent.appendChild(element);

  const generator = context.mountGenerator({
    element,
    name: "furigana",
    request: { kind: "furigana" satisfies BlobKind, text: raw, lang: null, voice: null, options: {} },
    // Where a caller that knows nothing about this module would append. The
    // correct path is `annotate`, which aligns first.
    output: mountedRuns[0]?.rt ?? null,
    media: null,
  });

  const document = context.settings.document;
  let alignment: RubyAlignment | null = null;
  let reading: string | null = null;
  let annotated = false;

  const mount: RubyMount<E> = {
    element,
    base,
    runs: mountedRuns,
    generator,
    side: context.side,
    ordinal: rubies.length,
    get reading(): string | null {
      return reading;
    },
    get alignment(): RubyAlignment | null {
      return alignment;
    },
    annotate(next): RubyAlignment {
      if (annotated || next === "") {
        return alignment ?? { kind: "whole", segments: [], reason: "nothing to annotate" };
      }
      const result = alignFurigana(base, next);
      alignment = result;
      reading = next;
      annotated = true;
      element.setAttribute(RUBY_DATA.reading, next);
      element.setAttribute(RUBY_DATA.align, result.kind);
      // ONLY the <rt>s are written to. A ruby inside a hidden cloze stays hidden:
      // no data-state above this element, no `hidden` removed, nothing else.
      element.setAttribute(DATA.resolved, "");
      if (result.kind === "none") return result; // nothing to say; base reads itself
      if (result.kind === "whole") {
        // A whole-base reading fits a one-run skeleton exactly. It does NOT fit a
        // multi-run one — dropping it into the first `<rt>` would print ひきかえ
        // over ～ and read as the reading of that run alone — so it is NOT
        // written. `data-reading` and the returned alignment carry it instead,
        // and a caller that wants it on screen re-renders this card with
        // `FuriganaOptions.reading` supplying it, which takes the one-run shape.
        if (mountedRuns.length === 1) {
          mountedRuns[0]?.rt.appendChild(document.createTextNode(next));
        }
        return result;
      }
      result.segments.forEach((segment, index) => {
        if (segment.reading === null) return;
        mountedRuns[index]?.rt.appendChild(document.createTextNode(segment.reading));
      });
      return result;
    },
  };
  rubies.push(mount);

  if (known !== null) mount.annotate(known);
  options.onRuby?.(mount as RubyMount);
}
