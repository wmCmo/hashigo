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
 *
 * ─── STATIC MARKUP: `data-icon` ─────────────────────────────────────────────
 *
 * 2026-09-27, 全体のアイコン化。`index.html` のボタンは `data-icon="名前"` を書くだけで、
 * 起動時に `hydrateIcons()` がその要素の先頭にアイコンを差し込む。ボタンの文言は
 * 残す — アイコンは文言の代わりではなく目印で、ラベルのないアイコンだけのボタンは
 * 矢印と閉じるの二種類に限る（どちらも aria-label を持つ）。
 *
 * `data-icon-on="名前-fill"` を併記すると二つ差し込み、`.on` / `.arm` /
 * `aria-pressed="true"` のときに塗りの方へ切り替わる（style.css の `.ic-on`）。
 * 状態を色に頼らず形で示すのは同期アイコンと同じ理由 — 就寝モードは白黒。
 */

// The deck line's chips (new card, reversed, …) set their text at 10px, where
// Light's hairline strokes go faint — the same reason `dots-three` is Regular.
import arrowsLeftRight from "@phosphor-icons/core/assets/regular/arrows-left-right.svg?raw";
import calendarBlank from "@phosphor-icons/core/assets/regular/calendar-blank.svg?raw";
import clock from "@phosphor-icons/core/assets/regular/clock.svg?raw";
import repeatOnce from "@phosphor-icons/core/assets/regular/repeat-once.svg?raw";
import sparkle from "@phosphor-icons/core/assets/regular/sparkle.svg?raw";
import archive from "@phosphor-icons/core/assets/light/archive-light.svg?raw";
import arrowCounterClockwise from "@phosphor-icons/core/assets/light/arrow-counter-clockwise-light.svg?raw";
import arrowDown from "@phosphor-icons/core/assets/light/arrow-down-light.svg?raw";
import arrowLeft from "@phosphor-icons/core/assets/light/arrow-left-light.svg?raw";
import arrowUUpLeft from "@phosphor-icons/core/assets/light/arrow-u-up-left-light.svg?raw";
import arrowUp from "@phosphor-icons/core/assets/light/arrow-up-light.svg?raw";
import arrowsClockwise from "@phosphor-icons/core/assets/light/arrows-clockwise-light.svg?raw";
import arrowsOutCardinal from "@phosphor-icons/core/assets/light/arrows-out-cardinal-light.svg?raw";
import boxArrowUp from "@phosphor-icons/core/assets/light/box-arrow-up-light.svg?raw";
import caretDown from "@phosphor-icons/core/assets/light/caret-down-light.svg?raw";
import caretLeft from "@phosphor-icons/core/assets/light/caret-left-light.svg?raw";
import caretRight from "@phosphor-icons/core/assets/light/caret-right-light.svg?raw";
import caretUp from "@phosphor-icons/core/assets/light/caret-up-light.svg?raw";
import chartBar from "@phosphor-icons/core/assets/light/chart-bar-light.svg?raw";
import check from "@phosphor-icons/core/assets/light/check-light.svg?raw";
import cloudArrowDown from "@phosphor-icons/core/assets/light/cloud-arrow-down-light.svg?raw";
import cloudCheck from "@phosphor-icons/core/assets/light/cloud-check-light.svg?raw";
import cloudCheckFill from "@phosphor-icons/core/assets/fill/cloud-check-fill.svg?raw";
import cloudSlash from "@phosphor-icons/core/assets/light/cloud-slash-light.svg?raw";
import cloudWarning from "@phosphor-icons/core/assets/light/cloud-warning-light.svg?raw";
import cloudX from "@phosphor-icons/core/assets/fill/cloud-x-fill.svg?raw";
import copy from "@phosphor-icons/core/assets/light/copy-light.svg?raw";
import dotsThree from "@phosphor-icons/core/assets/regular/dots-three.svg?raw";
import downloadSimple from "@phosphor-icons/core/assets/light/download-simple-light.svg?raw";
import eye from "@phosphor-icons/core/assets/light/eye-light.svg?raw";
import folderOpen from "@phosphor-icons/core/assets/light/folder-open-light.svg?raw";
import folderPlus from "@phosphor-icons/core/assets/light/folder-plus-light.svg?raw";
import gauge from "@phosphor-icons/core/assets/light/gauge-light.svg?raw";
import gearSix from "@phosphor-icons/core/assets/light/gear-six-light.svg?raw";
import headphones from "@phosphor-icons/core/assets/light/headphones-light.svg?raw";
import list from "@phosphor-icons/core/assets/light/list-light.svg?raw";
import magnifyingGlass from "@phosphor-icons/core/assets/light/magnifying-glass-light.svg?raw";
import microphone from "@phosphor-icons/core/assets/light/microphone-light.svg?raw";
import microphoneFill from "@phosphor-icons/core/assets/fill/microphone-fill.svg?raw";
import pencilSimple from "@phosphor-icons/core/assets/light/pencil-simple-light.svg?raw";
import pencilSimpleLine from "@phosphor-icons/core/assets/light/pencil-simple-line-light.svg?raw";
import plus from "@phosphor-icons/core/assets/light/plus-light.svg?raw";
import play from "@phosphor-icons/core/assets/light/play-light.svg?raw";
import playFill from "@phosphor-icons/core/assets/fill/play-fill.svg?raw";
import pushPin from "@phosphor-icons/core/assets/light/push-pin-light.svg?raw";
import pushPinSlash from "@phosphor-icons/core/assets/light/push-pin-slash-light.svg?raw";
import repeat from "@phosphor-icons/core/assets/light/repeat-light.svg?raw";
import repeatFill from "@phosphor-icons/core/assets/fill/repeat-fill.svg?raw";
import speakerHigh from "@phosphor-icons/core/assets/light/speaker-high-light.svg?raw";
import speakerSlash from "@phosphor-icons/core/assets/light/speaker-slash-light.svg?raw";
import cards from "@phosphor-icons/core/assets/light/cards-light.svg?raw";
import toggleLeft from "@phosphor-icons/core/assets/light/toggle-left-light.svg?raw";
import toggleRightFill from "@phosphor-icons/core/assets/fill/toggle-right-fill.svg?raw";
import trash from "@phosphor-icons/core/assets/light/trash-light.svg?raw";
import x from "@phosphor-icons/core/assets/light/x-light.svg?raw";

const ICONS = {
  archive,
  "arrows-left-right": arrowsLeftRight,
  "calendar-blank": calendarBlank,
  clock,
  "repeat-once": repeatOnce,
  sparkle,
  "arrow-counter-clockwise": arrowCounterClockwise,
  "arrow-down": arrowDown,
  "arrow-left": arrowLeft,
  "arrow-u-up-left": arrowUUpLeft,
  "arrow-up": arrowUp,
  "arrows-clockwise": arrowsClockwise,
  "arrows-out-cardinal": arrowsOutCardinal,
  "box-arrow-up": boxArrowUp,
  "caret-down": caretDown,
  "caret-left": caretLeft,
  "caret-right": caretRight,
  "caret-up": caretUp,
  "chart-bar": chartBar,
  check,
  "cloud-arrow-down": cloudArrowDown,
  "cloud-check": cloudCheck,
  "cloud-check-fill": cloudCheckFill,
  "cloud-slash": cloudSlash,
  "cloud-warning": cloudWarning,
  "cloud-x": cloudX,
  copy,
  "dots-three": dotsThree,
  "download-simple": downloadSimple,
  eye,
  "folder-open": folderOpen,
  "folder-plus": folderPlus,
  gauge,
  "gear-six": gearSix,
  headphones,
  list,
  "magnifying-glass": magnifyingGlass,
  microphone,
  "microphone-fill": microphoneFill,
  "pencil-simple": pencilSimple,
  "pencil-simple-line": pencilSimpleLine,
  play,
  plus,
  "play-fill": playFill,
  "push-pin": pushPin,
  "push-pin-slash": pushPinSlash,
  repeat,
  "repeat-fill": repeatFill,
  "speaker-high": speakerHigh,
  "speaker-slash": speakerSlash,
  cards,
  "toggle-left": toggleLeft,
  "toggle-right-fill": toggleRightFill,
  trash,
  x,
} as const;

export type IconName = keyof typeof ICONS;

/**
 * カードの操作名 → アイコン。ギャラリーの札、プレビューの層、カードの ⋯ が同じ動詞に
 * 同じ形を使うように一箇所に置く。
 */
const OP_ICONS: Readonly<Record<string, IconName>> = {
  preview: "eye",
  edit: "pencil-simple",
  pin: "push-pin",
  unpin: "push-pin-slash",
  archive: "archive",
  unarchive: "box-arrow-up",
  duplicate: "copy",
  delete: "trash",
};

/** 操作名のアイコン。知らない名前なら null（文言だけのボタンのまま）。 */
export function opIcon(label: string): IconName | null {
  return OP_ICONS[label] ?? null;
}

function isIconName(name: string): name is IconName {
  return Object.hasOwn(ICONS, name);
}

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

/**
 * 先頭にアイコンを差し込む（文言は残す）。`on` を渡すと Light と Fill の二つを入れ、
 * どちらを見せるかは CSS が要素の状態で決める。二度呼んでも二重にはならない。
 */
export function prependIcon(element: HTMLElement, name: IconName, on?: IconName): void {
  for (const old of element.querySelectorAll(":scope > .ic")) old.remove();
  const icons = [icon(name)];
  if (on !== undefined) {
    const filled = icon(on);
    filled.classList.add("ic-on");
    icons[0]!.classList.add("ic-off");
    icons.push(filled);
  }
  element.prepend(...icons);
  // 文言が並ぶときだけ間を空ける。アイコンだけのボタン（矢印・閉じる）は中央に一つ。
  if ((element.textContent ?? "").trim() !== "") {
    for (const each of icons) each.classList.add("ic-lead");
  }
}

/**
 * `data-icon` / `data-icon-on` を持つ要素すべてにアイコンを入れる。名前の打ち間違いは
 * 黙って無視せず投げる — 見えないアイコンは誰にも気付かれない。
 */
export function hydrateIcons(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const name = element.dataset["icon"] ?? "";
    const on = element.dataset["iconOn"];
    if (!isIconName(name)) throw new Error(`unknown icon: ${name}`);
    if (on !== undefined && !isIconName(on)) throw new Error(`unknown icon: ${on}`);
    prependIcon(element, name, on);
  }
}
