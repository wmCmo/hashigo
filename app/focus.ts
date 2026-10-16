/**
 * REVIEW ONE DECK, OR ONLY THE SILENT CARDS — Zach, 2026-10-16:
 *
 * *"sometimes when im outside i may not be able to speak or do shadowing, so i
 * need a mode that i can review all the cards that has no audio … maybe a mode
 * that once im inside a deck, i can click review by deck"*.
 *
 * Both are ONE request (`focus`) that rebuilds today's plan with a deck and/or the
 * silent filter, and both are undone the same way: `focus(null, false)`. The plan
 * is still the scheduler's — due first by its own order, today's new cards dealt
 * the same way — only narrowed. Nothing is written.
 *
 * **The scope has to stay visible.** A narrowed plan that looks like the whole one
 * is how he would finish "today" with 1,400 cards untouched, so the header carries
 * a chip naming it for as long as it holds, and the chip is also the way out.
 */

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

const chip = el<HTMLButtonElement>("focuschip");
const clear = el<HTMLButtonElement>("focusclear");

/** What the chip says: `漢字 · silent`, `漢字`, `silent`, or null for the whole plan. */
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

/**
 * The two buttons at the top of a deck's page. "everything" (deckId null) has no
 * plain review button — that is the plan he already has — only the silent one.
 */
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
