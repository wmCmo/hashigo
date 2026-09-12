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
 * ── ONE CLOZE AT A TIME, THEN THE NEXT SIDE — ZACH, 2026-09-12 ──────────────
 *
 * **This REVERSES an earlier call recorded in this header, and the reversal is
 * his.** *"when you click reveal, it shows the whole thing, the next slide, and
 * the third slide, and every cloze. the correct order should be, each cloze in
 * that slide, once every clozes are shown, the next side and so on."*
 *
 * So `revealNext()` is the unit now and `reveal()` is the bulk operation. What
 * the old three reasons were actually worth, having been overruled:
 *
 *   1. **"`cloze/indexes` is empty on all 7,716 cards, so nothing is
 *      index-grouped"** — still true, and it never argued for a group. It argued
 *      that the AUTHOR named no groups, which leaves the order to the screen.
 *      Document order is the order he reads in.
 *   2. **"単語 side 2's two clozes are the same fact written twice"** — measured
 *      again and it is not one fact. `{{<<Reference>>}}` is the READING;
 *      `{{<furigana><<単語>></furigana>}}` is the KANJI with the reading as ruby.
 *      On the 3,177 mode-2 cards, where the clip is the question, showing the
 *      reading first and the kanji second is the exercise in two steps rather
 *      than one — hear しょうきゃく, confirm the reading, then meet 償却.
 *   3. **"there is nowhere to record a partial reveal"** — correct, and it stays
 *      correct: nothing here is graded or persisted. A step is a thing on screen,
 *      not a thing in the schema. Decision 2's binary grade is untouched.
 *
 * PER SIDE still bounds it: a step never crosses into the next side, because
 * sides are presented in sequence and revealing side 3's cloze while side 2 is on
 * screen leaks the answer to side 2. That part was always the load-bearing half.
 *
 * **A side sounds its clip when its LAST cloze is unmasked**, not when its first
 * is — so the shadowing comparison still lands on the complete answer, and a
 * stepped reveal plays no earlier than the old one-shot did.
 *
 * The loop still listens on every `ClozeMount.onReveal`, so a cloze revealed by
 * ANY route — a tap, a direct `mount.reveal()`, `result.revealAll()` — keeps the
 * side's bookkeeping honest: `side.revealed` means "every cloze on it is shown",
 * on every route, and that is what fires the clip and the `reveal` event.
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
  /** Every cloze on this side is unmasked. A side with no clozes turns true on `reveal()`. */
  readonly revealed: boolean;
  /** How many clozes are still hidden. `0` on a side that has none. */
  readonly masked: number;
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
   * Unmask the NEXT hidden cloze on this side, in document order — one step of
   * Zach's 2026-09-12 ordering. Returns false when nothing was left to unmask.
   *
   * The clip sounds only on the step that unmasks the LAST one, so a side with
   * two clozes takes two presses and makes exactly one sound. A side with no
   * clozes has no steps at all: `reveal()` is its only verb.
   */
  revealNext(cause?: RevealCause, options?: { readonly silent?: boolean }): boolean;
  /**
   * Unmask ONE named cloze — what a tap on that cloze means, now that a tap no
   * longer drags its neighbours with it. Out-of-order is allowed: he tapped it.
   */
  revealCloze(
    mount: ClozeMount<E>,
    cause?: RevealCause,
    options?: { readonly silent?: boolean },
  ): boolean;
  /**
   * Deliberately play ONE clip on this side — the armed element's own play
   * affordance, or a "play again" button. Unmasks the side first if it was still
   * masked, because sound implies revealed. Not idempotent: that is the point.
   *
   * This is also how the second clip on a side gets played at all. `reveal()`
   * starts the first and defers the rest (two at once is noise); the rest stay
   * armed and reach the port through here.
   */
  play(mount: MediaMount<E>, options?: { readonly unmask?: boolean }): boolean;
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
  /**
   * Deliberate re-listen of the side's first clip. Reuses the live lease.
   *
   * **It never reveals anything.** Before the side is revealed the clip is still
   * the question (decision 29's mode 2), and repeating a question is not
   * answering it — see `play`'s `unmask` option for the measurement that made
   * this a bug fix rather than a preference.
   */
  replay(): boolean;
}

export interface RevealEvent<E extends RenderElement = RenderElement> {
  /**
   * `step` is one cloze unmasked on a side that still has more — the partial
   * move Zach's ordering introduced. The side's `reveal` event still fires once,
   * when the last one goes, so anything counting reveals counts sides.
   */
  readonly kind: "enter" | "reveal" | "step" | "conceal" | "replay" | "prompt";
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
    // Set while THIS file is driving `mount.reveal()`, so the bookkeeping
    // listener below knows the call is already accounted for and stays out of it.
    // It is also the re-entry guard: `unmask()` reveals several mounts in a row
    // and each one fires a listener.
    let revealing = false;
    // Clozes unmasked since the side was last fully masked. Reported on the
    // side's one `reveal` event, so "how many did this act show" survives a
    // stepped reveal as well as a one-shot one.
    let unmasked = 0;

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
      get masked(): number {
        return clozes.reduce((count, mount) => count + (mount.revealed ? 0 : 1), 0);
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
      revealNext(cause = "caller", options = {}): boolean {
        const next = clozes.find((mount) => !mount.revealed);
        return next === undefined ? false : side.revealCloze(next, cause, options);
      },
      revealCloze(mount, cause = "caller", options = {}): boolean {
        if (!clozes.includes(mount) || mount.revealed || revealed || revealing) return false;
        // `revealing` is up for exactly the DOM write, so the bookkeeping
        // listener sees an accounted-for reveal and this method owns what
        // follows. Not held across `settle()` — `settle` may play, and a clip is
        // not part of the re-entry it guards against.
        revealing = true;
        try {
          mount.reveal();
        } finally {
          revealing = false;
        }
        if (bindClozes) {
          asTarget(mount.element)?.setAttribute(REVEAL_ATTRIBUTES.expanded, "true");
        }
        unmasked += 1;
        settle(cause, options.silent === true);
        return true;
      },
      play(mount, options = {}): boolean {
        if (!media.includes(mount)) return false;
        // Sound implies revealed BY DEFAULT: a deliberate tap on one clip unmasks
        // the side too, because on an ANSWER clip you cannot hear the reading
        // without being shown it.
        //
        // `unmask: false` IS THE MODE-2 CASE AND IT IS A BUG FIX, 2026-09-12.
        // Measured in the browser: on a card where the clip is the QUESTION, the
        // replay button — which decision 29 deliberately makes available BEFORE
        // the reveal, so he can hear the question again — unmasked both clozes on
        // the side. `data-state` still said `prompt` and the kanji was on screen.
        // That is precisely the defect the hard rule exists to prevent, arriving
        // through the one control allowed past it.
        //
        // So a caller that knows the clip is still the question says so, and gets
        // `prompt()`'s contract instead: sound, and nothing unmasked. It degrades
        // to the ordinary path once the side IS revealed, where there is nothing
        // left to protect.
        const asking = options.unmask === false && !revealed;
        const changed = asking ? null : unmask();
        const first = changed !== null;
        audio?.play([mount], asking ? "prompt" : first ? "reveal" : "replay");
        emit({
          kind: asking ? "prompt" : first ? "reveal" : "replay",
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
        unmasked = 0;
        for (const mount of clozes) {
          mount.conceal();
          if (bindClozes) asTarget(mount.element)?.setAttribute(REVEAL_ATTRIBUTES.expanded, "false");
        }
        audio?.pauseAll?.();
        emit({ kind: "conceal", side, cause: null, clozes: clozes.length, audio: 0 });
      },
      replay(): boolean {
        const first = media[0];
        // NEVER REVEALS. "Again" is the same act as last time, not a bigger one —
        // and before the side is revealed the clip is still the QUESTION, where
        // repeating it must show nothing. Once the side IS revealed this is the
        // ordinary re-listen, because `unmask: false` only bites while masked.
        return first === undefined ? false : side.play(first, { unmask: false });
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

    /**
     * One cloze has just been unmasked. Decide whether that finished the side.
     *
     * This is the only place a stepped reveal can turn into a `reveal` event and
     * a clip, and it is deliberately the SAME place the old whole-side path
     * ended up in — so "the side is revealed" cannot mean two different things
     * depending on which verb got there.
     */
    function settle(cause: RevealCause, silent: boolean): void {
      if (clozes.some((mount) => !mount.revealed)) {
        emit({ kind: "step", side, cause, clozes: 1, audio: 0 });
        return;
      }
      revealed = true;
      let played = 0;
      if (media.length > 0 && audio !== null && !silent) {
        played = media.length;
        audio.play(media, "reveal");
      }
      emit({ kind: "reveal", side, cause, clozes: unmasked, audio: played });
      announce();
    }

    function announce(): void {
      for (const listener of [...listeners]) listener(side);
    }

    // BOOKKEEPING, NOT GROUPING — the difference is Zach's 2026-09-12 ordering.
    // This listener used to pull the whole side; now it only notices. A cloze
    // unmasked by a route this file did not drive (`result.revealAll()`, a direct
    // `mount.reveal()`, a render hook) still has to count, or `side.revealed`
    // would stay false on a side that is visibly open and its clip would never
    // sound.
    //
    // `revealCloze` and `unmask` both raise `revealing` while they write, so
    // their own reveals arrive here already accounted for and are skipped.
    for (const mount of clozes) {
      unbinds.push(
        mount.onReveal(() => {
          if (revealing || revealed) return;
          if (bindClozes) {
            asTarget(mount.element)?.setAttribute(REVEAL_ATTRIBUTES.expanded, "true");
          }
          unmasked += 1;
          settle("cloze", false);
        }),
      );
    }

    return side;
  });

  function emit(event: RevealEvent<E>): void {
    log.push(event);
    options.onEvent?.(event);
  }

  // ── wiring ──

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
        // THIS cloze, not its neighbours — Zach's 2026-09-12 ordering. He tapped
        // a specific mask; out of order is allowed, because he chose it.
        const onClick = (): void => {
          side.revealCloze(mount, "cloze");
        };
        const onKey = (event: unknown): void => {
          const key = (event as { key?: unknown }).key;
          if (key !== "Enter" && key !== " " && key !== "Spacebar") return;
          // Space scrolls the page otherwise, which on a phone-sized review screen
          // moves the card out from under the answer he just revealed.
          (event as { preventDefault?: () => void }).preventDefault?.();
          side.revealCloze(mount, "cloze");
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
