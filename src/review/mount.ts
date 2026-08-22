/**
 * The review screen's card mount — the whole path from a card id to a live,
 * revealable, audible card, in one call.
 *
 *     const mounted = mountCard({ db, cardId, direction, document, store });
 *     container.appendChild(mounted.result.root);
 *     mounted.loop.enter(0);            // side on screen. PLAYS NOTHING.
 *     // ... the human says the contour aloud, then taps ...
 *     mounted.loop.side(0)?.reveal();   // unmasks, and THIS is what plays
 *
 * WHY THIS EXISTS RATHER THAN A CALLER DOING IT. The path is six calls in a
 * specific order, two of which are silently lossy if skipped, and it had never
 * been written down in `src/` — only inside `spike/viewer/`, which is a throwaway
 * harness that implements its own reveal sequencing rather than using the loop
 * that ships.
 *
 * ─── THE SHARP EDGE, WHICH COST REAL TIME TO SEE ─────────────────────────────
 *
 * **`loadRenderedCard` is NOT sufficient for a card with audio, and it is the
 * documented entry point.** `src/cards/README.md`'s own example uses it. But
 * `expandGeneratorFields` needs the template's FIELDS and the card's VALUES, and
 * `loadRenderedCard` returns neither — it returns only the `RenderedCard`. So a
 * caller who follows the example gets a card that renders correctly and is
 * silent, with no error anywhere, on the 5,664 cards that carry speech.
 *
 * So this module calls `loadCard` and keeps the loaded card, then renders. Two
 * things are load-bearing in that order and each is a silent whole-corpus failure
 * if dropped:
 *
 *   1. `pendingGenerators: true` — forced by `renderLoadedCard`, which is why
 *      that function exists. Without it the markers are substituted away and
 *      **99.5%** of the audio disappears (6,855 speech mounts against 31).
 *   2. `expandGeneratorFields` — without it the mounts exist but carry no
 *      `request`, so `cardAudioResolver` has nothing to address and every clip
 *      resolves to null. Also silent.
 *
 * ─── THE HARD RULE, AND WHERE IT LIVES ───────────────────────────────────────
 *
 * Audio fires on the cloze REVEAL, never when a side appears. This module does
 * not implement that — `shadowingLoop` in `src/render/reveal.ts` does, and this
 * is the first thing in `src/` to use it. `spike/viewer/` proved Chromium does
 * not autoplay, but it hand-rolled `revealSide()`/`armSide()` instead of the
 * shipping loop, so its green panel was evidence about the browser rather than
 * about this code. Wiring the real loop once, here, is what its README asked for.
 *
 * `enter()` records that a side is on screen and does nothing else. The only two
 * paths to sound are `reveal()` and a deliberate `play()`/`replay()`.
 *
 * BROWSER-PORTABLE: typed against `RenderDocument`, so `browserDocument(document)`
 * drives a real screen and `memoryDocument()` drives a test. Nothing here reaches
 * a `node:` import.
 */

import {
  cardAudioResolver,
  directionForTrackKind,
  loadCard,
  renderLoadedCard,
  type LoadedCard,
} from "../cards/index.js";
import { expandGeneratorFields } from "../generate/index.js";
import {
  audioController,
  type AudioController,
  type AudioControllerOptions,
} from "../render/audio.js";
import { renderSides, type RenderResult } from "../render/index.js";
import type { RenderDocument, RenderElement } from "../render/dom.js";
import { shadowingLoop, type ShadowingLoop } from "../render/reveal.js";
import type { BlobStore } from "../blobs/store.js";
import type { Direction } from "../template/index.js";
import type { SqliteHandle } from "../db/browser.js";

export interface MountOptions<E extends RenderElement> {
  readonly db: SqliteHandle;
  readonly cardId: string;
  /** `directionForTrackKind(track.kind)`. Defaults to `"forward"`. */
  readonly direction?: Direction;
  readonly document: RenderDocument<E>;
  /** The payload store. Omit it and audio resolves to nothing, silently. */
  readonly store?: BlobStore | null;
  /**
   * Narrow a mount's element to something playable. Defaults to the controller's
   * own duck-type check, which is false for a `MemoryElement` and true for a real
   * `<audio>`. A test passes a recorder here.
   */
  readonly playable?: AudioControllerOptions<E>["playable"];
  readonly onOutcome?: AudioControllerOptions<E>["onOutcome"];
}

export interface MountedCard<E extends RenderElement> {
  readonly cardId: string;
  readonly loaded: LoadedCard;
  readonly result: RenderResult<E>;
  readonly loop: ShadowingLoop<E>;
  readonly audio: AudioController<E>;
  /** Speech/audio mounts the render produced, before any resolution is tried. */
  readonly clipCount: number;
  /** Generator fields expanded. Zero on a card with no generators. */
  readonly expanded: number;
  /**
   * `expandGeneratorFields`'s own "the ONE way this module can go quietly wrong":
   * a key option that cannot ride on the synthetic element, so the renderer's
   * descriptor hashes to a different key than the request beside it and the audio
   * misses with nothing to show for it. **Zero over the whole corpus**, and
   * surfaced here rather than dropped so a screen can assert on it.
   */
  readonly divergent: readonly string[];
  /** Release the audio leases and unbind the loop. Idempotent. */
  dispose(): void;
}

/**
 * Load, render, expand, mount and arm one card.
 *
 * Returns null when there is no such card — the same contract as
 * `loadRenderedCard`, so a caller can treat a missing card as "skip it" rather
 * than as an exception.
 *
 * Nothing plays as a result of this call. `AudioController.stats.requested` is
 * still 0 when it returns, and a test asserts exactly that over the real corpus.
 */
export function mountCard<E extends RenderElement>(
  options: MountOptions<E>,
): MountedCard<E> | null {
  const { db, cardId, document } = options;
  const loaded = loadCard(db, cardId);
  if (loaded === null) return null;

  const direction = options.direction ?? "forward";
  const rendered = renderLoadedCard(loaded, direction);

  // See the header: this is the step `loadRenderedCard` cannot do for you.
  const bound = expandGeneratorFields(rendered.sides, {
    fields: loaded.template?.fields ?? [],
    values: loaded.values,
  });

  const result = renderSides(bound.sides, { document });

  const audio = audioController<E>(result, {
    resolve: cardAudioResolver(db, cardId, {
      ...(options.store === undefined || options.store === null ? {} : { store: options.store }),
    }),
    ...(options.playable === undefined ? {} : { playable: options.playable }),
    ...(options.onOutcome === undefined ? {} : { onOutcome: options.onOutcome }),
  });

  const loop = shadowingLoop<E>(result, { audio });

  let disposed = false;
  return {
    cardId,
    loaded,
    result,
    loop,
    audio,
    clipCount: result.media.filter((m) => m.kind === "audio" || m.kind === "video").length,
    expanded: bound.expanded.length,
    divergent: bound.divergent,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      loop.dispose();
    },
  };
}

/** `mountCard` for a scheduler/session track, which knows its own direction. */
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
