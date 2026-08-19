# `spike/` — THROWAWAY

**Everything in this directory is disposable harness.** It exists to settle
questions that could not be settled by reasoning, and it is safe to delete once
the PWA shell in `src/` exists. Nothing in `src/` imports it. Do not build on it;
build on `src/db/browser.ts`, which is the production half of this work.

The one file here worth keeping in some form is `contract-compat.ts` — see below.

```
spike/
  index.html          the page
  main.ts             main thread: DOM, persist(), header check, misuse probes
  db.worker.ts        the dedicated Worker: ALL SQLite work happens here
  protocol.ts         the messages between them
  contract-compat.ts  tsc-only proof that better-sqlite3 satisfies SqliteHandle
  make-bootstrap.mjs  build/hashigo.db -> a checkpointed, non-WAL copy to fetch
```

## Run it

```bash
npm run spike:bootstrap    # once; makes build/spike/hashigo-bootstrap.db (69 MB)
npm run spike:build        # vite build -> build/spike-dist/
npm run spike:preview      # http://localhost:4273  (this is the PASS condition)
npm run spike:dev          # http://localhost:5273  (dev server, also verified)
npm run spike:check        # tsc: the two handles satisfy one contract
```

`build/` is gitignored, so neither the 69 MB bootstrap database nor the bundle
output can enter the repo.

## What it settled

| question | answer, measured |
|---|---|
| Does `@sqlite.org/sqlite-wasm` survive a Vite bundle? | Yes, with `optimizeDeps.exclude`. Rollup emits `assets/sqlite3-*.wasm` and rewrites the URL itself. |
| Does `opfs-sahpool` need COOP/COEP? | No. `crossOriginIsolated=false`, `SharedArrayBuffer` undefined, no `cross-origin-*` response header served, pool installs anyway. |
| Do `schema.sql` / `views.sql` load unmodified? | Yes, as `?raw` text: 19 tables, 21 views, 14 triggers, 20 indexes, `card_fts ... tokenize='trigram'`. |
| Does WAL work on OPFS? | **No.** `PRAGMA journal_mode = WAL` reports `delete` and the mode does not change. `src/db/open.ts`'s old comment was wrong and has been corrected. |
| Can it run on the main thread? | **No.** `createSyncAccessHandle` is absent from `FileSystemFileHandle.prototype` outside a worker in Chrome 148 and 151; the install fails with `Missing required OPFS APIs`. |
| What happens past `initialCapacity`? | `SQLITE_CANTOPEN: result code 14: unable to open database file` — the *same* message an unrelated failure gives. Not `SQLITE_FULL`. |
| Does it survive a reload? | Yes. A probe row written before the reload is read back after it, with no re-import. |

## The real output, pasted

`npm run spike:preview` → `http://localhost:4273/`, second load (the reload
path). Chromium 151 via Playwright, Windows 11. A screenshot of this run is at
`build/spike/hashigo-spike-opfs-oracle.png`.

```
1. environment
  inDedicatedWorker()      true
  isSecureContext          true
  crossOriginIsolated      false  <- no COOP/COEP is set
  SharedArrayBuffer        undefined
  navigator.storage.persist in WORKER: undefined
  page reported persisted(): false
2. sqlite-wasm, loaded through the bundler
  sqlite 3.53.0 initialised in 32.2ms
  wasm entry: 3530000 / 2026-04-09 11:41:38
  compile option ENABLE_FTS5: present
  compile option ENABLE_RTREE: present
  compile option ENABLE_MATH_FUNCTIONS: present
  compile option THREADSAFE=0: present
3. opfs-sahpool
  installed as vfs "opfs-sahpool" in 99.3ms
  capacity 12 (requested 12, sqlite-wasm default is 6), files 2
  files: ["/spike-fresh.db","/hashigo.db"]
4. src/schema/*.sql -> a fresh OPFS database
  schema.sql 35,034 chars, views.sql 21,769 chars (bundled as ?raw text)
  created and applied in 23.1ms
  index    20
  table    19
  trigger  14
  view     21
  card_fts tokenizer: CREATE VIRTUAL TABLE card_fts USING fts5 ( card_id UNINDEXED, name, body, tags, tokenize = 'trigram' )
  user_version 2; src/db/browser.ts says 2, src/schema/index.ts says 2
  journal_mode: delete -> asked for WAL -> reported delete -> now delete
  WAL does NOT take on sahpool; it stays delete. open.ts's comment was wrong.
  integrity_check + foreign_key_check: ok
  applySchema on an already-stamped database applied nothing
5. the real 7,716-card database in OPFS
  /hashigo.db is already in OPFS — NOT re-importing (this is the reload path)
  opened /hashigo.db in 2.4ms
  cards        7,716
  reviews      102,020
  fwd / rev    58,937 / 43,083
  retention    96.24%
  decks        39   templates 10
  tags         19 with cards (20 rows)
  card_links   8,744
  active days  1,317  2022-06-28 -> 2026-08-18
  study hours  636.1
  blobs        37,763, with a path: 0
  ORACLE MATCHES on every figure, from OPFS
  query times: study_totals 321.6ms | track split 36.5ms | decks 0.3ms | tags 0.0ms |
               tag_usage 0.2ms | card_links 0.3ms | templates 0.1ms | blobs 3.5ms | blobs.path 14.6ms
  probe row from an earlier run SURVIVED: 2026-08-19T11:07:41.318Z
  wrote probe 2026-08-19T11:08:30.843Z (1 row) and committed in 4.2ms
  MATCH "気持ち" (len 3) -> 1 in 0.5ms
  MATCH "ありがとう" (len 5) -> 1 in 0.4ms
  MATCH "勉強" (len 2) -> 0 in 0.0ms
  LIKE fallback '意味' -> 3 in 4.2ms
6. pool and quota
  capacity 12, files 2: ["/hashigo.db","/spike-fresh.db"]
  navigator.storage.estimate(): usage 77.0 MiB / quota 10.08 GiB
  persisted() in worker: false
ALL STEPS COMPLETED
```

First load of the same build, which imports instead of reattaching:

```
  fetched 69,173,248 bytes in 269.7ms
  header write=1 read=1 (1 = rollback journal, 2 = WAL)
  importDb -> OPFS: 69,173,248 bytes in 53.7ms
  no probe row from an earlier run (first run in this OPFS)
```

The two deliberate misuses:

```
MAIN-THREAD PROBE — installing opfs-sahpool outside a worker
  REFUSED on the main thread: Error: could not install the opfs-sahpool VFS: Missing required OPFS APIs.

POOL EXHAUSTION PROBE
  capacity 12, files 2 before
  opened and wrote /probe-0.db; files now 3
  ... (probe-1 .. probe-8)
  opened and wrote /probe-8.db; files now 11
  refused after 10 extra database(s): SQLite3Error: SQLITE_CANTOPEN: sqlite3 result code 14: unable to open database file
  cleaned up; capacity 12, files 2: ["/hashigo.db","/spike-fresh.db"]
```

Read that last one carefully: `/probe-9.db` **opened** (12 of 12 slots) and then
its first *write* failed, because the rollback journal needs a slot of its own
and there was none. So capacity is not exhausted at open time — it is exhausted
at the first transaction after open, with an error message that says nothing
about capacity.

And `optimizeDeps.exclude` earning its place — the config with the exclude
removed, same page:

```
FAILED: RuntimeError: Aborted(CompileError: WebAssembly.instantiate():
  expected magic word 00 61 73 6d, found 3c 21 64 6f @+0)
  at instantiateArrayBuffer (.../node_modules/.vite/deps/@sqlite__org_sqlite-wasm.js)
```

`3c 21 64 6f` is `<!do` — the dev server's HTML fallback, because the pre-bundled
copy under `node_modules/.vite/deps/` has no `sqlite3.wasm` beside it.
