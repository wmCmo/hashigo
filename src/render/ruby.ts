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

export function isKana(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x3041 && code <= 0x3096) ||
    (code >= 0x309d && code <= 0x309f) ||
    (code >= 0x30a1 && code <= 0x30fa) ||
    (code >= 0x30fc && code <= 0x30ff) ||
    (code >= 0xff66 && code <= 0xff9d)
  );
}

export function isKanji(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    code === 0x3005 ||
    code === 0x3006
  );
}

export function toHiragana(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
  }
  return out;
}

export type RunKind =
  | "kanji"
  | "kana"
  | "other";

export interface BaseRun {
  readonly text: string;
  readonly kind: RunKind;
}

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

export interface RubySegment {
  readonly base: string;
  readonly kind: RunKind;
  readonly reading: string | null;
}

export type AlignmentKind =
  | "segmented"
  | "whole"
  | "none";

export interface RubyAlignment {
  readonly kind: AlignmentKind;
  readonly segments: readonly RubySegment[];
  readonly reason: string;
}

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
      if (pending !== null) return whole(`kanji run ${pending.text} bounded by ${run.text}`);
      segments.push({ base: run.text, kind: "other", reading: null });
      continue;
    }
    const needle = toHiragana(run.text);
    let at: number;
    if (pending === null) {
      if (!folded.startsWith(needle, cursor)) return whole(`kana run ${run.text} not at the cursor`);
      at = cursor;
    } else if (index === lastIndex) {
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

export function rubyPlainText(alignment: RubyAlignment): string {
  return alignment.segments
    .map((part) => (part.reading === null ? part.base : `${part.base}(${part.reading})`))
    .join("");
}

export const RUBY_DATA = {
  reading: "data-reading",
  align: "data-ruby-align",
  runs: "data-ruby-runs",
} as const;

export interface RubyRun<E extends RenderElement = RenderElement> {
  readonly run: BaseRun;
  readonly rt: E;
}

export interface RubyMount<E extends RenderElement = RenderElement> {
  readonly element: E;
  readonly base: string;
  readonly runs: readonly RubyRun<E>[];
  readonly generator: GeneratorMount<E>;
  readonly side: number;
  readonly ordinal: number;
  readonly reading: string | null;
  readonly alignment: RubyAlignment | null;
  annotate(reading: string): RubyAlignment;
}

export interface FuriganaOptions {
  readonly reading?: (base: string) => string | null | undefined;
  readonly onRuby?: (mount: RubyMount) => void;
}

export interface FuriganaSupport<E extends RenderElement = RenderElement> {
  readonly renderers: Partial<NodeRenderers<E>>;
  readonly rubies: readonly RubyMount<E>[];
  annotate(readings: ReadonlyMap<string, string>): number;
}

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
  const raw = plainText(node.children as readonly Node[]);
  const base = stripInvisible(raw);
  const element = context.element("ruby", `${CLASS.generator} hashigo-furigana`);
  context.attribute(element, DATA.generator, "furigana");
  context.attribute(element, DATA.state, "pending");
  context.count("element:furigana");

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
      element.setAttribute(DATA.resolved, "");
      if (result.kind === "none") return result;
      if (result.kind === "whole") {
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
