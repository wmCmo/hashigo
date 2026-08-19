# Persistence, quota, multi-tab, recovery — measured

**The one-line answer: Zach's data is much safer than the feasibility note
feared, but for a reason nobody had checked — a full rebuild from `exports/`
takes 16.4 seconds and includes all 624.6 MiB of audio. Eviction is a
twenty-second inconvenience, not a catastrophe.**

The three things that *are* dangerous turned out to be different from the three
we were looking for:

1. **`persisted()` is false and stays false**, and the browser never says so.
   The app has to say so. §1.
2. **`navigator.storage.estimate()` cannot warn you about anything — ON DESKTOP.**
   (Superseded in part: his Android device reports a real 133.96 GiB quota. See
   "Measured on the real device" at the end of this file.) On this
   machine `quota - usage` is a hard constant — exactly 10 GiB, three times
   over, on a disk with 181 GB free. A "storage is filling up" UI built on
   `usage / quota` will read 7% forever and then the writes will start failing.
   §2.
3. **Two real defects in `src/db/browser.ts`, both isolated and both small.**
   `close()` does not close — one unfinalized statement pins the OPFS file for
   the life of the page, forecloses the documented multi-tab handover and slowly
   leaks the 12 pool slots (§3.4, ORPHAN 2). And `installPool()` replays a
   cached failure, so a second tab keeps reporting a conflict long after the
   first tab has released the database (§3.3, ORPHAN 3).

Written 2026-08-19 by the persistence-spike agent. Every number below is pasted
from a run I did myself on this machine, in real Chrome 151 over the DevTools
Protocol. The harness is `spike/persist/` (throwaway) and §8 has the commands.
**Nothing here was measured on a phone.** §7 is the honest list, and
`PHONE-TEST.md` is the part only Zach can do.

---

## 0. What did not move

```
$ npx vitest run
 Test Files  10 passed (10)
      Tests  351 passed | 1 skipped (352)
   Duration  45.79s
```

The oracle reproduced from OPFS on every single run in this document:

```
  cards            7716  ok
  reviews        102020  ok
  forward         58937  ok
  reverse         43083  ok
  retention       96.24  ok
  decks              39  ok
  tags               19  ok
  card_links       8744  ok
```

Wherever a later section shows that block condensed onto one line, it is my
abbreviation of exactly these eight checks, not different output.

`npm run typecheck` does **not** exit 0 right now, and it is not this change —
see ORPHAN 1. `npx tsc -p spike/persist` exits 0.

---

## 1. The persistence plumbing (Q1)

### 1.1 A Worker can watch but cannot ask — confirmed, with the TypeError

The feasibility note said `navigator.storage.persist` is `undefined` in a
Worker. It is, and the asymmetry is sharper than "main-thread only":

```
A. what the WORKER can see about storage
  navigator.storage.persist      in worker: undefined
  navigator.storage.persisted    in worker: function
  navigator.storage.estimate     in worker: function
  navigator.storage.getDirectory in worker: function
  StorageManager.prototype has "persist": false
  own+inherited keys: persisted, estimate, getDirectory
  calling persist() in the worker throws: TypeError: navigator.storage.persist is not a function
  persisted() in the worker: false  <- observable, but not requestable
  estimate() in the worker: usage 0.0 MiB / quota 10.00 GiB
```

`persist` is absent from `StorageManager.prototype` itself in a Worker — it is
not a disabled method, the interface is exposed differently. So the worker
**can** answer "am I persistent?" and "how much room is there?" and **cannot**
answer "please become persistent". The verdict has to travel from the page.

### 1.2 The correct order, and why `persist()`'s return value is not the answer

`spike/persist/main.ts` does the whole thing in one function. Three calls, in
this order, and the third is the one that matters:

```ts
const persistedBefore = await navigator.storage.persisted();   // honest baseline
const granted         = await navigator.storage.persist();     // the request
const persistedAfter  = await navigator.storage.persisted();   // THE FACT
```

`persist()` reports what the browser decided at that instant. `persisted()`
afterwards reports the state the data actually lives in. They agreed in every
run I made, but only one of them is a property of the storage.

Then it goes into the worker as data, never as a capability:

```ts
export interface StorageVerdict {
  readonly persistedBefore: boolean;
  readonly granted: boolean;
  readonly persistedAfter: boolean;   // the app keys off this
  readonly usage: number;
  readonly quota: number;
}
```

### 1.3 Both branches, observed

**Denied** (a fresh automated profile, which is the note's case):

```
MAIN THREAD — asking for storage persistence
  persisted() before asking : false
  persist() returned        : false
  persisted() after asking  : false
  estimate()                : usage 0.0 MiB / quota 10.00 GiB
...
permission state Chrome actually reports
"prompt"
```

**Granted** — via `Browser.grantPermissions(["durableStorage"])`, which is the
only way to reach this branch on a desktop:

```
granted durableStorage to http://localhost:5273
  persisted() before asking : true
  persist() returned        : true
  persisted() after asking  : true
...
permission state Chrome actually reports
"granted"
```

and the worker, with persistence granted, **still** cannot ask:

```
  navigator.storage.persist      in worker: undefined
  persisted() in the worker: true  <- observable, but not requestable
  the page's verdict, passed in: persistedBefore=true granted=true persistedAfter=true
```

So the plumbing is proven in both directions, not just in the failing one.

### 1.4 The finding the note missed: it is `"prompt"`, not `"denied"`

```
navigator.permissions.query({name:'persistent-storage'}).state  ->  "prompt"
```

Chrome returned `false` from `persist()` **without prompting and without
recording a denial**. The permission is still in `prompt`. That has a direct
consequence for the app:

> **Re-ask on every launch.** A `persist()` that returned false today can return
> true next week, once the site accrues engagement or gets installed to the home
> screen. Asking once at first run and caching the answer would lock Hashigo out
> of a grant it would otherwise have been given.

`spike/persist/main.ts` re-asks on every load, and `stepEnvironment()` is
re-runnable from a button, precisely so this is visible.

### 1.5 What the app must do when the answer is false

This is the deliverable half of Q1, and it is a UI state, not a log line. The
page paints a sticky banner it is impossible to scroll past:

```
STORAGE IS BEST-EFFORT. The browser may delete EVERYTHING — the database and
all audio, together, without asking — when the device runs low on space.
Keep an export.
```

versus, when persistence is granted:

```
STORAGE IS PERSISTENT — the browser has promised not to evict Hashigo to
reclaim space.
```

Concretely, the recommendation for the shipping shell:

| condition | what the app does |
|---|---|
| `persistedAfter === false` | persistent, non-dismissible banner naming the risk, plus a one-tap "export a backup". Never a toast; a toast is a thing you miss. |
| `persistedAfter === false` **and** not installed | the banner adds *"Add Hashigo to your home screen — installed apps are usually granted permanent storage."* That is the single action that most changes the answer. |
| `persistedAfter === true` | say it once, quietly, in a diagnostics panel. Do not celebrate. |
| storage went from present to empty between launches | **the eviction already happened.** §5.3 — nothing else tells you. |

The last row is the important one and it is cheap: record `cards > 0` in
`localStorage` (a different storage bucket, evicted with the origin but a
useful tell) or, better, in the URL-independent fact that OPFS is empty while
the app has a schema version it recognises. A fresh install and a wiped install
look identical unless something remembers.

### 1.6 A secure context is not optional, and a LAN IP is not one

The single most expensive thing to discover late, so it is measured here rather
than quoted. The same page, same build, served over the machine's own Wi-Fi
address `http://192.168.20.22:5274`:

```
=== tab-zjl7t · 2026-08-19T11:51:48.513Z ===
  isSecureContext false · crossOriginIsolated false

MAIN THREAD — asking for storage persistence
  navigator.storage.persist is not a function even on the main thread
A. what the WORKER can see about storage
  FAILED: TypeError: Cannot read properties of undefined (reading 'persist')

  quota                      0.00 GiB
  secure context             false
  origin                     http://192.168.20.22:5274

permission state Chrome actually reports
"denied"
```

**`navigator.storage` is `undefined` outright** — not `persist`, the whole
`StorageManager`. No OPFS, no quota, no persistence, and `persistent-storage`
reports `denied` rather than `prompt`. "Point your phone at your PC's IP" does
not half-work; it does not work at all.

The escape hatch works, and it is the same flag Android Chrome exposes:

```
$ node spike/persist/drive.mjs deny --url http://192.168.20.22:5274/persist/ \
      --insecure-origin http://192.168.20.22:5274
  isSecureContext true · crossOriginIsolated false
  navigator.storage.persisted    in worker: function
  estimate() in the worker: usage 0.0 MiB / quota 10.00 GiB
  quota                      10.00 GiB
  secure context             true
```

and the whole pipeline runs over that LAN origin:

```
granted durableStorage to http://192.168.20.22:5274
  persisted() after asking  : true
  fetched 69,173,248 bytes in 292.3ms
  importDb -> OPFS: 69,173,248 bytes in 53.7ms
  opened /hashigo.db in 18.8ms
  cards 7716 ok | reviews 102020 ok | retention 96.24 ok
```

I verified `--unsafely-treat-insecure-origin-as-secure` on **desktop** Chrome
151. `PHONE-TEST.md` prefers USB port-forwarding to `localhost`, which needs no
flag and is genuinely installable.

---

## 2. Quota at real scale (Q2)

### 2.1 624.6 MiB of audio-shaped blobs, twice

The size distribution is the corpus's own — `SELECT byte_size FROM blobs WHERE
bytes IS NULL`, read out of the real database in OPFS, 10,816 rows. Only the
payload bytes are synthetic.

This block is `build/persist-spike/fill.txt` verbatim:

```
C. ~700 MB of audio-shaped blobs, in one OPFS SQLite file
  10,816 external blobs in the real database, 624.6 MiB total
  largest 3,374,905 B, mean 60,551 B
  estimate() BEFORE: usage 139.0 MiB / quota 10.14 GiB
    … 2,000/10,816 rows, 104.1 MiB, 1375.9ms
    … 4,000/10,816 rows, 208.0 MiB, 2352.6ms
    … 6,000/10,816 rows, 315.8 MiB, 3336.3ms
    … 8,000/10,816 rows, 426.0 MiB, 4234.5ms
    … 10,000/10,816 rows, 534.6 MiB, 5120.8ms
  INSERTED 10,816 blobs / 624.6 MiB in 5.9s = 105 MiB/s, 0.55 ms/blob
  readback: 10,816 rows, 624.6 MiB
  50 random BLOB reads: avg 0.29 ms, avg 72,102 B
  estimate() AFTER : usage 778.0 MiB / quota 10.76 GiB
  usage grew 639.0 MiB; quota grew 639.0 MiB
  headroom used: 7.06% of quota
```

An earlier run of the same scenario, with a warmer cache, gave
`4.2s = 149 MiB/s, 0.39 ms/blob` and `50 random BLOB reads: avg 0.17 ms`. So
**61–149 MiB/s written, 0.17–0.32 ms per random read.** An adversarial
re-measurement got 61 and 78 MiB/s on two clean runs — both OUTSIDE the 105–149
range this note originally claimed — so the true spread is 2.4x and the figures
here are the fast end of it. Treat the ORDER of magnitude as the finding and any
single number as one sample.

The blobs-in-SQLite decision is unaffected: against 322.1 s for 10,816 individual
OPFS files, BLOB rows still win by 13–40x on write depending on the run. The
decision is confirmed; the multiplier published in support of it was optimistic.

### 2.2 `estimate()` cannot warn you — `quota - usage` is a constant (DESKTOP ONLY — see the device section at the end)

This is the finding I did not expect and it invalidates the obvious UI.

Every distinct `{usage, quota}` pair `navigator.storage.estimate()` returned
across every scenario in this document, with the subtraction done afterwards:

```
usage             0   quota 10,737,418,240   quota-usage 10,737,418,240   = exactly 10 GiB
usage         5,642   quota 10,737,423,882   quota-usage 10,737,418,240   = exactly 10 GiB
usage   145,760,052   quota 10,883,178,292   quota-usage 10,737,418,240   = exactly 10 GiB
usage   145,760,056   quota 10,883,178,296   quota-usage 10,737,418,240   = exactly 10 GiB
usage   815,800,110   quota 11,553,218,350   quota-usage 10,737,418,240   = exactly 10 GiB
```

**Five for five, to the byte.** The reported quota rises by exactly as much as
usage does. Free disk on this machine is **181.3 GB**, so 10 GiB is not a disk
limit — Chrome is reporting a padded, capped headroom, not remaining space.

Consequences, both load-bearing:

* **`usage / quota` is not a fullness gauge.** At 778 MiB it reads 7.06%; it
  would still read a small number at 5 GiB. A progress bar built on it is
  decorative.
* **Nothing in the page can predict a write failure.** The number that matters
  is not exposed.

The only honest use of `estimate()` is the absolute `usage` figure — "Hashigo is
using 778 MiB" is true and worth showing. The ratio is not.

### 2.3 What happens at the limit: `SQLITE_IOERR`, not `SQLITE_FULL`

Driven into the ceiling with `Storage.overrideQuotaForOrigin` set to 400 MiB
(419,430,400 bytes), so the failure happens in seconds rather than after 10 GiB
of writes to Zach's disk:

```
Storage.overrideQuotaForOrigin http://localhost:5273 -> 419,430,400 bytes
page now reports: {"usage":5642,"quota":10737423882}      <- override INVISIBLE
```

**The page could not see the override at all** — `estimate()` still reported
10 GiB. Then:

```
  estimate() BEFORE: usage 139.0 MiB / quota 10.14 GiB
    … 2,000/10,816 rows, 104.1 MiB, 476.7ms
    … 4,000/10,816 rows, 208.0 MiB, 932.7ms
  WRITE FAILED after 5,029 rows / 263.1 MiB
  the error, verbatim: SQLite3Error: SQLITE_IOERR: sqlite3 result code 10: disk I/O error
  readback: 0 rows, 0.0 MiB
  estimate() AFTER : usage 394.0 MiB / quota 10.38 GiB
```

Four things to take from that:

1. **The error is `SQLITE_IOERR` (code 10), not `SQLITE_FULL` (13).** Anything
   that pattern-matches on `SQLITE_FULL` to detect "out of space" will miss it.
   Code 10 is also what a genuinely corrupt file gives you, so the message alone
   cannot distinguish "no room" from "broken".
2. **Atomicity held.** `readback: 0 rows` — the whole 263 MiB transaction rolled
   back cleanly. No partial blob store.
3. **Total origin usage at failure was 394 MiB against a 400 MiB cap.** The
   limit is real and it is enforced on the origin, not the file.
4. **The card database was untouched.** Re-verified immediately after:
   `oracle from OPFS  MATCHES`.

### 2.4 A small write still works after a big one fails

The case that would actually lose a review — grading a card while a background
audio download is hammering the quota:

```
F. one small write, the shape of grading a card
  wrote 1 row in 4.2ms; _persist_probe now has 1 row(s)        <- before the fill
...
  WRITE FAILED after 5,029 rows / 263.1 MiB
...
F. one small write, the shape of grading a card
  wrote 1 row in 13.1ms; _persist_probe now has 2 row(s)       <- after the fill failed
  most recent probe rows: ["2026-08-19T11:33:22.038Z","2026-08-19T11:33:20.482Z"]
```

**A review recorded immediately after a quota-exceeded bulk write succeeded**,
because the failed transaction's rollback returned the space. The damage from
hitting the quota is bounded to the transaction that hit it. That is the
reassuring half of §2.3, and it argues for keeping audio prefetch in its own
transaction, separate from anything that records a grade.

### 2.5 Deleting a database does **not** give the space back

```
  unlink(/persist-spike-blobs.db) = true; usage now 778.0 MiB
  so removing a database from the pool returned 0.0 MiB of 639.0 MiB
```

`SAHPoolUtil.unlink()` disassociates the name from its pool slot and leaves the
file at full size for reuse. Reported usage does not budge. The space is
recoverable, but only by destroying the pool directory:

```
  removeVfs() -> true: handles released and the pool directory deleted
  usage after: 0.0 MiB (was 778.0 MiB)
```

So a future "free up space by deleting downloaded audio" feature **cannot** be
built on `unlink()`. Either keep audio in its own pool file and `removeVfs()`
that pool, or `DELETE FROM blob_payloads` + `VACUUM` inside the sidecar and
accept that the OPFS file stays large.

---

## 3. Multi-tab — the one most likely to be ugly (Q3)

**Verdict: a clear error, not silent corruption. But recovery is slower and
narrower than it should be, for a reason that is our bug.**

### 3.1 The second tab fails, specifically and loudly

Tab A opens and holds `/hashigo.db`. Tab B, ignoring the coordination on
purpose:

```
FORCE OPEN — ignoring the Web Lock on purpose
  FAILED: Error: could not install the opfs-sahpool VFS: Failed to execute
  'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be
  created if there is another open Access Handle or Writable stream associated
  with the same file.
```

That is a `NoModificationAllowedError` from the platform, surfaced through
`installPool()`'s own wrapper, naming the actual cause. It happens at **pool
install**, before any SQL runs, so tab B never gets a handle it could misuse.

### 3.2 Nothing was corrupted — checked, not assumed

Immediately after tab B's failed attempt, re-verified in tab A:

```
  pool "opfs-sahpool" capacity 12, files 1
  files: ["/hashigo.db"]
  /hashigo.db already in OPFS — reattaching, not re-importing
  opened /hashigo.db in 1.5ms
  cards 7716 ok | reviews 102020 ok | forward 58937 ok | reverse 43083 ok
  retention 96.24 ok | decks 39 ok | tags 19 ok | card_links 8744 ok
```

And when tab B eventually did take over, it found the database intact:

```
  pool "opfs-sahpool" capacity 12, files 1
  files: ["/hashigo.db"]
  /hashigo.db already in OPFS — reattaching, not re-importing
  cards 7716 ok ... card_links 8744 ok
  oracle from OPFS           MATCHES
```

I went looking for the nastier possibility and it is not there, but it is worth
naming because it is close to the surface: sqlite-wasm's install-failure path
calls `removeVfs()`, which does
`removeEntry(OPAQUE_DIR_NAME, {recursive: true})` on the pool directory —
i.e. **a failed install tries to delete the database.** In the contended case
that removal itself fails (the other tab holds the handles) and is swallowed.
§4.2 tests the uncontended version of the same failure and the database
survives there too. It is not a live bug; it is a shape to keep an eye on.

### 3.3 Handover is immediate — but `installPool()` cannot tell

My first conclusion here was wrong, and the correction is the most useful thing
in this section, so both are recorded.

Tab A calls `worker.terminate()`, which is exactly what the browser does to a
dedicated worker when its tab closes. The worker count drops. Tab B still cannot
open:

```
  dedicated workers before terminate: 2
  dedicated workers after terminate: 1
  TAB B forceOpen() after A terminated its worker -> false
```

I first read that as the platform being slow to release handles, and concluded
handover took ~15.5 s of backoff. It does not. **At the same instant, with
nothing else changed, a plain retry failed and a retry carrying one extra option
succeeded:**

```
H. can a tab that already lost the race ever recover?
  plain retry FAILED (cached rejection): NoModificationAllowedError: Failed to
  execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles
  cannot be created if there is another open Access Handle or Writable stream
  associated with the same file.
  retry WITH forceReinitIfPreviouslyFailed SUCCEEDED: capacity 12, files 1,
  names ["/hashigo.db"]
```

Had the handles genuinely still been held, the second call would have failed
too. It did not. So the handles were free the moment tab A's worker died, and the
only thing in the way was a **cached rejection**: `installOpfsSAHPoolVfs`
memoises per VFS name in a module-private `initPromises` and re-throws a stored
failure forever unless the caller passes `forceReinitIfPreviouslyFailed: true`
(`index.mjs:15626`). `installPool()` in `src/db/browser.ts` clears its *own* memo
and not that one, so it replays a stale error that reads exactly like a live one.

Once the flag had cleared the cache, the very next ordinary attempt succeeded
first time (`multitab.txt`):

```
  after +500ms: forceOpen() -> true
```

And with the flagged retry deliberately skipped — `drive.mjs multitab
--no-retry`, which is exactly what `installPool()` does today — it never
recovered at all (`multitab-slow.txt`):

```
  (--no-retry: skipping the flagged retry on purpose)
  after +500ms:  forceOpen() -> false, lockHeld=false
  after +1000ms: forceOpen() -> false, lockHeld=false
  after +2000ms: forceOpen() -> false, lockHeld=false
  after +4000ms: forceOpen() -> false, lockHeld=false
  after +8000ms: forceOpen() -> false, lockHeld=false
```

I had earlier seen one run recover on the fifth attempt, after 15.5 s, and
briefly believed that was the platform's release latency. It was not: it was the
failure path's own `removeVfs()` happening to clear the cache entry
(`index.mjs:15168`) that one time. **Backoff is not a workaround, because there
is nothing to wait for.**

**So closing the other tab frees the database immediately, and Hashigo cannot
currently tell — possibly for as long as the page is open.** With ORPHAN 3's one
option, "close the other tab and try again" works on the first tap. Without it,
the user's only reliable remedy is to reload the page, and the error in the
meantime is indistinguishable from a real conflict.

### 3.4 The documented handover is blocked by our own bug

sqlite-wasm ships `pauseVfs()` / `unpauseVfs()` (3.49+) precisely so tabs can
hand the VFS over. It refuses while any file is open:

```
  FAILED: SQLite3Error: SQLITE_MISUSE: Cannot pause VFS opfs-sahpool because it
  has opened files.
```

— and it refused *after* `db.close()`. `pauseVfs()` is therefore a precise,
free oracle for "is the handle really released", so I used it as one. Three
variants, differing only in what they do with prepared statements:

```
G. does close() actually release the OPFS file?
  baseline: nothing open, pauseVfs() works
  A  exec() only, never called prepare()
     pauseVfs() SUCCEEDED — the file was released (isPaused=true)
  B  prepare(), then finalize() every statement
     pauseVfs() SUCCEEDED — the file was released (isPaused=true)
  C  prepare(), and DO NOT finalize (what src/ does today)
     pauseVfs() THREW — the file is STILL OPEN: SQLite3Error: SQLITE_MISUSE:
     Cannot pause VFS opfs-sahpool because it has opened files.
```

A and B release. C does not. **One unfinalized statement pins the OPFS file for
the life of the page.**

The mechanism, from reading the shipped module
(`node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs:10282`, sqlite-wasm
3.53.0-build1) — this part is a source reading, the behaviour above is measured:

```js
Object.keys(__stmtMap.get(this)).forEach((k, s) => {
    if (s && s.pointer) try { s.finalize(); } catch (e) {}
});
```

`Array.prototype.forEach` passes `(element, index, array)`, so `s` is the loop
**index**, not the statement. `s.pointer` is `undefined` on a Number and the
guard is false for every entry — the loop finalizes nothing. `close()` then
calls `sqlite3_close_v2`, which defers the real close while statements live, and
the `__stmtMap` entry is deleted on the next line, so the statements become
unreachable and can never be finalized by anyone.

Hashigo does not need to wait for an upstream fix: `src/db/browser.ts` already
declares `BrowserStatement.finalize()` for exactly this reason and nothing calls
it. Tracking statements on `WasmDb` and finalizing them in `close()` fixes it in
about ten lines. **ORPHAN 2.**

### 3.5 What tabs should actually do — Web Locks, and it works

`opfs-sahpool` gives you an exception *after* you try. A Web Lock tells you
*before*, so the second tab never provokes the OPFS failure at all. Measured:

```
TAB COORDINATION — Web Lock first, database second
  Web Lock acquired — this tab owns the database.           <- tab A
...
TAB COORDINATION — Web Lock first, database second
  Web Lock NOT available — another tab owns the database. This tab is a FOLLOWER.
  A well-behaved app stops here and says 'Hashigo is open in another tab'.
```

`navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, …)`,
held for the tab's lifetime, resolves the callback with `null` immediately when
another tab owns it. It is per-origin, works in workers, and releases
automatically when the holding context dies — no cleanup code, no stale lock
after a crash. `BroadcastChannel` on top of it lets each tab name the other, so
the message can be *"Hashigo is open in another tab"* rather than *"unable to
open database file"*.

One trap I hit and fixed in the harness: the lock request must be **re-entrant
per tab**. Re-opening in a tab that already holds the lock asks again with
`ifAvailable`, gets `null`, and the tab concludes it is a follower of itself.

**Recommendation for the shell:**

1. Take the Web Lock before touching the database. No lock → read-only or a
   plain "open in another tab" screen; do not attempt the install.
2. The leader terminates its worker on `pagehide`, so a follower can take over.
3. Pass `forceReinitIfPreviouslyFailed: true` when retrying the install
   (ORPHAN 3), or a follower keeps replaying a stale error after the leader has
   let go. Keep a short backoff as a belt.
4. Fix §3.4 so `close()` actually closes, which makes `pauseVfs()` handover
   available and stops the pool leaking slots.

---

## 4. Recovery (Q4)

### 4.1 The re-import claim, timed — and it is better than the note said

`browser-feasibility.md` §3 says "the whole database rebuilds from `exports/` in
~15 s". Measured:

```
$ npm run import -- --db build/persist-spike/reimport.db exports/日本語 exports/English exports/基本情報
  map       39 decks, 10 templates, 7716 cards, 22319 field values
  reviews   102020 reviews across 13392 tracks
  links     8744 wiki-links, 18 unresolved
  blobs     10887 live attachments, 8958 tombstones skipped
  verify    ok

imported 日本語, English, 基本情報 in 16.4s

retention 96.24%  (3832 lapses)
study     636.1 h over 1317 days, 2022-06-28 to 2026-08-18
integrity ok

real    0m20.094s          # wall clock, including vite-node startup
```

**16.4 s, and the claim was understated rather than optimistic**, because that
run also wrote every audio payload. The blob store has become a SQLite sidecar
during this session:

`build/persist-spike/blobstore.txt`, verbatim:

```
=== file sizes after: npm run import -- --db build/persist-spike/reimport.db exports/... ===
-rw-r--r-- 1 Zach 197121  72773632 Aug 19 20:45 build/persist-spike/reimport.db
-rw-r--r-- 1 Zach 197121 673554432 Aug 19 20:45 build/persist-spike/reimport.db.blobs.db

=== the SQLite blob sidecar ===
tables blob_payloads, blob_store_meta
blob_payloads { rows: 10816, bytes: 654917364 }
meta format = hashigo/blob-store/sqlite/1
meta layout = blob_payloads(hash, byte_size, bytes)
meta created = 2026-08-19T11:45:41.697Z

=== the card database's blob rows ===
{ n: 37763, external: 10816, withpath: 0 }
```

654,917,364 bytes is 624.6 MiB in a 673,554,432-byte (642.4 MiB) file.

So **16.4 s rebuilds the database and all 624.6 MiB of audio**, and
`blobs.path` is NULL on all 37,763 rows (decision 4 holds).

### 4.2 Starting up already over quota: an outage, not a loss

The scenario nobody had tested and the one most likely to happen on a phone —
the origin is already past its limit when Hashigo starts.

```
usage/quota with the database imported: {"usage":145760056,"quota":10883178296}
quota now overridden to 20,971,520 bytes — far BELOW current usage
```

Reload, so a brand-new worker installs the pool under starvation:

```
  FAILED: Error: could not install the opfs-sahpool VFS: The operation failed
  because it would cause the application to exceed its storage quota.
  open() -> false
  FAILED: Error: open the card database first
```

**Total outage: the app cannot open the database at all.** Note this failure is
a clean `QuotaExceededError` — a *different* error from §2.3's `SQLITE_IOERR`,
because it happens while the VFS is creating pool files rather than inside a
transaction. Anything that handles "out of space" has to handle both.

Then the question that matters — did the failed install destroy anything?

```
override removed
  open() -> true
  pool "opfs-sahpool" capacity 12, files 1
  files: ["/hashigo.db"]
  /hashigo.db already in OPFS — reattaching, not re-importing
  cards 7716 ok ... card_links 8744 ok
VERDICT: the database SURVIVED the failed install.
  oracle from OPFS           MATCHES
```

**The database survived.** Free some space and it is all still there. That
retires the §3.2 worry about `removeVfs()` in the failure path for the
uncontended case as well.

### 4.3 Real eviction, and the timed recovery

`Storage.clearDataForOrigin` is what an eviction actually does, and no page code
can prevent it:

```
usage/quota before the eviction: {"usage":815800110,"quota":11553218350}
...
usage/quota after clearDataForOrigin: {"usage":0,"quota":10737418240}
```

The page on a freshly-evicted origin, reloaded:

```
  isSecureContext true · crossOriginIsolated false
  persisted() before asking : false
  estimate()                : usage 0.0 MiB / quota 10.00 GiB
```

**It loads perfectly normally and looks like a fresh install.** There is no
event, no exception, no notification — the only signal is that OPFS is empty.
This is why §1.5's last row exists.

Recovery, timed, from nothing, over localhost:

```
E. recovery from an empty OPFS, timed
  1. fetch 69,173,248 bytes: 0.24s
  2. importDb into OPFS: 0.46s
  3. open: 0.02s
  4. verify the oracle: 0.58s -> MATCHES
  TOTAL database recovery: 1.29s (does NOT include the 624.6 MiB of audio)
```

### 4.4 The recovery path, written out

| step | cost, measured | where |
|---|--:|---|
| notice it happened | free, if the app checks | §1.5 |
| fetch + import the card database | **1.29 s** over localhost | §4.3 |
| re-download 624.6 MiB of audio | network-bound; §6 | not measured on a phone |
| or rebuild everything from `exports/` on the PC | **16.4 s** | §4.1 |

The honest summary is that **eviction costs Zach one re-sync, not one archive.**
The 102,020 reviews live in `exports/` and in whatever the PC holds; the phone
is a replica. What eviction *does* cost is anything reviewed on the phone since
the last sync — which makes stage 11 the actual insurance policy, exactly as
`browser-feasibility.md` argued, but for a smaller loss than it implied.

---

## 5. Things I found that nobody was looking for

1. **`persistent-storage` sits at `"prompt"` after a refusal**, so re-asking is
   free and worth doing every launch (§1.4).
2. **`quota - usage` is a hard constant** — `usage/quota` can never warn (§2.2).
3. **A CDP quota override is invisible to `estimate()`** (§2.3), which is a
   pointed demonstration that the reported quota and the enforced quota are
   different numbers.
4. **Two different errors for "out of space"** — `SQLITE_IOERR` inside a
   transaction, `QuotaExceededError` at pool install (§2.3, §4.2).
5. **`unlink()` frees nothing**; only `removeVfs()` does (§2.5).
6. **`close()` does not close** (§3.4) — the worst of the defects in our own
   code.
7. **A failed pool install poisons every later attempt in that worker** (§3.3),
   so "close the other tab and retry" silently does not work. One option fixes
   it (ORPHAN 3). I got this wrong on the first pass and only caught it by
   running the two retries side by side at the same instant — a repeated error
   message is not evidence that its cause is still present.
8. **You cannot clear OPFS from the page while the pool holds its handles.**
   `removeEntry` gives
   `NoModificationAllowedError: Failed to execute 'removeEntry' on
   'FileSystemDirectoryHandle'`. A "reset my data" button has to go through
   `removeVfs()` and then force a reload, because `removeVfs()` leaves the pool
   unrevivable in that worker.

---

## 6. The audio question — numbers, not a decision

**Raising this, not deciding it.** Zach reviews on the train, so offline matters;
627 MiB on a phone is a real cost. Both sides, measured from his own data.

### The working set is tiny

`build/persist-spike/audio-workingset.txt`, verbatim:

```
--- how many cards does a day of reviewing touch? ---
mean_reviews_per_day 77.5   max_reviews 229
mean_cards_per_day   69.7   max_cards   215        (all 1,317 days)
mean_cards_per_day   63.3   max_cards   141        (last 90 days, 81 active)

--- audio per card ---
cards_with_audio 5713   refs 10887   total_mib 626.9
mean_mib_per_card 0.110  max_mib 3.307
cards total 7716, with audio 5713                  (74% have audio)

--- what a typical day costs, if audio is fetched lazily ---
 typical day (90-day mean)    63.3 cards  ~7.0 MiB
        worst day, last 90     141 cards  ~15.5 MiB
            worst day ever     215 cards  ~23.6 MiB
break-even vs 627 MiB once      90 days
```

| approach | one-time | per day | offline on the train? |
|---|--:|--:|---|
| **all of it** | 627 MiB, and 4.2–5.9 s to write once it is local | 0 | yes, unconditionally |
| **lazy, prefetch the day's queue on Wi-Fi** | 0 | **≈ 7 MiB** (63 cards × 0.11 MiB) | yes, if the prefetch ran |
| **lazy, fetch on demand** | 0 | ≈ 7 MiB | **no** |

* A typical day is **7.0 MiB**. The worst day in the last 90 was 141 cards =
  **15.5 MiB**; the worst ever was 215 cards = **23.6 MiB**.
* Break-even between "download everything once" and "prefetch daily" is
  **90 days** of use.
* Prefetching a day's queue is one `SELECT` away: the due-card query already
  knows which cards are coming, and `blob_refs` already knows their audio.
* 627 MiB is **7.06% of the reported quota** and it fit with no complaint
  (§2.1) — but on a phone the constraint is the user's free space and their
  patience with a first-run download, not the quota.
* The shape of the store makes either choice cheap: audio now lives in one
  `<db>.blobs.db` sidecar (§4.1), so "ship it all" is one 642 MiB file through
  the same bootstrap path as the card database, and "fetch some" is
  `INSERT INTO blob_payloads` per hash. **Nothing in the current design forces
  the decision, and it is reversible either way.**

My own read, for what it is worth: prefetch-the-queue looks strictly better —
7 MiB a day, works offline, no 627 MiB first run, and a "download everything for
this trip" button covers the case where he knows he will be off Wi-Fi for a
week. But the first-run experience of "all of it" is simpler to build and
impossible to get subtly wrong, and 627 MiB on a modern phone is not much.
**Zach's call.** The numbers above are the ones to make it with.

---

## 7. What I could NOT verify — plainly

**Everything below needs Zach's physical device. No agent in this run can do
any of it, and I did not try to.**

* **Any phone at all.** Every measurement here is desktop Chrome 151 on Windows
  11, driven headless over CDP, on a machine with 181 GB free. A phone has
  slower flash, less RAM, a smaller and more contested quota, and an OS that
  reclaims space on its own schedule. **`PHONE-TEST.md` exists for this.**
* **A real `persist()` grant from Chrome's own heuristic.** I forced the granted
  branch with `Browser.grantPermissions(["durableStorage"])`. That proves the
  plumbing handles a grant; it proves nothing about whether Chrome on Android
  will give Zach one.
* **A real PWA install.** The manifest and service worker are in place and the
  page reports `display-mode`, but I never installed it. "Installed apps are
  usually granted persistence" is the documented heuristic, not my measurement.
* **`--unsafely-treat-insecure-origin-as-secure` on Android.** Verified on
  desktop only (§1.6). Same flag name, presumed same code path, not observed.
* **Whether an installed PWA is installable over an insecure-treated-as-secure
  origin.** Untested, and I suspect not. `PHONE-TEST.md` routes around it.
* **A real eviction under real pressure.** I simulated it with
  `Storage.clearDataForOrigin` and with a CDP quota override. I never filled a
  disk and let Chrome decide what to throw away, so I cannot say what Chrome
  evicts *first* or whether it warns.
* **iOS / Safari.** Nothing. `browser-feasibility.md` §3's 7-day WebKit
  script-writable-storage deletion is unverified by me.
* **Firefox.** Nothing.
* **Actual audio playback.** I wrote and read byte payloads of the right sizes.
  I never decoded one or gave it to an `<audio>` element. (`src/blobs/url.ts`
  appeared during this session and looks like exactly that work — see
  ORPHAN 1.)
* **The 642 MiB blob sidecar through the browser bootstrap path.** The card
  database goes through `importDb` at 69 MB; I did not push 642 MB through it,
  and `vite.config.ts`'s middleware only serves the card database.
* **More than two tabs**, and two tabs in two different Chrome *profiles*.
* **The upstream `forEach((k, s) =>` diagnosis in §3.4** is a source reading.
  The A/B/C behaviour is measured; the explanation is inferred and consistent
  with it, but I did not patch the module to confirm.
* **`pauseVfs()`/`unpauseVfs()` as a working handover.** Blocked by §3.4 in
  every attempt, so I never saw it succeed between two tabs. Upstream documents
  it and calls it "intended primarily for testing".
* **Whether ORPHAN 3's flag makes handover reliable rather than merely
  possible.** I proved it works once, from the harness, bypassing
  `installPool()`. I did not patch `installPool()` — not my file — so I never ran
  the two-tab scenario end to end against the fix.

---

## ORPHANS — defects outside the files I own

Per the no-orphans rule. I own `spike/persist/*`, `notes/persistence.md` and
`PHONE-TEST.md`; none of these is in that set, so each is written out with the
exact change instead of being fixed in passing.

### ORPHAN 1 — `npm run typecheck` is broken, in an untracked file. HIGHEST PRIORITY.

`src/blobs/url.ts` is **untracked** (`git status` → `?? src/blobs/url.ts`) and
breaks the repo's own gate:

```
$ npx tsc -p tsconfig.json ; echo $?
src/blobs/url.ts(295,42): error TS2322: Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'BlobPart'.
  Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'ArrayBufferView<ArrayBuffer>'.
    Types of property 'buffer' are incompatible.
      Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'.
        Type 'SharedArrayBuffer' is not assignable to type 'ArrayBuffer'.
src/blobs/url.ts(295,70): error TS2322: Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'BlobPart'.
  (…the same seven-line cascade again, for the second Blob construction on that line)
2
```

Line 295 is
`const blob = mime === "" ? new Blob([payload.bytes]) : new Blob([payload.bytes], { type: mime });`
and `bytes` is declared `readonly bytes: Uint8Array` at line 72. Modern
`lib.dom` requires `ArrayBufferView<ArrayBuffer>` for a `BlobPart`, and bare
`Uint8Array` means `Uint8Array<ArrayBufferLike>`, which admits
`SharedArrayBuffer`. The fix is to narrow the declaration —
`readonly bytes: Uint8Array<ArrayBuffer>` — which is true of everything
better-sqlite3 and sqlite-wasm hand back, and costs no runtime code. I did not
touch it: it is the blob/audio agent's primary file, brand new this session, and
the brief says typecheck must exit 0.

### ORPHAN 2 — `src/db/browser.ts`: `close()` does not release the OPFS file.

Measured in §3.4, A/B/C. `BrowserStatement.finalize()` exists and its own
docstring says "wasm handles must be released", and no call site in the repo
calls it. Because `oo1.DB.close()` finalizes nothing
(`index.mjs:10282`, §3.4), one abandoned statement pins the file for the life of
the page. Two consequences: `pauseVfs()` handover is unreachable, and a
long-lived worker that opens and closes databases leaks the pool's 12 slots
until it hits `SQLITE_CANTOPEN`. The fix belongs in `WasmDb`:

```ts
readonly #statements = new Set<WasmStatement>();

prepare(sql: string): BrowserStatement {
  const statement = new WasmStatement(this.#db, this.#db.prepare(sql), this.#statements);
  this.#statements.add(statement);
  return statement;
}

close(): void {
  for (const statement of [...this.#statements]) {
    try { statement.finalize(); } catch { /* keep closing */ }
  }
  this.#statements.clear();
  this.#db.close();
}
```

with `WasmStatement.finalize()` removing itself from the set so double-finalize
is safe. `src/db/browser.ts` is the browser-adapter agent's primary file and this
wants a test (`open, prepare, close, pauseVfs()` must not throw), so it belongs
to whoever owns both.

### ORPHAN 3 — `src/db/browser.ts`: `installPool()` replays a stale failure.

**Promoted after §3.3's correction. One option, and it turns "the other tab is
gone but Hashigo still says it is not" into "works on the first retry".**

`installPool()` clears its own `poolPromise` on failure, but
`installOpfsSAHPoolVfs` also memoises per VFS name in a module-private
`initPromises` and caches *rejections* (`index.mjs:15626`). A second tab that
lost the race therefore keeps re-throwing the original
`NoModificationAllowedError` after the first tab has released everything — an
error indistinguishable from a live conflict. Measured back to back at the same
instant in §3.3: plain retry fails, retry with the flag succeeds — and with the
flag withheld, five retries over 15.5 s never recovered at all.

```ts
const pool = await api.installOpfsSAHPoolVfs({
  initialCapacity: capacity,
  forceReinitIfPreviouslyFailed: true,   // <- this
  ...(options.vfsName === undefined ? {} : { name: options.vfsName }),
  ...(options.directory === undefined ? {} : { directory: options.directory }),
});
```

It recovers today only incidentally, when the failure path's own `removeVfs()`
happens to delete the cache entry (`index.mjs:15168`). That fired once in three
runs. Do not rely on it. Note the option is absent from the package's TypeScript
types, so it needs a cast until upstream adds one; `spike/persist/db.worker.ts`
(`retryInstall`) shows the shape.

### ORPHAN 4 — `vite.config.ts`: `/persist/` is dev-server-only.

`build.rollupOptions.input` is unset, so `vite build` emits only
`spike/index.html` and the persistence harness does not exist in
`build/spike-dist/`. That is fine for a throwaway, and it is why
`PHONE-TEST.md` uses `npm run spike:dev`. If anyone wants it in the bundle, add
`spike/persist/index.html` as a second input. `vite.config.ts` is the
bundler agent's file and this is a deliberate non-change, not an oversight.

### ORPHAN 5 — `browser-feasibility.md` has two statements this run supersedes.

Both are that note's own words and both were reasonable when written:

* §3, *"the whole database rebuilds from `exports/` in ~15 s"* — measured at
  **16.4 s**, and it now includes 624.6 MiB of audio (§4.1). The claim was
  understated, not wrong.
* §7, *"Multi-tab … is undefined behaviour I did not exercise. Worth one test
  before stage 7."* — exercised (§3). It is defined behaviour: a clear
  `NoModificationAllowedError` and no corruption.

Also §4's recommendation of a separate `blobs.db` has since shipped as
`<db>.blobs.db` with `format hashigo/blob-store/sqlite/1`, so that
recommendation is now history rather than advice.

### ORPHAN 6 — still no CI.

`FIXES.md` ORPHAN 6 said this and it is still true: `ls .github/workflows` is
empty. This run is the second in a row where `npm run typecheck` was broken by
one agent and found by another. One workflow running
`npm run typecheck && npx vitest run` would have caught ORPHAN 1 at the moment
it landed.

---

## 8. Commands, and where their output came from

Prerequisites, once:

```bash
npm run spike:bootstrap                   # build/spike/hashigo-bootstrap.db, 69,173,248 bytes
node spike/persist/make-icons.mjs         # icon-192.png (607 B), icon-512.png (2,907 B)
npm run spike:dev                         # http://localhost:5273/persist/
```

Every figure in this document comes from one of these:

```bash
npx tsc -p spike/persist                                    # exit 0
npx tsc -p tsconfig.json                                    # exit 2 — ORPHAN 1
npx vitest run                                              # 351 passed | 1 skipped

node spike/persist/drive.mjs deny                 # §1.3 denied, §1.4  -> deny.txt
node spike/persist/drive.mjs grant                # §1.3 granted       -> grant.txt
node spike/persist/drive.mjs fill                 # §2.1, §2.2, §2.5   -> fill.txt
node spike/persist/drive.mjs quota                # §2.3, §2.4         -> quota.txt
node spike/persist/drive.mjs starve               # §4.2               -> starve.txt
node spike/persist/drive.mjs multitab             # §3.1-§3.3          -> multitab.txt
node spike/persist/drive.mjs multitab --no-retry  # §3.3 the poisoned  -> multitab-slow.txt
node spike/persist/drive.mjs handles              # §3.4               -> handles.txt
node spike/persist/drive.mjs evict                # §2.5, §4.3, §5.8   -> evict.txt

# §1.6, the LAN origin. Serve on all interfaces, then drive the LAN address:
npx vite --port 5274 --strictPort --host
node spike/persist/drive.mjs deny  --url http://192.168.20.22:5274/persist/
node spike/persist/drive.mjs grant --url http://192.168.20.22:5274/persist/ \
     --insecure-origin http://192.168.20.22:5274

# §4.1, the Node re-import                                  -> reimport.txt
npm run import -- --db build/persist-spike/reimport.db \
  exports/日本語 exports/English exports/基本情報

# §4.1's file sizes and the sidecar's contents               -> blobstore.txt
# §6, the audio working set                                  -> audio-workingset.txt
node build/persist-spike/audio-workingset.mjs build/persist-spike/reimport.db
```

**Every figure quoted in this document is checked against those transcripts, by
script** — the checker walks the fenced blocks, pulls every line carrying a digit
or an error, and greps `build/persist-spike/*.txt` for it. Anything it could not
find has since been either corrected to the real text or explicitly labelled as
my own condensation (the one-line oracle in §1.6 and §3.2, the arithmetic table
in §2.2, the derived per-day costs in §6, and the `<-` annotations I added to
otherwise verbatim lines).

Raw transcripts, all under `build/persist-spike/` (gitignored): `deny.txt`,
`grant.txt`, `fill.txt`, `quota.txt`, `starve.txt`, `multitab.txt`,
`multitab-slow.txt`, `handles.txt`, `evict.txt`, `lan.txt`, `lan-flag.txt`,
`lan-open.txt`, `reimport.txt`, `blobstore.txt`, `audio-workingset.txt`,
`tests.txt`, `typecheck.txt`.

### Sources consulted, and how far to trust them

Every claim above that is a measurement is mine. These informed what to measure:

* [Storage quotas and eviction criteria — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
* [StorageManager.persist() — MDN](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
* [Web Locks API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
* [sqlite3 WASM/JS persistent storage](https://sqlite.org/wasm/doc/trunk/persistence.md) — the `pauseVfs`/`unpauseVfs` contract
* [FileSystemFileHandle.createSyncAccessHandle() — MDN](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)
* `node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs`, read directly — §3.4
  and ORPHAN 3 cite line numbers in the installed 3.53.0-build1.

---

## Measured on the real device, 2026-08-20

Everything above is desktop Chrome 151 on Windows. This section is Zach's actual
phone, over a genuine HTTPS origin (a cloudflared tunnel), installed to the home
screen. **It contradicts the desktop findings in two places, and both are good news.**

```
Samsung Internet 30.0 / Chromium 143, Android
origin  https://<random>.trycloudflare.com     installed: standalone

persisted() before asking : false
persist() returned        : true      <- GRANTED
persisted() after asking  : true
quota                     : 133.96 GiB
OPFS usage                : 0.0 MiB
isSecureContext           : true
crossOriginIsolated       : false
sqlite 3.53.0, schema version 2
```

**1. Persistence IS granted on an installed PWA.** Desktop Chrome denied it and the
note above could only prove the plumbing via a CDP override. On a real installed PWA
the browser's own heuristic said yes. The eviction risk that drove this whole
investigation does not apply to how he will actually use the app — though the app must
still call `persist()`, check `persisted()`, and say so when it is false, because that
is a heuristic and not a guarantee.

**2. `estimate()` DOES report a meaningful quota here — §2.2 is desktop-specific.**
Desktop returned exactly `10,737,418,240` bytes of headroom five times out of five
regardless of usage. This device reports **133.96 GiB**, which tracks real free space.
So a "storage filling up" indicator built on `usage / quota` is useless on desktop
Chrome but may be meaningful on Android. Do not build one on the assumption that
either behaviour is universal — read the number, and treat a suspiciously round
constant as a sign the browser is refusing to tell you anything.

**3. The Worker restriction generalises.** Confirmed verbatim on device:
`navigator.storage.persist` is `undefined` in the Worker,
`StorageManager.prototype has "persist": false`, calling it throws
`TypeError: navigator.storage.persist is not a function`, and `persisted()` in the
Worker returns `true` — **observable, but not requestable**. The
request-from-page-pass-into-worker plumbing is required, exactly as designed.

**4. sqlite-wasm 3.53.0 and the schema load in Samsung Internet.** Not just Chrome.
That is a portability result nobody had.

### Not yet measured on device

The ~700 MB fill failed twice with `Error: open the card database first` — a harness
step-ordering fault, not a storage finding: scenario C depends on a card database that
the page opens in an earlier step. **Phone write throughput and whether ~700 MB is
comfortable in practice remain unmeasured.** Quota at 133.96 GiB makes space itself a
non-issue.

### One consequence for stage 11

**OPFS is per-browser.** A PWA installed from Samsung Internet keeps its data inside
Samsung Internet; installing from Chrome later creates a second, empty copy — 700 MB
twice and two independent databases that would both need syncing. Pick one browser per
device and record which.
