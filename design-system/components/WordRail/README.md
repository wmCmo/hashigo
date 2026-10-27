# WordRail

The session as a strip of words above the card: the current word in `ink` with a 3px dot beneath it, the others in `ink-2`, fading out at both edges. Moving to the next card slides the strip 280ms.

**You provide** `words` (the headwords in session order), `current` (an index), and optionally `onSelect` to let a tap jump to a word; without it the rail is display only.

- Show only words already reviewed or already visible. A word the next card asks you to recall must not appear before its card, so mask or omit upcoming headwords on recall cards.
- Place it `space-7` below the chrome and `space-5` above the card.
