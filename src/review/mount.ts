/**
 * The review screen's card mount — the whole path from a card id to a live,
 * revealable, audible card, in one call.
 *
 *     const mounted = mountCard({ db, cardId, direction, document, store });
 *     container.appendChild(mounted.result.root);
 *     mounted.enter(0);                 // on screen. Silent in `produce` mode;
 *                                       // in `identify` mode the clip IS the
 *                                       // question, and nothing unmasks.
 *     // ... he says the contour aloud, or names the word he just heard ...
 *     mounted.loop.side(0)?.reveal();   // unmasks, and THIS is what compares
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
 *   3. **`resolveGenerated`** — and this one was MISSING here until 2026-08-23,
 *      found by a peer review rather than by me. On 単語 and 言葉, `Audio` and
 *      `Translate` chain off `例文`/`Example`, an `ai` field with ZERO stored
 *      values, so without a resolver `fieldText` returns null and the chain dies
 *      at the first hop — silently, again. Measured over the corpus on
 *      `test/cards.test.ts`'s basis:
 *
 *          without  6,855 speech mounts · 10,722 expanded
 *          with    10,656 speech mounts · 18,324 expanded
 *
 *      **3,801 clips — 35.7% of the corpus audio — never mounted**, and the card
 *      count is identical (5,664) because every missing one is the SECOND clip on
 *      a card that already had one: the `例文` sentence audio, which is exactly
 *      what side 3 of 単語 exists to drill. `test/review.test.ts` now pins the
 *      figure so it cannot regress; nothing did before.
 *
 * ─── THE HARD RULE, AND WHERE IT LIVES ───────────────────────────────────────
 *
 * `shadowingLoop` in `src/render/reveal.ts` owns the mechanism; this module owns
 * the POLICY, and after decision 29 that split is the whole design. The loop's
 * `enter()` does nothing and knows nothing about `Reading`. This file is where a
 * card's mode is decided and where the mode-2 question is asked.
 *
 *   mode 1   `Reading` true, 692 cards    audio on REVEAL   `型` behind a cloze
 *   mode 2   otherwise,    3,177 cards    audio on ENTRY    `型` plain
 *
 * So `MountedCard.enter()` is the method to use, not `loop.enter()`. They differ
 * on exactly one thing: `enter()` asks the mode-2 question, and does it through
 * `side.prompt()`, which plays without unmasking anything.
 *
 * `spike/viewer/` proved Chromium does not autoplay, but it hand-rolled
 * `revealSide()`/`armSide()` instead of the shipping loop, so its green panel was
 * evidence about the browser rather than about this code. Wiring the real loop
 * once, here, is what its README asked for.
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
import { expandGeneratorFields, storeTextResolver } from "../generate/index.js";
import {
  audioController,
  type AudioController,
  type AudioControllerOptions,
} from "../render/audio.js";
import { renderSides, type RenderResult } from "../render/index.js";
import type { RenderDocument, RenderElement } from "../render/dom.js";
import { shadowingLoop, type ShadowingLoop, type ShadowingSide } from "../render/reveal.js";
import { cardMode, promptsOnEntry, type CardMode } from "./mode.js";
import type { BlobStore } from "../blobs/store.js";
import type { FieldGenerationRequest } from "../generate/index.js";
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
   * The TEXT an upstream generator produced, for fields that chain off another
   * generator's output. Defaults to `storeTextResolver(db)`, which is what makes
   * `Audio` and `Translate` reachable at all — see note 3 in this file's header.
   *
   * Pass `null` to switch it off deliberately. That costs 35.7% of the corpus
   * audio, so only a measurement should do it.
   */
  readonly resolveGenerated?: ((request: FieldGenerationRequest) => string | null) | null;
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
  /**
   * Which exercise this card runs, and what a `Reading` toggle would write.
   * Decision 29 — see `./mode.ts`.
   */
  readonly mode: CardMode;
  /**
   * Put a side on screen, and in `identify` mode ask its question.
   *
   * **Use this rather than `loop.enter(position)`.** The loop's own `enter` is
   * mode-blind by design and plays nothing ever, which is correct for the 692
   * `produce` cards and silently wrong for the other 3,177: on those the clip IS
   * the prompt. This is the one place in the repo that knows the difference.
   *
   * At most one question per entry, so a screen that re-renders does not ask
   * twice. `loop.enter` remains available and remains silent.
   */
  enter(position: number): ShadowingSide<E> | null;
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

  // See the header: these are the two steps `loadRenderedCard` cannot do for you.
  // `resolveGenerated` defaults ON because the chained fields are unreachable
  // without it and nothing raises when they are missing.
  const resolveGenerated =
    options.resolveGenerated === undefined ? storeTextResolver(db) : options.resolveGenerated;
  const bound = expandGeneratorFields(rendered.sides, {
    fields: loaded.template?.fields ?? [],
    values: loaded.values,
    ...(resolveGenerated === null ? {} : { resolveGenerated }),
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
  const mode = cardMode(loaded);
  // One question per entry. The policy lives here rather than in `prompt()` so
  // that `src/render/reveal.ts` stays a mechanism with no memory of modes.
  const asked = new Set<number>();

  let disposed = false;
  return {
    cardId,
    loaded,
    result,
    loop,
    audio,
    mode,
    enter(position: number): ShadowingSide<E> | null {
      const side = loop.enter(position);
      if (side === null) return null;
      if (promptsOnEntry(mode.mode, side) && !asked.has(position)) {
        asked.add(position);
        side.prompt();
      }
      return side;
    },
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
