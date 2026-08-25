/**
 * THE SIDEBAR'S TREE, DERIVED FROM A FLAT LIST — AND A GUARD AGAINST A CYCLE THAT
 * CANNOT HAPPEN YET.
 *
 * The worker sends decks as a flat array with a `parentId` edge on each (his requests
 * 2 and 5: templates nest like Notion pages, and the nesting is togglable). The tree
 * is derived here rather than sent, because the flat list is also what the gallery and
 * the new-card form want.
 *
 * A PARENT MUST COUNT ITS DESCENDANTS. `deck.cards` and `deck.due` are that deck's own
 * rows, so a parent whose cards all live in children would read `0` beside a child
 * reading `3,702`. `subtreeTotals` is what makes the number mean what a reader assumes
 * it means.
 *
 * ── WHY THERE IS A CYCLE GUARD FOR A CYCLE THE DATA CANNOT CONTAIN ──
 *
 * The recursion this replaces had none, and it did not need one: Mochi's decks are a
 * tree, and `deckOp` today is archive / unarchive / rename / create / delete — not one
 * of which can make a deck its own ancestor.
 *
 * But request 14 is "we should be able to CRUD the deck as well", and the obvious next
 * operation is MOVE. The day a deck can be reparented, an unguarded recursion here
 * does not misdraw the sidebar — it recurses until the stack dies, taking the page
 * with it, on a database that is otherwise fine. That is a bad failure to buy for
 * three lines, and a worse one to debug, because the sidebar is painted on load and
 * the app would simply be dead on open.
 *
 * So the guard returns what it has and marks the result rather than throwing:
 * `truncated` is true when an edge was refused. A sidebar that draws a slightly wrong
 * total is recoverable; a blank page is not.
 *
 * Self-contained by the same rule as `review-boundary.ts` — no imports, so it compiles
 * under the root `tsconfig.json` (which excludes `app/`) as well as `app/tsconfig.json`,
 * and `test/app-logic.test.ts` can reach it. `DeckBrief` is structurally assignable to
 * `TreeDeck`, so `main.ts` passes its real decks straight in.
 */

/** A deck, reduced to the four fields the tree needs. `DeckBrief` satisfies this. */
export interface TreeDeck {
  readonly id: string;
  readonly parentId: string | null;
  /** This deck's own cards, not its descendants'. */
  readonly cards: number;
  /** This deck's own due tracks — non-dormant, non-archived, due today or earlier. */
  readonly due: number;
}

export interface SubtreeTotals {
  readonly cards: number;
  readonly due: number;
  /**
   * True when a parent edge was refused because following it would revisit a deck.
   * The totals are then a floor rather than the truth, and the caller should say so
   * rather than presenting them as exact.
   */
  readonly truncated: boolean;
}

/**
 * Direct children of `parentId`, in the order the source list gave them.
 *
 * Order is the caller's, deliberately: the worker sends decks in path order, and
 * re-sorting here would silently override a deliberate `pos` from the database.
 */
export function childrenOf<D extends TreeDeck>(
  decks: readonly D[],
  parentId: string | null,
): readonly D[] {
  return decks.filter((deck) => deck.parentId === parentId);
}

/**
 * This deck plus everything beneath it.
 *
 * `seen` is threaded rather than global so two calls cannot interfere, and it is
 * checked on the way DOWN, which is what makes a self-parenting deck terminate
 * instead of counting itself forever.
 */
export function subtreeTotals<D extends TreeDeck>(decks: readonly D[], deck: D): SubtreeTotals {
  const seen = new Set<string>();

  function walk(current: D): SubtreeTotals {
    if (seen.has(current.id)) return { cards: 0, due: 0, truncated: true };
    seen.add(current.id);

    let cards = current.cards;
    let due = current.due;
    let truncated = false;
    for (const child of childrenOf(decks, current.id)) {
      const under = walk(child);
      cards += under.cards;
      due += under.due;
      truncated = truncated || under.truncated;
    }
    return { cards, due, truncated };
  }

  return walk(deck);
}

/**
 * Every deck that no other deck claims as a parent — the tree's roots.
 *
 * A deck whose `parentId` names a deck that is NOT in the list is a root too, which
 * matters more than it sounds: the sidebar can be handed a filtered list (one deck's
 * subtree, or the non-archived decks) and an orphan must still be drawn. Dropping it
 * would make a deck vanish from the sidebar while its cards stayed in the gallery.
 */
export function rootsOf<D extends TreeDeck>(decks: readonly D[]): readonly D[] {
  const present = new Set(decks.map((deck) => deck.id));
  return decks.filter((deck) => deck.parentId === null || !present.has(deck.parentId));
}
