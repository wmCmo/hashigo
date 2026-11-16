import type { DeckBrief, DeckOp } from "./protocol.js";
import { openGallery } from "./gallery.js";
import { bareLayer, closeIfTop, pushLayer } from "./layers.js";
import { pushUndo, refreshAfterOp } from "./ops.js";
import { childrenOf, deckIndex, subtreeCards } from "./sidebar.js";
import { openConfirm, openPrompt, say } from "./ui.js";
import { ask } from "./worker-client.js";
import { openVoiceDialog } from "./voice-dialog.js";
import { icon, type IconName } from "./icons.js";
import { count } from "./plural.js";

export async function runDeckOp(request: {
  op: DeckOp;
  deckId: string;
  name?: string;
  parentId?: string | null;
}): Promise<void> {
  try {
    const reply = await ask<"deckOp">({ kind: "deckOp", ...request });
    say(reply.describe);
    if (reply.undo !== null) {
      const undo = reply.undo;
      pushUndo({
        describe: reply.describe,
        run: async () => {
          await ask<"deckOp">({
            kind: "deckOp",
            op: undo.op,
            deckId: undo.deckId,
            ...(undo.name === undefined ? {} : { name: undo.name }),
            ...(undo.parentId === undefined ? {} : { parentId: undo.parentId }),
            ...(undo.cardIds === undefined ? {} : { cardIds: undo.cardIds }),
          });
          await refreshAfterOp();
        },
      });
    }
    await refreshAfterOp();
  } catch (cause) {
    say((cause as Error).message, true);
  }
}

export function openDeckMenu(deck: DeckBrief): void {
  const root = document.createElement("div");
  root.className = "layer layer-confirm layer-menu";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", `${deck.path} actions`);
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = deck.path;
  const totals = subtreeCards(deck);
  const text = document.createElement("p");
  text.textContent =
    `${count(totals.cards, "card")} in this deck and everything under it` +
    (deck.cards === totals.cards ? "" : ` · ${deck.cards.toLocaleString()} directly in it`) +
    (deck.archived ? " · archived" : "");
  panel.append(heading, text);

  const list = document.createElement("div");
  list.className = "menu-list";
  const item = (
    glyph: IconName,
    label: string,
    note: string,
    run: () => void,
    danger = false,
  ): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item has-icon";
    if (danger) button.classList.add("danger");
    const name = document.createElement("b");
    name.textContent = label;
    const why = document.createElement("i");
    why.textContent = note;
    button.append(icon(glyph), name, why);
    button.addEventListener("click", () => {
      closeIfTop(root);
      run();
    });
    list.appendChild(button);
  };

  item("folder-open", "open", "see its cards in the gallery", () => void openGallery(deck.id));

  item("pencil-simple-line", "rename", "the name only — nothing moves", () => {
    openPrompt("Rename deck", `Currently ${deck.path}.`, "name", deck.name, (name) =>
      void runDeckOp({ op: "rename", deckId: deck.id, name }),
    );
  });

  item("folder-plus", "new sub-deck", "empty, inside this one", () => {
    openPrompt(
      "New sub-deck",
      `It goes inside ${deck.name} and starts empty. Reverse is 'inherit', so it ` +
        `follows whatever ${deck.name} resolves to.`,
      "name",
      "",
      (name) => void runDeckOp({ op: "create", deckId: "", name, parentId: deck.id }),
    );
  });

  item("arrows-out-cardinal", "move", "put it under another deck, or at the top", () => openDeckMove(deck));

  item("speaker-high", "voice", "which voice new clips in this deck are made in", () =>
    openVoiceDialog("deck", deck.id, deck.path),
  );

  item(
    deck.archived ? "box-arrow-up" : "archive",
    deck.archived ? "unarchive" : "archive",
    deck.archived
      ? "put it and its cards back in the queue"
      : "this deck and every card under it stop being scheduled",
    () => {
      const cards = count(totals.cards, "card");
      openConfirm(
        deck.path,
        deck.archived
          ? `Unarchives ${deck.name} and the ${cards} under it, including any you ` +
            `archived one at a time. Undo puts back exactly what this changes.`
          : `Archives ${deck.name} and the ${cards} under it. They stop being ` +
            `scheduled and keep their history. Undo puts back exactly what this changes.`,
        deck.archived ? "unarchive deck" : "archive deck",
        () => void runDeckOp({ op: deck.archived ? "unarchive" : "archive", deckId: deck.id }),
        "normal",
      );
    },
  );

  const subDecks = childrenOf(deck.id).length;
  const blocked = totals.cards > 0 || subDecks > 0;
  const holds = totals.cards > 0 ? count(totals.cards, "card") : count(subDecks, "sub-deck");
  item(
    "trash",
    "delete",
    blocked ? `only an empty deck · this one holds ${holds}` : "only an empty deck",
    () => {
      if (!blocked) {
        openConfirm(
          `Delete ${deck.name}?`,
          `It is empty, so nothing goes with it. There is no undo for a deleted ` +
            `deck; making it again is one action.`,
          "delete",
          () => void runDeckOp({ op: "delete", deckId: deck.id }),
        );
      } else if (totals.cards > 0 && !deck.archived) {
        openConfirm(
          `${deck.name} isn't empty`,
          `It holds ${holds}, and only an empty deck can be deleted. Archive it ` +
            `instead to take it and its cards out of the queue; undo brings them back.`,
          "archive deck",
          () => void runDeckOp({ op: "archive", deckId: deck.id }),
          "normal",
        );
      } else {
        openNotice(
          `${deck.name} isn't empty`,
          totals.cards > 0
            ? `It holds ${holds}, and only an empty deck can be deleted. It is ` +
              `archived already; to delete it, delete its cards first.`
            : `It holds ${holds}, and only an empty deck can be deleted. Delete or ` +
              `move ${subDecks === 1 ? "it" : "them"} first.`,
        );
      }
    },
    !blocked,
  );

  panel.appendChild(list);
  root.append(backdrop, panel);
  pushLayer(bareLayer(root));
  (list.firstElementChild as HTMLElement | null)?.focus();
}

function openNotice(title: string, body: string): void {
  const root = document.createElement("div");
  root.className = "layer layer-confirm";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const text = document.createElement("p");
  text.textContent = body;
  const bar = document.createElement("div");
  bar.className = "confirm-bar";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.textContent = "ok";
  ok.addEventListener("click", () => closeIfTop(root));
  bar.appendChild(ok);
  panel.append(heading, text, bar);
  root.append(backdrop, panel);
  pushLayer(bareLayer(root));
  ok.focus();
}

function openDeckMove(deck: DeckBrief): void {
  const under = new Set<string>();
  const walk = (id: string): void => {
    under.add(id);
    for (const child of childrenOf(id)) walk(child.id);
  };
  walk(deck.id);

  const root = document.createElement("div");
  root.className = "layer layer-confirm layer-menu";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = `Move ${deck.name}`;
  const text = document.createElement("p");
  text.textContent =
    "Its cards and sub-decks come with it. Its own sub-decks are not listed — a " +
    "deck cannot go inside itself.";
  panel.append(heading, text);

  const list = document.createElement("div");
  list.className = "menu-list";
  const choose = (label: string, parentId: string | null): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item";
    const name = document.createElement("b");
    name.textContent = label;
    button.appendChild(name);
    button.addEventListener("click", () => {
      closeIfTop(root);
      void runDeckOp({ op: "move", deckId: deck.id, parentId });
    });
    list.appendChild(button);
  };
  choose("the top level", null);
  for (const candidate of deckIndex) {
    if (under.has(candidate.id)) continue;
    if (candidate.id === deck.parentId) continue;
    choose(candidate.path, candidate.id);
  }

  panel.appendChild(list);
  root.append(backdrop, panel);
  pushLayer(bareLayer(root));
  (list.firstElementChild as HTMLElement | null)?.focus();
}
