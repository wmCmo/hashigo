/// <reference types="vite/client" />
/**
 * ICONS — Phosphor, Light weight at rest and FILL for "on". Zach, 2026-09-26,
 * after seeing Phosphor Light beside Lucide on a mock of the review screen:
 * *"oh phosphor wins immediately, you're right, filled is a must"*.
 *
 * ─── WHY LIGHT, AND WHY FILL IS THE "ON" STATE ──────────────────────────────
 *
 * Light is the weight that matches decision 32's hairline rules; Lucide's 2px
 * line sat heavier than the borders around it. And an "on" state that is the
 * SAME icon filled reads without colour — which matters twice here: the brief
 * keeps colour scarce, and his phone's bedroom mode is black and white, where
 * the sync dot's red and green were indistinguishable.
 *
 * `dots-three` is REGULAR, not Light: at 18px Light's three dots were the one
 * icon that went faint in the comparison.
 *
 * ─── HOW THEY ARE DELIVERED ─────────────────────────────────────────────────
 *
 * Imported as raw SVG text, one file per icon, so only what is used is bundled,
 * it works offline like the rest of the shell, and `fill="currentColor"` makes
 * every icon the colour of the text around it — dark mode for free. No icon
 * font: nothing to load, no flash of empty boxes.
 */

import arrowDown from "@phosphor-icons/core/assets/light/arrow-down-light.svg?raw";
import arrowUp from "@phosphor-icons/core/assets/light/arrow-up-light.svg?raw";
import arrowsClockwise from "@phosphor-icons/core/assets/light/arrows-clockwise-light.svg?raw";
import cloudArrowDown from "@phosphor-icons/core/assets/light/cloud-arrow-down-light.svg?raw";
import cloudCheck from "@phosphor-icons/core/assets/light/cloud-check-light.svg?raw";
import cloudCheckFill from "@phosphor-icons/core/assets/fill/cloud-check-fill.svg?raw";
import cloudSlash from "@phosphor-icons/core/assets/light/cloud-slash-light.svg?raw";
import cloudWarning from "@phosphor-icons/core/assets/light/cloud-warning-light.svg?raw";
import cloudX from "@phosphor-icons/core/assets/fill/cloud-x-fill.svg?raw";
import dotsThree from "@phosphor-icons/core/assets/regular/dots-three.svg?raw";
import list from "@phosphor-icons/core/assets/light/list-light.svg?raw";
import play from "@phosphor-icons/core/assets/light/play-light.svg?raw";
import playFill from "@phosphor-icons/core/assets/fill/play-fill.svg?raw";
import x from "@phosphor-icons/core/assets/light/x-light.svg?raw";

const ICONS = {
  "arrow-down": arrowDown,
  "arrow-up": arrowUp,
  "arrows-clockwise": arrowsClockwise,
  "cloud-arrow-down": cloudArrowDown,
  "cloud-check": cloudCheck,
  "cloud-check-fill": cloudCheckFill,
  "cloud-slash": cloudSlash,
  "cloud-warning": cloudWarning,
  "cloud-x": cloudX,
  "dots-three": dotsThree,
  list,
  play,
  "play-fill": playFill,
  x,
} as const;

export type IconName = keyof typeof ICONS;

/** The icon as an element: a `<span class="ic">` holding the SVG, hidden from screen readers. */
export function icon(name: IconName): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "ic";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = ICONS[name];
  return span;
}

/** Replace an element's content with an icon. The element keeps its own label. */
export function setIcon(element: HTMLElement, name: IconName): void {
  element.replaceChildren(icon(name));
}
