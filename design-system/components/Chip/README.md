# Chip

A 22px pill with one or two words: card state, lateness, or a pitch-accent pattern. `neutral` is `ink` on `sunk`. `quiet` is `ink-2` with a `hairline` ring. `accent` is `accent-text` with an `accent` ring. `danger` is `danger` on `sunk`.

**You provide** the words as children, `tone`, and `lang="ja"` for Japanese labels (they switch to the `jp` family).

- `accent` marks the answer the card is training, such as the pitch pattern (平板, 頭高). Use at most one per card.
- Use `quiet` for metadata the eye can skip, such as lateness.
- Never more than three chips in a row.
