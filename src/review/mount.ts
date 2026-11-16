import {
  cardAudioResolver,
  directionForTrackKind,
  knownTagsFor,
  linkNamesFor,
  cardContext,
  loadCard,
  renderLoadedCard,
  type LinkNames,
  type LoadedCard,
} from "../cards/index.js";
import { expandGeneratorFields, storeTextResolver } from "../generate/index.js";
import {
  audioController,
  type AudioController,
  type AudioControllerOptions,
  type AudioResolver,
} from "../render/audio.js";
import { renderSides, type RenderResult } from "../render/index.js";
import { furiganaSupport } from "../render/ruby.js";
import { accentMarkSupport } from "../render/accent-marks.js";
import { mathRenderers } from "../render/math.js";
import { MARKS_FIELD } from "../accent/sentence.js";
import { fieldWithRole } from "../fields/index.js";
import { fillTextSlots, textSlots, type TextSlot } from "./text.js";
import type { RenderDocument, RenderElement } from "../render/dom.js";
import { shadowingLoop, type ShadowingLoop, type ShadowingSide } from "../render/reveal.js";
import { cardMode, promptsOnEntry, type CardMode } from "./mode.js";
import type { BlobStore } from "../blobs/store.js";
import type { FieldGenerationRequest } from "../generate/index.js";
import type { Direction, Side } from "../template/index.js";
import type { SqliteHandle } from "../db/browser.js";

export interface MountOptions<E extends RenderElement> {
  readonly db: SqliteHandle;
  readonly cardId: string;
  readonly direction?: Direction;
  readonly document: RenderDocument<E>;
  readonly store?: BlobStore | null;
  readonly resolveGenerated?: ((request: FieldGenerationRequest) => string | null) | null;
  readonly playable?: AudioControllerOptions<E>["playable"];
  readonly onOutcome?: AudioControllerOptions<E>["onOutcome"];
  readonly playback?: AudioControllerOptions<E>["playback"];
}

export interface PrepareOptions {
  readonly db: SqliteHandle;
  readonly cardId: string;
  readonly direction?: Direction;
  readonly resolveGenerated?: ((request: FieldGenerationRequest) => string | null) | null;
}

export interface PreparedCard {
  readonly cardId: string;
  readonly direction: Direction;
  readonly loaded: LoadedCard;
  readonly sides: readonly Side[];
  readonly mode: CardMode;
  readonly expanded: number;
  readonly divergent: readonly string[];
  readonly linkNames: LinkNames;
  readonly knownTags: readonly string[];
}

export interface MountPreparedOptions<E extends RenderElement> {
  readonly document: RenderDocument<E>;
  readonly resolve: AudioResolver;
  readonly playable?: AudioControllerOptions<E>["playable"];
  readonly onOutcome?: AudioControllerOptions<E>["onOutcome"];
  readonly playback?: AudioControllerOptions<E>["playback"];
}

export interface MountedCard<E extends RenderElement> {
  readonly cardId: string;
  readonly loaded: LoadedCard;
  readonly result: RenderResult<E>;
  readonly loop: ShadowingLoop<E>;
  readonly audio: AudioController<E>;
  readonly mode: CardMode;
  enter(position: number): ShadowingSide<E> | null;
  readonly textSlots: readonly TextSlot[];
  fillText(texts: readonly (string | null)[]): number;
  readonly clipCount: number;
  readonly expanded: number;
  readonly divergent: readonly string[];
  dispose(): void;
}

export function prepareCard(options: PrepareOptions): PreparedCard | null {
  const { db, cardId } = options;
  const loaded = loadCard(db, cardId);
  if (loaded === null) return null;

  const direction = options.direction ?? "forward";
  const rendered = renderLoadedCard(loaded, direction);

  const resolveGenerated =
    options.resolveGenerated === undefined ? storeTextResolver(db) : options.resolveGenerated;
  const voiceOverride = cardContext(db, cardId)?.voice ?? null;
  const bound = expandGeneratorFields(rendered.sides, {
    fields: loaded.template?.fields ?? [],
    values: loaded.values,
    ...(resolveGenerated === null ? {} : { resolveGenerated }),
    voiceOverride,
  });

  return {
    cardId,
    direction,
    loaded,
    sides: bound.sides,
    mode: cardMode(loaded),
    expanded: bound.expanded.length,
    divergent: bound.divergent,
    linkNames: linkNamesFor(db, bound.sides),
    knownTags: knownTagsFor(db, bound.sides),
  };
}

export function mountPrepared<E extends RenderElement>(
  prepared: PreparedCard,
  options: MountPreparedOptions<E>,
): MountedCard<E> {
  const furigana = furiganaSupport<E>();
  const furiganaElement = furigana.renderers.element;
  const marks = accentMarkSupport<E>(
    furiganaElement === undefined ? {} : { fallback: furiganaElement },
  );
  const result = renderSides(prepared.sides, {
    document: options.document,
    renderers: { ...marks.renderers, ...mathRenderers<E>() },
    resolveCardLink: (id) => {
      const name = prepared.linkNames[id];
      return name === undefined ? {} : { name };
    },
    resolveTag: (path: string) => (prepared.knownTags.includes(path) ? {} : null),
  });
  const marksField = fieldWithRole(prepared.loaded.template?.fields ?? [], "ojad");
  const annotation =
    prepared.loaded.values.get(marksField?.id ?? MARKS_FIELD.id) ??
    prepared.loaded.values.get(MARKS_FIELD.id) ??
    "";
  if (annotation !== "") marks.annotateAll(annotation);

  const text = textSlots(result, furigana.rubies);

  const audio = audioController<E>(result, {
    resolve: options.resolve,
    ...(options.playable === undefined ? {} : { playable: options.playable }),
    ...(options.onOutcome === undefined ? {} : { onOutcome: options.onOutcome }),
    ...(options.playback === undefined ? {} : { playback: options.playback }),
  });

  const loop = shadowingLoop<E>(result, { audio });
  const mode = prepared.mode;
  const widgetsBySide = new Map<number, number>();
  for (const widget of result.widgets) {
    widgetsBySide.set(widget.side, (widgetsBySide.get(widget.side) ?? 0) + 1);
  }
  const asked = new Set<number>();

  let disposed = false;
  return {
    cardId: prepared.cardId,
    loaded: prepared.loaded,
    result,
    loop,
    audio,
    mode,
    enter(position: number): ShadowingSide<E> | null {
      const side = loop.enter(position);
      if (side === null) return null;
      if (
        promptsOnEntry(mode.mode, side, widgetsBySide.get(side.index) ?? 0) &&
        !asked.has(position)
      ) {
        asked.add(position);
        side.prompt();
      }
      return side;
    },
    textSlots: text.slots,
    fillText(texts) {
      return fillTextSlots(text.mounts, texts, options.document);
    },
    clipCount: result.media.filter((m) => m.kind === "audio" || m.kind === "video").length,
    expanded: prepared.expanded,
    divergent: prepared.divergent,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      loop.dispose();
    },
  };
}

export function mountCard<E extends RenderElement>(
  options: MountOptions<E>,
): MountedCard<E> | null {
  const { db, cardId } = options;
  const prepared = prepareCard({
    db,
    cardId,
    ...(options.direction === undefined ? {} : { direction: options.direction }),
    ...(options.resolveGenerated === undefined
      ? {}
      : { resolveGenerated: options.resolveGenerated }),
  });
  if (prepared === null) return null;
  return mountPrepared<E>(prepared, {
    document: options.document,
    resolve: cardAudioResolver(db, cardId, {
      ...(options.store === undefined || options.store === null ? {} : { store: options.store }),
    }),
    ...(options.playable === undefined ? {} : { playable: options.playable }),
    ...(options.onOutcome === undefined ? {} : { onOutcome: options.onOutcome }),
    ...(options.playback === undefined ? {} : { playback: options.playback }),
  });
}

export function mountTrack<E extends RenderElement>(
  options: Omit<MountOptions<E>, "cardId" | "direction"> & {
    readonly track: { readonly cardId: string; readonly kind: string };
  },
): MountedCard<E> | null {
  const { track, ...rest } = options;
  return mountCard<E>({
    ...rest,
    cardId: track.cardId,
    direction: directionForTrackKind(track.kind),
  });
}
