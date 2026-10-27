# FlashCard

The card: one headword set huge and centred, its gloss, reading and part of speech left-aligned below, then the side's content. It is the only raised surface on a screen.

**You provide** `head` (the word, any length — its size steps down on its own: up to 2 characters `headword`, 3–4 `headword-md`, 5+ `headword-sm`; force it with `headSize`), and optionally `gloss`, `reading`, `pos`, `children` (usually `Example`s) and `action` (one `PlayButton`, pinned bottom-right where the right thumb rests).

- One card per screen. Never nest cards or put a card inside a list.
- `gloss` is the first sense only; the rest belongs on a later side.
- Hide the answer by wrapping it in `Cloze`, never by leaving the field out, so the layout does not jump on reveal.
- Do not colour the headword. The accent is for the play disc and the live dot.
