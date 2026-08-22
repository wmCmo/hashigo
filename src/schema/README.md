# src/schema — Stage 1. Owns the data model: cards, ordered sides, review *tracks* (forward / reverse / cloze:n), three-state reverse resolution, materialised tag paths, refcounted content-addressed blobs, and the stage-1 aggregate shape the dashboard and phase-2 insights both read.

## The contract, v7

Four other stages code against these names. `PRAGMA user_version` is **8**; any
other version is refused rather than migrated, because every database here is
rebuildable from `exports/` in about fifteen seconds. `SCHEMA_VERSION` in
`index.ts` carries the changelog for every bump — read that, not this line, for
what each version added. The short version of 3-7: per-card/deck `voice` plus
`blobs.unreferenced_at` (3), the `accents` table and the `accent` field type (4),
analyser priority in `accent_resolved` (5), adjudicated words leaving the
disagreement queue (6), and `template_fields.local` so a field Mochi never had
survives a re-import (7).

**Intervals are two columns, never one.** `reviews.elapsed_days` is MEASURED —
what actually happened between two reviews — and `reviews.scheduled_days` is
PLANNED — what the scheduler had asked for that same gap. `next_scheduled_days`
is what the review scheduled going forward (Mochi's own `interval` field).
`card_tracks.scheduled_days` is the track's current planned interval. The name
`interval_days` no longer exists anywhere, so a stale query fails with "no such
column" instead of returning a plausible wrong number.

Read `review_log` for everything that is not an interval, and
`review_log_elapsed` when you need the measured one — it backfills
`elapsed_days` from the timestamps, and it is a separate view because the window
costs 187% and most aggregates never look at an interval. Bucketed retention
comes from `retention_by_elapsed_interval` or `retention_by_scheduled_interval`;
there is deliberately no `retention_by_interval`, because the old name did not
say which. `review_interval_audit` must return no rows.

**Grades are binary.** There is no `grade` column and there will not be one.
`remembered` is the whole signal; `BINARY_GRADE` maps it to Again (1) / Good (3)
for FSRS, and `FROZEN_FSRS_WEIGHTS` names `w[15]`/`w[16]` as unreachable.

**Search indexes rendered text.** `cards.search_text` is derived by
`renderPlainTextParts()` in `src/text/` — wiki-link syntax reduced to display
text, zero-width and
bidi marks stripped, NFC. The stored `value` keeps everything verbatim; only
this column is cleaned. NULL means "not maintained" and falls back to the raw
concatenation; `''` means "maintained, genuinely empty". Every write path owes a
recompute — no SQL can enforce it, and `test/schema.test.ts` pins the staleness
hazard so it is not discovered in the search box. Query through `searchPlan()`,
which routes 1–2 character queries to a LIKE scan over `card_search_index`
because the trigram index cannot serve them at all.

## `sources.ts` — the DDL text, and the one rule about this directory

`schema.sql` and `views.sql` are loaded by **`sources.ts`**, not by `index.ts`, and that
split is load-bearing rather than tidiness. `index.ts` is where the enumerations live, so
eleven modules value-import it — template, renderer, scheduler, generate, dashboard
metrics among them. While the `node:fs` read sat in `index.ts` and ran at module scope,
**every one of those subsystems threw at module load in a browser worker**, for a
filesystem read none of them asked for.

So: **`index.ts` has no Node imports and must never acquire any. Anything touching I/O
goes in `sources.ts`.** `test/browser-portable.test.ts` walks the transitive closure and
fails on the first `node:` specifier, so this cannot regress quietly.

`src/db/open.ts` is the only consumer of `SCHEMA_SOURCES`. A browser build needs DDL only
when it CREATES a database — both spikes open an existing file with
`applySchema: false` — and when it does, the seam is a sibling `sources.browser.ts` using
the `?raw` text import already in production in `spike/db.worker.ts`. That specifier is a
Vite-ism and cannot go in a shared path, because `dist/` is plain `tsc` output that Node
imports directly.
