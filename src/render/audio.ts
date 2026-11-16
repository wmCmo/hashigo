import { BlobUrlScope, attachMedia, type BlobPayload, type BlobUrlLease } from "../blobs/url.js";
import type {
  GenerationDescriptor,
  MediaMount,
  RenderElement,
  RenderResult,
} from "./index.js";

export type AudioAddress =
  | {
      readonly origin: "attachment";
      readonly key: string;
    }
  | {
      readonly origin: "generator";
      readonly request: GenerationDescriptor;
    };

export type AudioResolver = (
  address: AudioAddress,
) => BlobPayload | null | PromiseLike<BlobPayload | null>;

export interface PlayableMediaElement extends RenderElement {
  src: string;
  currentTime: number;
  readonly paused: boolean;
  play(): unknown;
  pause(): void;
  load(): void;
  playbackRate?: number;
  loop?: boolean;
  preservesPitch?: boolean;
}

export const AUDIO_DATA = {
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

export type PlayReason = "reveal" | "replay" | "gesture" | "prompt";

export type AudioOutcomeKind =
  | "playing"
  | "replayed"
  | "missing"
  | "unaddressable"
  | "unplayable"
  | "blocked"
  | "failed"
  | "deferred";

export interface AudioOutcome<E extends RenderElement = RenderElement> {
  readonly mount: MediaMount<E>;
  readonly kind: AudioOutcomeKind;
  readonly reason: PlayReason;
  readonly hash: string | null;
  readonly detail: string | null;
}

export interface AudioStats {
  readonly requested: number;
  readonly playing: number;
  readonly replayed: number;
  readonly deferred: number;
  readonly missing: number;
  readonly unaddressable: number;
  readonly unplayable: number;
  readonly blocked: number;
  readonly failed: number;
  readonly attached: number;
}

export interface AudioControllerOptions<E extends RenderElement = RenderElement> {
  readonly resolve: AudioResolver;
  readonly scope?: BlobUrlScope;
  readonly playable?: (mount: MediaMount<E>) => PlayableMediaElement | null;
  readonly onOutcome?: (outcome: AudioOutcome<E>) => void;
  readonly playback?: () => { readonly rate: number; readonly loop: boolean };
}

export interface AudioTrack<E extends RenderElement = RenderElement> {
  readonly mount: MediaMount<E>;
  readonly address: AudioAddress | null;
  readonly side: number;
}

export interface AudioController<E extends RenderElement = RenderElement> {
  readonly tracks: readonly AudioTrack<E>[];
  readonly stats: AudioStats;
  readonly scope: BlobUrlScope;
  track(mount: MediaMount<E>): AudioTrack<E> | null;
  play(mounts: readonly MediaMount<E>[], reason?: PlayReason): Promise<readonly AudioOutcome<E>[]>;
  replay(mount: MediaMount<E>): Promise<AudioOutcome<E>>;
  pauseAll(): void;
  idle(): Promise<void>;
  release(): number;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function asPlayable<E extends RenderElement>(mount: MediaMount<E>): PlayableMediaElement | null {
  const candidate = mount.element as unknown as { play?: unknown };
  return typeof candidate.play === "function" ? (mount.element as unknown as PlayableMediaElement) : null;
}

export function audioAddress<E extends RenderElement>(
  result: RenderResult<E>,
  mount: MediaMount<E>,
): AudioAddress | null {
  if (mount.origin === "attachment") {
    return mount.reference.key === null ? null : { origin: "attachment", key: mount.reference.key };
  }
  for (const generation of result.generations) {
    if (generation.media !== mount) continue;
    return generation.request === null ? null : { origin: "generator", request: generation.request };
  }
  return null;
}

interface Attachment {
  readonly lease: BlobUrlLease;
  readonly element: PlayableMediaElement;
  detach(): void;
}

export function audioController<E extends RenderElement>(
  result: RenderResult<E>,
  options: AudioControllerOptions<E>,
): AudioController<E> {
  const playable = options.playable ?? asPlayable;
  const scope = options.scope ?? new BlobUrlScope();
  const tracks: AudioTrack<E>[] = [];
  const byMount = new Map<MediaMount<E>, AudioTrack<E>>();
  for (const mount of result.media) {
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

  function start(
    mount: MediaMount<E>,
    element: PlayableMediaElement,
    reason: PlayReason,
    kind: "playing" | "replayed",
    hash: string,
  ): Promise<AudioOutcome<E>> {
    if (kind === "replayed") {
      try {
        element.currentTime = 0;
      } catch {
      }
    }
    const playback = options.playback?.();
    if (playback !== undefined) {
      element.preservesPitch = true;
      element.playbackRate = playback.rate;
      element.loop = playback.loop;
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
        }
      }
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    release() {
      if (released) return 0;
      released = true;
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
