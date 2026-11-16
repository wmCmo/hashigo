import type { ClozeMount, MediaMount, RenderElement, RenderResult } from "./index.js";

export type RevealAudioReason = "reveal" | "replay" | "gesture" | "prompt";

export interface RevealAudio<E extends RenderElement = RenderElement> {
  play(mounts: readonly MediaMount<E>[], reason?: RevealAudioReason): unknown;
  pauseAll?(): void;
  release?(): unknown;
}

export interface ActivationTarget extends RenderElement {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
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

export const REVEAL_ATTRIBUTES = {
  role: "role",
  tabIndex: "tabindex",
  expanded: "aria-expanded",
} as const;

export type RevealTrigger =
  | "cloze"
  | "audio"
  | "none";

export type RevealCause = "cloze" | "gesture" | "caller";

export interface ShadowingSide<E extends RenderElement = RenderElement> {
  readonly index: number;
  readonly position: number;
  readonly element: E;
  readonly clozes: readonly ClozeMount<E>[];
  readonly audio: readonly MediaMount<E>[];
  readonly trigger: RevealTrigger;
  readonly revealed: boolean;
  readonly masked: number;
  readonly entered: boolean;
  enter(): void;
  reveal(cause?: RevealCause, options?: { readonly silent?: boolean }): boolean;
  revealNext(cause?: RevealCause, options?: { readonly silent?: boolean }): boolean;
  revealCloze(
    mount: ClozeMount<E>,
    cause?: RevealCause,
    options?: { readonly silent?: boolean },
  ): boolean;
  play(mount: MediaMount<E>, options?: { readonly unmask?: boolean }): boolean;
  prompt(): boolean;
  conceal(): void;
  replay(): boolean;
}

export interface RevealEvent<E extends RenderElement = RenderElement> {
  readonly kind: "enter" | "reveal" | "step" | "conceal" | "replay" | "prompt";
  readonly side: ShadowingSide<E>;
  readonly cause: RevealCause | null;
  readonly clozes: number;
  readonly audio: number;
}

export interface ShadowingLoopOptions<E extends RenderElement = RenderElement> {
  readonly audio?: RevealAudio<E> | null;
  readonly bindClozes?: boolean;
  readonly armMedia?: boolean;
  readonly onEvent?: (event: RevealEvent<E>) => void;
}

export interface ShadowingLoop<E extends RenderElement = RenderElement> {
  readonly result: RenderResult<E>;
  readonly sides: readonly ShadowingSide<E>[];
  readonly current: ShadowingSide<E> | null;
  readonly log: readonly RevealEvent<E>[];
  side(position: number): ShadowingSide<E> | null;
  bySideIndex(index: number): ShadowingSide<E> | null;
  enter(position: number): ShadowingSide<E> | null;
  onReveal(listener: (side: ShadowingSide<E>) => void): () => void;
  dispose(): void;
}

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

  const sides: ShadowingSide<E>[] = result.sides.map((rendered) => {
    const clozes = result.clozes.filter((mount) => mount.side === rendered.index);
    const media = result.media.filter(
      (mount) => mount.side === rendered.index && (mount.kind === "audio" || mount.kind === "video"),
    );
    const trigger: RevealTrigger =
      clozes.length > 0 ? "cloze" : media.length > 0 ? "audio" : "none";
    let revealed = false;
    let entered = false;
    let revealing = false;
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
        return first === undefined ? false : side.play(first, { unmask: false });
      },
    };

    function unmask(): number | null {
      if (revealed || revealing) return null;
      revealing = true;
      let changed = 0;
      try {
        for (const mount of clozes) {
          if (mount.revealed) continue;
          mount.reveal();
          changed += 1;
        }
        revealed = true;
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

  if (bindClozes) {
    for (const side of sides) {
      for (const mount of side.clozes) {
        const target = asTarget(mount.element);
        if (target === null) continue;
        target.setAttribute(REVEAL_ATTRIBUTES.role, "button");
        target.setAttribute(REVEAL_ATTRIBUTES.tabIndex, "0");
        target.setAttribute(REVEAL_ATTRIBUTES.expanded, mount.revealed ? "true" : "false");
        const onClick = (): void => {
          side.revealCloze(mount, "cloze");
        };
        const onKey = (event: unknown): void => {
          const key = (event as { key?: unknown }).key;
          if (key !== "Enter" && key !== " " && key !== "Spacebar") return;
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
