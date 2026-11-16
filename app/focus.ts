import type { FocusCount } from "./protocol.js";
import { el } from "./dom.js";
import { prependIcon } from "./icons.js";
import { shell } from "./shell.js";
import { say } from "./ui.js";
import { ask } from "./worker-client.js";

interface Focus {
  readonly deckId: string | null;
  readonly deckName: string | null;
  readonly silent: boolean;
}

const WHOLE: Focus = { deckId: null, deckName: null, silent: false };
let current: Focus = WHOLE;

export function isFocused(): boolean {
  return current.deckId !== null || current.silent;
}

const chip = el<HTMLButtonElement>("focuschip");
const clear = el<HTMLButtonElement>("focusclear");

function focusLabel(deckName: string | null, silent: boolean): string | null {
  const parts = [deckName, silent ? "silent" : null].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

function paintChip(): void {
  const label = focusLabel(current.deckName, current.silent);
  chip.hidden = label === null;
  clear.hidden = label === null;
  if (label === null) return;
  chip.textContent = label;
  prependIcon(chip, "x");
  chip.setAttribute("aria-label", `reviewing ${label} only — tap to review everything`);
  chip.title = "back to the whole plan";
}

export async function startFocus(
  deckId: string | null,
  deckName: string | null,
  silent: boolean,
): Promise<void> {
  const reply = await ask<"focus">({ kind: "focus", deckId, silent });
  current = { deckId, deckName: deckId === null ? null : deckName, silent };
  paintChip();
  document.body.setAttribute("data-view", "review");
  await shell().restartReview();
  const scope = focusLabel(current.deckName, current.silent) ?? "everything";
  say(`${scope}: ${reply.dueCount} due, ${reply.newCount} new`);
}

export async function paintDeckReview(
  host: HTMLElement,
  deckId: string | null,
  deckName: string | null,
): Promise<void> {
  host.replaceChildren();
  const counts = await ask<"focusCounts">({ kind: "focusCounts", deckId });
  const make = (text: string, glyph: "cards" | "speaker-slash", count: FocusCount, silent: boolean) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gallery-review-go";
    const n = count.due + count.fresh;
    button.disabled = n === 0;
    button.textContent = `${text} · ${n.toLocaleString()}`;
    prependIcon(button, glyph);
    button.title = `${count.due} due, ${count.fresh} new`;
    button.addEventListener("click", () => void startFocus(deckId, deckName, silent));
    return button;
  };
  if (deckId !== null) host.appendChild(make("review this deck", "cards", counts.all, false));
  host.appendChild(make("silent only", "speaker-slash", counts.silent, true));
}

chip.addEventListener("click", () => void startFocus(null, null, false));
clear.addEventListener("click", () => void startFocus(null, null, false));
paintChip();
