/**
 * Stage 4 — the only code in Hashigo that starts a sound, and the reasons it is
 * allowed to.
 *
 *     import { audioController } from "hashigo/render/audio";   // direct, not the barrel
 *
 *     const audio = audioController(result, { resolve });
 *     const loop = shadowingLoop(result, { audio });
 *     …
 *     loop.dispose();          // → audio.release() → every object URL revoked
 *
 * ── WHY THIS FILE IS SEPARATE FROM THE RENDERER ─────────────────────────────
 *
 * `src/render/{index,dom,nodes,sanitise}.ts` provably cannot make noise:
 * `test/render.test.ts` greps all four for `autoplay` and `.play(` and censuses
 * every media element the corpus produces for `autoplay`, `loop` and `src`. That
 * property is worth keeping, so playback lives here instead — in a file whose
 * whole surface is two entry points, `play(…, "reveal")` and `replay(…)`, both of
 * which are reached only from `./reveal.ts` and only after Zach has produced an
 * answer.
 *
 * THE RULE, IN ONE SENTENCE: the audio is 高低アクセント shadowing material. He
 * looks at the kanji, recalls whether each mora is high or low, says it aloud,
 * and only then hears the clip. A clip that plays when a side APPEARS gives away
 * the contour before he has produced it and silently destroys the exercise. So
 * nothing here is called on side entry — `enterSide()` in `./reveal.ts` is
 * deliberately the one method that does nothing at all.
 *
 * ── WHAT THE CORPUS SAYS ABOUT WHERE AUDIO IS ───────────────────────────────
 *
 * Measured over all 7,716 cards (`test/reveal.test.ts`, "the real corpus"):
 *
 *   * 95 `<audio>` elements exist in the resolved corpus. **94 are generator
 *     slots** from inline `<speech>` tags and exactly **one** is an authored
 *     attachment (`![…](uVQp0iMb.mp3)` on card `CtDsQetR`). The whole corpus
 *     contains 7 attachment references in total — 1 mp3 and 6 images.
 *   * So 624.6 MiB of audio is NOT referenced from card text. It is Mochi's
 *     `component-cache`, addressed by generation identity, and every field the
 *     templates use for audio (`単語/Speech`, `単語/Audio`, `言葉/Speech`,
 *     `言葉/Audio`, `基本情報/Audio`, `数字/Voice`, `New Vocab/Pronunciation`,
 *     `Polysemy/Example-sound`, `文法/Output`) is a typed `speech` field whose
 *     stored value is empty on every single card.
 *
 * That is why `AudioAddress` has two shapes and not one. An attachment is
 * addressed by `blob_refs.ref_key`; a generator slot is addressed by the
 * `GenerationDescriptor` the renderer recorded, which `generationIdentity()` in
 * `src/import/blobs.ts` turns into the content address of the cached clip. A
 * controller that only understood attachments would find one clip in the corpus.
 *
 * ── OBJECT URLS ARE THE LEAK THIS FILE IS SHAPED TO PREVENT ─────────────────
 *
 * `src/blobs/url.ts` owns the lifecycle and states the rules; this file obeys
 * them rather than reimplementing them.
 *
 *   * ONE `BlobUrlScope` PER CARD PRESENTATION, and this controller is per card
 *     presentation, so it makes its own unless handed one.
 *   * THE SCOPE REVOKES, NOT THE ELEMENT. Every `attachMedia` here passes
 *     `{ revoke: false }` — two elements can share one lease (the same clip twice
 *     on a card costs one URL), and an element that revoked its own `src` would
 *     revoke it out from under the other. `release()` detaches every element
 *     first and revokes afterwards, which is `url.ts`'s rule 3 applied to a whole
 *     card at once.
 *   * A REVOKED LEASE IS NEVER REUSED. `attachMedia` throws on one; `replay()`
 *     re-claims instead, which is idempotent per address and mints no second URL.
 *
 * Zach reviews ~69 cards a day on a phone at 60,551 B per clip average, so a
 * controller that leaked one URL per clip played would pin ~4 MB a day for as
 * long as the tab lived. `test/reveal.test.ts` runs a 40-card session and
 * asserts `live === 0` and `revoked === claimed` at the end.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * No fetching, no hashing, no database. `resolve` is injected: in the browser it
 * is a worker round-trip to the blob database (hence the `PromiseLike` branch),
 * under Node it is a synchronous read, and in tests it is a Map. This module
 * never learns where bytes live, which is the same rule the rest of the project
 * keeps — no location in any addressable column.
 */

import { BlobUrlScope, attachMedia, type BlobPayload, type BlobUrlLease } from "../blobs/url.js";
import type {
  GenerationDescriptor,
  MediaMount,
  RenderElement,
  RenderResult,
} from "./index.js";

// ─── addressing ──────────────────────────────────────────────────────────────

/**
 * Where the bytes for one media element are filed.
 *
 * Two shapes because the corpus has two, and they are addressed differently:
 * an attachment by `blob_refs.ref_key`, a generator slot by the generation
 * identity of its request. See the header for the counts.
 */
export type AudioAddress =
  | {
      readonly origin: "attachment";
      /** `blob_refs.ref_key` — the bare filename, `@media/` already stripped. */
      readonly key: string;
    }
  | {
      readonly origin: "generator";
      /** Pass straight to `generationIdentity()`; do not pre-normalise. */
      readonly request: GenerationDescriptor;
    };

/**
 * Bytes for an address, or null when the store has none.
 *
 * May return a promise: in the browser the blob database lives in a dedicated
 * Worker, so the honest shape is asynchronous. A synchronous return is handled
 * synchronously all the way to `play()`, which matters — a play that happens in
 * the same task as the user's gesture never meets an autoplay policy.
 */
export type AudioResolver = (
  address: AudioAddress,
) => BlobPayload | null | PromiseLike<BlobPayload | null>;

// ─── the element port ────────────────────────────────────────────────────────

/**
 * The slice of `HTMLMediaElement` this module drives.
 *
 * A port for the same reason `./dom.ts` is a port: the suite runs under Node
 * with no DOM, and this project's rule is that the thing tested is the thing that
 * ships. `test/reveal.test.ts` pins `HTMLAudioElement` against this type with a
 * type-only assignment, so widening it past what a real element provides stops
 * `npm run typecheck` rather than surprising stage 7.
 *
 * `play()` returns `unknown` on purpose: the platform returns `Promise<void>`,
 * a test double returns nothing, and both satisfy this.
 */
export interface PlayableMediaElement extends RenderElement {
  src: string;
  currentTime: number;
  readonly paused: boolean;
  play(): unknown;
  pause(): void;
  load(): void;
}

/** `data-` attributes this module writes. The renderer writes none of these. */
export const AUDIO_DATA = {
  /** `idle` before anything, then the outcome of the last attempt. */
  state: "data-audio-state",
} as const;

export type AudioState =
  | "idle"
  | "playing"
  | "missing"
  | "unaddressable"
  | "unplayable"
  | "blocked"
  | "failed";

// ─── outcomes ────────────────────────────────────────────────────────────────

/**
 * Why a clip was asked for. There is no fifth reason.
 *
 * Three of the four mean "he has already produced an answer". `"prompt"` is the
 * one that does not, and it exists because **decision 29 made the hard rule
 * conditional**: on the 3,177 cards where `Reading` is not true the audio IS the
 * question — he hears the word and names the kanji — so the clip fires when the
 * side appears. That is a different exercise, not a laxer one.
 *
 * It is still not "a side appeared". `enter()` cannot reach this: a caller that
 * knows the card's mode has to ask for it by name, and `src/review` is the only
 * thing in the repo that does. See `reviewModeFor` there.
 */
export type PlayReason = "reveal" | "replay" | "gesture" | "prompt";

export type AudioOutcomeKind =
  /** Attached and playing. */
  | "playing"
  /** Already attached; restarted from the top. No second object URL. */
  | "replayed"
  /**
   * Addressable, but the store has no such blob. The element is left exactly as
   * the renderer made it — no `src` — and the REVEAL IS NOT AFFECTED. A missing
   * clip must never stop him seeing the reading he just produced.
   */
  | "missing"
  /** No address: an absolute-URL/path reference, or a generator with no request. */
  | "unaddressable"
  /** The element is not a media element (a memory render, or an unknown extension). */
  | "unplayable"
  /** `play()` rejected — an autoplay policy, or no user activation yet. */
  | "blocked"
  /** `play()` threw, or the resolver did. */
  | "failed"
  /**
   * A second clip on the same side, deliberately NOT started: two clips at once
   * is noise, and sequencing them needs `ended`, which never fires for a clip the
   * listener skipped. It stays armed, so it is one tap away.
   */
  | "deferred";

export interface AudioOutcome<E extends RenderElement = RenderElement> {
  readonly mount: MediaMount<E>;
  readonly kind: AudioOutcomeKind;
  readonly reason: PlayReason;
  /** The content address, once one is known. */
  readonly hash: string | null;
  readonly detail: string | null;
}

export interface AudioStats {
  /** `resolve` calls. THE number the "nothing on side entry" test watches. */
  readonly requested: number;
  readonly playing: number;
  readonly replayed: number;
  readonly deferred: number;
  readonly missing: number;
  readonly unaddressable: number;
  readonly unplayable: number;
  readonly blocked: number;
  readonly failed: number;
  /** Elements currently holding a `src`. */
  readonly attached: number;
}

// ─── the controller ──────────────────────────────────────────────────────────

export interface AudioControllerOptions<E extends RenderElement = RenderElement> {
  readonly resolve: AudioResolver;
  /**
   * The scope that owns the object URLs. Omit it and the controller makes one it
   * owns; pass one when several cards share a cache and you will release it
   * yourself. Either way `release()` revokes only what THIS controller claimed.
   */
  readonly scope?: BlobUrlScope;
  /**
   * Narrow a mount's element to something playable. The default asks the object
   * whether it has a `play` function, which is false for a `MemoryElement` and
   * true for a real `<audio>`.
   */
  readonly playable?: (mount: MediaMount<E>) => PlayableMediaElement | null;
  readonly onOutcome?: (outcome: AudioOutcome<E>) => void;
}

export interface AudioTrack<E extends RenderElement = RenderElement> {
  readonly mount: MediaMount<E>;
  /** Null when nothing addressable was recorded; see `unaddressable`. */
  readonly address: AudioAddress | null;
  readonly side: number;
}

export interface AudioController<E extends RenderElement = RenderElement> {
  /** Every audio/video mount in the render, in document order. */
  readonly tracks: readonly AudioTrack<E>[];
  readonly stats: AudioStats;
  readonly scope: BlobUrlScope;
  track(mount: MediaMount<E>): AudioTrack<E> | null;
  /**
   * Start the first addressable clip among `mounts` and defer the rest.
   *
   * THE ONLY WAY SOUND STARTS, and `./reveal.ts` calls it from exactly two
   * places: a reveal, and a deliberate replay.
   */
  play(mounts: readonly MediaMount<E>[], reason?: PlayReason): Promise<readonly AudioOutcome<E>[]>;
  /** Restart one clip from the top, reusing the live lease. Mints no second URL. */
  replay(mount: MediaMount<E>): Promise<AudioOutcome<E>>;
  /** Pause everything this controller attached. Does not revoke. */
  pauseAll(): void;
  /**
   * Resolves once every in-flight `play`/`replay` has settled.
   *
   * For tests and for a UI that wants to wait; it is never on the path of a
   * review. Note the one way it can stay pending: measured in Chromium 151,
   * `play()` on an element with no source returns a promise that neither resolves
   * nor rejects. Nothing here calls `play()` before assigning a source, so that
   * shape is unreachable through this controller — but do not build a UI that
   * blocks on `idle()`.
   */
  idle(): Promise<void>;
  /**
   * Detach every element, then revoke every URL this controller claimed — in
   * that order, because an element left holding a revoked URL fails its next
   * `load()` for reasons that do not mention revocation. Idempotent.
   */
  release(): number;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** The default `playable`: a real media element has a callable `play`. */
function asPlayable<E extends RenderElement>(mount: MediaMount<E>): PlayableMediaElement | null {
  const candidate = mount.element as unknown as { play?: unknown };
  return typeof candidate.play === "function" ? (mount.element as unknown as PlayableMediaElement) : null;
}

/**
 * Build the address for one mount.
 *
 * An attachment carries its own key. A generator slot does not — the descriptor
 * is on the `GeneratorMount` whose `media` is this mount, which is why this needs
 * the whole `RenderResult` and not just the media list.
 */
export function audioAddress<E extends RenderElement>(
  result: RenderResult<E>,
  mount: MediaMount<E>,
): AudioAddress | null {
  if (mount.origin === "attachment") {
    return mount.reference.key === null ? null : { origin: "attachment", key: mount.reference.key };
  }
  for (const generation of result.generations) {
    if (generation.media !== mount) continue;
    // `request` is null only for `pinyin`, which has no `blobs.kind` to file an
    // output under — and no audio either, so this is belt and braces.
    return generation.request === null ? null : { origin: "generator", request: generation.request };
  }
  return null;
}

interface Attachment {
  readonly lease: BlobUrlLease;
  readonly element: PlayableMediaElement;
  detach(): void;
}

/**
 * One controller per card presentation.
 *
 * It reads the render once, collects the audio and video mounts with their
 * addresses, and then does nothing until somebody reveals something.
 */
export function audioController<E extends RenderElement>(
  result: RenderResult<E>,
  options: AudioControllerOptions<E>,
): AudioController<E> {
  const playable = options.playable ?? asPlayable;
  const scope = options.scope ?? new BlobUrlScope();
  const tracks: AudioTrack<E>[] = [];
  const byMount = new Map<MediaMount<E>, AudioTrack<E>>();
  for (const mount of result.media) {
    // Video gets the same treatment as audio: it has a soundtrack, so the rule
    // is the same. The corpus has none, so this path is untested against real
    // data and says so rather than pretending.
    if (mount.kind !== "audio" && mount.kind !== "video") continue;
    const track: AudioTrack<E> = {
      mount,
      address: audioAddress(result, mount),
      side: mount.side,
    };
    tracks.push(track);
    byMount.set(mount, track);
    mount.element.setAttribute(AUDIO_DATA.state, "idle" satisfies AudioState);
  }

  const attachments = new Map<MediaMount<E>, Attachment>();
  const claimed = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let released = false;
  const counts = {
    requested: 0,
    playing: 0,
    replayed: 0,
    deferred: 0,
    missing: 0,
    unaddressable: 0,
    unplayable: 0,
    blocked: 0,
    failed: 0,
  };

  function finish(
    mount: MediaMount<E>,
    kind: AudioOutcomeKind,
    reason: PlayReason,
    hash: string | null,
    detail: string | null,
    state: AudioState | null,
  ): AudioOutcome<E> {
    counts[kind] += 1;
    if (state !== null) mount.element.setAttribute(AUDIO_DATA.state, state);
    const outcome: AudioOutcome<E> = { mount, kind, reason, hash, detail };
    options.onOutcome?.(outcome);
    return outcome;
  }

  /** Start playback on an already-attached element. Never mints or revokes. */
  function start(
    mount: MediaMount<E>,
    element: PlayableMediaElement,
    reason: PlayReason,
    kind: "playing" | "replayed",
    hash: string,
  ): Promise<AudioOutcome<E>> {
    if (kind === "replayed") {
      try {
        // Legal only once the element has loaded metadata; a fresh element throws
        // InvalidStateError in some browsers, and a replay that starts wherever it
        // left off is still a replay.
        element.currentTime = 0;
      } catch {
        /* nothing to rewind yet */
      }
    }
    let result: unknown;
    try {
      result = element.play();
    } catch (error) {
      return Promise.resolve(
        finish(mount, "failed", reason, hash, String(error), "failed"),
      );
    }
    if (!isPromiseLike<void>(result)) {
      return Promise.resolve(finish(mount, kind, reason, hash, null, "playing"));
    }
    return Promise.resolve(result).then(
      () => finish(mount, kind, reason, hash, null, "playing"),
      (error: unknown) =>
        // A rejected play() is the autoplay policy or a lost user activation. It
        // is not a broken clip and it is not an error worth throwing at a review
        // session — it is reported and the element keeps its controls.
        finish(mount, "blocked", reason, hash, String(error), "blocked"),
    );
  }

  function attachAndPlay(
    mount: MediaMount<E>,
    element: PlayableMediaElement,
    payload: BlobPayload,
    reason: PlayReason,
  ): Promise<AudioOutcome<E>> {
    let lease: BlobUrlLease;
    try {
      lease = scope.claim(payload);
    } catch (error) {
      return Promise.resolve(finish(mount, "failed", reason, payload.hash, String(error), "failed"));
    }
    claimed.add(lease.hash);
    // `revoke: false` deliberately: the SCOPE revokes, in `release()`, after every
    // element has been detached. Two elements may share one lease.
    //
    // The cast is the one place this port meets the platform type. `attachMedia`
    // takes an `HTMLMediaElement` and touches exactly four things — `src`,
    // `pause()`, `removeAttribute()`, `load()` — every one of which
    // `PlayableMediaElement` declares, and `test/reveal.test.ts` pins the other
    // direction (a real `HTMLAudioElement` satisfies the port) with a type-only
    // assignment. So it widens a value that provably provides what the callee
    // uses, which is preferable to a second copy of `attachMedia`'s
    // clear-then-revoke ordering — the one thing here that must not be
    // reimplemented.
    const media = attachMedia(element as unknown as HTMLMediaElement, lease, { revoke: false });
    attachments.set(mount, { lease, element, detach: media.detach });
    return start(mount, element, reason, "playing", lease.hash);
  }

  function one(mount: MediaMount<E>, reason: PlayReason): Promise<AudioOutcome<E>> {
    if (released) {
      return Promise.resolve(
        finish(mount, "failed", reason, null, "controller released", null),
      );
    }
    const track = byMount.get(mount) ?? null;
    if (track === null) {
      return Promise.resolve(
        finish(mount, "unplayable", reason, null, `${mount.kind} is not an audio track`, null),
      );
    }
    const element = playable(mount);
    if (element === null) {
      return Promise.resolve(
        finish(mount, "unplayable", reason, null, "element has no play()", "unplayable"),
      );
    }
    const held = attachments.get(mount);
    if (held !== undefined && !held.lease.revoked) {
      // Already attached: a replay, however it was asked for. Costs no URL.
      held.lease.touch();
      return start(mount, element, reason, "replayed", held.lease.hash);
    }
    const address = track.address;
    if (address === null) {
      return Promise.resolve(
        finish(mount, "unaddressable", reason, null, mount.reference.ref, "unaddressable"),
      );
    }
    counts.requested += 1;
    let payload: BlobPayload | null | PromiseLike<BlobPayload | null>;
    try {
      payload = options.resolve(address);
    } catch (error) {
      return Promise.resolve(finish(mount, "failed", reason, null, String(error), "failed"));
    }
    if (!isPromiseLike<BlobPayload | null>(payload)) {
      return payload === null
        ? Promise.resolve(finish(mount, "missing", reason, null, describe(address), "missing"))
        : attachAndPlay(mount, element, payload, reason);
    }
    return Promise.resolve(payload).then(
      (resolved) => {
        if (released) return finish(mount, "failed", reason, null, "controller released", null);
        return resolved === null
          ? finish(mount, "missing", reason, null, describe(address), "missing")
          : attachAndPlay(mount, element, resolved, reason);
      },
      (error: unknown) => finish(mount, "failed", reason, null, String(error), "failed"),
    );
  }

  function watch<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }

  return {
    tracks,
    scope,
    get stats(): AudioStats {
      return { ...counts, attached: attachments.size };
    },
    track(mount) {
      return byMount.get(mount) ?? null;
    },
    play(mounts, reason = "reveal") {
      // FIRST ADDRESSABLE CLIP ONLY. See `deferred`.
      let started = false;
      const outcomes: Promise<AudioOutcome<E>>[] = [];
      for (const mount of mounts) {
        const track = byMount.get(mount);
        if (track === undefined) continue;
        if (started) {
          outcomes.push(
            Promise.resolve(finish(mount, "deferred", reason, null, "another clip on this side", null)),
          );
          continue;
        }
        started = true;
        outcomes.push(one(mount, reason));
      }
      return watch(Promise.all(outcomes));
    },
    replay(mount) {
      return watch(one(mount, "replay"));
    },
    pauseAll() {
      for (const attachment of attachments.values()) {
        try {
          attachment.element.pause();
        } catch {
          /* a never-loaded element can throw; it changes nothing */
        }
      }
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    release() {
      if (released) return 0;
      released = true;
      // Order matters and it is `url.ts` rule 3: clear every element BEFORE
      // revoking anything, or the element keeps a handle that no longer resolves
      // and its next load() fails with a MEDIA_ELEMENT_ERROR naming a blob URL.
      for (const attachment of attachments.values()) attachment.detach();
      attachments.clear();
      let revoked = 0;
      for (const hash of claimed) if (scope.release(hash)) revoked += 1;
      claimed.clear();
      return revoked;
    },
  };
}

function describe(address: AudioAddress): string {
  return address.origin === "attachment"
    ? `attachment ${address.key}`
    : `${address.request.kind} ${JSON.stringify(address.request.text.slice(0, 40))}`;
}
