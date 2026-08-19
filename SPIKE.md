# Browser spike — what it settled

**The browser layer works. The single biggest remaining risk is that not one
measurement in this document came from a phone.**

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
   where the database lives. It must be called from the page and the result passed
   in. `persisted()` came back `false`, and Chrome reports the permission state as
   `"prompt"`, not `"denied"` — so it is worth re-asking every launch. The browser
   never tells the user; the app must.
2. **`navigator.storage.estimate()` cannot warn about anything.** `quota - usage` is
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

**Every measurement in this document is desktop Chrome 151 on Windows 11.** No agent
touched an Android device. `PHONE-TEST.md` is the handoff — a checklist written for
you, not for an agent.

Specifically unverified:

- **A real `persist()` grant** from Chrome's own heuristic. It was forced via CDP,
  which proves our plumbing and nothing about Android. Installed PWAs are usually
  granted, so "add to home screen" is part of the test.
- **A real PWA install**, and whether an insecure-origin-treated-as-secure is
  installable at all.
- **A real eviction under real disk pressure** — simulated with a quota override, so
  we cannot say what Chrome evicts first or whether it warns.
- **Phone write throughput.** Desktop spread is already 2.4× run to run; a phone will
  be slower than the slow end, and `reclaim()` at 35–54 s on desktop could be
  minutes.
- **iOS, Safari, Firefox** — nothing at all. WebKit deletes script-writable storage
  after 7 days without interaction unless the app is on the Home Screen.

A LAN address will not work for this test: on `http://192.168.x.x`,
`navigator.storage` is **absent outright**, not merely restricted. `PHONE-TEST.md`
uses USB port-forwarding so the phone sees the PC as `localhost`.

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
