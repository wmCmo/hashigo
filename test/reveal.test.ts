/**
 * Stage 4 acceptance for the SHADOWING LOOP — `src/render/reveal.ts` and
 * `src/render/audio.ts`.
 *
 * SPEC, "Read this before building the renderer or the review UI": the sides of
 * 単語 and 漢字 are a produce-then-verify drill for 高低アクセント, and the
 * ordering carries the pedagogy. He looks at the kanji, recalls whether each mora
 * is high or low, says it aloud, and ONLY THEN reveals the reading and hears the
 * clip. So:
 *
 *   ** AUDIO MUST NEVER FIRE BECAUSE A SIDE APPEARED. **
 *
 * That is pinned five ways here, because it is a correctness requirement and a
 * test that does not pin it is inadequate:
 *
 *   1. Rendering a card and ENTERING every side of it requests no bytes, mints no
 *      object URL and calls `play()` zero times (§3).
 *   2. Revealing requests exactly one clip, attaches it and plays it (§3).
 *   3. Over ALL 7,716 real cards, entering every side of every card with a
 *      resolver that THROWS if it is called — 27,352 sides, zero calls (§10).
 *   4. The armed media element's own play affordance reveals; nothing else does,
 *      and it fires once (§5).
 *   5. Neither module can express autoplay: source checks for the attribute, for
 *      a direct `src` assignment, and for a `play()` whose reason is not one of
 *      the three this file names (§9).
 *
 * ── DECISION 29 (2026-08-23): THE RULE IS ABOUT `enter()`, NOT ABOUT SILENCE ──
 *
 * On the 3,177 cards where `Reading` is not true the clip is the QUESTION and the
 * kanji is the answer, so it fires when the side appears. **None of the five
 * above was relaxed by one card**, because none of them was ever about silence —
 * they are about `enter()` and about the port being unreachable except through a
 * named reason. §3b tests the new reason, `prompt()`, and the assertion that
 * matters there is that it unmasks NOTHING: it plays the question and leaves the
 * answer hidden, which is the entire difference from `play()`.
 *
 * WHICH MODE A CARD IS IN IS NOT DECIDED HERE, and §9 asserts this file never
 * mentions `Reading`. `src/review/mode.ts` owns that, and `test/review.test.ts`
 * measures both modes over the real corpus.
 *
 * And the leak the third required test is about: a review session mints one
 * object URL per clip and MUST revoke every one of them. 40 cards, 40 claims,
 * 40 revocations, `live === 0` (§3).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BlobUrlScope, type BlobPayload } from "../src/blobs/url.js";
import { fieldValueText } from "../src/import/entities.js";
import {
  asRecord,
  asRecords,
  asText,
  isRecord,
  loadExport,
  walkCards,
  type MochiRecord,
} from "../src/import/transit.js";
import { parseContent, resolveCard, type TemplateInput } from "../src/template/index.js";
import {
  MemoryElement,
  MemoryText,
  memoryDocument,
  renderResolvedCard,
  renderSides,
  serialise,
  type MediaMount,
  type RenderDocument,
  type RenderResult,
} from "../src/render/index.js";
import {
  AUDIO_DATA,
  audioAddress,
  audioController,
  type AudioAddress,
  type AudioController,
  type AudioOutcome,
  type PlayableMediaElement,
} from "../src/render/audio.js";
import {
  REVEAL_ATTRIBUTES,
  shadowingLoop,
  type ActivationTarget,
  type RevealAudio,
  type RevealEvent,
  type ShadowingLoop,
} from "../src/render/reveal.js";

// ─── 1. the ports really are the DOM ─────────────────────────────────────────

/**
 * Type-only, in the manner of `spike/contract-compat.ts`: no runtime value, and
 * the assignment IS the assertion. If either port is widened past what a browser
 * provides, `npm run typecheck` stops compiling — which is the moment to find out.
 */
export const audioElementSatisfiesPort: PlayableMediaElement =
  null as unknown as HTMLAudioElement;
export const videoElementSatisfiesPort: PlayableMediaElement =
  null as unknown as HTMLVideoElement;
export const htmlElementIsActivatable: ActivationTarget = null as unknown as HTMLElement;
/** And the real controller is what the loop's port describes — no adapter. */
export const controllerSatisfiesRevealAudio: RevealAudio<MemoryElement> =
  null as unknown as AudioController<MemoryElement>;

// ─── 2. the doubles ──────────────────────────────────────────────────────────

/**
 * A memory element that can be listened to.
 *
 * The same reasoning as `src/render/dom.ts`: no jsdom, because the rule is that
 * the thing tested is the thing that ships and a second DOM implementation is not
 * it. `LiveElement` adds only `addEventListener`/`removeEventListener`, which is
 * exactly the `ActivationTarget` port, and `FakeMedia` adds exactly the
 * `PlayableMediaElement` port — both pinned against the real DOM in §1.
 */
class LiveElement extends MemoryElement {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  /** Listener count, so "unbound after one shot" is observable. */
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeMedia extends LiveElement {
  plays = 0;
  pauses = 0;
  loads = 0;
  currentTime = 0;
  #paused = true;
  /** Set to make `play()` reject, the way an autoplay policy does. */
  rejectPlay: string | null = null;

  /** Reflected onto the attribute, as a real media element reflects `src`. */
  get src(): string {
    return this.getAttribute("src") ?? "";
  }

  set src(value: string) {
    this.setAttribute("src", value);
  }

  get paused(): boolean {
    return this.#paused;
  }

  play(): Promise<void> {
    this.plays += 1;
    if (this.rejectPlay !== null) return Promise.reject(new Error(this.rejectPlay));
    this.#paused = false;
    // A real element fires `play` here, which is what the loop arms against.
    this.dispatch("play");
    return Promise.resolve();
  }

  pause(): void {
    this.pauses += 1;
    this.#paused = true;
  }

  load(): void {
    this.loads += 1;
  }
}

/** A document whose `<audio>`/`<video>` can be played and whose spans can be tapped. */
function liveDocument(): RenderDocument<MemoryElement> {
  return {
    createElement: (tag) =>
      tag === "audio" || tag === "video" ? new FakeMedia(tag) : new LiveElement(tag),
    createTextNode: (data) => new MemoryText(data),
  };
}

/** A payload with a real 64-hex address, so `assertAddress` is satisfied. */
function payloadFor(seed: string, bytes = 64): BlobPayload {
  let hash = "";
  for (let index = 0; hash.length < 64; index += 1) {
    hash += Math.abs(hashCode(`${seed}:${index}`)).toString(16).padStart(8, "0");
  }
  return {
    hash: hash.slice(0, 64),
    bytes: new Uint8Array(bytes).fill(7),
    mime: "audio/mpeg",
  };
}

function hashCode(text: string): number {
  let value = 0;
  for (const character of text) value = (value * 31 + character.codePointAt(0)!) | 0;
  return value;
}

/** A `URL.createObjectURL` stand-in that records everything. Node has none. */
function urlRecorder(): {
  readonly minted: string[];
  readonly revoked: string[];
  readonly options: { createObjectURL: (blob: Blob) => string; revokeObjectURL: (url: string) => void };
} {
  const minted: string[] = [];
  const revoked: string[] = [];
  return {
    minted,
    revoked,
    options: {
      createObjectURL: (blob: Blob) => {
        const url = `blob:https://hashigo.test/${minted.length}-${blob.size}`;
        minted.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => {
        revoked.push(url);
      },
    },
  };
}

interface Harness {
  readonly result: RenderResult<MemoryElement>;
  readonly loop: ShadowingLoop<MemoryElement>;
  readonly audio: AudioController<MemoryElement>;
  readonly scope: BlobUrlScope;
  readonly urls: ReturnType<typeof urlRecorder>;
  readonly requests: AudioAddress[];
  readonly outcomes: AudioOutcome<MemoryElement>[];
  readonly events: RevealEvent<MemoryElement>[];
  media(index?: number): FakeMedia;
  cloze(index: number): LiveElement;
}

/**
 * Render authored card text and wire the whole loop over it.
 *
 * `store` maps an address to bytes; an address that is absent is a MISSING BLOB,
 * which is one of the cases the task names.
 */
function harness(
  text: string,
  options: { readonly store?: ReadonlyMap<string, BlobPayload>; readonly armMedia?: boolean } = {},
): Harness {
  const store = options.store ?? new Map<string, BlobPayload>();
  const urls = urlRecorder();
  const scope = new BlobUrlScope(urls.options);
  const requests: AudioAddress[] = [];
  const outcomes: AudioOutcome<MemoryElement>[] = [];
  const events: RevealEvent<MemoryElement>[] = [];
  const result = renderSides(parseContent(text), { document: liveDocument() });
  const audio = audioController(result, {
    scope,
    resolve: (address) => {
      requests.push(address);
      return store.get(addressKey(address)) ?? null;
    },
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  const loop = shadowingLoop(result, {
    audio,
    onEvent: (event) => events.push(event),
    ...(options.armMedia === undefined ? {} : { armMedia: options.armMedia }),
  });
  return {
    result,
    loop,
    audio,
    scope,
    urls,
    requests,
    outcomes,
    events,
    media(index = 0) {
      const mount = result.media.filter((entry) => entry.kind === "audio")[index];
      if (mount === undefined) throw new Error(`no audio mount ${index}`);
      return mount.element as FakeMedia;
    },
    cloze(index) {
      const mount = result.clozes[index];
      if (mount === undefined) throw new Error(`no cloze ${index}`);
      return mount.element as LiveElement;
    },
  };
}

/** The store key the harness files bytes under. Mirrors what stage 9 will do. */
function addressKey(address: AudioAddress): string {
  return address.origin === "attachment"
    ? `attachment:${address.key}`
    : `${address.request.kind}:${address.request.lang ?? ""}:${address.request.text}`;
}

const AUDIO_ATTACHMENT = "![Copilot_Audio_20260122_194103.mp3](uVQp0iMb.mp3)";
/** 単語 side 2 in miniature: the reading clozed, and the clip that verifies it. */
const SHADOWING_SIDE = `{{あらかた}}\n${AUDIO_ATTACHMENT}`;
const CLIP = payloadFor("uVQp0iMb.mp3");
const STORE = new Map<string, BlobPayload>([["attachment:uVQp0iMb.mp3", CLIP]]);

// ─── 3. THE THREE REQUIRED TESTS ─────────────────────────────────────────────

describe("the hard rule: audio fires on reveal, never on side entry", () => {
  it("requests NO audio when a side is rendered and entered", () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    // Rendering alone.
    expect(h.requests).toEqual([]);
    expect(h.urls.minted).toEqual([]);
    expect(h.media().plays).toBe(0);

    // And entering every side — which is where every other flashcard renderer
    // starts the clip, and where doing so would delete the exercise.
    for (const side of h.loop.sides) h.loop.enter(side.position);
    expect(h.loop.sides.map((side) => side.entered)).toEqual([true]);
    expect(h.requests).toEqual([]);
    expect(h.urls.minted).toEqual([]);
    expect(h.audio.stats.requested).toBe(0);
    expect(h.media().plays).toBe(0);
    expect(h.media().hasAttribute("src")).toBe(false);
    expect(h.media().getAttribute(AUDIO_DATA.state)).toBe("idle");
    // The element the renderer built is untouched: still silent, still sourceless.
    expect(serialise(h.media())).toBe(
      '<audio class="hashigo-audio" data-media-kind="audio" data-media-ref="uVQp0iMb.mp3"' +
        ' data-media-key="uVQp0iMb.mp3" controls="" preload="none"' +
        ' aria-label="Copilot_Audio_20260122_194103.mp3" data-audio-state="idle"></audio>',
    );
    // Every `enter` in the log carries zero audio mounts, by construction.
    expect(h.events.map((event) => [event.kind, event.audio])).toEqual([["enter", 0]]);
  });

  it("requests and plays the audio ON REVEAL, once he has produced the reading", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.enter(0);
    expect(h.loop.side(0)?.trigger).toBe("cloze");

    expect(h.loop.side(0)?.reveal("cloze")).toBe(true);
    await h.audio.idle();

    // Exactly one request, for exactly the attachment the card names.
    expect(h.requests).toEqual([{ origin: "attachment", key: "uVQp0iMb.mp3" }]);
    expect(h.audio.stats.requested).toBe(1);
    // One object URL, on the element, and playing.
    expect(h.urls.minted).toHaveLength(1);
    expect(h.media().src).toBe(h.urls.minted[0]);
    expect(h.media().plays).toBe(1);
    expect(h.media().paused).toBe(false);
    expect(h.media().getAttribute(AUDIO_DATA.state)).toBe("playing");
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["playing"]);
    expect(h.outcomes[0]?.reason).toBe("reveal");
    expect(h.outcomes[0]?.hash).toBe(CLIP.hash);
    // And the reading is on screen — the DOM changed before the sound started.
    expect(h.result.clozes[0]?.revealed).toBe(true);
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.expanded)).toBe("true");
  });

  it("revokes the blob: URL, so a long session leaks nothing", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    const url = h.urls.minted[0];
    expect(url).toBeDefined();
    expect(h.scope.live).toBe(1);

    h.loop.dispose();

    expect(h.urls.revoked).toEqual([url]);
    expect(h.scope.live).toBe(0);
    expect(h.scope.liveBytes).toBe(0);
    // Cleared BEFORE revoking (url.ts rule 3): an element left holding a revoked
    // URL fails its next load() with an error that never mentions revocation.
    expect(h.media().hasAttribute("src")).toBe(false);
    expect(h.media().pauses).toBeGreaterThan(0);
    expect(h.media().loads).toBe(1);
    // Idempotent: a second dispose revokes nothing twice.
    h.loop.dispose();
    expect(h.urls.revoked).toEqual([url]);
  });

  it("holds nothing after a 40-card session — one URL per clip, all of them released", async () => {
    // Zach reviews ~69 cards a day on a phone at 60,551 B per clip average. A
    // controller that leaked one URL per clip would pin megabytes for the life of
    // the tab, which is the bug `src/blobs/url.ts` is shaped to prevent.
    const urls = urlRecorder();
    let live = 0;
    let peak = 0;
    for (let card = 0; card < 40; card += 1) {
      const scope = new BlobUrlScope(urls.options);
      const payload = payloadFor(`clip-${card}`, 60_551);
      const result = renderSides(parseContent(`{{答え}}\n![clip](card${card}.mp3)`), {
        document: liveDocument(),
      });
      const audio = audioController(result, {
        scope,
        resolve: () => payload,
      });
      const loop = shadowingLoop(result, { audio });
      loop.enter(0);
      loop.side(0)?.reveal("cloze");
      await audio.idle();
      live += 1;
      peak = Math.max(peak, scope.live);
      loop.dispose();
      live -= 1;
      expect(scope.live).toBe(0);
    }
    expect(urls.minted).toHaveLength(40);
    expect(urls.revoked).toHaveLength(40);
    expect(new Set(urls.revoked)).toEqual(new Set(urls.minted));
    expect(peak).toBe(1);
    expect(live).toBe(0);
  });
});

// ─── 3b. decision 29: prompt() plays the QUESTION, and unmasks nothing ───────

describe("prompt(): the mode-2 question", () => {
  it("plays without unmasking, which is the whole difference from play()", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    const side = h.loop.enter(0)!;
    // Entering is still silent. `prompt()` is a separate, deliberate call.
    expect(h.requests).toEqual([]);
    expect(side.revealed).toBe(false);

    expect(side.prompt()).toBe(true);
    await h.audio.idle();

    // It played…
    expect(h.media().plays).toBe(1);
    expect(h.requests).toHaveLength(1);
    expect(h.outcomes.map((o) => o.reason)).toEqual(["prompt"]);
    // …and the answer is STILL HIDDEN. On an identify card the cloze holds the
    // kanji he is meant to name, so unmasking here would print the answer beside
    // the question. `play()` does unmask, deliberately; this must not.
    expect(side.revealed).toBe(false);
    expect(h.result.clozes.every((cloze) => !cloze.revealed)).toBe(true);
    expect(h.events.map((e) => e.kind)).toEqual(["enter", "prompt"]);
    expect(h.events.at(-1)?.clozes).toBe(0);
    h.loop.dispose();
  });

  it("and play() on the same side DOES unmask — the contrast, asserted", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    const side = h.loop.enter(0)!;
    const mount = h.result.media.find((m) => m.kind === "audio")!;
    expect(side.play(mount)).toBe(true);
    await h.audio.idle();
    expect(side.revealed).toBe(true);
    h.loop.dispose();
  });

  it("returns false where there is no question to ask", () => {
    // A side with no clip. `prompt()` reporting false is what lets a screen tell
    // "asked" from "nothing to ask" — 1 of the 392 言葉 cards has an empty head
    // word and reaches exactly this.
    const h = harness("{{あらかた}}");
    const side = h.loop.enter(0)!;
    expect(side.prompt()).toBe(false);
    expect(h.events.map((e) => e.kind)).toEqual(["enter"]);
    expect(side.revealed).toBe(false);
    h.loop.dispose();
  });

  it("reveal({silent}) unmasks and sounds NOTHING", async () => {
    // Added for the shell, and it is the SAFE direction — less audio, never more.
    // A screen that shows the whole card after the answer unmasks several sides at
    // once, and `audioController.play()` defers extras only WITHIN one call: three
    // reveals start three clips. Measured on 単語, whose word clip and
    // example-sentence clip both fired over the top of each other.
    const h = harness(SHADOWING_SIDE, { store: STORE });
    const side = h.loop.enter(0)!;
    expect(side.reveal("caller", { silent: true })).toBe(true);
    await h.audio.idle();
    // Unmasked…
    expect(side.revealed).toBe(true);
    expect(h.result.clozes.every((cloze) => cloze.revealed)).toBe(true);
    // …and silent, all the way down: no resolve, no object URL, no play().
    expect(h.requests).toEqual([]);
    expect(h.urls.minted).toEqual([]);
    expect(h.media().plays).toBe(0);
    expect(h.events.at(-1)?.audio).toBe(0);
    h.loop.dispose();
  });

  it("and the same side WITHOUT silent does sound — the pairing", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    const side = h.loop.enter(0)!;
    expect(side.reveal("caller")).toBe(true);
    await h.audio.idle();
    expect(h.media().plays).toBe(1);
    h.loop.dispose();
  });

  it("a reveal AFTER a prompt still works, and is what compares", async () => {
    // The mode-2 loop end to end: hear it, name it, then reveal to check.
    const h = harness(SHADOWING_SIDE, { store: STORE });
    const side = h.loop.enter(0)!;
    side.prompt();
    await h.audio.idle();
    expect(side.reveal("caller")).toBe(true);
    await h.audio.idle();
    expect(side.revealed).toBe(true);
    // Two sounds: the question and the comparison. The second reuses the lease
    // rather than minting a second object URL.
    expect(h.media().plays).toBe(2);
    expect(h.urls.minted).toHaveLength(1);
    h.loop.dispose();
  });
});

// ─── 4. clozes on a side reveal TOGETHER ─────────────────────────────────────

describe("cloze grouping", () => {
  /**
   * 単語 side 2 in the shape the template writes it: the reading as text and the
   * reading as ruby, both clozed. They are the same fact, so revealing one and
   * masking the other would print the answer and hide it at once.
   */
  const TWO_CLOZES = "{{あらかた}}\n{{<furigana>粗方</furigana>}}";

  it("reveals every cloze on the side from one tap, and only that side", () => {
    const h = harness(`${TWO_CLOZES}\n---\n{{意味}}`);
    expect(h.result.clozes).toHaveLength(3);
    expect(h.loop.sides.map((side) => side.clozes.length)).toEqual([2, 1]);

    h.cloze(0).dispatch("click");

    expect(h.result.clozes.map((mount) => mount.revealed)).toEqual([true, true, false]);
    expect(h.loop.sides.map((side) => side.revealed)).toEqual([true, false]);
    // One reveal event, not two: the group is one act.
    expect(h.events.filter((event) => event.kind === "reveal")).toHaveLength(1);
    expect(h.events.find((event) => event.kind === "reveal")?.clozes).toBe(2);
  });

  it("groups a cloze revealed by ANY route, including result.revealAll()", () => {
    // The grouping is enforced on `ClozeMount.onReveal`, not on the tap, so there
    // is no way to reveal half a side — `revealOne` does not exist.
    const direct = harness(TWO_CLOZES);
    direct.result.clozes[1]?.reveal();
    expect(direct.loop.sides[0]?.revealed).toBe(true);
    expect(direct.result.clozes.map((mount) => mount.revealed)).toEqual([true, true]);

    const all = harness(`${TWO_CLOZES}\n---\n{{意味}}`);
    all.result.revealAll();
    expect(all.loop.sides.map((side) => side.revealed)).toEqual([true, true]);
    expect(all.events.filter((event) => event.kind === "reveal")).toHaveLength(2);
  });

  it("is keyboard reachable and announces itself", () => {
    const h = harness("{{答え}}");
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.role)).toBe("button");
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.tabIndex)).toBe("0");
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.expanded)).toBe("false");

    let prevented = 0;
    h.cloze(0).dispatch("keydown", { key: "x", preventDefault: () => (prevented += 1) });
    expect(h.loop.sides[0]?.revealed).toBe(false);
    h.cloze(0).dispatch("keydown", { key: " ", preventDefault: () => (prevented += 1) });
    expect(h.loop.sides[0]?.revealed).toBe(true);
    // Space must not also scroll the card out from under the answer.
    expect(prevented).toBe(1);
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.expanded)).toBe("true");
  });

  it("re-masks on conceal and pauses the clip, then replays on the next reveal", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    h.loop.side(0)?.conceal();
    expect(h.result.clozes[0]?.revealed).toBe(false);
    expect(h.media().paused).toBe(true);
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.expanded)).toBe("false");
    // Concealing does not revoke: the clip is still attached and re-revealing
    // restarts it without a second object URL.
    expect(h.scope.live).toBe(1);

    h.loop.side(0)?.reveal();
    await h.audio.idle();
    expect(h.media().plays).toBe(2);
    expect(h.urls.minted).toHaveLength(1);
    expect(h.audio.stats.requested).toBe(1);
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["playing", "replayed"]);
  });

  it("leaves a render with no clozes and no audio at trigger `none`", () => {
    const h = harness("路線\nroute");
    expect(h.loop.sides.map((side) => side.trigger)).toEqual(["none"]);
    h.loop.enter(0);
    expect(h.loop.side(0)?.reveal()).toBe(true);
    expect(h.requests).toEqual([]);
  });
});

// ─── 5. a side with audio and no cloze ───────────────────────────────────────

describe("a side with audio but no cloze", () => {
  /**
   * 91 of 91 audio-bearing sides in the corpus today, and still the majority once
   * stage 9 fills the typed `speech` fields (§10). Nothing is hidden, so there is
   * no reveal to hang playback on: the trigger is a deliberate gesture.
   */
  const AUDIO_ALONE = `例文を読んでください。\n${AUDIO_ATTACHMENT}`;

  it("classifies the side and still plays nothing on entry", () => {
    const h = harness(AUDIO_ALONE, { store: STORE });
    expect(h.loop.side(0)?.trigger).toBe("audio");
    expect(h.loop.side(0)?.clozes).toEqual([]);
    h.loop.enter(0);
    expect(h.requests).toEqual([]);
    expect(h.media().plays).toBe(0);
  });

  it("plays on the review UI's own reveal call", async () => {
    const h = harness(AUDIO_ALONE, { store: STORE });
    h.loop.enter(0);
    expect(h.loop.side(0)?.reveal("caller")).toBe(true);
    await h.audio.idle();
    expect(h.media().plays).toBe(1);
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["playing"]);
  });

  it("plays on the element's own play affordance, exactly once, then unbinds", async () => {
    // The renderer leaves media elements with NO `src`, so the native controls are
    // dead until something attaches bytes. Arming is what makes the first tap
    // work; after it, the element holds a real `src` and its controls work alone.
    const h = harness(AUDIO_ALONE, { store: STORE });
    h.loop.enter(0);
    expect(h.media().count("click")).toBe(1);
    expect(h.media().count("play")).toBe(1);

    h.media().dispatch("click");
    await h.audio.idle();

    expect(h.loop.side(0)?.revealed).toBe(true);
    expect(h.events.find((event) => event.kind === "reveal")?.cause).toBe("gesture");
    expect(h.media().plays).toBe(1);
    // One shot: our own `element.play()` fires a `play` event, and re-entering
    // would ask for the clip a second time.
    expect(h.media().count("click")).toBe(0);
    expect(h.media().count("play")).toBe(0);
    expect(h.audio.stats.requested).toBe(1);
    expect(h.urls.minted).toHaveLength(1);
  });

  it("stops interpreting gestures once the element has a source", async () => {
    // THE BUG THIS GATE EXISTS FOR. `audio.play()` assigns a source and calls
    // `element.play()`; the platform then fires a `play` event, and a handler that
    // read that as a gesture asked for the clip a second time. After the attach
    // the element owns its own interactions — a tap on the seek bar is not a
    // request to restart the clip — so the listeners come off.
    const h = harness(AUDIO_ALONE, { store: STORE });
    h.loop.side(0)?.reveal("caller");
    await h.audio.idle();
    expect(h.media().plays).toBe(1);
    expect(h.media().count("play")).toBe(0);
    expect(h.media().count("click")).toBe(0);

    h.media().dispatch("click");
    expect(h.media().plays).toBe(1);
    expect(h.audio.stats.requested).toBe(1);
  });

  it("stays tappable when the clip was missing, because nothing got attached", async () => {
    // A one-shot latch would have burned the retry here, and a clip stage 9 has
    // not generated yet is exactly the case that matters.
    const h = harness(AUDIO_ALONE);
    h.media().dispatch("click");
    await h.audio.idle();
    expect(h.audio.stats.missing).toBe(1);
    expect(h.media().hasAttribute("src")).toBe(false);
    expect(h.media().count("click")).toBe(1);

    h.media().dispatch("click");
    await h.audio.idle();
    expect(h.audio.stats.missing).toBe(2);
  });

  it("arms nothing when asked not to, and then only the caller can start it", () => {
    const h = harness(AUDIO_ALONE, { store: STORE, armMedia: false });
    expect(h.media().count("click")).toBe(0);
    h.media().dispatch("click");
    expect(h.loop.side(0)?.revealed).toBe(false);
    expect(h.requests).toEqual([]);
  });

  it("starts the FIRST clip only and defers the rest of the side", async () => {
    const store = new Map<string, BlobPayload>([
      ["attachment:a.mp3", payloadFor("a")],
      ["attachment:b.mp3", payloadFor("b")],
    ]);
    const h = harness("![a](a.mp3)\n![b](b.mp3)", { store });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    // Two clips at once is noise, and sequencing needs `ended`, which never fires
    // for a clip the listener skipped.
    //
    // `deferred` lands FIRST because it is a decision, not an observation: the
    // second clip is deferred synchronously, while `playing` waits for the
    // platform's `play()` promise to settle. The SOUND still starts synchronously
    // — `plays` below is what proves that.
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["deferred", "playing"]);
    expect(h.media(0).plays).toBe(1);
    expect(h.media(1).plays).toBe(0);
    expect(h.urls.minted).toHaveLength(1);
    // The deferred one is still one tap away, because it is still armed.
    h.media(1).dispatch("click");
    await h.audio.idle();
    expect(h.media(1).plays).toBe(1);
    expect(h.urls.minted).toHaveLength(2);
  });
});

// ─── 6. replaying deliberately ───────────────────────────────────────────────

describe("replaying deliberately", () => {
  it("restarts from the top and mints no second object URL", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    h.media().currentTime = 3.2;

    h.loop.side(0)?.replay();
    await h.audio.idle();

    expect(h.media().plays).toBe(2);
    expect(h.media().currentTime).toBe(0);
    expect(h.urls.minted).toHaveLength(1);
    expect(h.scope.stats.claimed).toBe(1);
    expect(h.scope.stats.reused).toBe(0);
    expect(h.audio.stats.requested).toBe(1);
    expect(h.audio.stats.replayed).toBe(1);
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["playing", "replayed"]);
    expect(h.events.map((event) => event.kind)).toEqual(["reveal", "replay"]);
  });

  it("treats a replay asked for before the reveal AS the reveal", async () => {
    // Otherwise there would be a second route to sound that left the side's
    // clozes masked and its bookkeeping untouched.
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.side(0)?.replay();
    await h.audio.idle();
    expect(h.loop.side(0)?.revealed).toBe(true);
    expect(h.result.clozes[0]?.revealed).toBe(true);
    expect(h.events.map((event) => event.kind)).toEqual(["reveal"]);
    expect(h.media().plays).toBe(1);
  });

  it("re-claims rather than reusing a revoked lease", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    // Somebody released the URL out from under the element — the cap does exactly
    // this. `attachMedia` throws on a revoked lease, so the controller must claim
    // again rather than hand a dead URL to an element.
    h.scope.release(CLIP.hash);
    await h.audio.replay(h.result.media[0] as MediaMount<MemoryElement>);
    expect(h.urls.minted).toHaveLength(2);
    expect(h.media().src).toBe(h.urls.minted[1]);
    expect(h.audio.stats.requested).toBe(2);
  });
});

// ─── 7. a card whose audio blob is missing ───────────────────────────────────

describe("a missing blob", () => {
  it("reveals anyway, plays nothing, and mints nothing", async () => {
    // A clip that is not in the store must never stop him seeing the reading he
    // just produced. This is the case that decides whether the reveal depends on
    // the audio or the audio on the reveal.
    const h = harness(SHADOWING_SIDE); // empty store
    h.loop.enter(0);
    expect(h.loop.side(0)?.reveal("cloze")).toBe(true);
    await h.audio.idle();

    expect(h.result.clozes[0]?.revealed).toBe(true);
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.expanded)).toBe("true");
    expect(h.audio.stats.requested).toBe(1);
    expect(h.audio.stats.missing).toBe(1);
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["missing"]);
    expect(h.outcomes[0]?.detail).toBe("attachment uVQp0iMb.mp3");
    expect(h.urls.minted).toEqual([]);
    expect(h.media().plays).toBe(0);
    expect(h.media().hasAttribute("src")).toBe(false);
    expect(h.media().getAttribute(AUDIO_DATA.state)).toBe("missing");
    // And nothing to release.
    h.loop.dispose();
    expect(h.urls.revoked).toEqual([]);
  });

  it("reports an unaddressable reference instead of asking the store", () => {
    // `![x](https://example.test/a.mp3)` is refused by the sanitiser, so there is
    // no media mount at all; a `file`-kind reference is a mount with no key.
    const h = harness("![x](audio.weird)");
    expect(h.result.media.map((mount) => mount.kind)).toEqual(["file"]);
    expect(h.audio.tracks).toEqual([]);
    h.loop.side(0)?.reveal();
    expect(h.requests).toEqual([]);
  });

  it("reports a rejected play() as blocked, not as a broken clip", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.media().rejectPlay = "NotAllowedError";
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["blocked"]);
    expect(h.media().getAttribute(AUDIO_DATA.state)).toBe("blocked");
    // The reveal still stands, and the clip is attached for a manual retry.
    expect(h.result.clozes[0]?.revealed).toBe(true);
    expect(h.media().src).toBe(h.urls.minted[0]);
  });

  it("survives a resolver that throws", async () => {
    const result = renderSides(parseContent(SHADOWING_SIDE), { document: liveDocument() });
    const audio = audioController(result, {
      scope: new BlobUrlScope(urlRecorder().options),
      resolve: () => {
        throw new Error("worker is gone");
      },
    });
    const loop = shadowingLoop(result, { audio });
    expect(loop.side(0)?.reveal()).toBe(true);
    await audio.idle();
    expect(audio.stats.failed).toBe(1);
    expect(result.clozes[0]?.revealed).toBe(true);
  });
});

// ─── 8. addressing: the corpus's audio is 94/95 GENERATED ────────────────────

describe("addressing", () => {
  it("addresses an attachment by ref_key and a generator slot by its request", async () => {
    const attachment = harness(AUDIO_ATTACHMENT);
    expect(attachment.audio.tracks.map((track) => track.address)).toEqual([
      { origin: "attachment", key: "uVQp0iMb.mp3" },
    ]);

    // 94 of the corpus's 95 audio elements are this shape: an inline <speech>
    // whose bytes are addressed by generation identity, not by a filename. A
    // controller that only understood attachments would find one clip in 7,716
    // cards.
    const generated = harness('<speech lang="jp">言葉</speech>');
    // `audioAddress` is the same answer computed directly from the render, which
    // is what stage 9 will call when it wants to know what to generate.
    expect(generated.audio.tracks[0]?.address).toEqual(
      audioAddress(generated.result, generated.result.media[0] as MediaMount<MemoryElement>),
    );
    const address = generated.audio.tracks[0]?.address;
    expect(address?.origin).toBe("generator");
    if (address?.origin !== "generator") throw new Error("unreachable");
    expect(address.request.kind).toBe("speech");
    expect(address.request.text).toBe("言葉");
    // Normalised to BCP-47 by the template layer; never Mochi's inline `jp`.
    expect(address.request.lang).toBe("ja-JP");

    const payload = payloadFor("tts");
    const store = new Map([[`speech:ja-JP:言葉`, payload]]);
    const h = harness('<speech lang="jp">言葉</speech>', { store });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    expect(h.media().plays).toBe(1);
    expect(h.outcomes[0]?.hash).toBe(payload.hash);
  });

  it("shares one object URL when the same clip appears twice on a card", async () => {
    const h = harness(`![a](same.mp3)\n---\n![b](same.mp3)`, {
      store: new Map([["attachment:same.mp3", payloadFor("same")]]),
    });
    h.loop.side(0)?.reveal();
    h.loop.side(1)?.reveal();
    await h.audio.idle();
    expect(h.media(0).plays).toBe(1);
    expect(h.media(1).plays).toBe(1);
    // One address, one URL, one copy of the bytes — and one revocation.
    expect(h.urls.minted).toHaveLength(1);
    expect(h.scope.stats.reused).toBe(1);
    h.loop.dispose();
    expect(h.urls.revoked).toHaveLength(1);
    expect(h.media(0).hasAttribute("src")).toBe(false);
    expect(h.media(1).hasAttribute("src")).toBe(false);
  });

  it("does nothing at all without an audio port", () => {
    const result = renderSides(parseContent(SHADOWING_SIDE), { document: liveDocument() });
    const loop = shadowingLoop(result);
    loop.enter(0);
    expect(loop.side(0)?.reveal()).toBe(true);
    expect(result.clozes[0]?.revealed).toBe(true);
    expect((result.media[0]?.element as FakeMedia).plays).toBe(0);
  });

  it("changes nothing in a serialised render when binding is off", () => {
    // The precompute path (`serialise`) must come out byte-identical, so `role`,
    // `tabindex` and `aria-expanded` are only added where something can be tapped.
    const plain = renderSides(parseContent("{{答え}}"), { document: memoryDocument() });
    const before = serialise(plain.root);
    shadowingLoop(plain, { bindClozes: false, armMedia: false });
    expect(serialise(plain.root)).toBe(before);
  });
});

// ─── 9. neither module can express autoplay ───────────────────────────────────

const SRC_RENDER = resolve(import.meta.dirname, "..", "src", "render");

/** Crude but sufficient for two files we own: drop block and line comments. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("source discipline", () => {
  it("never mentions autoplay and never assigns a src", () => {
    for (const name of ["reveal.ts", "audio.ts"]) {
      const code = stripComments(readFileSync(resolve(SRC_RENDER, name), "utf8"));
      expect(code, `${name} mentions autoplay`).not.toContain("autoplay");
      expect(code, `${name} sets a src attribute`).not.toMatch(/setAttribute\(\s*["']src["']/);
      expect(code, `${name} uses innerHTML`).not.toContain("innerHTML");
      // Bytes reach an element only through `attachMedia`, which owns the
      // clear-then-revoke ordering. A second path would be a second leak.
      expect(code, `${name} assigns element.src`).not.toMatch(/\.src\s*=[^=]/);
    }
  });

  it("starts playback from exactly three NAMED places, and none of them is `enter`", () => {
    const reveal = stripComments(readFileSync(resolve(SRC_RENDER, "reveal.ts"), "utf8"));
    // `reveal.ts` may only ask the port, and only with a reason it names at the
    // call site. Counting the calls alone was the old assertion and it was too
    // weak the moment decision 29 added a third: a fourth could have arrived as
    // `audio.play(media, reason)` with `reason` computed anywhere. So the reasons
    // are read out of the source, and the SET is what is pinned.
    const asks = [...reveal.matchAll(/audio(?:\?)?\.play\(\s*\[?[^,)]*\]?\s*,\s*(.*?)\)/g)];
    expect(asks).toHaveLength(3);
    const reasons = asks.map((match) => (match[1] ?? "").trim());
    // `play()`'s is a conditional over two literals; the other two are literals.
    expect(reasons).toContain('"reveal"');
    expect(reasons).toContain('"prompt"');
    expect(reasons.some((reason) => reason.includes('"replay"'))).toBe(true);
    // Every reason is spelled out here. A computed one — a variable, a lookup —
    // means the caller chose it, which is the one thing this file must not allow.
    for (const reason of reasons) {
      expect(reason, `computed play reason: ${reason}`).toMatch(/^["'?:\s\w]+$/);
    }

    // `enter()` is the method that must stay empty of it, and decision 29 did not
    // touch that. `prompt()` exists precisely so `enter()` did not have to change.
    const enter = /enter\(\): void \{([\s\S]*?)\n      \},/.exec(reveal)?.[1] ?? "MISSING";
    expect(enter).not.toBe("MISSING");
    expect(enter).not.toContain("play");
    expect(enter).not.toContain("prompt");
    // It may MENTION audio — it logs `audio: 0` so the trail proves the zero — but
    // it may not reach the port.
    expect(enter).not.toMatch(/audio\s*[?.[]/);

    // And the loop still does not know what decides the mode. The moment
    // `Reading` appears here, the invariant stops being checkable by reading one
    // method — which is the whole reason the policy sits in `src/review`.
    expect(reveal, "reveal.ts must not know about Reading").not.toMatch(/\bReading\b/);

    // `audio.ts` touches the element's own play() in one helper, `start()`.
    const audio = stripComments(readFileSync(resolve(SRC_RENDER, "audio.ts"), "utf8"));
    expect([...audio.matchAll(/element\.play\(/g)]).toHaveLength(1);
  });
});

// ─── 10. the real corpus ─────────────────────────────────────────────────────

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const EXPORT_DIRS = EXPORT_NAMES.map((name) => resolve(import.meta.dirname, "..", "exports", name));
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

interface CorpusCard {
  readonly id: string;
  readonly templateId: string;
  readonly content: string;
  readonly values: Record<string, string>;
}

/**
 * Memoised, and that is not premature: `loadExport` decodes a 21 MB transit
 * document, and this file reads the corpus from three tests. FIVE test files now
 * sweep the corpus in parallel workers — template, render, japanese-render,
 * reveal, search — under `vitest.config.ts`'s `testTimeout: 120_000` and
 * `maxWorkers: 6`, both of which are there because that parallelism broke the
 * defaults. Every avoidable second here is one another file does not have to
 * survive.
 */
let corpus: { cards: CorpusCard[]; templates: Map<string, TemplateInput> } | null = null;

function readCorpus(): { cards: CorpusCard[]; templates: Map<string, TemplateInput> } {
  return (corpus ??= loadCorpus());
}

function loadCorpus(): { cards: CorpusCard[]; templates: Map<string, TemplateInput> } {
  const cards: CorpusCard[] = [];
  const templates = new Map<string, TemplateInput>();
  for (const dir of EXPORT_DIRS) {
    const root = loadExport(dir);
    for (const raw of asRecords(root["templates"])) {
      templates.set(asText(raw["id"]), {
        id: asText(raw["id"]),
        content: asText(raw["content"]),
        fields: Object.entries(asRecord(raw["fields"])).flatMap(([key, field]) =>
          isRecord(field)
            ? [
                {
                  id: asText(field["id"]) || key,
                  name: asText(field["name"]),
                  ...(asText(field["type"]) === "" ? {} : { type: asText(field["type"]) }),
                },
              ]
            : [],
        ),
        reversePermutation: null,
      });
    }
    for (const { card } of walkCards(root)) {
      const values: Record<string, string> = {};
      for (const [fieldId, field] of Object.entries(asRecord(card["fields"]))) {
        values[fieldId] = fieldValueText(isRecord(field) ? (field as MochiRecord)["value"] : field);
      }
      cards.push({
        id: asText(card["id"]),
        templateId: asText(card["template-id"]),
        content: asText(card["content"]),
        values,
      });
    }
  }
  return { cards, templates };
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Bucket every side of every card by what is on it.
 *
 * `fillSpeechFields` is the PROJECTION: every audio field in every template is a
 * typed `speech` field whose stored value is empty on all 7,716 cards (Mochi kept
 * the 624.6 MiB in `component-cache`, addressed by generation identity, not in
 * `fields`). Filling them with an attachment reference is what the corpus looks
 * like once stage 9 lands, and it is the only way to measure the distribution the
 * trigger has to serve in the long run rather than guessing at it.
 */
function census(
  cards: readonly CorpusCard[],
  templates: ReadonlyMap<string, TemplateInput>,
  fillSpeechFields: boolean,
): {
  readonly sides: Map<string, number>;
  readonly perAudioSide: Map<number, number>;
  readonly triggers: Map<string, number>;
  readonly where: Map<string, number>;
  readonly origins: Map<string, number>;
  readonly cardsWithAudio: number;
  readonly totalSides: number;
} {
  const sides = new Map<string, number>();
  const perAudioSide = new Map<number, number>();
  const triggers = new Map<string, number>();
  const where = new Map<string, number>();
  const origins = new Map<string, number>();
  let cardsWithAudio = 0;
  let totalSides = 0;
  for (const card of cards) {
    const template = templates.get(card.templateId) ?? null;
    const values = { ...card.values };
    if (fillSpeechFields && template !== null) {
      for (const field of template.fields ?? []) {
        if (field.type === "speech") values[field.id] = "![tts](generated.mp3)";
      }
    }
    const resolved = resolveCard({ id: card.id, content: card.content, values }, template);
    const result = renderResolvedCard(resolved, { document: memoryDocument() });
    const loop = shadowingLoop(result, { bindClozes: false, armMedia: false });
    let hasAudio = false;
    for (const side of loop.sides) {
      totalSides += 1;
      bump(triggers, side.trigger);
      const key =
        side.audio.length === 0
          ? side.clozes.length === 0
            ? "neither"
            : "cloze-only"
          : side.clozes.length === 0
            ? "audio-alone"
            : "audio+cloze";
      bump(sides, key);
      if (side.audio.length === 0) continue;
      hasAudio = true;
      perAudioSide.set(side.audio.length, (perAudioSide.get(side.audio.length) ?? 0) + 1);
      bump(where, `${card.templateId || "(template-less)"} side ${side.index}: ${key}`);
      for (const mount of side.audio) bump(origins, mount.origin);
    }
    if (hasAudio) cardsWithAudio += 1;
  }
  return { sides, perAudioSide, triggers, where, origins, cardsWithAudio, totalSides };
}

function object<K extends string | number>(counts: Map<K, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

describe.skipIf(!HAVE_EXPORTS)("the real corpus (exports/)", () => {
  it("censuses cloze-and-audio co-occurrence, which is what decides the trigger", () => {
    const { cards, templates } = readCorpus();
    expect(cards).toHaveLength(7716);
    const now = census(cards, templates, false);
    const later = census(cards, templates, true);
    console.log(
      [
        "── TODAY, as the export stands ────────────────────────────────",
        `cards ${cards.length} · sides ${now.totalSides} · cards with audio ${now.cardsWithAudio}`,
        `per side        ${JSON.stringify(object(now.sides))}`,
        `trigger         ${JSON.stringify(object(now.triggers))}`,
        `audio origin    ${JSON.stringify(object(now.origins))}`,
        `clips per audio side ${JSON.stringify(object(now.perAudioSide))}`,
        `audio sides     ${JSON.stringify(object(now.where), null, 1)}`,
        "── PROJECTED, with the typed `speech` fields filled (stage 9) ──",
        `cards with audio ${later.cardsWithAudio}`,
        `per side        ${JSON.stringify(object(later.sides))}`,
        `trigger         ${JSON.stringify(object(later.triggers))}`,
        `audio origin    ${JSON.stringify(object(later.origins))}`,
        `clips per audio side ${JSON.stringify(object(later.perAudioSide))}`,
        `audio sides     ${JSON.stringify(object(later.where), null, 1)}`,
      ].join("\n"),
    );

    // THE FINDING THAT DECIDED THE FALLBACK TRIGGER. Not one audio-bearing side
    // in the corpus has a cloze on it, so "audio with no cloze" is not an edge
    // case to fall back to — it is the only case the corpus exercises, and it
    // stays the majority even once the typed `speech` fields are generated.
    expect(now.sides.get("audio+cloze") ?? 0).toBe(0);
    expect(now.sides.get("audio-alone")).toBe(91);
    expect(now.cardsWithAudio).toBe(86);
    // 94 generator slots and exactly one authored attachment.
    expect(object(now.origins)).toEqual({ attachment: 1, generator: 94 });
    expect(later.sides.get("audio+cloze") ?? 0).toBeGreaterThan(0);
    expect(later.sides.get("audio-alone") ?? 0).toBeGreaterThan(
      later.sides.get("audio+cloze") ?? 0,
    );
  }, 120_000);

  it(
    "enters every side of every card in silence, then reveals it and hears exactly one clip",
    async () => {
      // THE STRONGEST FORM OF THE HARD RULE, and the two halves have to be one
      // sweep to be worth anything: the same 7,716 cards and 27,352 sides are
      // ENTERED first, with a resolver and a URL minter that record a violation if
      // anything so much as asks for bytes, and only then REVEALED — at which
      // point exactly one clip per audio side plays and every object URL comes
      // back. Split across two tests, each half could have passed for the wrong
      // reason (silence because nothing was wired; playback because entry had
      // already attached it).
      const { cards, templates } = readCorpus();
      const violations: string[] = [];
      const urls = urlRecorder();
      const outcomes = new Map<string, number>();
      let entered = 0;
      let armed = 0;
      let revealed = 0;
      let played = 0;
      let peakLive = 0;
      let entering = true;
      for (const card of cards) {
        const resolved = resolveCard(
          { id: card.id, content: card.content, values: card.values },
          templates.get(card.templateId) ?? null,
        );
        const result = renderResolvedCard(resolved, { document: liveDocument() });
        const scope = new BlobUrlScope({
          createObjectURL: (blob) => {
            if (entering) violations.push(`${card.id}: object URL minted on entry`);
            return urls.options.createObjectURL(blob);
          },
          revokeObjectURL: urls.options.revokeObjectURL,
        });
        // The REAL controller is the port, so this is not a test against a stub.
        const audio = audioController(result, {
          scope,
          resolve: (address) => {
            if (entering) violations.push(`${card.id}: bytes requested on entry`);
            return payloadFor(addressKey(address));
          },
          onOutcome: (outcome) => bump(outcomes, outcome.kind),
        });
        const loop = shadowingLoop(result, { audio });

        // ── entering ──
        for (const side of loop.sides) {
          loop.enter(side.position);
          entered += 1;
          for (const mount of side.audio) {
            armed += 1;
            const element = mount.element as FakeMedia;
            if (element.plays > 0) violations.push(`${card.id}: element played on entry`);
            if (element.hasAttribute("src")) violations.push(`${card.id}: src set on entry`);
          }
        }
        const idle = audio.stats;
        if (idle.requested + idle.playing + idle.replayed + idle.attached > 0) {
          violations.push(`${card.id}: ${JSON.stringify(idle)}`);
        }

        // ── revealing ──
        entering = false;
        for (const side of loop.sides) {
          if (side.audio.length === 0) continue;
          side.reveal("caller");
          revealed += 1;
        }
        await audio.idle();
        played += result.media.filter(
          (mount) => mount.kind === "audio" && (mount.element as FakeMedia).plays > 0,
        ).length;
        peakLive = Math.max(peakLive, scope.live);
        loop.dispose();
        expect(scope.live).toBe(0);
        entering = true;
      }
      console.log(
        [
          `entered ${entered} sides across ${cards.length} cards · armed ${armed} media elements`,
          `revealed ${revealed} audio sides · clips played ${played} · object URLs ` +
            `${urls.minted.length} minted / ${urls.revoked.length} revoked · peak live per card ${peakLive}`,
          `outcomes ${JSON.stringify(object(outcomes))}`,
        ].join("\n"),
      );
      expect(violations).toEqual([]);
      expect(entered).toBe(27352);
      expect(armed).toBe(95);
      expect(revealed).toBe(91);
      // One clip per audio side: 4 second clips on 4 sides were deferred, not
      // started, because two at once is noise.
      expect(played).toBe(91);
      expect(outcomes.get("deferred")).toBe(4);
      expect(urls.minted).toHaveLength(91);
      expect(urls.revoked).toHaveLength(91);
      expect(new Set(urls.revoked)).toEqual(new Set(urls.minted));
    },
    120_000,
  );
});
