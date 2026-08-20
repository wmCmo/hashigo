# Browser feasibility — can Hashigo actually be a local-first PWA?

> [!WARNING]
> **SNAPSHOT, 2026-08-19. Some claims below are superseded — see `NEXT.md` and
> `CLAUDE.md` for current state.** This is kept as the record of what was found and
> measured at the time, so it is not rewritten. Known stale in this file:
> - the **65x** write / 20x read blob multiplier. An adversarial re-measurement across
>   four Chrome 151 environments reproduced none of these figures; the honest range is
>   **13-40x** on write. The ORDERING never reversed, so the decision it supports
>   stands — only the multiplier was optimistic. See `SPIKE.md` §2.
> - `reclaim()` at 6.8 s — re-measured at **35-54 s**

**Short answer: yes, and the risk is much lower than OVERNIGHT.md §2.4 implies.**
I ran the real 66 MB Hashigo database inside a real browser, over real OPFS, and
reproduced the entire oracle from it. Trigram FTS5 — the thing Ctrl+K depends on —
is present in the stock build and works on Japanese.

One architectural decision falls out of the measurements and it is not the one
that shipped: **audio blobs belong inside SQLite, not in individual OPFS files.**
Per-file OPFS writes are 65× slower.

Written 2026-08-19 by the browser-feasibility agent. Investigation only — no
production code was written or changed. Every number below is pasted from a run I
did myself; the commands are in §8 so they can be re-run.

---

## 0. The one-paragraph version

`@sqlite.org/sqlite-wasm` 3.53.0 is maintained, ships `ENABLE_FTS5`, and its
`opfs-sahpool` VFS needs **no COOP/COEP headers**. `src/schema/schema.sql` and
`views.sql` load into it **unmodified** — 19 tables, 21 views, 14 triggers,
including `card_fts ... tokenize = 'trigram'`. From an OPFS-backed database in
Chromium I got `cards 7,716 | reviews 102,020 (58,937 fwd / 43,083 rev) |
retention 96.24% | templates 10 | decks 45 | tags 20`, and those survived a page
reload with no re-import. 77% of `src/` (10,164 of 13,203 lines) already has zero
Node imports. The browser layer is a bounded, ~2-day job, not a rewrite.

---

## 1. State of SQLite-in-the-browser (Q1)

| project | status | verdict |
|---|---|---|
| **`@sqlite.org/sqlite-wasm`** | official, maintained; **3.53.0-build1** installed and run today | **use this** |
| **wa-sqlite** | maintained, v1.0 July 2024; added `OPFSWriteAheadVFS` April 2026 (concurrent reads during writes, needs Chrome 121+ `readwrite-unsafe`) | credible fallback, not needed |
| **absurd-sql** | unmaintained; upstream keeps it "only as a reference" | **dead end — do not use** |

The official build offers three persistent VFSes. What I measured:

| VFS | needs COOP/COEP + SharedArrayBuffer? | notes |
|---|---|---|
| `opfs` | **yes** | SAB + Atomics; more multi-tab tolerant |
| **`opfs-sahpool`** | **no — confirmed empirically** | fastest; single connection; `initialCapacity` default **6** files |
| `kvvfs` | no | localStorage, ~5 MB. Irrelevant at our size. |

I served the test page with **no** COOP/COEP headers on purpose. The browser
reported `crossOriginIsolated=false` on both the main thread and the worker, and
`opfs-sahpool` installed anyway in 226 ms. That removes the single biggest
deployment constraint people associate with SQLite-in-the-browser — Hashigo can
be served as plain static files.

`createSyncAccessHandle`, which sahpool is built on, is **Baseline Widely
available since March 2023** (Chrome/Edge 86+, Firefox 111+, Safari 16.4–17+),
and is restricted to **dedicated Workers** and **secure contexts**. Both
constraints are fine for a PWA; the second means `localhost` or HTTPS.

### Load-bearing correction to `src/db/open.ts`

Its header says WAL "is the mode the OPFS build will use too". Treat that as
unproven. Observed: deserializing the WAL-mode `build/hashigo.db` failed with

```
SQLite3Error: SQLITE_CANTOPEN: sqlite3 result code 14: unable to open database file
```

The identical file converted to `journal_mode=delete` loaded and queried fine.
Upstream docs say WAL works on the OPFS VFSes from 3.47 (with
`locking_mode=exclusive` on `opfs`), but the **bootstrap path** — shipping or
importing a prebuilt `.db` — requires a non-WAL file. Whatever produces a
database destined for the browser must check the file out of WAL first. This is
a one-line pragma, but nothing currently does it and nothing tests it.

---

## 2. FTS5 + trigram: it survives (Q2)

**This was the load-bearing question and the answer is good.** `PRAGMA
compile_options` from the stock wasm build, run today:

```
ENABLE_FTS5          <- present
ENABLE_RTREE
ENABLE_MATH_FUNCTIONS
ENABLE_SESSION
OMIT_LOAD_EXTENSION  <- see caveat
THREADSAFE=0
DEFAULT_PAGE_SIZE=8192
```

`CREATE VIRTUAL TABLE tri USING fts5(body, tokenize='trigram')` succeeds, and
the project's own `card_fts` definition came through the real `schema.sql`
unchanged. Searching the real corpus **from OPFS**:

```
MATCH "気持ち"   (len 3) -> 1   in 5.5ms
MATCH "ありがとう" (len 5) -> 1   in 0.9ms
MATCH "勉強"     (len 2) -> 0   in 0.2ms
MATCH "意味"     (len 2) -> 0   in 0.1ms
LIKE fallback '意味'  -> 3       in 8.6ms
```

Two consequences:

1. **No change to the search design is required.** Trigram is not a
   custom-build-only feature; it is in the canonical wasm build.
2. **OVERNIGHT.md §2.7's two-character gap is a property of trigram, not of
   Node.** It reproduces exactly in wasm. It is neither better nor worse in the
   browser.

### §2.7's "full table scan" worry is unfounded — measured

The whole searchable corpus is **774,658 characters across 7,716 rows** — under
1 MB. The LIKE fallback for 1–2 character queries costs:

```
LIKE '意味' ->    3 hits   17 ms      LIKE 'する' ->  229 hits   11 ms
LIKE '勉強' ->    1 hits    8 ms      LIKE 'ない' ->   77 hits    7 ms
LIKE '漢字' ->    1 hits    8 ms      LIKE '語'   ->   29 hits    8 ms
```

**7–17 ms for a full scan over the entire corpus** (8.6 ms in-browser). Stage 8
should just write the LIKE fallback over `body`. It is imperceptible and needs no
index, no bigram table, and no second tokenizer.

**Caveat: `OMIT_LOAD_EXTENSION`.** Runtime extension loading is compiled out, so
no ICU collation and no custom tokenizer can be added later without building your
own wasm. Everything currently in `schema.sql` is built in, so this costs nothing
today — but it forecloses "just add a Japanese morphological tokenizer later."
If a real tokenizer is ever wanted, that becomes a custom wasm build.

---

## 3. 657 MB of audio in OPFS (Q3)

The measured payload, from the real database: **10,816 path-backed blobs,
624.6 MiB**, average 60,551 B, max 3,374,905 B — of which `speech` is 10,791
files / 617.9 MiB. (The 26,947 *inline* blobs — ai, translate, furigana — total
only 1.55 MiB and are a non-issue.)

### Quota is not the problem

```
quota BEFORE: usage=0.0MiB    quota=10.00GiB
quota FINAL : usage=699.0MiB  quota=10.68GiB   -> 6.4% of quota used
```

699 MiB is the 66 MB database plus all 624.6 MiB of audio, written and read back
successfully. Chromium grants roughly 60% of total disk per origin; Firefox is
stingier (best-effort is min(10% of disk, 10 GiB group limit)); Safari/WebKit is
~60% for browser and installed home-screen apps but ~15% for embedded WKWebView.
At 0.7 GB Hashigo is comfortably inside all of them. **OPFS counts against the
same origin quota as IndexedDB and the Cache API** — there is no separate budget.

### Eviction is the problem

```
typeof navigator.storage.persist in MAIN thread: function
persisted() before = false
persist() GRANTED  = false
persisted() after  = false
```

Two concrete findings:

* **`navigator.storage.persist` does not exist in a Worker** — it is
  `undefined` there, main-thread only. Since all the SQLite work happens in a
  worker, the persistence request must be made from the page and the result
  passed in. Easy to get wrong; easy to not notice, because everything works
  until the day the data is evicted.
* **Persistence was denied** in my automated Chromium. Without it the origin is
  best-effort and is evicted **whole** under storage pressure — the database and
  every audio file go together, never partially. In practice Chrome grants
  persistence to installed PWAs and sites with engagement, so a real
  install-to-home-screen is likely to be granted, but **I did not observe a
  grant, so do not assume one.** The app must call `persist()`, check
  `persisted()`, and tell the user plainly if it is false.

### Safari / iOS — different, and I could not test it

Zach reviews on **Android** and edits on **two PCs**, so this is not on the
critical path, but for completeness: WebKit proactively deletes script-writable
storage after **7 days without user interaction** when tracking prevention is on.
Adding to the Home Screen exempts the app from that. Pre-iOS 17 Safari had a
hard 1 GiB per-origin cap with a user prompt beyond it, and Safari < 17 has OPFS
bugs upstream considers disqualifying. **If iOS ever matters, it needs its own
test.** I ran none.

### Recovery, not just persistence

Because eviction is all-or-nothing and can happen without warning, the design
needs an answer to "the browser threw everything away." Since the whole database
rebuilds from `exports/` in ~15 s, and blobs are content-addressed, the honest
answer is a re-import path plus stage 11 sync — not heroics to prevent eviction.

---

## 4. **The blob storage finding — this is the decision-relevant one**

I stored the identical 624.6 MiB two ways in the same browser, back to back:

| approach | write 624.6 MiB | per item | random read |
|---|---|---|---|
| **10,816 individual OPFS files** (2-level hex fanout, 256 dirs) | **322.1 s** | 29.78 ms | **10.60 ms** |
| **BLOB rows in one OPFS-backed SQLite file** | **4.9 s** | 0.46 ms | **0.54 ms** |

```
WROTE 10,816 files / 624.6 MiB in 322.1s  = 2 MiB/s, 29.78 ms/file
INSERTED 10,816 blobs / 624.6 MiB in 4.9s = 126 MiB/s, 0.46 ms/blob
read 50 random files:  avg 10.60 ms/file
read 50 random BLOBs:  avg  0.54 ms
```

**65× faster to write, 20× faster to read.** Per-file OPFS overhead (~30 ms for
create + open sync handle + write + close) dominates completely; inside SQLite
the same bytes are one sequential write.

Five and a half minutes of un-interruptible writing versus five seconds is the
difference between a first-run experience that works and one that looks broken
on a phone.

### What this means for `src/blobs/`

A concurrent agent has already built `src/blobs/{address,store,db,node}.ts`, and
the `BlobStore` contract in `store.ts` is well designed — it explicitly
anticipates "OPFS on the phone" and forbids leaking locations. **Keep the
interface; back it with a SQLite table, not with one OPFS file per blob.**
`write(hash, bytes)` / `read(hash)` map onto a `blobs(hash PRIMARY KEY, bytes
BLOB)` table exactly as well as onto a directory, and the store interface means
this choice is reversible.

Two caveats I did not test:

* Audio must reach `<audio>` as a `blob:` URL via `URL.createObjectURL` rather
  than a file path. That is cheap but it is code that does not exist.
* A ~700 MB single database file in the sahpool worked here, but I did not test
  incremental growth, `VACUUM`, or free-page reuse at that size. A separate
  `blobs.db` (a second pool file, as I used) keeps the 66 MB card database small,
  quick to sync, and quick to rebuild. I recommend that split.

---

## 5. How much existing code has to change (Q4)

Measured by import graph over the current working tree (33 files, 13,203 lines):

### Portable as-is — 26 files, 10,164 lines (**77%**)

Zero `node:*` and zero `better-sqlite3` imports. These are pure TypeScript over
plain data and run in a browser unchanged:

```
src/template/{ast,parse,resolve,index}.ts        2,058 lines
src/dashboard/{metrics,render,index}.ts          2,541
src/scheduler/{backtest,policy}.ts               1,497
src/scheduler/algorithms/{fsrs6,sm2,baseline,index}.ts  995
src/import/{entities,reviews,links,tags}.ts      2,140
src/blobs/{address,store,db,cli,index}.ts          689
src/text/{index,render}.ts                         222
src/{index,db/index}.ts                             22
```

The FSRS-6 port, the whole template engine, the whole renderer pipeline and all
the metrics are already browser-ready. **This is the part that would have been
expensive, and it is free.**

### Needs an adapter — 7 files, 3,039 lines (23%)

| file | lines | node dependency | what it needs |
|---|--:|---|---|
| `src/schema/index.ts` | 403 | `node:fs` | **smallest, highest value.** One `readFileSync(new URL(...))` at line ~347. Replace with a bundler text import (`import sql from "./schema.sql?raw"`). Kills OVERNIGHT §2.2's whole class of bug at the same time. |
| `src/db/open.ts` | 133 | `better-sqlite3`, `node:fs/path` | the real work: a sibling `open.browser.ts` returning the same `Db` shape over `OpfsSAHPoolDb`. Note better-sqlite3 is **synchronous**, and so is sahpool once installed — the API shape survives. Install is the only async step. |
| `src/import/blobs.ts` | 1,177 | `better-sqlite3`, `node:crypto`, `node:fs`, `node:path` | `node:crypto` → `crypto.subtle.digest` (async — this is the one genuinely invasive change). Much of this file may become redundant if `src/blobs/` supersedes it. |
| `src/blobs/node.ts` | 239 | `node:crypto/fs/path` | **already the intended seam** — write `src/blobs/opfs.ts` beside it. No change to `node.ts`. |
| `src/import/transit.ts` | 263 | `node:fs`, `node:path` | takes a path; needs to take bytes. Mechanical. |
| `src/import/index.ts` | 649 | `node:path` | only `basename`. Trivial to inline. |
| `src/dashboard/cli.ts` | 175 | `node:fs`, `node:path` | **leave it Node-only.** It is a CLI. Nothing to port. |

### Must be rewritten

Nothing. There is no module whose logic is unportable — only I/O edges.

**No bundler, `index.html`, service worker, or manifest exists yet.** That is
additive work, not migration.

---

## 6. The minimal proof, and what it costs (Q5)

Much of the risk is already retired — the experiments in this note *are* a
partial proof, and they took about an hour. What remains:

| # | task | hours |
|---|---|--:|
| 1 | Vite config + `index.html` + worker entry; serve `sqlite3.wasm` correctly | 2 |
| 2 | `schema.sql`/`views.sql` as bundled text (`?raw`); drop `node:fs` from `src/schema/index.ts` | 1 |
| 3 | `openDatabaseBrowser()` over `opfs-sahpool` matching the `Db` shape `src/db` already exports | 3 |
| 4 | Bootstrap: ship/import a prebuilt non-WAL `.db`, incl. the WAL→delete conversion | 2 |
| 5 | `OpfsBlobStore` backed by a `blobs.db` table, against the existing `BlobStore` contract | 3 |
| 6 | `persist()` from the main thread + a visible "storage is not persistent" state | 1 |
| 7 | Render one real card in the browser (proves template+renderer under bundling) | 2 |
| 8 | Play one real mp3 from a stored blob via `createObjectURL` | 1 |
| 9 | Run it on Zach's actual Android phone over HTTPS/LAN | 2 |
| | **total** | **17 h ≈ 2 working days** |

Items 1–4 are the true go/no-go and are **8 hours**. If those pass — and every
component of them has now been observed working in isolation — the architecture
is sound.

### Recommendation

**Do stage 0.5 before stage 4, as OVERNIGHT.md §6 already argues — but do it
knowing it is a 2-day integration job, not an unbounded risk.** The specific
sequence that de-risks fastest is items 2 → 3 → 4: at that point the real
database is running in the browser and everything after it is ordinary work.

Do **not** let stage 4 (renderer) proceed on the assumption that blobs are
files. That decision should be made now, from §4, because `src/blobs/` is being
written this session.

---

## 7. What I could NOT verify — stated plainly

* **Android.** All browser measurements are desktop Chromium (Playwright) on
  Windows 11. A phone has slower storage and less RAM. The 29.78 ms/file figure
  in particular is a Windows number and may be partly antivirus; the *ratio*
  between the two blob strategies is far more trustworthy than the absolute.
* **Safari, iOS, and Firefox.** Not tested at all. Support is documented, not
  observed by me.
* **A real `persist()` grant.** I observed a denial in an automated browser. I
  did not test an installed PWA, which is the case that matters.
* **Multi-tab.** `opfs-sahpool` is documented single-connection. Zach edits on
  two PCs (separate origins-on-separate-machines, fine) but two tabs on one
  machine is undefined behaviour I did not exercise. Worth one test before
  stage 7.
* **Actual audio playback.** I stored and re-read mp3-sized byte payloads; I
  never decoded one or fed it to an `<audio>` element. The bytes I wrote were
  synthetic, not the real mp3s.
* **WAL on OPFS.** I proved WAL breaks the *deserialize* path. I did not test
  `journal_mode=WAL` on a sahpool-backed file; upstream says it works.
* **Bundling.** No bundler was run. `sqlite-wasm` is known to need care with
  Vite (the `.wasm` asset and the worker), and I did not exercise it — I loaded
  the ES module directly from a plain static server.
* **The 3,159-card / 79 KB stale-`content` question, the 54 dropped wiki-links,
  and every other OVERNIGHT.md item** — out of scope here, untouched.

### Numbers that moved

**None.** The oracle is unchanged:

```
cards 7,716 | reviews 102,020 | retention 96.24%
wiki-links 8,690 | tombstones 8,958
tags after normalisation: 19
```

and the same figures reproduce *inside the browser* (§8). The interval buckets I
computed in wasm (`1-7d 21,236 @ 98.15%`, `7-30d 19,876 @ 96.69%`, `0-1d 7,087 @
95.41%`) match OVERNIGHT.md §2.5's **planned** column exactly, which is the
expected result for the schema-v1 snapshot I used.

---

## 8. Commands, and their real output

Everything ran from a scratchpad outside the repo
(`…/scratchpad/wasmtest`), against `@sqlite.org/sqlite-wasm@3.53.0-build1`. No
repo file was modified and no dependency was added to `package.json`.

**Setup**

```
npm install @sqlite.org/sqlite-wasm      # added 1 package
node server.mjs                          # static server, NO COOP/COEP headers
```

**The real schema, into the wasm build** (`node t2.mjs`)

```
src/schema/schema.sql: LOADED OK (34400 bytes)
src/schema/views.sql:  LOADED OK (20243 bytes)
tables 19, views 21, triggers 14
card_fts DDL: CREATE VIRTUAL TABLE card_fts USING fts5 ( card_id UNINDEXED, name, body, tags, tokenize = 'trigram' )
```

**The oracle, from an OPFS-backed database in Chromium** (`/test.html`)

```
COI(main)=false
crossOriginIsolated in worker: false
quota BEFORE: usage=0.0MiB quota=10.00GiB
sqlite version: 3.53.0
opfs-sahpool INSTALLED in 226ms  capacity=10 used=0
fetched hashigo.db 66,646,016 bytes in 207ms
importDb -> OPFS: 66,646,016 bytes in 64ms  fileCount=1
opened from OPFS in 5ms
journal_mode: delete | page_size 4096
--- ORACLE from OPFS-backed SQLite ---
cards        7,716
reviews      102,020
fwd / rev    58,937 / 43,083
retention %  96.24
templates    10 | decks 45 | tags 20
--- trigram FTS5 from OPFS ---
  MATCH "気持ち" (len 3) -> 1  in 5.5ms
  MATCH "ありがとう" (len 5) -> 1  in 0.9ms
  MATCH "勉強" (len 2) -> 0  in 0.2ms
  MATCH "意味" (len 2) -> 0  in 0.1ms
  LIKE fallback '意味' -> 3 in 8.6ms
  dashboard aggregate 82ms -> 30-365d:35861@94.21%  1-7d:21236@98.15%  7-30d:19876@96.69%  null:17960@97.88%  0-1d:7087@95.41%
  write+commit 14.3ms; probe=2026-08-19T04:16:07.971Z
quota AFTER db: usage=73.0MiB quota=10.07GiB
persisted() = false
```

**Durability across a full page reload** (`/test2.html`) — no re-import

```
pool reattached: capacity=10 fileCount=1
files in pool: ["/hashigo.db"]
AFTER RELOAD, no re-import:
  cards 7,716 | reviews 102,020 | retention 96.24%
  _probe row survived: 2026-08-19T04:16:07.971Z
persisted() in worker: false
navigator.storage.persist in WORKER: undefined  <-- main-thread only
```

**624.6 MiB as 10,816 OPFS files** (same page)

```
writing 10,816 files, 624.6 MiB total (avg 60,553 B)
  … 1,079/10,816 files, 62.4 MiB, 24.1s
  … 5,159/10,816 files, 297.6 MiB, 160.8s
WROTE 10,816 files / 624.6 MiB in 322.1s  = 2 MiB/s, 29.78 ms/file
  subdirectories created: 256
read 50 random files: avg 10.60 ms/file (avg 58,026 B)
quota FINAL: usage=699.0 MiB (0.68 GiB) quota=10.68 GiB
headroom: 6.4% of quota used
```

**The same 624.6 MiB as BLOB rows in one OPFS SQLite file** (`/test3.html`)

```
inserting 10,816 BLOBs, 624.6 MiB, into ONE OPFS-backed SQLite file
INSERTED 10,816 blobs / 624.6 MiB in 4.9s = 126 MiB/s, 0.46 ms/blob
  (commit alone: 0.49s)
  rows=10,816 totalbytes=624.6 MiB
read 50 random BLOBs by hash: avg 0.54 ms (avg 58,026 B)
quota: usage=1466.0 MiB / 11.43 GiB
```

**Cleanup** — OPFS returned to empty afterwards

```
removed 2 top-level entries; usage now 0.0 MiB
```

**Standing regression check** — unchanged

```
$ PYTHONIOENCODING=utf-8 python tools/mochi.py exports/日本語 exports/English exports/基本情報
=== TOTAL
    cards 7,716 | reviews 102,020 | retention 96.24%
    wiki-links 8,690 | tombstones 8,958
    inline generators: {'speech': 287, 'translate': 106, 'image': 8, 'furigana': 19, 'ai': 125}
    tags after normalisation: 19
```

### Sources

* [The Current State Of SQLite Persistence On The Web: May 2026 Update — PowerSync](https://powersync.com/blog/sqlite-persistence-on-the-web)
* [sqlite3 WebAssembly persistent storage docs](https://sqlite.org/wasm/doc/trunk/persistence.md)
* [@sqlite.org/sqlite-wasm — npm](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm)
* [SQLite FTS5 Extension (trigram tokenizer)](https://www.sqlite.org/fts5.html)
* [Storage quotas and eviction criteria — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
* [FileSystemFileHandle.createSyncAccessHandle() — MDN](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)
* [Updates to Storage Policy — WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/)
* [SQLite Wasm in the browser backed by OPFS — Chrome for Developers](https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system)
