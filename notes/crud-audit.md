# Do we have full CRUD for every kind of information?

Zach asked this on 2026-08-23, before the editor is built. It is the right time to
ask it and the answer changes what the editor is: **Read is complete, Update is
most of the way there and its mechanism is proven end to end, and Create and
Delete are absent — but they are absent for two completely different reasons.**

Measured against the real database, not read off the schema.

## The matrix

`C` and `D` mean "a user can do this from the app". A script that an agent runs is
not a user-facing capability, and is marked as such.

| information | rows | C | R | U | D | where the write lives today |
|---|---:|:-:|:-:|:-:|:-:|---|
| **cards** | 7,716 | — | ✅ | ~ | — | `voice` only (`src/generate/voice.ts`). Not name, deck, template or archived |
| **card_field_values** | 26,167 | ✅ | ✅ | ✅ | — | **the only fully live write path** — `app/db.worker.ts` (the `Reading` toggle), `src/accent`, `src/backup` |
| **card_tracks** | 13,392 | — | ✅ | ✅ | — | `src/scheduler/tracks.ts` — grading, and `dormant` |
| **reviews** | 102,020 | ✅ | ✅ | 🚫 | 🚫 | `src/scheduler` inserts. **Append-only BY TRIGGER** (`reviews_append_only`) |
| **decks** | 39 | — | ✅ | ~ | — | `voice` only. No create, rename, move or archive |
| **templates** | 10 | — | ✅ | script | — | `content` via `scripts/accent-field-apply.ts`. **Nothing in `src/` writes a template** |
| **template_fields** | 47 | script | ✅ | ~ | — | `src/backup` upserts; `scripts/` creates. No user path, no delete |
| **tags** / **card_tags** | 20 / 66 | — | ✅ | — | — | importer only |
| **card_links** | 8,744 | — | ✅ | — | — | importer only |
| **blobs / blob_refs / payloads** | 37,763 / 42,569 | ✅ | ✅ | 🚫 | ✅ | `src/blobs`. **Immutable by trigger**, refcounted, delete-protected while referenced |
| **accents** | 6,898 | ✅ | ✅ | ✅ | — | `src/accent/store.ts`. Derived — not user data |
| **settings** | 4 | ✅ | ✅ | ✅ | — | upsert |

🚫 = deliberately forbidden, and the schema enforces it with a trigger rather than
a convention. ~ = one column, not the row.

## The four findings

### 1. Update is nearly there, and the hard part of it is already proven

`card_field_values` is the table the editor actually needs, and the app already
writes it: the `Reading` toggle goes page → worker → `INSERT … ON CONFLICT DO
UPDATE`, and the worker re-checks the field is the one it thinks it is before
writing. **So his request 3 — "press `e` to edit each field" — is a UI over a write
path that works.** It is the smallest quarter of CRUD, not the largest.

What is missing around it is not the write but the guards: nothing validates a
value against `template_fields.type` (a `boolean` field would happily take
`"maybe"`), and nothing re-derives what a change invalidates — editing a head word
should orphan its accent and its generated audio, and today it would not.

### 2. Delete is missing CODE, not DESIGN — the schema is fully prepared

This was the surprise. Every foreign key pointing at `cards` is **`ON DELETE
CASCADE`**: `card_field_values`, `card_tracks`, `card_tags`, `card_links`,
`blob_refs`. The FTS index has `AFTER INSERT / UPDATE / DELETE` triggers on all
three of its sources, so search stays correct. `blob_refs_ad` decrements a blob's
refcount when a card takes its reference away, and `blobs_no_delete_while_
referenced` refuses to drop a payload something still points at.

So "delete this card" is one `DELETE FROM cards WHERE id = ?` over machinery that
is already correct and already carrying 7,716 cards' worth of references — and
nobody has ever run it. That is the whole gap.

### 3. `archived` IS the soft delete, it already works, and nothing can set it

`cards.archived` and `decks.archived` exist. **234 cards are archived in the
imported data, carrying 451 live tracks**, and every consumer that matters already
honours it — `src/scheduler/queue.ts:139` (`t.dormant = 0 AND c.archived = 0`, and
its comment names those exact figures), the dashboard, and the backtest.

I nearly reported this as a bug — "archived cards reach the review queue" — and it
is not one. The queue filters them, and the arithmetic says so: 679 tracks are due
right now, 33 of them on archived cards, and the session plans 601 due. Checking
the number is what killed the claim; the grep alone had made it look real.

**So "delete a card" in the UI is most likely `archived = 1`,** which is one column
over behaviour that is already tested by the corpus, and is reversible. A hard
delete is available underneath it if he ever wants it. That is his call, not mine.

### 4. Create needed no decision at all — the question was mine, not his

This section has now been wrong twice, and both versions were rigorous. The first
said create was "blocked on an identity decision". The second measured that a
locally-created card already survives a re-import and reduced the question to an id
FORMAT, recommending a hyphen so collision with a Mochi id would be impossible by
construction.

**Zach's answer, and it was his fourth time saying it:**

> in what world would the id from mochi collide with id from hashigo? i never
> import one card or one deck, once we finish developing hashigo, ill delete the
> whole card and reimport again

**The import is WHOLESALE**, and decision 16 leaves exactly one more of them.
After it, no Mochi id ever arrives here again. There is no shared namespace to
collide inside, so there was never a collision to design against.

A new card id therefore needs to be unique in THIS database and nothing else,
which `cards.id UNIQUE` already enforces — a repeat is a failed insert, not silent
corruption. `app/db.worker.ts` mints 8 base62 characters, the same shape Mochi
uses, because uniformity is free and one format is one thing to reason about.

**BUILT 2026-08-23**, and the half that actually needed care was not identity at
all: **a card with no `card_tracks` row is invisible to the scheduler forever** —
never due, never new, never in a session. Creating one opens `forward` always and
`reverse` when the deck resolves to it, read from `card_reverse_resolved` rather
than re-deriving the inheritance walk. Verified end to end: a new 単語 card came
back `forward + reverse`.

**The generalisable bit, because two careful analyses in a row missed it:** a
measurement can be flawless and still answer a question nobody asked. Neither
version of this section was wrong about the code. Both were wrong about the
workflow, and the workflow was written down — three times before this one.

## What this means for the order of work

1. **Edit fields** (his 3) — the write path exists; this is a UI plus the two
   guards named in finding 1.
2. **Archive a card** — one column, machinery already correct and already
   exercised by 234 imported rows.
3. **Delete a card** — one statement, and the cascade is already right. Worth
   doing after archive so the destructive one is the second choice, not the first.
4. **Create** — needs the identity decision first. Do not start it before that.

Three things should stay outside user CRUD, and the schema already says so with
triggers rather than trusting anyone to remember: **reviews** are append-only,
**blobs** are immutable and content-addressed, and **accents** are derived.

---

*Measured 2026-08-23 against `build/hashigo.db` at schema v8. The row counts move
with the final import (decision 16); the shape does not.*
