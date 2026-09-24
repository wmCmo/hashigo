/**
 * DECK OPERATIONS AND THE DECK MENUS — the rest of his #14: create, rename, move,
 * archive, delete, each with its undo.
 *
 * Moved out of `main.ts` on 2026-09-25. It needed nothing from that file.
 */

import type { DeckBrief, DeckOp } from "./protocol.js";
import { openGallery } from "./gallery.js";
import { bareLayer, closeIfTop, pushLayer } from "./layers.js";
import { pushUndo, refreshAfterOp } from "./ops.js";
import { childrenOf, deckIndex, subtreeCards } from "./sidebar.js";
import { openConfirm, openPrompt, say } from "./ui.js";
import { ask } from "./worker-client.js";

/**
 * Every deck operation goes through here, so undo and the error path exist once.
 *
 * The undo is spread from `reply.undo` rather than rebuilt: `restoreArchive`
 * carries the exact card ids the archive flipped, and reconstructing the inverse
 * op instead of replaying the recorded one is the bug that un-archived 234
 * individually-archived cards on a single ctrl+Z.
 */
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
    // The worker refuses a delete that would take cards and a move that would make
    // a cycle, and both messages explain themselves. Shown as-is.
    say((cause as Error).message, true);
  }
}

/**
 * His #14, in full: *"and also, we need CRUD for decks"*.
 *
 * Every operation the worker supports, each with the sentence that makes it a
 * decision rather than a button. It is a LAYER like everything else, so Escape
 * peels it and the review underneath is untouched.
 *
 * ─── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * Per-deck `reverse` and `target_retention` overrides. Both are real columns with
 * real resolution views, and both change what he is DRILLED on — the line decision
 * 31 draws around what stays his. The workspace defaults are in settings, where a
 * change is one row and obvious; a per-deck override buried in a context menu is
 * how a deck ends up scheduled differently for a reason nobody remembers.
 */

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
    `${totals.cards.toLocaleString()} card(s) in this deck and everything under it` +
    (deck.cards === totals.cards ? "" : ` · ${deck.cards.toLocaleString()} directly in it`) +
    (deck.archived ? " · archived" : "");
  panel.append(heading, text);

  const list = document.createElement("div");
  list.className = "menu-list";
  const item = (label: string, note: string, run: () => void, danger = false): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item";
    if (danger) button.classList.add("danger");
    const name = document.createElement("b");
    name.textContent = label;
    const why = document.createElement("i");
    why.textContent = note;
    button.append(name, why);
    button.addEventListener("click", () => {
      closeIfTop(root);
      run();
    });
    list.appendChild(button);
  };

  item("open", "see its cards in the gallery", () => void openGallery(deck.id));

  item("rename", "the name only — nothing moves", () => {
    openPrompt("Rename deck", `Currently ${deck.path}.`, "name", deck.name, (name) =>
      void runDeckOp({ op: "rename", deckId: deck.id, name }),
    );
  });

  item("new sub-deck", "empty, inside this one", () => {
    openPrompt(
      "New sub-deck",
      `It goes inside ${deck.name} and starts empty. Reverse is 'inherit', so it ` +
        `follows whatever ${deck.name} resolves to.`,
      "name",
      "",
      (name) => void runDeckOp({ op: "create", deckId: "", name, parentId: deck.id }),
    );
  });

  item("move", "put it under another deck, or at the top", () => openDeckMove(deck));

  item(
    deck.archived ? "unarchive" : "archive",
    deck.archived
      ? "put it and its cards back in the queue"
      : "this deck AND every card under it stop being scheduled",
    () => {
      openConfirm(
        deck.path,
        `${deck.archived ? "Unarchiving" : "Archiving"} marks the deck AND every ` +
          `card in its subtree (${totals.cards.toLocaleString()}), because the review ` +
          `queue filters on the CARD — two predicates that disagree is worse than one ` +
          `that is blunt. Undo restores exactly the rows this flips, so cards you ` +
          `archived by hand keep their state. This is also the answer to your 数字 ` +
          `question: Mochi has no deck-level archive at all, so a deck you archived ` +
          `there arrived here unarchived.`,
        deck.archived ? "unarchive deck" : "archive deck",
        () => void runDeckOp({ op: deck.archived ? "unarchive" : "archive", deckId: deck.id }),
        // Undo restores exactly the rows it flipped, and no history is destroyed
        // either way — an archived track goes dormant, it does not lose its reviews.
        "normal",
      );
    },
  );

  item(
    "delete",
    "only an empty deck — the schema refuses to take cards with it",
    () => {
      openConfirm(
        `Delete ${deck.name}?`,
        totals.cards > 0
          ? `It holds ${totals.cards.toLocaleString()} card(s) in its subtree. ` +
            `\`cards.deck_id\` is ON DELETE RESTRICT, deliberately — deleting a deck ` +
            `must never silently take four years of cards with it. Move them, or ` +
            `archive the deck instead.`
          : `It is empty, so nothing goes with it. There is no undo for a deleted ` +
            `deck; making it again is one action.`,
        "delete",
        () => void runDeckOp({ op: "delete", deckId: deck.id }),
      );
    },
    true,
  );

  panel.appendChild(list);
  root.append(backdrop, panel);
  pushLayer(bareLayer(root));
  (list.firstElementChild as HTMLElement | null)?.focus();
}

/**
 * Choose a new parent.
 *
 * The list EXCLUDES the deck and everything under it, because moving a deck into
 * its own descendant makes `deck_ancestry` — a recursive view with no depth bound —
 * loop, and every path, count and inheritance query goes through it. The worker
 * refuses it as well; this stops him getting as far as an error message.
 */
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
