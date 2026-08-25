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

### 4. Create needs an ID FORMAT — and that is a smaller question than this
### note first claimed

Nothing outside the importer creates a card, deck, template, field, tag or link.
The first version of this section said create was "blocked on an identity
decision" and implied two problems: whether a locally-made card SURVIVES the final
import, and what id it should carry. **Measured 2026-08-23, the first one is
already solved and I should not have raised it.**

**A locally-created card already survives a re-import, by construction.**

* There is **no `DELETE FROM cards` anywhere in `src/`**. The importer upserts;
  it never reconciles the card table against the export, so a card the export has
  never heard of is simply not considered.
* `pruneFieldValues` — the one thing that does delete on import — is scoped
  `WHERE card_id IN (SELECT card_id FROM import_field_keys)`, i.e. to the cards
  in *this* import. Its own docstring says so: *"it can never touch a card that
  came from an export not being re-read."*
* And `template_fields.local = 1` is exempt from even that, which is decision 9
  working exactly as intended.

So the only open question is the FORMAT, and the corpus answers it:

```plaintext
cards            7,716   ALL exactly 8 chars   base62 [0-9A-Za-z]
decks               39   all 8                 base62
templates           10   all 8                 base62
template_fields     32   31 × 8, 1 × 4         base62   (the 4 is `name`)
LOCAL fields         3   10 / 12 / 18          contains `-`
```

**Mochi's alphabet is base62 and cannot produce a hyphen.** So an id containing
one cannot collide with a Mochi id — *by construction, not by probability*. That
is a stronger guarantee than a UUID, which is merely unlikely to collide, and it
is 26 characters shorter in a value that appears in every wiki-link.

**And the convention already exists in this repo.** Decision 9's local fields are
`local-yomi`, `local-kana-primary`, `local-accent`. The same reasoning was applied
once already, to the same problem, one level down.

**Recommendation, for Zach to accept or reject in one line:**

> A locally-created card gets `local-` followed by 8 base62 characters —
> `local-k3Xp9QmA`. Hyphen ⇒ Mochi cannot generate it ⇒ no collision is possible.
> Same rule for a locally-created deck or template.

`cards.id` carries no CHECK constraint on format, so nothing has to change in the
schema. `id` is UNIQUE, so even a same-device repeat is an insert error rather
than silent corruption. For stage 11, two devices creating offline collide only if
they draw the same 8 of 62⁸ ≈ 2.2 × 10¹⁴ — and that surfaces as a failed insert,
not as merged cards.

**What is genuinely left of create, once the format is settled**, is UI rather
than identity: which deck, which template, and whether a new card enters the queue
immediately or waits for the next session. Those are his, and they are smaller
questions than the one this note originally posed.

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
