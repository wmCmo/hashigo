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
  /**
   * His shadowing controls (2026-09-12) — rate and loop, asked for at each play.
   *
   * Passed straight through to the controller. This module is the POLICY half of
   * the split described in `src/render/reveal.ts`, and it has no policy here: how
   * fast he wants to hear a clip is a preference that belongs to the screen, and
   * the screen is `app/`.
   */
  readonly playback?: AudioControllerOptions<E>["playback"];
}

/** `MountOptions` minus everything that needs a DOM. The worker's half. */
export interface PrepareOptions {
  readonly db: SqliteHandle;
  readonly cardId: string;
  readonly direction?: Direction;
  readonly resolveGenerated?: ((request: FieldGenerationRequest) => string | null) | null;
}

/**
 * One card, ready to render, with no live object in it.
 *
 * **Structured-cloneable on purpose** — this is what crosses `postMessage` in the
 * app shell. Keep it that way: a function, a class instance, a `Date` with
 * behaviour attached, or anything holding a DOM node makes the phone throw
 * `DataCloneError` where the Node suite would never notice.
 */
export interface PreparedCard {
  readonly cardId: string;
  readonly direction: Direction;
  readonly loaded: LoadedCard;
  /** The resolved, generator-expanded sides. Plain AST. */
  readonly sides: readonly Side[];
  readonly mode: CardMode;
  readonly expanded: number;
  readonly divergent: readonly string[];
  /**
   * Card id → name, for the wiki-links on these sides.
   *
   * Collected HERE, in the half that holds the database, because the renderer's
   * `resolveCardLink` is synchronous and the page has no database to ask. A bare
   * `[[id]]` printed its raw id on 33 cards until 2026-09-15 for exactly that
   * reason — the fallback was the only branch anything could reach. See
   * `src/cards/link-names.ts`.
   */
  readonly linkNames: LinkNames;
  /**
   * The `#tag` paths on these sides that are REAL tags.
   *
   * Collected here for `linkNames`' reason, stated one comment up: the
   * renderer's resolver is synchronous and the page has no database. It travels
   * with the card so that a card mounted before anything else has loaded still
   * gets its tags — see `knownTagsFor`, which records the boot race that taught
   * this.
   */
  readonly knownTags: readonly string[];
}

/** `MountOptions` minus the database. The page's half. */
export interface MountPreparedOptions<E extends RenderElement> {
  readonly document: RenderDocument<E>;
  /**
   * Where bytes come from. In-process this is `cardAudioResolver(db, cardId)`;
   * in the shell it posts to the worker and returns a promise, which
   * `AudioResolver` has always allowed.
   */
  readonly resolve: AudioResolver;
  readonly playable?: AudioControllerOptions<E>["playable"];
  readonly onOutcome?: AudioControllerOptions<E>["onOutcome"];
  /**
   * His shadowing controls (2026-09-12) — rate and loop, asked for at each play.
   *
   * Passed straight through to the controller. This module is the POLICY half of
   * the split described in `src/render/reveal.ts`, and it has no policy here: how
   * fast he wants to hear a clip is a preference that belongs to the screen, and
   * the screen is `app/`.
   */
  readonly playback?: AudioControllerOptions<E>["playback"];
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
  /**
   * The `ai` / `translate` / `dictionary` slots this card rendered EMPTY.
   *
   * The renderer leaves them empty by contract — their children are the prompt,
   * not the output — and until 2026-09-12 nothing ever filled them, so every
   * example sentence in the corpus was invisible. The page hands these to the
   * worker, which owns the store, and passes the answers to `fillText`.
   */
  readonly textSlots: readonly TextSlot[];
  /**
   * Write resolved text into those slots, in the order `textSlots` lists them.
   * Returns how many were filled; a null or empty answer leaves the slot
   * `pending`, which is a different fact from "generated nothing".
   */
  fillText(texts: readonly (string | null)[]): number;
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
/**
 * Everything the DATABASE has to say about a card, and nothing that needs a DOM.
 *
 * ─── WHY THIS IS A SEPARATE STEP: THE SHELL HAS A PROCESS BOUNDARY ───────────
 *
 * OPFS sync access handles are worker-only (`opfs-sahpool` refuses to install
 * outside a dedicated worker — measured, `spike/README.md`), and Hashigo sets no
 * COOP/COEP headers on purpose, so there is no SharedArrayBuffer and no way to
 * make a synchronous `SqliteHandle` reachable from the page. **The database is in
 * a worker; the DOM is not.** So the six-call path has to be cut somewhere, and
 * the only question is whether it gets cut ONCE, here, or re-derived by every
 * caller that has a worker.
 *
 * This is the cut. `PreparedCard` is deliberately **structured-cloneable** —
 * strings, plain AST nodes, arrays and a `Map` — so a worker can post it whole.
 * `test/review.test.ts` asserts that with a real `structuredClone`, because "it
 * looks like data" is how a function sneaks into a payload and turns into a
 * DataCloneError on the phone and not in the suite.
 */
export function prepareCard(options: PrepareOptions): PreparedCard | null {
  const { db, cardId } = options;
  const loaded = loadCard(db, cardId);
  if (loaded === null) return null;

  const direction = options.direction ?? "forward";
  const rendered = renderLoadedCard(loaded, direction);

  // See the header: these are the two steps `loadRenderedCard` cannot do for you.
  // `resolveGenerated` defaults ON because the chained fields are unreachable
  // without it and nothing raises when they are missing.
  const resolveGenerated =
    options.resolveGenerated === undefined ? storeTextResolver(db) : options.resolveGenerated;
  // Stage E: a card or deck voice override, inherited through the views. Read
  // here rather than joined into `loadCard` — `src/cards/load.ts` measured the
  // join at 23 ms a card and this query alone at 0.01 ms.
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
    // AFTER `expandGeneratorFields`, not before: a generator's output is rendered
    // text and can carry links of its own, so collecting from `rendered.sides`
    // would miss them.
    linkNames: linkNamesFor(db, bound.sides),
    knownTags: knownTagsFor(db, bound.sides),
  };
}

/**
 * The other half: DOM, audio and the loop, from a `PreparedCard`.
 *
 * Takes a `resolve` rather than a database, because on the shell's page side
 * there is no database — the resolver posts a message to the worker and returns a
 * promise. `AudioResolver` has always accepted a `PromiseLike`, which is the one
 * thing that makes this split free.
 *
 * **The hard rule survives the boundary intact**, and it is worth saying why:
 * nothing here resolves anything. `audioController` asks the resolver only from
 * `play()`, `reveal()` and `prompt()` reach `play()`, and `enter()` reaches
 * nothing. So a worker that only answers payload requests is itself evidence —
 * the message log shows no payload message while a side is merely on screen.
 */
export function mountPrepared<E extends RenderElement>(
  prepared: PreparedCard,
  options: MountPreparedOptions<E>,
): MountedCard<E> {
  /**
   * FURIGANA RENDERS THROUGH `src/render/ruby.ts` HERE, AND UNTIL 2026-09-12 IT
   * DID NOT — which made that module dead code on the only path that ships.
   *
   * The core renderer emits one base and ONE `<rt>`, which puts the whole reading
   * over the whole word: `めぐる` spread across `巡る`, `る` sitting over `る`.
   * `furiganaSupport` splits the base into kanji/kana RUNS at render time and
   * emits an `<rt>` per run, so a late-arriving reading can be aligned to the
   * kanji alone — 巡(めぐ)る, the way every dictionary Zach reads writes it.
   *
   * **It is not an edge case: 1,034 of the 3,242 furigana generations (31.9%)
   * have a base mixing kanji and kana**, so a third of every reading would have
   * been visibly wrong the moment they started being filled at all.
   *
   * The skeleton has to be built BEFORE the reading is known — the DOM port has
   * five operations and `removeChild` is not one of them, so a `<ruby>` cannot be
   * restructured afterwards. That is why this is a render-time decision and not
   * something the fill step could have done on its own.
   */
  const furigana = furiganaSupport<E>();
  // `<ojad>` — stage 12's per-mora accent marks over the example sentence. It
  // CHAINS onto furigana rather than replacing it: both override `element`, and
  // a 単語 card has one of each on it. See `src/render/accent-marks.ts`.
  const furiganaElement = furigana.renderers.element;
  const marks = accentMarkSupport<E>(
    furiganaElement === undefined ? {} : { fallback: furiganaElement },
  );
  /**
   * `$…$` TYPESETS HERE, AND UNTIL 2026-09-23 IT DID NOT — the same fault as
   * furigana above, in a different module, found the same way: Zach opened a card
   * and read the source.
   *
   * `src/render/math.ts` is 382 lines with its own header arguing the subset
   * decision, and `mathRenderers` was imported by **`test/japanese-render.test.ts`
   * and nothing else**. Every one of its tests passed against a renderer the app
   * never installed, so the suite was green and the card showed `変動費率＝変動費
   * $\div$売上`.
   *
   * It composes with no care needed: furigana and the accent marks both override
   * `element`, and this overrides `math` alone. Spread order is therefore
   * irrelevant, and it is spread SECOND only to read as "the marks chain, plus
   * this".
   *
   * **Installing it cannot take a formula away.** The core's default for a `math`
   * node is verbatim source, which is byte for byte what this renderer falls back
   * to on a fragment outside the subset — so the worst case is today's output.
   * Measured over the real corpus 2026-09-23: **8 distinct fragments on 14 cards,
   * all 8 typeset, 0 refused** (`\div` 100 uses, `\times` 31, `\frac` 1).
   */
  const result = renderSides(prepared.sides, {
    document: options.document,
    renderers: { ...marks.renderers, ...mathRenderers<E>() },
    // A bare `[[id]]` prints the TARGET CARD'S NAME, which is what Mochi does and
    // what `wikiLink` has always been able to do — it had never been given a
    // resolver, so the "never render an empty anchor" fallback was the only branch
    // reachable and 33 cards showed a raw id. `{}` and not `null` for an unknown
    // id: null means "no such card" and prints `[[display|id]]` verbatim, which
    // would be a regression on the 18 links whose target really is gone.
    resolveCardLink: (id) => {
      const name = prepared.linkNames[id];
      return name === undefined ? {} : { name };
    },
    // A tag the workspace does not have renders as its own text. The asymmetry
    // with `resolveCardLink` above is deliberate: an unknown card id is usually a
    // deleted card and still worth a link, whereas an unknown `#` is usually not
    // a tag at all — a URL fragment, a stray hash — and must not become a chip.
    // Straight off the prepared card. No option, no page-held set, no request
    // that could arrive after the mount: the worker already answered "which of
    // this card's tags exist" while it had the database open.
    resolveTag: (path: string) => (prepared.knownTags.includes(path) ? {} : null),
  });
  // Filled straight away, unlike furigana: the annotation is a stored field on
  // the card that is already in hand, not a generation that has to be looked up.
  //
  // BY ROLE since stage F, with the fixed id kept as a FALLBACK — and the
  // fallback is load-bearing, not caution. `app/local-fields.ts` seeds a device
  // insert-only, so a phone whose seed predates the role carries the old row
  // (id `ojad`, no role) until its next seed rebuild. He has reported "ojad isn't
  // here" twice; dropping the fallback in the same release is how that becomes a
  // third time.
  const marksField = fieldWithRole(prepared.loaded.template?.fields ?? [], "ojad");
  const annotation =
    prepared.loaded.values.get(marksField?.id ?? MARKS_FIELD.id) ??
    prepared.loaded.values.get(MARKS_FIELD.id) ??
    "";
  if (annotation !== "") marks.annotateAll(annotation);

  // The empty text generators, collected but NOT filled — the page has no
  // database. See ./text.ts for why this is a second step and what it fixes.
  const text = textSlots(result, furigana.rubies);

  const audio = audioController<E>(result, {
    resolve: options.resolve,
    ...(options.playable === undefined ? {} : { playable: options.playable }),
    ...(options.onOutcome === undefined ? {} : { onOutcome: options.onOutcome }),
    ...(options.playback === undefined ? {} : { playback: options.playback }),
  });

  const loop = shadowingLoop<E>(result, { audio });
  const mode = prepared.mode;
  // Widgets per AUTHORED side index, for `promptsOnEntry`'s second arm — a side
  // that says "produce your answer here" makes whatever is sounding the question.
  const widgetsBySide = new Map<number, number>();
  for (const widget of result.widgets) {
    widgetsBySide.set(widget.side, (widgetsBySide.get(widget.side) ?? 0) + 1);
  }
  // One question per entry. The policy lives here rather than in `prompt()` so
  // that `src/render/reveal.ts` stays a mechanism with no memory of modes.
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
