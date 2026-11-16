import type { MountedCard, PreparedCard } from "../src/review/index.js";
import { el } from "./dom.js";

export interface Layer {
  readonly root: HTMLElement;
  readonly mounted: MountedCard<HTMLElement> | null;
  readonly prepared: PreparedCard | null;
  readonly cardId: string;
  readonly ops: boolean;
  pinned: boolean;
  archived: boolean;
  onClose?: () => void;
}

export const layerHost = el("layers");
export const layers: Layer[] = [];

export function closeIfTop(root: HTMLElement): void {
  if (layers.at(-1)?.root !== root) {
    return;
  }
  closeTop();
}

export function closeTop(): void {
  const top = layers.pop();
  if (top === undefined) return;
  top.mounted?.dispose();
  top.root.remove();
  if (layerHost.childElementCount === 0) document.body.classList.remove("layered");
  const next = layers.at(-1);
  (next?.root.querySelector(".layer-close") as HTMLElement | undefined)?.focus();
  top.onClose?.();
}

export function pushLayer(layer: Layer): void {
  layerHost.appendChild(layer.root);
  document.body.classList.add("layered");
  layers.push(layer);
}

export function registerLayer(layer: Layer): void {
  layers.push(layer);
}

export function bareLayer(root: HTMLElement): Layer {
  return { root, mounted: null, prepared: null, cardId: "", ops: false, pinned: false, archived: false };
}
