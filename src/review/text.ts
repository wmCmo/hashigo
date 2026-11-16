import { DATA } from "../render/index.js";
import type {
  GeneratorMount,
  RenderDocument,
  RenderElement,
  RenderResult,
} from "../render/index.js";
import type { RubyMount } from "../render/ruby.js";

const FILLABLE = new Set(["ai", "translate", "dictionary", "furigana"]);

const ANSWER_KINDS = new Set(["furigana"]);

export interface FillTarget<E extends RenderElement = RenderElement> {
  readonly mount: GeneratorMount<E>;
  readonly ruby: RubyMount<E> | null;
}

export interface TextSlot {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
}

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
      const reading = readingOf(text);
      if (reading === "") return;
      ruby.annotate(reading);
    } else {
      output.appendChild(document.createTextNode(text));
    }
    mount.element.setAttribute(DATA.state, "ready");
    filled += 1;
  });
  return filled;
}

const ANNOTATION = /[^（(）)]+[（(]([^）)]*)[）)]/gu;

export function readingOf(annotated: string): string {
  ANNOTATION.lastIndex = 0;
  if (!ANNOTATION.test(annotated)) return annotated.trim();
  ANNOTATION.lastIndex = 0;
  return annotated.replace(ANNOTATION, (_whole, reading: string) => reading).trim();
}
