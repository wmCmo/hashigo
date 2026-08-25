# What Zach actually wants — his list, 2026-08-23

Written down because an agent told him the app was "essentially finished" while he
was holding this, and because a list this size must not live in a chat log. **This
is not a backlog someone derived; it is his, in his words.** Nothing here has been
started.

> honestly, i haven't opened my phone yet, ive been using it on desktop, but man,
> there are like 100 things i wanna add, so now it's not about testing whether i
> like it, we're not even there yet

## The list, verbatim

1. dashboard that i can access from the side bar
2. why are templates not nesting like notion pages on the side bar
3. i remember i told you a second time that i want notion, obsidian like searching
   feature, so like ctrl +k and it pops up a modal that we can search and enter
4. showing cards on the sidebar is pointless, i have like 10,000+ cards, it's
   better to use obsidian style search
5. nesting deck on the side bar should be togglable
6. and once you click the deck, what happens? the main screen goes to the card
   gallery, imagine a notion gallery database view, something like that, where you
   can filter, search, sort, click to preview, edit archive, pin, copy, duplicate,
   delete, from there
7. on both preview and review, i would like shift p for pin, and d for delete,
   with warning modal ofc, and a for archive
8. i think right now my archived cards are still showing, like i think my whole
   数字 deck is supposed to be archived
9. while reviewing card, i would like to use arrows (left and right) to move to
   next card and move back, without registering any reviewing record, just wanna
   see what's next, we should have ux friendly button for mobile as well, for
   every 操作 that i just told you
10. is the field for drawing kanji working? i tried but it didn't work
11. where can i edit my template? there should be a modal for editing template and
    fields
12. there should be settings, with all settings that this app should have
13. when you ctrl+z, it should undo your last action, whether create card, review
    card, remember card, forget card, etc., we need button on mobile as well,
    basically any 操作 on pc, should be able to do as well on mobile
14. we should be able to CRUD the deck as well — decks, cards, templates

> that's all the top of my mind

## The one recurring principle, and it is not one of the fourteen

**Every 操作 available on the desktop must be available on mobile**, item 9 and 13
both say it and item 6's gallery implies it. Keyboard shortcuts are an ACCELERATOR
for the laptop, never the only route — a `shift+P` with no button is a feature the
phone does not have. Decision 19 already said the neighbouring thing about keycap
hints; this extends it from hints to the operations themselves.

**And #4 corrects something already built.** The sidebar lists cards; he does not
want a card list at 10,000+ cards, he wants search. What is built should shrink to
decks + search, and the LIST belongs in the gallery (#6).

## Item 8 is answered, and neither of us guessed right

He believes his whole 数字 deck should be archived. Measured:

```plaintext
数字 cards        78 archived = 0     12 archived = 1
数字 deck row     archived = 0
decks archived=1  NONE, in the entire database
```

**Because Mochi has no deck-level archive flag at all** — `src/import/entities.ts`
line 326 says so in as many words, writing `archived: 0` unconditionally with the
comment *"Mochi has no deck-level archive flag"*. So if he archived the DECK in
Mochi, that state does not exist in the export and never reached us. The 12 are
cards he archived individually.

Two consequences:

* **The review queue is behaving correctly and he is still right to complain.**
  `src/scheduler/queue.ts` filters `c.archived = 0`, so those 12 are excluded and
  the other 78 are due — which is what he is seeing. Nothing is broken; the
  information simply is not in the export.
* **`decks.archived` exists in the schema, and NOTHING reads or writes it.**
  Another "built and does nothing". Archiving a deck in Hashigo is the fix, and it
  is part of his #14 (CRUD the deck). The queue would then need to honour the deck
  flag as well as the card flag — it currently checks only the card.

## What this list means for the order of everything else

It reorders the repo's own queue. Sync (stage 11) is still the only STRUCTURAL
blocker — two devices, two databases — but almost everything above is UI he wants
before he would call this usable, and several items (6, 11, 14) are the editor and
gallery that stage 10 was always going to be.

**Do not read the six requests of earlier that day as the specification.** Those
were what came to mind when he first saw it run. This is what he wants.
