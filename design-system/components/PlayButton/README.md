# PlayButton

The ruri disc: the one thing on a card you press to hear it. A 28px `accent` disc with `shadow-accent` inside a 48px target.

**You provide** `onClick`, and `state` — `idle`, `playing` (three `on-accent` bars move in the disc) or `missing` (the disc goes `ink-3`, the button stops responding and says "No audio for this clip"). `size="sm"` is a 14px disc in a 40px target, for a second clip set in line with its sentence.

- One large disc per card, in the card's `action` slot, bottom-right.
- The disc carries no glyph at rest. Its colour is the signal; the accessible name says "Play audio".
- Never start audio on mount. The disc plays when pressed.
