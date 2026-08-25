# app — the shell (stage 9)

The page. Decision 23's direction A2 over `hashigo/session` → `hashigo/review` →
`hashigo/render`, with a real writable SQLite database in OPFS and audio on the
device.

```bash
npx vite-node scripts/app-bootstrap.ts    # once: the two files the page fetches
npm run app:dev -- --host 127.0.0.1       # local only
npm run app:dev -- --host ::              # phone / tunnel — see the trap below
npm run app:check                         # the gate: tsc -p app/tsconfig.json
```

**It runs.** First measured end to end 2026-08-23, in Chromium over the real
corpus: 7,716 cards, 102,020 imported reviews, a 531-card plan, and grades landing
in OPFS.

## Why this is its own top-level directory

Zach handed the structural call over (*"this is `how`, and I'm trusting you on
`how`"*). `spike/` is labelled THROWAWAY and `src/` is the library that has to
stay importable from Node, so the app is neither. It gets its own directory and
its own Vite config, because `vite.config.ts` has `root: "spike"` and every URL
the spike documents (`/persist/`, `/blobstore/`, `/mock/`) is relative to that —
moving the root would change all of them.

Two ports, so both can run at once: the spike on 5273, the app on **5274**.

## The split: the worker has the database, the page has the DOM

Not a performance choice — the only arrangement the platform allows.
`opfs-sahpool` needs `createSyncAccessHandle`, which is restricted to dedicated
workers, and Hashigo sets no COOP/COEP headers on purpose, so there is no
`SharedArrayBuffer` either. A synchronous `SqliteHandle` simply cannot be reached
from the page.

That is why `src/review` grew a seam:

```plaintext
db.worker.ts   prepareCard()   loadCard · renderLoadedCard · expandGeneratorFields
               ↓ structuredClone (PreparedCard: strings, plain AST, one Map)
main.ts        mountPrepared() renderSides · audioController · shadowingLoop
```

`AudioResolver` has always accepted a `PromiseLike`, which is what makes it free:
the page's resolver posts a message and returns a promise. `test/review.test.ts`
puts 300 prepared cards / 1,079 sides through a **real `structuredClone`** — not a
JSON round trip, which would drop a function silently and turn `loaded.values`
from a `Map` into `{}`.

**Both databases are two FILES in ONE pool.** `installPool` refuses a second pool
over the same directory, because two pools over one directory is documented as
unsupported and the failure mode is corruption rather than an exception.

**The message log is evidence for the hard rule.** `payload` is the only message
that moves audio bytes, and the page sends it from one place: the `resolve` handed
to `mountPrepared`. So a card merely on screen produces no payload message at all
— checkable from outside the code, in devtools.

## Three things running it found that reasoning had not

### 1. The prompt boundary has to be POSITIONAL, because of reverse tracks

The first version took "every side up to the first one that hides or sounds
something". **The first card the real session served killed it.** It was a
*reverse* track, whose side order is permuted to Meaning → Example → Vocab; the
Example side carries audio, so that rule pulled it into the question — and the
sentence *"time constraints make it impossible to do everything"* contains the
answer word. The screen printed the answer above the question.

> [!warning] **Corrected by Zach, 2026-08-23.** This first said "a reverse *New
> Vocab* track", which implied his English deck reverses. **It does not** —
> `English/Vocabulary` resolves `reverse: off` on 1,226 of its 1,234 cards. That
> card is one of **8 per-card overrides** there, with a live reverse track at 2
> reps due **2023-03-03**. The bug was real and the fix stands; citing a
> deck-level setting he never turned on was not. The honest support is
> `日本語/単語` and `日本語/漢字`, where reverse is on for all 5,357 cards — which is
> also why his request for a **"reversed" label at the top of the card** matters:
> most of his real reverse volume is there.
>
> **And 5,357 is 単語 + 漢字 ALONE, not the total** — corrected 2026-08-23 after he
> asked whether 数字 exports in reverse (it does not: 90 cards, 90 forward tracks,
> zero reverse). The corpus total is **5,676**. Only four decks store
> `reverse: on` — 単語 3,702 · 漢字 1,655 · 言葉 146 · 文法 83 — four child decks
> inherit it for 81 more, and 9 cards carry a per-card override. Every other deck,
> 数字 and 部首 and all of 基本情報 included, resolves to OFF.

So: **the question is the FIRST non-empty side**, plus a following side whose only
content is a WIDGET (that is 漢字 and only 漢字: `<<Kanji>>` / `<draw>` /
`<<Reading>>` / `<<Meaning>>`, and the canvas has to be on screen while he draws
from memory). Whatever the template author put first is the question, in whichever
order the direction asks for.

### 2. Exactly one clip per reveal, or 単語 plays two at once

`audioController.play()` defers extra clips only **within one call**, so unmasking
three sides the obvious way starts three clips. Measured on 単語: the word clip and
the example-sentence clip both fired. The reveal now picks one side to sound and
unmasks every other with `reveal(cause, { silent: true })` — a new option on
`ShadowingSide`, and the safe direction: less audio, never more.

### 3. A reverse identify track is SILENT on entry, and that is correct

Decision 29 plays the clip on entry for the 3,177 `Reading`-not-true cards. On a
**reverse** track of one of those, the first side is 意味 — a cloze and no clip —
and the word's audio sits on a later side where it is the ANSWER. Autoplaying it
would hand him what he is meant to produce.

`promptsOnEntry` already gets this right, because it asks about the SIDE and not
about the card. What was wrong was the HINT, which said "listen, name the word"
with nothing to listen to; it now reads the loop's own log instead of re-deriving
the mode. Pinned in `test/review.test.ts` as a differential — the same 40 cards,
**40/40 forward ask on entry, 40/40 reverse silent**.

## What the browser confirmed, that Node could not

A forward identify 単語 card, in Chromium, on entry and before any reveal:

```plaintext
prompt text     "[…]  […]  頭高"          the reading and the word BOTH masked
audio state     ["playing", "idle"]       the question sounded; the sentence did not
clozes          ["hidden","hidden","hidden"]
```

That is decision 29's mode 2 with the masks holding: `型` plain, the word hidden,
one clip, nothing revealed.

## P1's second half — the per-grade OPFS write

The last unmeasured number in the project, and it is now measured. 60 consecutive
grades through `session.answer()` → `gradeTrack`, timed **inside the worker** so
the figure excludes `postMessage`:

```plaintext
min 20.2 ms · p50 37.3 · p90 61.1 · max 81.5 · mean 38.9    Chromium, desktop
```

A 443-card day is therefore about **17 seconds** of write time in total. One
outlier of 1,563 ms was seen on the 7th grade of a cold database and did not
recur in 83 further grades; treat it as first-run warmup until something
reproduces it.

**Basis, because the number is meaningless without it:** `performance.now()` around
`ReviewSession.answer()` in the worker. That covers the reads `gradeTrack` does,
the `reviews` INSERT and the `card_tracks` UPDATE. **NOT measured on the handset
yet**; his phone wrote the corpus 1.44× faster than this machine, so expect it to
be quicker rather than slower.

### P2 was measured here too, and the estimate was HALF the real number

`WasmDb` used to leak a statement per `prepare()` — the class estimated ~6 per
grade. The app is the only place that is observable, and it says **12.07 per
graded card**: 30 grades left 365 open, so a 443-card day would have left ~5,350,
each one pinning the OPFS file so `pauseVfs()` throws.

Fixed by caching one statement per distinct SQL string in `WasmDb.prepare`:

```plaintext
before   12.07 open statements per graded card, growing linearly
after    0 — flat at 16 open / 16 cached over 19 consecutive grades
cost     none: p50 write 35.0 ms against 37.3, mean 37.7 against 38.9
```

## The dev server's bind address is a trap in both directions

Binding one address family REFUSES the other, and on Windows `localhost` resolves
to `::1` FIRST.

* `--host 127.0.0.1` — IPv4 only. Fine for a local browser.
* `--host ::` — dual stack. Needed for a tunnel: ngrok forwards to `localhost`,
  gets `::1`, and **does not fall back to IPv4** the way PowerShell does. It
  returns 502. Also binds the LAN.

Tunnelling also needs the hostname in `server.allowedHosts` **and** in
`preview.allowedHosts` — they are separate servers with separate checks. Never
`allowedHosts: true`: that is Vite's DNS-rebinding guard, and a wildcard hands any
page he visits a route to this dev server.

`server.fs.allow` is narrowed to `app/`, `src/` and `node_modules/` on purpose.
With `[root]`, Vite's `/@fs/` route served the entire corpus — measured on the
spike config: `build/hashigo.db` came back 200 at 74,465,280 bytes.

## The bootstrap files, and the bounded audio

`scripts/app-bootstrap.ts` writes both, into `build/app/`:

```plaintext
hashigo-app.db          72,630,272 bytes   7,716 cards · 102,020 reviews
hashigo-app-blobs.db    42,287,104 bytes   1,529 payloads (speech 1,504 · file 15 · image 10)
coverage                1,358 of 5,708 cards with speech can play something (23.8%)
```

`VACUUM INTO`, not a file copy: `build/hashigo.db` is in WAL mode and
`opfs-sahpool` stores one file per name, so a `-wal` sidecar cannot be imported and
anything living only in it would be **silently missing in the browser**. The script
refuses to ship a file whose header still says WAL.

The audio is a **bounded** subset and the rule is stated, because a subset with an
unstated rule is a lie: every `image`/`file` payload, then `speech` in ASCENDING
SIZE ORDER until `--speech-bytes` (default 32 MiB) is spent. Smallest-first buys
single WORDS — the 高低アクセント clip the drill needs — at ~30 KB rather than
sentences at ~120 KB, and it maximises playable cards per byte. Raise it with
`--speech-bytes` when the coverage matters more than the download.

Payloads are re-hashed on the way in, so the browser plays bytes that provably
still match the address the card database refers to.

## Eviction, detected after the fact

Decision 17's last missing piece. A receipt in `localStorage` — not in the
database, because a receipt inside the thing that went missing proves nothing, and
`localStorage` is also the only store the PAGE can use since it does not exist in
a worker. The worker answers the other half: was the card database in OPFS before
this open began.

**Verified against a real wipe**, not reasoned about: 187 local grades, then
`removeEntry('.opfs-sahpool', {recursive: true})` from a page with no worker
holding a handle, then a reload.

```plaintext
pool holds []
  fetching /hashigo-app.db        imported 72,630,272 bytes
  fetching /hashigo-app-blobs.db  imported 42,287,104 bytes
plan: 556 cards (546 due, 10 new) · 0 local reviews
THE DATABASE WAS GONE. A receipt from 2026-08-23T13:15 says it held 187 local
review(s). They are not recoverable from exports/ — restore a backup.
```

**What it CANNOT detect, said out loud rather than implied:** a full site-data
clear takes the receipt with it, and then this looks exactly like a first run. No
store survives that. The honest fallback is the boot log — a re-fetch of 72 MB is
visible, and the local-review count is stated on every successful open, so a drop
is noticeable even when the cause is not.

It reports the LOSS, not the event: `localReviews` is the only thing `exports/`
cannot rebuild, so a receipt saying 0 gets an informational line and no banner.

## `?reset=1` — the route a schema bump needs

`SCHEMA_VERSION` has moved eight times and `applySchema` refuses any version but
its own, so a bump means re-import rather than migrate — and there was no way to
do that from the app. There is now, behind a `confirm()` because it destroys local
grades.

It calls `removeVfs()`, and that is the whole point: **a per-file `unlink()` frees
NOTHING.** `SAHPoolUtil.unlink()` disassociates a name from its pool slot and
leaves the file — measured at 0.0 MiB of 639.0 MiB on Zach's own handset, and
byte-for-byte the same on desktop. Anything that deletes audio must not be built
on `unlink()`.

## The card-link preview, and it STACKS (his request 2)

A wiki-link opens a layer instead of navigating — *"it doesn't navigate away"* —
and a link inside a layer opens another on top, *"and you can keep going in mochi,
and i kinda like that system"*.

**A preview is not a review (decision 30)**, which is what makes this small: every
side at once, fully revealed, no masks, no grading, and nothing plays by itself.
So a layer needs none of review's machinery — no `enter()` (which would ask the
mode-2 question), no drill boundary, no one-clip arbitration. Every side is
unmasked with `reveal(cause, { silent: true })` and left alone.

Verified by driving it, four layers deep along a chain his corpus actually has:

```plaintext
open  hTFL12MG            depth 1   日本語/漢字 · preview
click W39u5mf4            depth 2   English/Vocabulary · preview
click X0JYAzzk            depth 3   English/Vocabulary · preview
click 6XA87oSz            depth 4   English/Vocabulary · preview
Escape ×4                 3 · 2 · 1 · 0     one layer at a time
```

The review card underneath is untouched throughout (`data-state` unchanged), and
the body stops scrolling while a layer is open — otherwise the card he is coming
back to has moved.

**No depth cap.** His corpus has 8,744 links over 4,335 cards, a deepest acyclic
chain of 9, and **23 MUTUAL pairs** — A links to B, B links back to A — so the
stack is genuinely unbounded and a limit would be a decision nobody has made. What
IS bounded is cost: each layer owns its mount and disposes it on close, so its
audio controller and every object URL it minted go with it.

Three details that came out of running it:

* **The native `<audio>` control is SHOWN in a layer** and hidden in review. In
  review the renderer leaves media sourceless and a dead control is worse than
  none; in a preview there is no reveal to hang playback on, and decision 30 says
  a clip stays one deliberate tap away. Measured: a preview opens with `0` plays
  and the clip's state `idle`; a deliberate tap moves it to `missing` — the
  resolver ran, the worker answered, and the clip is simply outside the 32 MiB
  subset. The wiring is proven even where the bytes are not there.
* **A layer swallows every key except Escape.** Without that, space would grade
  the card underneath the preview he is reading.
* **A click inside a layer does not reach the review card.** Its clozes are
  already open, and the capture-phase reveal handler would otherwise answer a
  question he has not been asked yet.

A link into a card this database does not have says so by id rather than showing
an empty box — expected rather than exceptional, with 8,958 tombstones in the
corpus.

## `e` edits every field, from either mode (his request 3)

*"whether the card is in the review mode or the pop up mode, you can press `e` for
edit to edit each field of the card right away"*.

**The editor is another LAYER**, which is what makes "from either mode" fall out
instead of needing two implementations: the stack already knows what is on top, so
`e` edits the previewed card when a preview is open and the review card otherwise.
Escape peels it like anything else. Verified both ways — `e` in review opened the
数字 card's three fields; `e` over a preview of a 単語 card stacked an editor on
top of it showing all eleven.

`notes/crud-audit.md` is why this was small: `card_field_values` is the one table
the app already wrote end to end, so this is a UI over a proven path.

**Three things it will not do, each for a measured reason:**

* **`speech`, `translate` and `ai` fields are read-only, and it SAYS SO on
  screen.** 19 such fields in the corpus, **zero non-empty values** — Mochi keeps
  generated output in `component-cache` addressed by generation identity, so the
  field's own value has always been empty. Typing into it would change nothing
  visible and would put text where the renderer expects a marker. A control
  disabled without a reason teaches him the app is broken.
* **A `boolean` gets a CHECKBOX, not a text box.** `card_field_values.value` is
  TEXT and the importer writes `"true"`/`"false"`; a free-text box would store
  `"maybe"` and every `<<#Field>>` gate in every template would read it as true.
* **It saves on BLUR, not per keystroke.** The longest field value in the corpus
  is 1,777 characters and each save is an OPFS write measured at 20–80 ms.

The worker validates independently of all that, because the field id arrives in a
message and a misdirected write destroys data with no error: the field must be
DECLARED on the card's own template — otherwise the edit creates one of the 235
orphan values this corpus already carries, invisible because nothing renders it —
and its type must be one whose stored value is the content.

**The card in front of him is not re-rendered on save.** Re-mounting mid-edit
would move the thing he is typing into; the change applies the next time the card
is shown, and the status line says so.

## Found by his screenshot: the `<input>` widget is inert

The 数字 template is `<< Voice >>` + `<input value=<<NoComma>>>` / `---` /
`<< Number >>` — hear a number, TYPE it, then see it. `src/render` does its half
completely: the box comes out as

```html
<input class="hashigo-input" data-widget="input" data-expect="267552680"
       inputmode="numeric" type="text" autocomplete="off" spellcheck="false">
```

`data-expect` is the answer and `inputmode="numeric"` even gets him the right
phone keyboard. **Nothing in `app/` reads either.** He can type into it and
nothing checks, nothing marks it right or wrong, and revealing does not compare.

90 cards, and it is the one template whose exercise is *producing an exact string*
rather than recalling something. Small — read `data-expect`, compare on reveal —
but it is unrequested scope, so it is written down rather than built.

## What is NOT here yet

* **Sync (stage 11) and the editor (stage 10).** The `Reading` toggle is the one
  editor-shaped thing the shell has, and only because decision 29's audit loop
  dies without it.
* **A service worker / manifest.** `spike/persist/` has a working pair and
  persistence was granted there on his handset **in a plain browser tab, not
  installed** — so install is not the precondition the notes assumed. Decision
  17's banner is here; the "add to home screen" prompt is not, and drops in
  priority.
* Nothing else on the critical path. Eviction detection landed 2026-08-23 — see
  below.
* **A tap target on the head word.** Decision 23 deliberately does not settle
  where the head word pins after the reveal, where a decision-13 re-ask re-enters
  the session, or type and spacing detail. Those are Zach's.
