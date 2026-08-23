# src/backup — the local archive

Decision 17. Everything in this database that `exports/` cannot rebuild, in a file
small enough that a one-tap export is a thing he will actually tap.

```bash
npx vite-node src/backup/cli.ts -- export --db build/hashigo.db --out backup.json
npx vite-node src/backup/cli.ts -- apply  --db build/hashigo.db --in  backup.json --dry
```

Measured over the real corpus: **332,262 bytes on disk (UTF-8)**, against a 74 MB file
and a 617.9 MiB blob store. It was 2,674 bytes until D3 landed on 2026-08-23 and
added 3,830 derived `型` labels — **3,830 of the 3,848 field values are derived**, and
only 18 are hand-authored. Kept anyway: 330 KB is still instant, and it makes a restore
one `apply` instead of "restore, rebuild the 1.4 GB Python venv, re-derive".

**Three numbers circulate for this one file and only one is bytes.** 235,686 is a compact
`JSON.stringify().length`, 316,860 is the pretty-printed `.length` the CLI used to print
as "bytes", and **332,262 is the actual UTF-8 size on disk**. `.length` counts UTF-16 code
units, which under-reports Japanese by 15,402 here. Decision 6: name the basis.

## Why it exists, and why it is not urgent yet

Today every review is reconstructible from `exports/`, so losing the database costs
about fifteen seconds. **Decision 16 changes that**: after the one final import,
`exports/` stops receiving his history, and from the first local grade onward the
app's own database is the only copy — held in OPFS, which is browser-owned storage
that "clear site data" or a browser eviction takes with it.

So this is insurance now and load-bearing later, which is exactly the reason to
build it while it is cheap to verify: there are 0 local reviews to lose today.

## What it carries

| archived | why |
|---|---|
| `reviews` where `source = 'local'` | grades made in Hashigo. **The** thing |
| the scheduling state of any track that has one | `due_at`, `scheduled_days`, `reps`, `lapses`, `last_reviewed_at`, `scheduler`, `scheduler_state` — restored directly rather than recomputed by replay |
| `template_fields` where `local = 1`, and their values | decision 9's `読み` / `かな主流` / `型`. Mochi never had them, so nothing else does |
| `settings` | four rows, and no credential among them |

Everything else is left out on purpose. Cards, decks, templates, tags, links and the
102,020 **imported** reviews rebuild from `exports/` in about fifteen seconds, and
the blobs are content-addressed and re-fetchable. Archiving them would turn 2.6 KB
into 690 MB.

**It archives ROWS, not the database file**, and that is the more important choice.
A binary SQLite copy is only restorable into the schema version it came from, and
`applySchema` refuses any version but its own — so a schema bump would strand every
backup taken before it. `SCHEMA_VERSION` has moved eight times. Rows plus stable
keys survive a bump, which is the whole point of a backup.

## The key is `(card_id, kind)`, never `track_id`

The one decision that would make this silently useless. `card_tracks.id` is
`INTEGER PRIMARY KEY` — a rowid alias handed out at insert time — so it is a
property of one build of one database, not an identity. A rebuild is
`rm build/hashigo.db` and a re-import, and the ids it assigns are whatever the
insert order gives.

They would very probably come out identical, **which is worse than if they
obviously did not**: an archive keyed on them restores cleanly, reports every row
applied, and attaches his review history to the wrong cards the first time anything
shifts. `(card_id, kind)` is the stable identity, and it is already UNIQUE — it is
the conflict target `src/import/reviews.ts` upserts on.

Pinned by the test that matters: the destination database is built with the cards
inserted in the **opposite order**, so the ids genuinely swap, and the assertions
are on which *card* ended up with which review. Simulating an id-keyed resolve
turns 3 tests red and the failure message says it plainly — `card_id: 'cardB'`
where `cardA` was expected.

## Two things found by testing rather than reasoning

**`pos` is TEXT, not a number.** `template_fields.pos` is a fractional index —
`'ab'`, `'ac'` — so Mochi can insert between two neighbours without renumbering.
`Number(pos)` gives `NaN`, which would have restored every local field with a null
order. Caught by reading the real rows; the column list alone would not have shown
it.

**A missing card used to abort the whole restore.** `card_field_values` has a
foreign key to `cards`, so a single deleted card made `applyLocalArchive` throw
`FOREIGN KEY constraint failed` and lose the rest of the archive — at exactly the
moment it is the only copy. Now every foreign key an archive can outlive is probed
first and reported as `*Orphaned`. This is not hypothetical: this corpus carries
**8,958 tombstones**, so restoring into a database rebuilt from a newer export will
meet a deleted card eventually. Skipped and counted, never fatal.

## Applying is idempotent

`reviews` is append-only with a `BEFORE UPDATE` trigger, so a re-apply cannot
update — it inserts what is missing and skips what is there, matched on
`(track, reviewed_at, source)`. Everything else upserts. Run it twice and the second
run says **ALREADY APPLIED**, the same shape as `scripts/reading-apply.ts`.

The CLI's `apply` runs in one transaction, so a surprise leaves the database as it
was. `--dry` does the real inserts and rolls back, and **prints the report anyway** —
a dry run that tells you nothing is not a dry run.

## What is missing

The **UI half of decision 17**: `notes/archive/persistence.md` prescribes a
persistent, non-dismissible banner when `persisted()` is false, an "add to home
screen" prompt beside it, and detection of an eviction that already happened. That
belongs to the app shell, which does not exist yet. This module is the mechanism;
nothing calls it from a screen.

Browser-portable — `SqliteHandle`, no `node:` import — so the one-tap export runs in
the OPFS worker. Turning the archive into a downloadable file is the shell's job;
this returns data, not a `Blob`.
