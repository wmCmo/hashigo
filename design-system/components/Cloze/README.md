# Cloze

A masked span: the text keeps its width under a `sunk` block with `radius-sm`, and turns to plain text on reveal.

**You provide** the answer as `children`, `revealed` when it should show, and optionally `label` (what a screen reader says while hidden; default "hidden").

- The text stays in the layout while hidden, so nothing reflows on reveal.
- Reveal one cloze at a time; the fade is 200ms and needs no other motion.
