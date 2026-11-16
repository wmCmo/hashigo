import type { BrowseHit, DeckBrief } from "./protocol.js";
import { prependIcon } from "./icons.js";
import { bareLayer, closeIfTop, layers, pushLayer } from "./layers.js";
import { shell } from "./shell.js";
import { loadDecks, templateChoices } from "./sidebar.js";
import { readVisits } from "./visits.js";
import { ask } from "./worker-client.js";
import { offerDuplicate, openEditorById, pushUndo, refreshAfterOp } from "./ops.js";

let paletteIndex = 0;
let paletteHits: readonly BrowseHit[] = [];
let paletteToken = 0;

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
    const scopeLabel = tagPath === null ? "" : `#${tagPath} · `;
    foot.textContent = suggesting
      ? `recent · ${reply.hits.length}`
      : reply.total === 0
        ? `${scopeLabel}nothing`
        : scopeLabel + `${reply.hits.length} of ${reply.total.toLocaleString()}`;
    foot.title = reply.mode === null ? "" : `${reply.mode} · ${reply.elapsedMs.toFixed(0)} ms`;
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
    row.dataset["cardId"] = hit.cardId;
    if (index === paletteIndex) row.classList.add("on");
    if (hit.archived) row.classList.add("is-archived");
    const name = document.createElement("span");
    name.className = "palette-name";
    name.textContent = hit.name === "" ? hit.cardId : hit.name;
    const meta = document.createElement("span");
    meta.className = "palette-meta";
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
    const name = title.value.trim();
    void ask<"createCard">({
      kind: "createCard",
      deckId: deck.value,
      templateId: template.value === "" ? null : template.value,
      name,
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
        const label = name === "" ? cardId : name;
        const made = `made ${label} · ${reply.tracks.join(" + ")} · in the new queue next session`;
        said.classList.remove("bad");
        said.textContent = made;
        title.value = "";
        pushUndo({
          describe: `new card ${label}`,
          run: async () => {
            await ask<"cardOp">({ kind: "cardOp", op: "delete", cardId });
            if (said.textContent === made) said.replaceChildren();
            await refreshAfterOp();
          },
        });
        void openEditorById(cardId);
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
