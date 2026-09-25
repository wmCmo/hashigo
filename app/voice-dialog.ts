/**
 * A VOICE FOR ONE CARD, OR ONE DECK — stage E of fields-as-modules, and the one
 * stage that is a new feature rather than a repair.
 *
 * The fifth pain point this project exists for, in `src/generate/voice.ts`'s own
 * words: Mochi sets the voice on the TEMPLATE, so four years of shadowing happened
 * against a voice nobody chose, because changing it meant changing it for every
 * card at once. The resolution for card → deck chain → workspace → field was
 * written and tested long ago and had no caller. This is the caller.
 *
 * ─── THE PRICE COMES FIRST, FOR THE SAME REASON AS THE FIELD EDITOR ─────────
 *
 * A clip is addressed by the voice that made it. Moving a card to a new voice
 * silences its clips in the old one until each is generated again — on purpose,
 * because a looser resolver would hide a half-finished voice change behind the
 * old audio (`src/cards/audio.ts`). So choosing a voice here prices it straight
 * away, measured by the worker through the inheritance views, and the button
 * says what it costs before it is pressed.
 *
 * An override reaches SPEECH IN ITS OWN LANGUAGE only. A Japanese voice set on a
 * deck that also holds New Vocab cards leaves their English clips alone.
 */

import { GOOGLE_VOICES } from "../src/generate/voices.js";
import { bareLayer, closeIfTop, pushLayer } from "./layers.js";
import { pushUndo, refreshAfterOp } from "./ops.js";
import type { VoiceTarget } from "./protocol.js";
import { say } from "./ui.js";
import { ask } from "./worker-client.js";

export function openVoiceDialog(target: VoiceTarget, targetId: string, name: string): void {
  const root = document.createElement("div");
  root.className = "layer layer-confirm";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", `voice for ${name}`);
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = `Voice for ${name}`;
  const text = document.createElement("p");
  text.textContent =
    (target === "deck"
      ? "Every card in this deck and the decks under it speaks NEW clips in this voice, "
      : "This card speaks NEW clips in this voice, ") +
    "unless a card or a closer deck sets its own. It only reaches speech in the " +
    "voice's own language. 'inherit' removes the override.";

  const select = document.createElement("select");
  select.className = "edit-input";
  select.setAttribute("aria-label", "voice");
  const inherit = document.createElement("option");
  inherit.value = "";
  inherit.textContent = "inherit — no override here";
  select.appendChild(inherit);
  for (const entry of GOOGLE_VOICES) {
    const option = document.createElement("option");
    option.value = entry.name;
    option.textContent = `${entry.lang} · ${entry.label}`;
    select.appendChild(option);
  }

  const price = document.createElement("p");
  price.className = "voice-price";
  price.textContent = "…";

  const bar = document.createElement("div");
  bar.className = "confirm-bar";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "cancel";
  cancel.addEventListener("click", () => closeIfTop(root));
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "set voice";
  go.disabled = true;
  bar.append(cancel, go);

  let asked = 0;
  const reprice = async (): Promise<void> => {
    const ticket = ++asked;
    go.disabled = true;
    price.textContent = "pricing…";
    const voice = select.value === "" ? null : select.value;
    try {
      const reply = await ask<"voice">({ kind: "voice", target, targetId, voice, dry: true });
      if (ticket !== asked) return; // a newer choice is already being priced
      const unchanged = voice === reply.previous;
      price.textContent = unchanged ? "This is what it is set to now." : reply.lines.join("\n\n");
      go.disabled = unchanged;
      go.className = reply.price.silenced > 0 ? "danger" : "";
      go.textContent = reply.price.silenced > 0 ? "set voice anyway" : "set voice";
    } catch (cause) {
      if (ticket === asked) price.textContent = (cause as Error).message;
    }
  };
  select.addEventListener("change", () => void reprice());

  go.addEventListener("click", () => {
    const voice = select.value === "" ? null : select.value;
    closeIfTop(root);
    void (async () => {
      try {
        const done = await ask<"voice">({ kind: "voice", target, targetId, voice, dry: false });
        say(done.describe);
        const back = done.previous;
        pushUndo({
          describe: done.describe,
          run: async () => {
            await ask<"voice">({ kind: "voice", target, targetId, voice: back, dry: false });
            await refreshAfterOp();
          },
        });
        await refreshAfterOp();
      } catch (cause) {
        say((cause as Error).message, true);
      }
    })();
  });

  panel.append(heading, text, select, price, bar);
  root.append(backdrop, panel);
  pushLayer(bareLayer(root));

  // Open on what the row carries now, so the first price is "unchanged" rather
  // than a proposal he did not make.
  void (async () => {
    try {
      const reply = await ask<"voice">({ kind: "voice", target, targetId, voice: null, dry: true });
      const current = reply.previous;
      if (current !== null && ![...select.options].some((option) => option.value === current)) {
        // An override written by something older than this catalogue. Shown as
        // itself so opening the dialog never proposes a change.
        const option = document.createElement("option");
        option.value = current;
        option.textContent = `${current} — set before this list existed`;
        select.appendChild(option);
      }
      select.value = current ?? "";
      await reprice();
    } catch (cause) {
      price.textContent = (cause as Error).message;
    }
  })();
  select.focus();
}
