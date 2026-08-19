# src/text — The single definition of "what does this card say in plain text".

`renderPlainText(raw, { resolveName })` turns authored card text into display
text: wiki-links reduce to their display text, invisible marks (U+200B..U+200F,
U+FEFF) are dropped, markdown is left readable, the result is NFC. Everything
that needs rendered text calls this — `cards.search_text` via the importer's
`renderPlainTextParts`, and later the reviewer and the `@` picker. Do not write
a second copy; a drifting second copy shows up as a card you can see but cannot
find.

**Stored bytes are never touched.** `cards.content` and
`card_field_values.value` keep the link syntax and every U+200E verbatim —
2,480 field values and 34 card contents still carry the mark after a full
import, and 0 rows of `search_text` do. Rendering is a read-time projection.

**Three link forms, all real:** `[[display|id]]` (8,690), `[[id]]` (46),
`[[|id]]` (8). The last two have no authored display text and fall back to the
target card's name. `[[display|]]` has no target and is not a link. Bracket
adjacency (`]]` immediately followed by `[[`) parses natively, so the U+200E
Zach had to type to keep Mochi's parser straight is no longer needed — but his
existing 3,016 marks stay in his data.

See the header of `render.ts` for the measurements behind each of those numbers
and for why NFKC is deliberately not applied here.
