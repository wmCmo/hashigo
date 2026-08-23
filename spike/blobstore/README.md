# `spike/blobstore/` — THROWAWAY

**Disposable harness.** It exists to settle, in a real browser, whether
`SqliteBlobStore` from `src/blobs/sqlite.ts` actually holds the whole corpus in
OPFS — and to measure it against `notes/archive/browser-feasibility.md` §4. Nothing in
`src/` imports anything here. Delete it once the PWA shell exists.

Every line of store code it exercises comes from `src/`, unmodified. That is the
whole point: the class this page runs in a Worker over `opfs-sahpool` is the same
class `test/blobs.test.ts` runs in Node over better-sqlite3. There is no browser
variant to drift.

```
spike/blobstore/
  index.html         the page
  main.ts            main thread: DOM, persist(), a pack check with no database in it
  store.worker.ts    the dedicated Worker: every database handle and the store live here
  pack.ts            streaming reader for the corpus pack
  protocol.ts        the messages between them
  make-pack.mjs      build/hashigo.db.blobs.db -> one streamable file of real mp3
```

## Run it

```bash
npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報
node spike/blobstore/make-pack.mjs      # -> build/spike/blob-corpus.pack (625.4 MiB)
npm run spike:bootstrap                 # -> build/spike/hashigo-bootstrap.db (69 MB, non-WAL)
npm run spike:dev                       # http://localhost:5273/blobstore/
```

`build/` is gitignored, so neither the pack nor the bootstrap database can enter
the repo.

**One page per origin at a time.** `opfs-sahpool` is single-connection, and a
second tab on the same origin fails the install outright:

```
could not install the opfs-sahpool VFS: Failed to execute 'createSyncAccessHandle' on
'FileSystemFileHandle': Access Handles cannot be created if there is another open
Access Handle or Writable stream associated with the same file.
```

That is `notes/archive/browser-feasibility.md` §7's untested multi-tab item, now observed.
To run two harnesses at once, give each its own origin: `npx vite --port 5299
--strictPort` is a different origin and therefore a different OPFS.

## What it settled

Two kinds of answer live in this table and they do not deserve equal trust.

**The correctness answers are exact and they repeat.** Every run by every agent,
on every profile, has produced the same counts: 10,816 payloads, 654,917,364
bytes, 10,816 of 10,816 rehashing to their own address, 0 mismatches, 0 missing,
0 orphaned, 0 size mismatches, 0 location offenders, free-page reuse working,
`integrity_check` ok.

**The timings do not repeat, and an earlier version of this table quoted a single
best run as though they did.** They have since been measured on three machines /
profiles and they spread by 3×–8×. The column below gives the full observed
range and, in brackets, the integrator's own two runs on a fresh origin
(`localhost:5291`, empty OPFS, Chromium 151 via Playwright, Windows 11) — see
"Reproducibility" below for the whole matrix. **Quote the range, never a point.**

| question | answer, Chromium 151 |
|---|---|
| Does the full corpus go into a BLOB table in OPFS? | Yes. 10,816 payloads / 654,917,364 bytes, in 10 batches. **2.5 s–24.8 s** across three environments — 25–248 MiB/s, 0.23–2.30 ms/blob. [mine: 6.5 s / 96 MiB/s cold, 5.6 s / 111 MiB/s warm] |
| Random read? | **0.13–1.06 ms/blob** over 50 random addresses. [mine: 0.25 ms cold, 0.15 ms warm] |
| Can the browser verify content addressing itself? | Yes. All 10,816 payloads rehash to their own address using `src/blobs/sha256.ts`, **0 mismatches** — every run, every environment. Cost **4.9 s–10.3 s** for 624.6 MiB read *and* hashed. [mine: 8.2 s / 76 MiB/s, twice] `crypto.subtle` is async and `BlobStore.verify` is not, which is why that file exists. |
| Does `auditBlobStore` work across two OPFS databases? | Yes. 37,763 rows, 26,947 inline, **10,816 present, 0 missing, 0 orphaned, 0 size mismatches**. 0.73–1.40 s. |
| Does it survive a reload? | Yes. Second run reports `write skipped (reload path)` and audits clean without re-importing. |
| Incremental growth at ~660 MB? | +300 payloads (17.2 MiB) in **198–696 ms**, 82,234 → 84,156 pages (+1,922). [mine: 413 ms, 427 ms] |
| Free-page reuse? | **Yes.** After deleting those 300, inserting 300 different ones added **0** pages where 2,198 would have been needed. Reproduced by everyone. |
| `incremental_vacuum`? | Works, and it is the most variable thing here: 1,920 pages cost **6.6 s–53.9 s**, one statement per page on the wasm handle. [mine: 28.7 s cold, 10.6 s warm — the same code, the same page, twice, 2.7× apart] See the comment on `reclaim()`; this spread is exactly why it takes a page budget instead of running to completion. |
| `VACUUM` on the 642 MB file? | **Completes, in 11.0 s** on the run that measured it, with `temp_store = file`. Quota usage peaks at ~2.4 GiB while the temporary copy exists, so it needs room for a second copy. `auto_vacuum` survives it. Not re-measured by the integrator (the box was left unticked), so treat 11.0 s as one observation. |
| Does the store file hold a location? | No. 5 columns, 2 tables, 0 offenders. `blob_payloads.bytes` matches on 560 of 10,816 mp3s and is excluded — see `FindLocationsOptions.exclude`. |

## Reproducibility — the timings, everywhere they have been taken

Same 624.6 MiB corpus, same page, same production classes, Chrome/Chromium 151
throughout. Rows are what each observer measured, not what anyone predicted.

| measurement | first run (what this file used to quote) | independent verifier, 4 profiles | integrator, fresh origin, cold → warm |
|---|---|---|---|
| insert 624.6 MiB | 2.5 s / 248 MiB/s / 0.23 ms | 12.7 s, 24.8 s / 25–49 MiB/s / 1.17–2.30 ms | **6.5 s → 5.6 s** / 96→111 MiB/s / 0.60→0.52 ms |
| random read | 0.13 ms | 0.20–1.06 ms | **0.25 → 0.15 ms** |
| rehash all payloads | 4.9 s / 128 MiB/s | 8.3–10.3 s / 61–76 MiB/s | **8.2 s / 76 MiB/s** (both runs) |
| `reclaim()` 1,920 pages | 6,597 ms | 35,024–53,882 ms | **28,720 → 10,569 ms** |
| +300 payloads | 198–210 ms | 386–696 ms | **413 → 427 ms** |

Nothing here changes the decision, and that is the point of measuring it: the
**architecture** claim is about a ratio of two orders of magnitude and the noise
is one factor of eight. But the *number* 2.5 s is not a fact about Hashigo, it is
a fact about one process on one machine on one afternoon, and it had already been
copied into a document written for Zach before anyone tried to reproduce it.

### The per-file alternative, re-measured in the same session

`notes/archive/browser-feasibility.md` §4's 65× / 20× came from one session on one
machine, and until now nobody had re-measured *both* halves together. The
integrator did, in the same browser, minutes apart: **1,000 individual OPFS
files** of the corpus's average payload size (60,551 B) over a 2-level hex
fanout, written with `createSyncAccessHandle` in a Worker, then 50 random reads,
then deleted.

```
1,000 files / 256 shard dirs: 19,297 ms  = 19.30 ms/file   (-> 10,816 files ~= 209 s)
50 random reads:                           14.31 ms/file
```

against the same session's BLOB rows at **0.52–0.60 ms** per payload written and
**0.15–0.25 ms** per random read. On this machine that is **32×–37× slower to
write and 57×–95× slower to read**, versus §4's 65× and 20×. So neither
multiplier reproduces exactly, the write gap is smaller than §4 claimed and the
read gap is much larger, and **the decision survives every measurement anyone has
taken by at least an order of magnitude in both directions.** Caveat, stated
plainly: 1,000 files is a sample extrapolated to 10,816, not the full corpus, and
per-file cost may well grow with directory size — §4's 29.78 ms/file over the real
10,816 is higher than this 19.30 ms/file over 1,000, which is consistent with
either growth or a slower machine-state.

## The one bug it caught that Node could not

`reclaim()` reported success having freed **1 page of 1,920**. `PRAGMA
incremental_vacuum` frees one page per `sqlite3_step()`, and better-sqlite3's
`exec()` drains the statement while sqlite-wasm's `oo1` `exec()` steps it once. The
fix is a loop inside `SqliteBlobStore.reclaim()`, which is the one place both
halves share. Nothing in Node could have found this.
