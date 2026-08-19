# Browser spike — what it settled

**The browser layer works, and it works on Zach's actual phone.** Updated 2026-08-20:
the persistence findings below were desktop-only when written; they have now been
re-run on a Samsung Galaxy over a real HTTPS origin, installed to the home screen.
**`persist()` was GRANTED** and the quota is 133.96 GiB, not the 10 GiB constant
desktop reported. See `notes/persistence.md` -> "Measured on the real device". The
remaining gap is narrow: phone write throughput for ~700 MB is still unmeasured,
because that scenario failed on a harness step-ordering fault.

Written 2026-08-19 by the integrator, after the workflow's own integrator and
completeness critic were both lost to API capacity errors. Every number below either
came from an adversarial verifier that regenerated it, or from a command I re-ran
myself. Where a builder and a verifier disagreed, the verifier's figure is the one
quoted, because in all three cases the builder had published its fastest run.

Gates, re-run by me at the end:

```
npx vitest run   → 10 files, 352 passed | 1 skipped
npm run typecheck → exit 0
npm run build     → VERIFIED 35 modules, 2 .sql byte-identical, 22 entry points · OK
npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths  → exits 0
```

Oracle, my own SQL against `build/hashigo.db`:

```
cards 7,716 · decks 39 · reviews 102,020 · card_links 8,744
retention 96.24% · lapses 3,832 · blobs.path non-NULL 0
target retention resolving 0.9 across every deck
```

---

## The four questions

### 1. Does a bundler work? — YES

`vite` + `@sqlite.org/sqlite-wasm` 3.53.0 with the `opfs-sahpool` VFS, served over
plain `http://localhost` with **no COOP/COEP headers**. `crossOriginIsolated` is
`false` and `SharedArrayBuffer` is `undefined`, and it works regardless — so Hashigo
ships as static files with no server requirements. This was the one thing
`notes/browser-feasibility.md` explicitly had not tested.

`src/schema/schema.sql` and `views.sql` load **unmodified**: 19 tables, 21 views, 14
triggers, and `card_fts` keeps `tokenize = 'trigram'`. FTS5 is present in the stock
wasm build. That was load-bearing for Ctrl+K and it survives.

One correction to shipped source: `src/db/open.ts` claimed WAL "is the mode the OPFS
build will use too". It is not — asked for WAL, sahpool reports `delete` and stays
`delete`.

### 2. Do blobs belong inside SQLite? — YES, and the decision is safe even though its numbers were not

Payloads now live as BLOB rows in a separate `<database>.blobs.db`. One
implementation (`src/blobs/sqlite.ts`) runs in Node and the browser, so the thing
tested is the thing that ships.

| | one file per blob | BLOB rows |
|---|--:|--:|
| Write 624.6 MiB, browser | 322.1 s | 8–25 s |
| Random read | 10.60 ms | 0.20–1.06 ms |

The advantage is **13–40× on write**, not the 65× first published. Every figure in
the builder's report was its fastest run; an adversarial re-measurement across four
Chrome 151 environments — warm and cold profiles alike — reproduced not one of them.
The ordering never reverses, so the decision stands; the multiplier was optimistic.

Durability is stronger than anyone had shown: a ~700 MB store survives a **browser
process restart**, not merely a page reload, with all 10,816 payloads rehashing to
their own addresses. `blobs.path non-NULL: 0`, confirmed by a raw byte scan of both
database files rather than only by our own `findLocations`.

### 3. Does real audio actually play? — YES

A real corpus mp3 — `裁判官は被告に有罪判決を言い渡した。`, `ja-JP-NanamiNeural`, a
clip Mochi labelled `text/xml` — went into a BLOB row, out through
`src/blobs/url.ts` as a `blob:` URL, into `<audio>`, and **decoded**: `canplay`,
4.536 s duration, clock advancing, `timeupdate` firing. 15 of 15 real mp3s did.

The verifier proved the decode was real without a browser at all: it walked the mp3
frame headers in Python and every one of the 15 durations matched Chromium to the
millisecond. A `src` that had merely been assigned could not do that.

**This overturned a claim of mine.** I had written that a wrong MIME type "would
break `<audio>` outright". False — Chromium sniffs the bytes and ignores the `Blob`
type; the same clip played under all five labels tested. There *is* one fatal shape:
`<source type="text/xml">` is filtered by `canPlayType` before a byte is read,
`duration` is `NaN`, and `element.error` stays `null`, so nothing reports the
failure. Sniffing stays mandatory for data hygiene. Set `src`, never `<source type>`.

### 4. Is the data safe? — SAFER THAN FEARED, for a reason nobody had checked

**A full rebuild from `exports/` takes 16–20 s, including all 624.6 MiB of audio.**
Eviction is a twenty-second inconvenience, not a catastrophe. That reframes the whole
persistence question: we do not need heroics to prevent eviction, we need a re-import
button.

Three traps found in its place:

1. **`navigator.storage.persist` does not exist in a Worker** — and the worker is
   where the database lives. (Confirmed verbatim on the real device: `undefined` in
   the Worker, `StorageManager.prototype has "persist": false`, and `persisted()`
   there returns true — observable but not requestable. This one generalises.) It
   must be called from the page and the result passed in. On desktop `persisted()`
   came back `false` and Chrome reported the permission state as `"prompt"` rather
   than `"denied"`, so it is worth re-asking every launch — **but on the real
   installed PWA it came back `true`.** The browser never tells the user either way;
   the app must.
2. **`navigator.storage.estimate()` cannot warn about anything — on desktop.**
   (His Android device reports a real 133.96 GiB instead, so this is NOT universal;
   do not design a storage indicator assuming either behaviour.) `quota - usage` is
   a hard constant — exactly `10,737,418,240` bytes, five times out of five, on a
   disk with 181 GB free. Any "storage filling up" indicator built on `usage / quota`
   reads 7% forever and then writes start failing. When they fail it is
   `SQLITE_IOERR`, not `SQLITE_FULL`, and the transaction rolls back cleanly — a
   review still records afterwards.
3. **Multi-tab is a clean error, not corruption.** `NoModificationAllowedError`, and
   the first tab re-verifies its oracle intact. But a plain retry fails *forever*
   because the failed install is memoised — backoff is not a workaround, there is
   nothing to wait for. Fixed with `forceReinitIfPreviouslyFailed`.

---

## Everything that needs your physical phone

Every measurement in the sections above is desktop Chrome 151 on Windows 11 — no
agent could touch an Android device. **Zach has since run `PHONE-TEST.md` himself**,
and the results are in `notes/persistence.md` → "Measured on the real device".

**Now answered on the device** (Samsung Internet 30.0 / Chromium 143, real HTTPS
origin via a cloudflared tunnel, installed to the home screen):

- **A real `persist()` grant** — **GRANTED.** Desktop denied it and could only prove
  the plumbing via a CDP override. The heuristic said yes to an installed PWA.
- **A real PWA install** — works; `display-mode: standalone`.
- **Quota** — 133.96 GiB, not desktop's 10 GiB constant. Space is a non-issue.
- **sqlite-wasm 3.53.0 + the schema load in Samsung Internet**, not only Chrome.

**Still unverified:**

- **Phone write throughput.** The ~700 MB scenario failed twice with `Error: open the
  card database first` — a harness step-ordering fault, not a storage finding. This
  is the one number still missing, and quota makes it a comfort question rather than
  a feasibility one.
- **A real eviction under real disk pressure** — simulated with a quota override, so
  we still cannot say what gets evicted first or whether anything warns.
- **iOS, Safari, Firefox** — nothing at all. WebKit deletes script-writable storage
  after 7 days without interaction unless the app is on the Home Screen.

Two routing lessons paid for the hard way. A LAN address will not work: on
`http://192.168.x.x`, `navigator.storage` is **absent outright**, not merely
restricted. And USB port-forwarding stalls if the phone never shows the RSA
authorisation prompt — **a cloudflared HTTPS tunnel proved far easier**, and it is
also the more faithful test, since a genuine HTTPS origin is how Hashigo will really
be served. `PHONE-TEST.md` should lead with the tunnel.

---

## Open for you

1. **Does the phone hold all ~700 MB of audio, or fetch it lazily?** Each device
   holds its own complete copy — that is what local-first means here, and no device
   ever reads another's database. All-local means offline on the train; lazy means a
   much smaller phone footprint but silence in a tunnel. Raised deliberately
   undecided.
2. **`reclaim()` needs a bound.** 35–54 s of blocked worker to reclaim ~15 MB is not
   something to run synchronously in front of you. The argument for a page limit got
   stronger, not weaker, when the number was corrected.
3. **Still no CI.** Second run in a row where one agent broke `typecheck` and another
   found it. A pre-commit hook running `typecheck` and the suite would have caught
   both before either was reported.

## Can stage 4 proceed?

Yes. The renderer should assume: SQLite over `opfs-sahpool` inside a dedicated
Worker, blobs read by hash from a second database, audio delivered as `blob:` URLs
with explicit revocation, and no `SharedArrayBuffer`. What it must not assume is a
phone that behaves like this desktop.
