export interface TreeDeck {
  readonly id: string;
  readonly parentId: string | null;
  readonly cards: number;
  readonly due: number;
}

export interface SubtreeTotals {
  readonly cards: number;
  readonly due: number;
  readonly truncated: boolean;
}

export function childrenOf<D extends TreeDeck>(
  decks: readonly D[],
  parentId: string | null,
): readonly D[] {
  return decks.filter((deck) => deck.parentId === parentId);
}

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

export function rootsOf<D extends TreeDeck>(decks: readonly D[]): readonly D[] {
  const present = new Set(decks.map((deck) => deck.id));
  return decks.filter((deck) => deck.parentId === null || !present.has(deck.parentId));
}
