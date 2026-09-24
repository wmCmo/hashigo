/**
 * THE LAYER STACK — every modal in the app, and the rules they share.
 *
 * Moved out of `main.ts` on 2026-09-25. It held SIXTEEN copies of the same three
 * lines — attach the root, mark the body `layered`, push the record — and a copy
 * that dropped the middle line would leave the review screen scrollable under a
 * modal. `pushLayer` is those three lines once.
 *
 * Previews stack with no depth cap because his own corpus has 23 mutual link
 * pairs (`main.ts`, "his request 2"); each layer owns its mount and disposes it on
 * close, which is what bounds the cost instead.
 */

import type { MountedCard, PreparedCard } from "../src/review/index.js";
import { el } from "./dom.js";

/**
 * A PREVIEW IS NOT A REVIEW — decision 30, and it decides everything here.
 *
 * > showing a preview card is not the same as put the card into a review mode,
 * > when you enter a review mode, everything goes as it is now, showing a
 * > previewed card lets you view every sides at once
 *
 * So a layer renders every side at once, fully revealed, with no masks, no
 * grading, and **nothing plays by itself**. A clip is one deliberate tap away, as
 * it always is — which is why the native `<audio>` controls, hidden in review, are
 * SHOWN in a layer: there is no reveal here to hang playback on.
 *
 * That also means a layer needs none of review's machinery. No `enter()` (which
 * would ask the mode-2 question), no drill boundary, no one-clip arbitration —
 * every side is unmasked with `{ silent: true }` and left alone.
 *
 * ─── THEY NEST, AND HIS OWN CORPUS SAYS THAT IS UNBOUNDED ───────────────────
 *
 * > when you click another link that's on the pop up modal, it opens another
 * > layer on the top, and you can keep going in mochi, and i kinda like that
 *
 * Measured before building it: 8,744 links from 4,335 cards, the deepest acyclic
 * chain is 9, and there are **23 MUTUAL pairs** — A links to B, B links back to A
 * — so the stack can grow without bound on real data. No depth cap is imposed
 * here, because the corpus does not impose one and a limit would be a decision
 * nobody has made. What IS bounded is cost: each layer owns its mount and
 * disposes it on close, so the audio controller and every object URL it minted go
 * with it (`src/blobs/url.ts` rule 1 — the scope that mints revokes).
 */
export interface Layer {
  readonly root: HTMLElement;
  /** Null for a layer that renders no card — the editor, and "card not found". */
  readonly mounted: MountedCard<HTMLElement> | null;
  /** The prepared card, so `e` can edit whatever layer is on top. */
  readonly prepared: PreparedCard | null;
  readonly cardId: string;
  /**
   * Whether the single-key card operations act on this layer.
   *
   * TRUE for a preview only, and it is deliberately not derived from `cardId`. The
   * EDITOR carries a card id too, and every one of its fields is an input — so a
   * layer keyed on the id alone would archive the card he is editing the moment
   * focus sat on the panel instead of a box. A preview has nothing to type into,
   * which is exactly why the bare keys belong there and nowhere else.
   */
  readonly ops: boolean;
  /** Repainted in place by `refreshAfterOp`, for the same reason the review bar is. */
  pinned: boolean;
  archived: boolean;
  /**
   * Runs after the layer is removed, however it was closed — ✕, Escape, the
   * backdrop, Ctrl+Enter. The editor uses it to save every field and, when it was
   * opened FROM a preview, to turn back into a fresh one. See `openEditorFor`.
   */
  onClose?: () => void;
}

export const layerHost = el("layers");
export const layers: Layer[] = [];

export function closeIfTop(root: HTMLElement): void {
  if (layers.at(-1)?.root !== root) {
    // Not the top layer. Removing it would strand everything above it, so the
    // click does nothing — the same thing every stacked dialog does.
    return;
  }
  closeTop();
}

export function closeTop(): void {
  const top = layers.pop();
  if (top === undefined) return;
  // Dispose BEFORE detaching: the mount releases its audio leases and revokes
  // every object URL it minted, and a detached tree would still be holding them.
  // Null on an editor layer, which renders no card and holds no lease.
  top.mounted?.dispose();
  top.root.remove();
  if (layerHost.childElementCount === 0) document.body.classList.remove("layered");
  const next = layers.at(-1);
  (next?.root.querySelector(".layer-close") as HTMLElement | undefined)?.focus();
  top.onClose?.();
}

/** Open a layer: attach it, lock the page under it, and put it on the stack. */
export function pushLayer(layer: Layer): void {
  layerHost.appendChild(layer.root);
  document.body.classList.add("layered");
  layers.push(layer);
}

/**
 * Put an ALREADY-ATTACHED layer on the stack.
 *
 * For the callers that must attach first because they work on the live element
 * before registering it — the preview mounts its clip buttons, measures the
 * drawing canvas and moves focus, none of which does anything to a detached tree.
 * They attach and mark the body themselves; this only records the layer.
 */
export function registerLayer(layer: Layer): void {
  layers.push(layer);
}

/** A layer that renders no card and takes no card operations — a dialog. */
export function bareLayer(root: HTMLElement): Layer {
  return { root, mounted: null, prepared: null, cardId: "", ops: false, pinned: false, archived: false };
}
