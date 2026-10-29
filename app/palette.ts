/**
 * Ctrl+K AND THE NEW-CARD FORM — his #3, and the create half of his #14.
 *
 * Moved out of `main.ts` on 2026-09-25. The palette is decision 47's suggestion
 * list when it opens empty, and a tag's cards when a `#tag` opens it scoped.
 */

import type { BrowseHit, DeckBrief } from "./protocol.js";
import { prependIcon } from "./icons.js";
import { bareLayer, closeIfTop, layers, pushLayer } from "./layers.js";
import { shell } from "./shell.js";
import { loadDecks, templateChoices } from "./sidebar.js";
import { readVisits } from "./visits.js";
import { ask } from "./worker-client.js";
import { offerDuplicate, pushUndo, refreshAfterOp } from "./ops.js";

/**
 * *"i want notion, obsidian like searching feature, so like ctrl +k and it pops
 * up a modal that we can search and enter"* — his second time asking.
 *
 * It is a LAYER, like everything else that goes over the card, so Escape peels it
 * and the review underneath is untouched. Arrow keys move the selection, Enter
 * opens the highlighted card as a preview.
 *
 * The query goes through `src/search`, which matters at two characters: `card_fts`
 * uses a trigram tokeniser and CANNOT serve a query shorter than three, and two
 * characters is the commonest search unit in Japanese. That module routes to a
 * ranked scan instead — 意味 returns 0 from MATCH and 3 from the scan.
 */
let paletteIndex = 0;
let paletteHits: readonly BrowseHit[] = [];
let paletteToken = 0;

/**
 * The palette, optionally SCOPED TO A TAG.
 *
 * Ctrl+K opens it with no scope, which is decision 47's suggestion list. A tap on
 * a `#tag` opens it scoped: the box starts empty and lists the tag's cards, and
 * anything he types then searches WITHIN the tag instead of replacing it.
 *
 * The scope is not a seeded query, and the difference is the whole point. Seeding
 * `Mathematics` into the box returned **18 cards where 9 carry the tag** — the
 * other 9 merely say the word somewhere. A tag that lands you next to its own
 * cards is not a link.
 */
export function openPalette(tagPath: string | null = null): void {
  if (document.querySelector(".palette") !== null) return;
  const root = document.createElement("div");
  root.className = "layer palette";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "search");

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "palette-panel";
  const input = document.createElement("input");
  input.className = "palette-input";
  input.type = "search";
  input.placeholder = tagPath === null ? "search cards" : `search within #${tagPath}`;
  input.autocomplete = "off";
  input.spellcheck = false;
  const list = document.createElement("div");
  list.className = "palette-list";
  const foot = document.createElement("div");
  foot.className = "palette-foot";
  panel.append(input, list, foot);
  root.appendChild(panel);

  const run = async (): Promise<void> => {
    const token = ++paletteToken;
    // A tag scope is never "suggesting": an empty box under `#Mathematics` means
    // "the tag's cards", which is a listing and not a guess at what he wants.
    const suggesting = input.value.trim() === "" && tagPath === null;
    const reply = await ask<"browse">({
      kind: "browse",
      query: input.value,
      deckId: null,
      tagPath,
      limit: 40,
      suggest: tagPath === null,
      visited: readVisits(),
    });
    if (token !== paletteToken) return;
    paletteHits = reply.hits;
    paletteIndex = 0;
    // "recent" rather than "40 of 7,716", which counts the collection and says nothing
    // about what is on screen. The suggestion list is not a result set.
    const scopeLabel = tagPath === null ? "" : `#${tagPath} · `;
    foot.textContent = suggesting
      ? `recent · ${reply.hits.length}`
      : reply.total === 0
        ? `${scopeLabel}nothing`
        : scopeLabel +
          `${reply.hits.length} of ${reply.total.toLocaleString()}` +
          (reply.mode === null ? "" : ` · ${reply.mode} · ${reply.elapsedMs.toFixed(0)}ms`);
    paintPalette(list);
  };

  input.addEventListener("input", () => void run());
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = paletteIndex + (event.key === "ArrowDown" ? 1 : -1);
      paletteIndex = Math.max(0, Math.min(paletteHits.length - 1, next));
      paintPalette(list);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = paletteHits[paletteIndex];
      if (hit !== undefined) {
        closeIfTop(root);
        void shell().openPreview(hit.cardId);
      }
    }
  });

  pushLayer(bareLayer(root));
  input.focus();
  void run();
}

function paintPalette(list: HTMLElement): void {
  list.replaceChildren();
  paletteHits.forEach((hit, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "palette-row";
    // The row's text is name and deck path run together (`篤日本語/漢字`); the id
    // is what something driving the page should match on.
    row.dataset["cardId"] = hit.cardId;
    if (index === paletteIndex) row.classList.add("on");
    if (hit.archived) row.classList.add("is-archived");
    const name = document.createElement("span");
    name.className = "palette-name";
    name.textContent = hit.name === "" ? hit.cardId : hit.name;
    const meta = document.createElement("span");
    meta.className = "palette-meta";
    // PINNED SAYS SO. Zach, 2026-10-22, over the empty Ctrl+K: *"we need a way to
    // know that those are pinned cards"*. Decision 47 puts the pins first and
    // nothing on the row said why they were there. Same place and voice as
    // "archived", plus the pin the card menu already uses.
    const flags = [hit.pinned ? "pinned" : null, hit.archived ? "archived" : null].filter((f) => f !== null);
    meta.textContent = [hit.deckPath, ...flags].join(" · ");
    if (hit.pinned) {
      row.classList.add("is-pinned");
      prependIcon(meta, "push-pin");
    }
    row.append(name, meta);
    row.addEventListener("click", () => {
      const top = layers.at(-1);
      if (top !== undefined) closeIfTop(top.root);
      void shell().openPreview(hit.cardId);
    });
    list.appendChild(row);
    if (index === paletteIndex) row.scrollIntoView({ block: "nearest" });
  });
}

/**
 * The new-card form — his request 5's other half, and the last of the six.
 *
 * Three inputs and nothing more: a title, a deck, a template. It then opens the
 * EDITOR on the card it made, because a card with a title and no fields is not
 * yet a card and the next thing he wants is always to fill it in.
 *
 * **The card does not join the session already in progress.** `buildSession` ran
 * before it existed, and rebuilding mid-session would reshuffle the queue under
 * him — so the reply says which tracks were opened and the form says when it will
 * appear. It enters the NEW queue (due_at NULL, reps 0), which means decision 12's
 * ten-a-day limit applies to it like any other new card.
 */
// DECLARED ABOVE `buildNewCardForm`, not below it. `let` sits in a temporal dead
// zone until its own statement executes, and the form is built during module
// initialisation — so declaring these after the function threw
// `Cannot access 'newCardDeck' before initialization` and killed the whole
// module before `boot()` ran. The page came up blank with an empty log.
let newCardDeck: HTMLSelectElement | null = null;
let newCardTemplate: HTMLSelectElement | null = null;

export function buildNewCardForm(): HTMLElement {
  const form = document.createElement("form");
  form.className = "newcard";

  const title = document.createElement("input");
  title.className = "newcard-title";
  title.type = "text";
  title.placeholder = "new card — the word";
  title.autocomplete = "off";
  title.spellcheck = false;

  const deck = document.createElement("select");
  deck.className = "newcard-select";
  deck.setAttribute("aria-label", "deck");

  const template = document.createElement("select");
  template.className = "newcard-select";
  template.setAttribute("aria-label", "template");
  const none = document.createElement("option");
  none.value = "";
  // 66 of his cards have no template at all, so this is a real option and not a
  // placeholder.
  none.textContent = "no template";
  template.appendChild(none);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "newcard-submit";
  submit.textContent = "create";

  const said = document.createElement("p");
  said.className = "newcard-said";

  form.append(title, deck, template, submit, said);

  const create = (allowDuplicate: boolean): void => {
    if (deck.value === "") return;
    submit.disabled = true;
    void ask<"createCard">({
      kind: "createCard",
      deckId: deck.value,
      templateId: template.value === "" ? null : template.value,
      name: title.value.trim(),
      allowDuplicate,
    })
      .then((reply) => {
        if (reply.duplicate !== null || reply.cardId === null) {
          offerDuplicate(said, reply.duplicate, {
            use: {
              label: "open",
              run: (cardId) => {
                said.replaceChildren();
                title.value = "";
                void shell().openPreview(cardId);
              },
            },
            anyway: () => create(true),
          });
          return;
        }
        const cardId = reply.cardId;
        said.classList.remove("bad");
        said.textContent =
          `made ${cardId} · ${reply.tracks.join(" + ")} · ` +
          `it joins the NEW queue next session`;
        title.value = "";
        // HIS #13's "create card". Undone by deleting it — which is safe here in a
        // way `delete` generally is not: a card made seconds ago has no review
        // history to lose, which is the whole reason delete is otherwise final.
        pushUndo({
          describe: `new card ${cardId}`,
          run: async () => {
            await ask<"cardOp">({ kind: "cardOp", op: "delete", cardId });
            await refreshAfterOp();
          },
        });
        // Straight into the editor on the card just made: a title with no fields
        // is not yet a card, and this is always the next thing he wants.
        if (reply.card !== null) shell().openEditorFor(reply.card);
        void loadDecks(true);
      })
      .catch((cause: Error) => {
        said.classList.add("bad");
        said.textContent = cause.message;
      })
      .finally(() => {
        submit.disabled = false;
      });
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    create(false);
  });

  // Filled when the deck list arrives.
  newCardDeck = deck;
  newCardTemplate = template;
  return form;
}

export function fillNewCardChoices(decks: readonly DeckBrief[]): void {
  if (newCardDeck !== null) {
    newCardDeck.replaceChildren();
    for (const entry of decks) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.path;
      newCardDeck.appendChild(option);
    }
  }
  if (newCardTemplate !== null) {
    const none = newCardTemplate.firstElementChild;
    newCardTemplate.replaceChildren();
    if (none !== null) newCardTemplate.appendChild(none);
    for (const entry of templateChoices) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = `${entry.name} · ${entry.fields} fields`;
      newCardTemplate.appendChild(option);
    }
  }
}
