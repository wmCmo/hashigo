/**
 * Stage 4 — the shadowing loop: what a tap means, when a side is revealed, and
 * the one ordering the whole exercise depends on.
 *
 *     import { shadowingLoop } from "hashigo/render/reveal";   // direct, not the barrel
 *     import { audioController } from "hashigo/render/audio";
 *
 *     const result = renderResolvedCard(resolveCard(card, template), { document });
 *     const audio = audioController(result, { resolve: bytesFromTheBlobStore });
 *     const loop = shadowingLoop(result, { audio });
 *
 *     loop.enter(0);            // side is on screen. NOTHING PLAYS.
 *     loop.side(0)?.reveal();   // he has said it aloud. NOW it plays.
 *     loop.dispose();           // every object URL revoked
 *
 * ── THE ORDERING IS THE PEDAGOGY ────────────────────────────────────────────
 *
 * SPEC, "Read this before building the renderer or the review UI": the four sides
 * of 単語 are a produce-then-verify drill for 高低アクセント, not a layout. He
 * looks at the kanji, recalls whether each mora is high or low, SAYS IT ALOUD,
 * and only then reveals the reading and hears the clip to compare.
 *
 *   ** AUDIO MUST NEVER FIRE BECAUSE A SIDE APPEARED. **
 *
 * `enter()` below is therefore the most important method in this file and it does
 * nothing: it records that a side is on screen and returns. Every other flashcard
 * renderer autoplays here, and autoplay gives away the contour before he has
 * produced it, which does not make the exercise worse — it deletes it.
 *
 * ── DECISION 29 AMENDED THE RULE. READ THIS BEFORE "FIXING" ANYTHING HERE ────
 *
 * The rule used to be stated absolutely, over all 7,716 cards. It is right for
 * the **692** cards where `Reading` is true and wrong for the **3,177** where it
 * is not, because those run the OPPOSITE exercise: the clip is the question and
 * the kanji is the answer, hidden behind a cloze. *"if you hide it behind the
 * cloze, and play しょうきゃく, i would be like... what しょう... and it would force
 * me to remember."*
 *
 * **That did not soften anything in this file.** `enter()` still does nothing and
 * still cannot reach the port — the amendment is entirely about WHO asks. There
 * are three ways to ask, none of them automatic, and each names why:
 *
 *   `reveal()`  he produced the answer and wants to compare      → mode 1
 *   `play()`    he deliberately tapped a clip                    → either
 *   `prompt()`  the clip IS the question, and nothing unmasks    → mode 2
 *
 * `prompt()` is the new one and it is the dangerous one, so it is deliberately
 * NOT reachable from `enter()`, does NOT unmask, and does not know what
 * `Reading` is. The caller that knows the card's mode calls it — `src/review`'s
 * `reviewModeFor`, which is the only thing in the repo that does. Point a
 * `prompt()` at a mode-1 card and you have re-created the autoplay defect by
 * hand; `test/review.test.ts` asserts mode 1 at exactly 0 play calls so that
 * shows up as a red test rather than as a quiet loss of the exercise.
 *
 * ── DO CLOZES ON A SIDE REVEAL INDIVIDUALLY OR TOGETHER? TOGETHER, PER SIDE ──
 *
 * Implemented as a per-SIDE group. Measured reasons, in the order they decided it:
 *
 *   1. `cloze/indexes` is empty on all 7,716 cards, so 11,476 of 11,476 clozes
 *      are the unindexed form and NOTHING is index-grouped. SPEC states the
 *      consequence outright: "every cloze reveals together".
 *   2. 2,968 sides carry exactly two clozes, and on 単語 side 2 they are the same
 *      fact written twice — `{{<<Reference>>}}` is the reading as text and
 *      `{{<furigana><<単語>></furigana>}}` is the reading as ruby. Revealing one
 *      and masking the other would print the answer and hide it simultaneously.
 *   3. There is nowhere to record a partial reveal. Grades are binary
 *      (remembered / forgot) and scheduling is per track; the `cloze:n` track
 *      exists in the schema and has **zero reviews in four years**, so a
 *      half-revealed side has no representable outcome.
 *
 * PER SIDE, not per card, because sides are presented in sequence: revealing
 * side 3's cloze while side 2 is on screen leaks the answer to side 2.
 *
 * The group is enforced rather than merely offered. The loop listens on each
 * `ClozeMount.onReveal`, so a cloze revealed by ANY route — a tap, a direct
 * `mount.reveal()`, or `result.revealAll()` — pulls its whole side with it. There
 * is deliberately no `revealOne`.
 *
 * ── A SIDE WITH AUDIO AND NO CLOZE: MEASURED, THEN DECIDED ──────────────────
 *
 * This is not the edge case it looks like. Over the real corpus (numbers pasted
 * in `test/reveal.test.ts`):
 *
 *   * **91 of 91** audio-bearing sides today have NO cloze on them. Zero sides
 *     have both. The cloze-reveal trigger is currently reachable on nothing,
 *     because every audio field in every template is a typed `speech` field whose
 *     stored value is empty on every card — the 624.6 MiB lives in Mochi's
 *     `component-cache`, addressed by generation identity.
 *   * Projected with those typed fields filled (stage 9), audio-alone is STILL
 *     the majority: ~6,900 audio-alone sides against ~3,900 audio+cloze.
 *
 * So it gets a real answer, not a fallback. A side with nothing hidden has no
 * reveal to hang playback on, so **the trigger is the listener's own deliberate
 * gesture**, in two forms, neither automatic:
 *
 *   1. `side.reveal()`, called by the review UI's own show-answer control — the
 *      control that has to exist anyway before a grade can be taken. On such a
 *      side it changes nothing visually and plays the clip. That IS the drill on
 *      単語 side 3 (`例文` + `Audio`) and 敬語 side 1: read it aloud, then hear it.
 *   2. The `<audio controls>` element's own play affordance. This cannot work
 *      unaided: the renderer creates media elements with **no `src`**, so tapping
 *      play on one plays nothing at all. The loop therefore ARMS every media
 *      element with `click`/`play` listeners that route the activation into
 *      `side.play(mount)` — that clip, unmasking the side on the way. Arming
 *      attaches listeners; it fetches no bytes, sets no `src` and makes no sound.
 *      The listeners are gated on the element still being sourceless and take
 *      themselves off once it is not, for a reason measured in a real browser and
 *      written up at the `onActivate` handler below.
 *
 * Arming applies on cloze sides too, and a gesture there unmasks the clozes as
 * well: you cannot hear the reading without also being shown it. Consistent with
 * the locked link decision — the only actor this defends against is Zach
 * deliberately spoiling himself, which is his business.
 *
 * `reveal()` starts the FIRST clip on a side and defers the rest, because two at
 * once is noise; the rest stay armed, so the second clip on a side (4 sides in the
 * corpus, 15 projected) is one tap away through `play()`.
 *
 * ── WHAT THIS FILE DOES NOT KNOW ────────────────────────────────────────────
 *
 * Nothing about blobs, object URLs or media elements: `audio` is an injected port
 * (`RevealAudio`) and `./audio.ts` implements it. Grep this file for `.play(` —
 * THREE call sites, one each in `reveal()`, `play()` and `prompt()`, and
 * `test/reveal.test.ts` counts them AND names the reason each one passes, so a
 * fourth route cannot arrive unnamed.
 *
 * **And it does not know which mode a card is in.** `Reading` is not mentioned
 * anywhere below and must not be: the moment this file decides when to autoplay,
 * the invariant stops being checkable by reading one method. Nothing about
 * grading, queues or which card comes next either; that is stage 7.
 */

import type { ClozeMount, MediaMount, RenderElement, RenderResult } from "./index.js";

// ─── the audio port ──────────────────────────────────────────────────────────

/**
 * Why the loop asked for sound. There is no reason called "a side appeared" —
 * `"prompt"` is decision 29's mode-2 question, asked by a caller that knows the
 * card's mode, and it leaves every cloze masked.
 */
export type RevealAudioReason = "reveal" | "replay" | "gesture" | "prompt";

/**
 * The slice of `./audio.ts`'s controller this file uses.
 *
 * A port rather than an import so that the loop can be tested — and reasoned
 * about — with a recorder in place of the real thing, and so that this file has
 * no dependency on `src/blobs`.
 */
export interface RevealAudio<E extends RenderElement = RenderElement> {
  play(mounts: readonly MediaMount<E>[], reason?: RevealAudioReason): unknown;
  pauseAll?(): void;
  release?(): unknown;
}

// ─── the activation port ─────────────────────────────────────────────────────

/**
 * An element the loop can attach behaviour to. `HTMLElement` satisfies it;
 * `MemoryElement` does not, which is why a memory render binds nothing and
 * `reveal()` remains callable directly.
 */
export interface ActivationTarget extends RenderElement {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  /** Read-only, and used for exactly one thing: has this element a source yet? */
  getAttribute(name: string): string | null;
}

function asTarget(element: RenderElement): ActivationTarget | null {
  const candidate = element as unknown as {
    addEventListener?: unknown;
    removeEventListener?: unknown;
    getAttribute?: unknown;
  };
  return typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function" &&
    typeof candidate.getAttribute === "function"
    ? (element as unknown as ActivationTarget)
    : null;
}

/** ARIA the loop adds to a cloze once it is actually interactive. */
export const REVEAL_ATTRIBUTES = {
  role: "role",
  tabIndex: "tabindex",
  expanded: "aria-expanded",
} as const;

// ─── what a side is ──────────────────────────────────────────────────────────

/** What makes a side revealable. Computed from the render, not configured. */
export type RevealTrigger =
  /** At least one cloze: tapping any of them reveals the whole side. */
  | "cloze"
  /** Audio but nothing hidden: an explicit gesture, see the header. */
  | "audio"
  /** Nothing to reveal at all — a prompt side. 19,018 of the corpus's 27,352. */
  | "none";

export type RevealCause = "cloze" | "gesture" | "caller";

export interface ShadowingSide<E extends RenderElement = RenderElement> {
  /** `Side.index` — the position in the AUTHORED template body. */
  readonly index: number;
  /** Where it sits in the order it is being shown in. */
  readonly position: number;
  readonly element: E;
  readonly clozes: readonly ClozeMount<E>[];
  /** Audio and video mounts on this side, in document order. */
  readonly audio: readonly MediaMount<E>[];
  readonly trigger: RevealTrigger;
  readonly revealed: boolean;
  /** True once `enter()` has been called. Entering plays nothing. */
  readonly entered: boolean;
  /**
   * Mark this side as on screen. **Deliberately does nothing else.** This is the
   * method every other flashcard renderer uses to start the audio, and starting
   * it here would destroy the shadowing exercise.
   */
  enter(): void;
  /**
   * Reveal every cloze on this side and play its first addressable clip.
   * Idempotent — returns false if it had already been revealed.
   *
   * `silent` unmasks and plays NOTHING. It exists because a screen that shows the
   * whole card after the answer unmasks several sides at once, and
   * `audioController.play()` defers only WITHIN one call — so two reveals start
   * two clips over the top of each other. Found by running the app rather than by
   * reasoning about it: 単語's word clip and its example-sentence clip both fired.
   *
   * It is the SAFE direction — less audio, never more — and it cannot be used to
   * sneak playback in. The screen reveals every side silently except the one clip
   * it means to play.
   */
  reveal(cause?: RevealCause, options?: { readonly silent?: boolean }): boolean;
  /**
   * Deliberately play ONE clip on this side — the armed element's own play
   * affordance, or a "play again" button. Unmasks the side first if it was still
   * masked, because sound implies revealed. Not idempotent: that is the point.
   *
   * This is also how the second clip on a side gets played at all. `reveal()`
   * starts the first and defers the rest (two at once is noise); the rest stay
   * armed and reach the port through here.
   */
  play(mount: MediaMount<E>): boolean;
  /**
   * Play this side's clips as the QUESTION, leaving every cloze masked.
   *
   * Decision 29's mode 2, and the one method here that plays without the human
   * having produced anything. It is safe only because of what it does NOT do:
   *
   *   * it does not unmask, so the kanji stays hidden and the clip stays the
   *     prompt. That is the whole difference from `play()`, which unmasks on
   *     purpose because a deliberate tap means "show me";
   *   * it is not called by `enter()`, and nothing here decides to call it. The
   *     caller has to know the card's mode and ask.
   *
   * Returns false when the side has no audio or the port is absent. Not
   * idempotent — one call, one question. `src/review`'s `enter()` calls it at
   * most once per entry; a screen that calls it twice asks twice.
   */
  prompt(): boolean;
  /** Re-mask the clozes and pause the audio. Does not revoke; a re-reveal replays. */
  conceal(): void;
  /** Deliberate re-listen of the side's first clip. Reuses the live lease. */
  replay(): boolean;
}

export interface RevealEvent<E extends RenderElement = RenderElement> {
  readonly kind: "enter" | "reveal" | "conceal" | "replay" | "prompt";
  readonly side: ShadowingSide<E>;
  readonly cause: RevealCause | null;
  /** Clozes this event changed. */
  readonly clozes: number;
  /** Audio mounts handed to the port. Zero for `enter` — always, by construction. */
  readonly audio: number;
}

export interface ShadowingLoopOptions<E extends RenderElement = RenderElement> {
  /** Omit it and the loop reveals silently — useful for a precomputed render. */
  readonly audio?: RevealAudio<E> | null;
  /**
   * Attach `click`/`keydown` to clozes so a tap reveals. Default true. Set false
   * for a render that is being serialised rather than shown.
   */
  readonly bindClozes?: boolean;
  /**
   * Attach one-shot `click`/`play` listeners to media elements, so their own
   * controls work despite the renderer leaving them without a `src`. Default
   * true. This is the audio-alone trigger; see the header.
   */
  readonly armMedia?: boolean;
  readonly onEvent?: (event: RevealEvent<E>) => void;
}

export interface ShadowingLoop<E extends RenderElement = RenderElement> {
  readonly result: RenderResult<E>;
  /** One entry per rendered side, in presentation order. */
  readonly sides: readonly ShadowingSide<E>[];
  /** The last side `enter()` was called on, or null. */
  readonly current: ShadowingSide<E> | null;
  /** Every enter/reveal/conceal/replay, in order. The audit trail for a session. */
  readonly log: readonly RevealEvent<E>[];
  /** By PRESENTATION position — what stage 7 counts in. */
  side(position: number): ShadowingSide<E> | null;
  /** By AUTHORED side index — what a template talks about. */
  bySideIndex(index: number): ShadowingSide<E> | null;
  enter(position: number): ShadowingSide<E> | null;
  onReveal(listener: (side: ShadowingSide<E>) => void): () => void;
  /** Unbind every listener and release the audio port. Idempotent. */
  dispose(): void;
}

// ─── the loop ────────────────────────────────────────────────────────────────

export function shadowingLoop<E extends RenderElement>(
  result: RenderResult<E>,
  options: ShadowingLoopOptions<E> = {},
): ShadowingLoop<E> {
  const audio = options.audio ?? null;
  const bindClozes = options.bindClozes !== false;
  const log: RevealEvent<E>[] = [];
  const listeners = new Set<(side: ShadowingSide<E>) => void>();
  const unbinds: (() => void)[] = [];
  let current: ShadowingSide<E> | null = null;
  let disposed = false;

  // Grouping keys on the AUTHORED side index, which is what a mount records.
  // `resolveCard` and `orderSides` both guarantee those are unique across a
  // render — reverse mode permutes the order, never the indices — so one cloze
  // belongs to exactly one group. A caller that synthesised sides sharing an index
  // (rendering a list of field values as `{ index: 0 }`, as one render test does)
  // would get them all in one group, which is the only sensible reading anyway.
  const sides: ShadowingSide<E>[] = result.sides.map((rendered) => {
    const clozes = result.clozes.filter((mount) => mount.side === rendered.index);
    const media = result.media.filter(
      (mount) => mount.side === rendered.index && (mount.kind === "audio" || mount.kind === "video"),
    );
    const trigger: RevealTrigger =
      clozes.length > 0 ? "cloze" : media.length > 0 ? "audio" : "none";
    let revealed = false;
    let entered = false;
    // Guards the re-entry that the enforced grouping creates: revealing cloze A
    // fires A's listener, which reveals the side, which reveals cloze B, whose
    // listener reveals the side again.
    let revealing = false;

    const side: ShadowingSide<E> = {
      index: rendered.index,
      position: rendered.position,
      element: rendered.element,
      clozes,
      audio: media,
      trigger,
      get revealed(): boolean {
        return revealed;
      },
      get entered(): boolean {
        return entered;
      },
      enter(): void {
        entered = true;
        // NOTHING ELSE HAPPENS HERE. See the header. `emit` is given zero audio
        // mounts explicitly so that the log proves it rather than implying it.
        emit({ kind: "enter", side, cause: null, clozes: 0, audio: 0 });
      },
      reveal(cause = "caller", options = {}): boolean {
        const changed = unmask();
        if (changed === null) return false;
        let played = 0;
        if (media.length > 0 && audio !== null && options.silent !== true) {
          played = media.length;
          audio.play(media, "reveal");
        }
        emit({ kind: "reveal", side, cause, clozes: changed, audio: played });
        announce();
        return true;
      },
      play(mount): boolean {
        if (!media.includes(mount)) return false;
        // Sound implies revealed, always: a deliberate tap on one clip unmasks
        // the side too, because you cannot hear the reading without being shown
        // it. The reverse route — sound with the answer still masked — is the one
        // this method must not open.
        const changed = unmask();
        const first = changed !== null;
        audio?.play([mount], first ? "reveal" : "replay");
        emit({
          kind: first ? "reveal" : "replay",
          side,
          cause: first ? "gesture" : null,
          clozes: changed ?? 0,
          audio: 1,
        });
        if (first) announce();
        return true;
      },
      prompt(): boolean {
        // No unmask() call, and that omission is the method. Mode 2 hides the
        // kanji and asks with the clip; unmasking here would print the answer
        // beside the question.
        if (media.length === 0 || audio === null) return false;
        audio.play(media, "prompt");
        emit({ kind: "prompt", side, cause: null, clozes: 0, audio: media.length });
        return true;
      },
      conceal(): void {
        if (!revealed) return;
        revealed = false;
        for (const mount of clozes) {
          mount.conceal();
          if (bindClozes) asTarget(mount.element)?.setAttribute(REVEAL_ATTRIBUTES.expanded, "false");
        }
        audio?.pauseAll?.();
        emit({ kind: "conceal", side, cause: null, clozes: clozes.length, audio: 0 });
      },
      replay(): boolean {
        const first = media[0];
        return first === undefined ? false : side.play(first);
      },
    };

    /**
     * Reveal every cloze on this side. Returns how many it changed, or null if the
     * side was already revealed — which is how the callers above tell a first
     * reveal from a replay.
     */
    function unmask(): number | null {
      if (revealed || revealing) return null;
      revealing = true;
      let changed = 0;
      try {
        // DOM first, sound second: a listener that measures the answer or plays a
        // clip must see the revealed tree, not the one before it.
        for (const mount of clozes) {
          if (mount.revealed) continue;
          mount.reveal();
          changed += 1;
        }
        revealed = true;
        // Only when the loop actually bound the cloze, which is the same condition
        // under which `role`/`tabindex` were added: a serialised memory render
        // must come out of this byte-identical.
        if (bindClozes) {
          for (const mount of clozes) {
            asTarget(mount.element)?.setAttribute(REVEAL_ATTRIBUTES.expanded, "true");
          }
        }
      } finally {
        revealing = false;
      }
      return changed;
    }

    function announce(): void {
      for (const listener of [...listeners]) listener(side);
    }

    return side;
  });

  function emit(event: RevealEvent<E>): void {
    log.push(event);
    options.onEvent?.(event);
  }

  // ── wiring ──
  // The group is enforced here rather than at the tap: a cloze revealed by any
  // route pulls its whole side with it, so `result.revealAll()` and a direct
  // `mount.reveal()` behave exactly like a tap.
  for (const side of sides) {
    for (const mount of side.clozes) {
      unbinds.push(mount.onReveal(() => side.reveal("cloze")));
    }
  }

  if (bindClozes) {
    for (const side of sides) {
      for (const mount of side.clozes) {
        const target = asTarget(mount.element);
        if (target === null) continue;
        // A masked span is not focusable and does not announce itself. Only added
        // when the element can actually be activated, so a serialised render is
        // unchanged.
        target.setAttribute(REVEAL_ATTRIBUTES.role, "button");
        target.setAttribute(REVEAL_ATTRIBUTES.tabIndex, "0");
        target.setAttribute(REVEAL_ATTRIBUTES.expanded, mount.revealed ? "true" : "false");
        const onClick = (): void => {
          side.reveal("cloze");
        };
        const onKey = (event: unknown): void => {
          const key = (event as { key?: unknown }).key;
          if (key !== "Enter" && key !== " " && key !== "Spacebar") return;
          // Space scrolls the page otherwise, which on a phone-sized review screen
          // moves the card out from under the answer he just revealed.
          (event as { preventDefault?: () => void }).preventDefault?.();
          side.reveal("cloze");
        };
        target.addEventListener("click", onClick);
        target.addEventListener("keydown", onKey);
        unbinds.push(() => {
          target.removeEventListener("click", onClick);
          target.removeEventListener("keydown", onKey);
        });
      }
    }
  }

  if (options.armMedia !== false) {
    for (const side of sides) {
      for (const mount of side.audio) {
        const target = asTarget(mount.element);
        if (target === null) continue;
        /**
         * A gesture is only OURS to interpret while the element has no `src`.
         *
         * That gate is what makes this safe rather than a feedback loop, and it
         * was a real bug before it existed: `audio.play()` assigns a source and
         * calls `element.play()`, the platform then fires a `play` event, and a
         * handler that read that as a gesture asked for the clip a second time.
         * A `play` event is indistinguishable from our own playback by any other
         * means — it is dispatched in a later task, so a re-entrancy flag around
         * our own call would not see it.
         *
         * Before the first attach, an activation cannot mean anything else and
         * cannot do anything at all: the renderer leaves media elements
         * sourceless, so the native play button is inert until something binds
         * bytes to it. AFTER the attach the element owns its own interactions —
         * a tap on the seek bar is not a request to restart the clip — so these
         * listeners take themselves off.
         *
         * It plays THIS clip rather than the side's first one, which is how the
         * second clip on a side (deferred by `reveal()`) is reachable at all.
         */
        const onActivate = (): void => {
          if (target.getAttribute("src") !== null) {
            off();
            return;
          }
          side.play(mount);
        };
        const off = (): void => {
          target.removeEventListener("click", onActivate);
          target.removeEventListener("play", onActivate);
        };
        // MEASURED IN A REAL BROWSER (Chromium 151, an http origin, a sourceless
        // `<audio controls>`; the probe is pasted in this task's report):
        //
        //   * `element.play()` on an element with NO SOURCE fires exactly ONE
        //     `play` event, leaves `paused === false`, `networkState === 0`, and
        //     the returned promise NEITHER resolves nor rejects. So `play` is a
        //     real, catchable signal that somebody asked for this clip — and the
        //     `src` gate above is what separates it from our own playback.
        //   * Assigning a `src` afterwards STARTS IT, with no second `play` event.
        //     A clip stage 9 has not generated yet therefore plays the moment it
        //     exists, without another gesture.
        //   * A click at the centre of the native control did NOT reach the host
        //     element as `click` — 0 events, at 320 px and at 48 px wide. So
        //     `click` is the belt-and-braces listener, not the load-bearing one:
        //     it is kept for engines that do retarget and for a custom control a
        //     stage-7 UI may lay over the element. NOT VERIFIED: a press on the
        //     native play button specifically, which the zero-sized viewport of
        //     the second browser could not be made to deliver.
        //
        // Either way the review UI's own show-answer control (`reveal()`) covers
        // this trigger on its own; the native path is an extra.
        target.addEventListener("click", onActivate);
        target.addEventListener("play", onActivate);
        unbinds.push(off);
      }
    }
  }

  return {
    result,
    sides,
    log,
    get current(): ShadowingSide<E> | null {
      return current;
    },
    side(position) {
      return sides.find((entry) => entry.position === position) ?? null;
    },
    bySideIndex(index) {
      return sides.find((entry) => entry.index === index) ?? null;
    },
    enter(position) {
      const side = sides.find((entry) => entry.position === position) ?? null;
      if (side === null) return null;
      current = side;
      side.enter();
      return side;
    },
    onReveal(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of unbinds) off();
      unbinds.length = 0;
      listeners.clear();
      audio?.release?.();
    },
  };
}
