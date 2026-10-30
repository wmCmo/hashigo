# app — the shell (stage 9)

The page. Decision 23's direction A2 over `hashigo/session` → `hashigo/review` →
`hashigo/render`, with a real writable SQLite database in OPFS and audio on the
device.

```bash
npx vite-node scripts/app-bootstrap.ts    # once: the two files the page fetches
npm run app:dev -- --host 127.0.0.1       # local only
npm run phone                             # ON THE PHONE — build + tunnel + URL
npm run app:check                         # the gate: tsc -p app/tsconfig.json
```

## On the phone: `npm run phone`

One command. It starts a Cloudflare tunnel, learns the hostname, authorises that
hostname, starts the preview server, and prints the URL to open.

**That order is not stylistic.** `allowedHosts` is read once at Vite startup, so a
server started first cannot be told about a hostname that did not exist yet — which
is why the hostname used to be a hand edit to a committed config before every
session.

### The origin decides everything, and it is why a NAMED tunnel matters

**OPFS is keyed by ORIGIN.** The database, the 42 MiB of audio and every grade made
on the phone live under whatever hostname the browser was on.

`cloudflared tunnel --url` — a *quick* tunnel, which is what has been used here so
far — hands out a **new random `*.trycloudflare.com` name every run**. So every
session is a new origin: an empty database, a ~115 MB re-download, and yesterday's
grades still sitting under yesterday's name where nothing will ever read them again.

Fine for a test. Unusable as a routine. **A fixed hostname is the only thing that
makes the phone's database survive to tomorrow.** Four ways to get one, all measured
2026-08-26:

| route | fixed? | costs | reachable by |
|---|---|---|---|
| cloudflared quick | **no** — new name every run | free | anyone with the URL |
| cloudflared named | yes | **a domain on his CF account** | anyone with the URL |
| ngrok free static | yes | free, **1 GB/month** | anyone with the URL |
| `tailscale serve` | yes | free | **his tailnet only** |

**He has no domain, so the Cloudflare named route is out.** A free Cloudflare account
is not enough on its own: `cloudflared tunnel route dns` writes into a zone, and a
zone is a domain he controls.

**ngrok's cap is real and this app is heavy.** He already has a reserved free static
domain — `crayfish-shorty-thinning.ngrok-free.dev`, and it bound on the first try —
but it currently answers:

```plaintext
HTTP/1.1 403 Forbidden          Ngrok-Error-Code: ERR_NGROK_725
This ngrok account has reached its network bandwidth limit for the month.
```

A first load here is **~115 MB** (72 MB of cards + 42 MB of audio), which is 11% of
the monthly allowance for ONE fresh origin. With a stable origin that is a one-time
cost and daily use is a few hundred KB; with the quick tunnel's new name every
session it would be four sessions a month.

**`tailscale serve` is the only one of the four that is not public**, and that is the
part worth more than the convenience: the other three put a server holding his entire
study history on the open internet behind an unguessable name. Free, no domain, no
bandwidth cap, and the certificate is real so it is a secure context:

### DONE, 2026-09-07 — measured over the tailnet

```plaintext
tailscale serve status     https://node.tailed819e.ts.net (tailnet only)
                           |-- / proxy http://127.0.0.1:4274
GET /                      200   tls verified   <title>梯子 · review</title>
GET /hashigo-app.db        200   "SQLite format 3"
GET /hashigo-app-blobs.db  200
tailscale funnel status    tailnet only — NOT publicly exposed
```

`tailscale serve --bg` is persistent configuration, so the daily routine is
`npm run phone` and nothing else. `tailscale serve --https=443 off` undoes it.

**`tailscale cert <host>` writes the pair into the CURRENT directory.** Probing
whether certificates were enabled dropped `node.tailed819e.ts.net.key` — a private
key — into the repo root, untracked and not ignored. Deleted, and `.gitignore` now
carries `*.ts.net.crt` / `*.ts.net.key` so a probe cannot be committed. `serve`
manages its own certificates and needs none of that; the only way those files appear
is someone checking.

### Setting it up — ONCE, and one step hangs instead of failing

Install on the laptop and the phone, sign both into the same account, then:

```bash
# 1. ENABLE HTTPS CERTIFICATES FOR THE TAILNET. Admin console only.
#    https://login.tailscale.com/admin/dns  ->  HTTPS Certificates  ->  Enable
# 2. then, on the laptop:
& "C:/Program Files/Tailscale/tailscale.exe" serve --bg 4274
```

**Step 1 is not optional and skipping it does not produce an error.**
`tailscale serve --bg 4274` on a tailnet without HTTPS certificates prints NOTHING
and never returns — measured here, killed after 60 s with an empty log and
`tailscale serve status` still saying "No serve config". The real message is only
reachable by asking for a certificate directly:

```plaintext
> tailscale cert node.tailed819e.ts.net
500 Internal Server Error: your Tailscale account does not support getting TLS certs
```

So `npm run phone` checks `tailscale serve status` before starting anything and
prints those two steps rather than launching a server nothing can reach. The Windows
installer also does not put `tailscale` on PATH, so the script looks in
`C:/Program Files/Tailscale/` as well.

Record the hostname once — `npm run phone` reads the provider off the suffix:

```bash
echo node.tailed819e.ts.net > .tunnel-named
```

`tailscale serve --bg` persists across reboots, so **none of this is the daily
routine**: after it, every session is `npm run phone` and the same URL every time.
`tailscale serve reset` undoes it.

`.ts.net` starts **no tunnel process at all**: `tailscale serve --bg` is persistent
configuration already running as a service, so the command only has to start the
server. That command is deliberately not run by the script — it changes machine state
that outlives the process, and silently reconfiguring his tailnet every time he wants
to review is the wrong shape.

### A LAN address cannot substitute, and that is measured

`http://192.168.x.x:4274` is **not a secure context**, and `navigator.storage` is
absent on one — no OPFS, no persistence, no app. His own handset, 2026-08-20,
`notes/archive/PHONE-TEST.md`: *"Route B (LAN IP) cannot work at all"*. The tunnel is
not a convenience here; it is the only route that runs the app.

### Two traps this command already handles

* **The cloudflared path has a space in it.** `C:\Program Files (x86)\cloudflared\`
  — spawned through a shell, cmd.exe splits it and reports `'C:/Program' is not
  recognized`. No shell.
* **Killing a shell does not kill what the shell started.** The server used to
  outlive Ctrl+C and hold port 4274, so the next run died on "already in use" while
  the tunnel stayed up and served **530** to the phone. Both children are direct
  children now, and both are killed as a tree.

Measured end to end over a real quick tunnel, 2026-08-26:

```plaintext
GET /                     200   <title>梯子 · review</title>
GET /hashigo-app.db       200   "SQLite format 3"
GET /hashigo-app-blobs.db 200
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

## The page is split into feature modules, and `main.ts` imports nothing back

Split on 2026-09-25, when Zach asked whether a 7,386-line `main.ts` was healthy. It
was not, for three measured reasons: nothing in it could be tested, every feature
commit touched it (73 of them), which is where his parallel sessions collided, and 46
module-level variables were readable and writable by 125 functions.

```plaintext
main.ts            the entry point and the REVIEW SCREEN: the session, the card,
                   the preview and card editor, boot. ~3,400 lines, and the heart.
shell.ts           the port main.ts provides at boot — what features still need from it
worker-client.ts   the worker and `ask`          layers.ts   the modal stack
ui.ts / dom.ts     say, the dialogs, the boot log, `el`
sidebar.ts         the tree, templates, sync dot — OWNS deckIndex, templateChoices
ops.ts             card operations and the undo stack
palette.ts  gallery.ts  template-editor.ts  dashboard.ts  settings.ts
deck-menu.ts  appearance.ts  backup-ui.ts
```

**Two rules hold it together, and `test/app-imports.test.ts` pins both.**

1. **Nothing imports `main.ts`.** It is the one module with side effects at load, so
   a cycle through it works only while nothing reads an import during evaluation.
   A feature that needs something `main.ts` still owns asks `shell()` for it.
   **`Shell` is a list that should only shrink**: each member is something a
   feature needs and `main.ts` still owns; when that thing is extracted, the member
   leaves and becomes a direct import. It started the day at four, grew to ten while
   the features came out, and ended at five — all of them review-screen or preview.
2. **Features may import each other.** The sidebar opens the gallery, the gallery
   calls card operations, the palette reads the sidebar's templates — they only
   ever call each other's functions after load, which ES modules handle.

**A module-level list has ONE writer.** `deckIndex` and `templateChoices` are
exported from `sidebar.ts` as live bindings and written only by `loadDecks`; an
import cannot be assigned to, so the compiler enforces it. That is also why
`refreshAfterOp` (in `ops.ts`) cannot touch the review card's pin/archive flags
itself — it asks `main.ts` to, through `shell().repaintReviewFlags()`.

The moves were made by a script that DERIVED each module's imports from what its
code used, and refused to write anything when a name had no home — it refused
twice, both times correctly (a local variable shadowing a top-level one of the same
name). Nothing was retyped.

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
> card has a live reverse track at 2 reps due **2023-03-03**. The bug was real and
> the fix stands; citing a deck-level setting he never turned on was not. The honest
> support is
> `日本語/単語` and `日本語/漢字`, where reverse is on for all 5,357 cards — which is
> also why his request for a **"reversed" label at the top of the card** matters:
> most of his real reverse volume is there.
>
> **And 5,357 is 単語 + 漢字 ALONE, not the total** — corrected 2026-08-23 after he
> asked whether 数字 exports in reverse (it does not: 90 cards, 90 forward tracks,
> zero reverse). The corpus total is **5,676**. Only four decks store
> `reverse: on` — 単語 3,702 · 漢字 1,655 · 言葉 146 · 文法 83 — four child decks
> inherit it for 81 more, and 9 cards carry `cards.reverse = 'on'`. Every other deck,
> 数字 and 部首 and all of 基本情報 included, resolves to OFF.
>
> **AND THOSE 9 ARE NOT 9 CHOICES HE MADE — corrected 2026-09-07 when he said "im
> pretty sure this deck isn't reversed" and asked for the export to be read.** In
> `build/hashigo.db` all 9 look identical: `cards.reverse = 'on'`. In the EXPORT they
> split, because `cards.reverse` is where the importer's do-not-orphan rule lands:
>
> ```plaintext
> English/Vocabulary, own `review-reverse?` in the export     reverse reviews   last
>   txkdHvOL  ray          True   <- his                          14        2025-09-16
>   3ym3Ai0O  ambivalent   True   <- his                          14        2026-01-03
>   oJ1QTcwf  plumb        True   <- his                          14        2026-02-14
>   oYjmEPwB  constraint   (none) <- FORCED by the importer         2        2023-03-01
>   J3R240Q0  irksome      (none) <- FORCED                         1        2024-04-08
>   rhX2sKTs  extol        (none) <- FORCED                         1        2023-08-08
>   6bOaHfsA  expulsion    (none) <- FORCED                         1        2026-05-07
>   9IsiWF95  impend       (none) <- FORCED                         1        2023-10-15
> ```
>
> **Three are his and five are the importer's.** The five carry one or two reverse
> reviews from years ago and no setting of their own — the signature of a stray tap in
> Mochi, not a decision. `src/import/entities.ts` forces them `on` so 43,083 reverse
> reviews corpus-wide are never orphaned, which is right at that scale and is what
> writes `cards.reverse` and erases the distinction.
>
> **The consequence is visible in the app**: their single reverse review is years old,
> so all five are deeply overdue and sort to the FRONT of the queue. The first four
> cards served on 2026-08-26 were `constraint`, `extol`, something, `irksome` — three
> of the five, all labelled REVERSED. That is what he was reacting to.
>
> **Do not "fix" this by relaxing the do-not-orphan rule.** Verified against the
> database: **zero** cards corpus-wide carry a reverse track while resolving off, so
> the rule has no outstanding debt — and a threshold on review count would silently drop
> history. If those five reverse tracks are unwanted, the narrow change is to mark
> those five tracks dormant (`dormant = 1` retains the history and stops scheduling —
> SPEC: "no scheduling toggle should ever destroy four years of history"). **That
> changes what he is DRILLED on, so it is his call** (decision 31).

So: **the question is the FIRST non-empty side.** Whatever the template author put
first is the question, in whichever order the direction asks for.

**It carried one exception until 2026-09-14 — a following side whose only content
was a WIDGET, which was 漢字's `<draw>` and nothing else — and Zach withdrew it**:
*"so it doesn't follow the `---`??? because i added that explicitly, i have my
reasons."* The exception was introduced here in `16afee6` on an agent's reasoning
about what the canvas needs, recorded in no decision; a `---` is a side break he
authored, and code does not overrule the template. The canvas is step 1 of the walk
now, which reveals nothing (漢字 has no cloze and no audio). Decision 44.

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
coverage                5,607 of 5,708 cards with speech can play something (98.2%)
```

`VACUUM INTO`, not a file copy: `build/hashigo.db` is in WAL mode and
`opfs-sahpool` stores one file per name, so a `-wal` sidecar cannot be imported and
anything living only in it would be **silently missing in the browser**. The script
refuses to ship a file whose header still says WAL.

The audio is a **bounded** subset and the rule is stated, because a subset with an
unstated rule is a lie: every `image`/`file` payload, then `speech` in ASCENDING
SIZE ORDER until `--speech-bytes` (default **200 MiB**, raised from 32 on
2026-09-07 — `scripts/app-bootstrap.ts` carries the coverage curve and why 200 is
where it turns) is spent. Smallest-first buys
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
  resolver ran, the worker answered, and the clip is simply outside the 200 MiB
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

## The sidebar (his request 5) — browsing is built, CREATE is not

*"a side bar to navigate, which is a space where we create cards, navigate the
card gallery"*. `/` opens it, Escape closes it, and a result opens a preview layer
— his request 2 reused exactly, because browsing to a card and following a link to
a card are the same act and deserve the same surface.

```plaintext
deck list        all decks 7,716 · English/Vocabulary 68 due · 1,234 · …
no query         "60 of 7,716"        ordered by name — a browse, not a ranking
search 意味       "3"                  日本語/単語 · 意味合い · a 基本情報 cloze card
deck filter      日本語/数字 → "60 of 90"
archived         7 in view, SHOWN and marked
result → preview  日本語/単語 · preview, then `e` stacks the editor on top
```

**意味 returning 3 is the point of routing through `src/search`.** Two characters
is the commonest search unit in Japanese and `card_fts`'s trigram tokeniser
**cannot serve a query shorter than three** — MATCH returns 0. That module routes
to a ranked scan and reports which path ran; the 3 above is exactly the figure its
own docstring predicts. A sidebar that had reached for FTS directly would have
shown him an empty list and looked broken.

**Archived cards are shown and marked, never hidden.** 234 in the corpus, 7 in
that view. Archiving means "stop reviewing", not "stop existing", and a browse
that silently omits a card he archived is a browse he cannot trust — the same
reasoning `SearchOptions.includeArchived` already documents.

**It opens on the LEFT and that is not arbitrary.** Decision 23 put the replay
button bottom-RIGHT because he reviews one-handed with his right thumb; a drawer
under that thumb would be opened by accident mid-card, interrupting a card he is
holding an answer for.

**Creating a card is here too**, and the id question that seemed to block it was
never real. Zach, for the fourth time: *"i never import one card or one deck, once
we finish developing hashigo, ill delete the whole card and reimport again"*. The
import is WHOLESALE, and decision 16 leaves exactly one more of them — after which
no Mochi id ever arrives again. So a card id has to be unique in this database and
nothing else, which `cards.id UNIQUE` already enforces. New ids are 8 base62
characters, the same shape Mochi uses, because one format is one thing to reason
about.

**The half that IS easy to forget is the tracks.** A card with no `card_tracks`
row is invisible to the scheduler forever — never due, never new, never in a
session. So creating one opens `forward` always and `reverse` when the deck
resolves to it, read from `card_reverse_resolved` rather than re-deriving the
inheritance walk. Verified: a new 単語 card came back `forward + reverse`.

`due_at` NULL and `reps` 0 puts it in the NEW queue, so decision 12's ten-a-day
limit applies to it like any other new card. It does not join the session already
running — that was built before the card existed and rebuilding mid-session would
reshuffle the queue underneath him — so the form says when it will appear.

Creating opens the EDITOR on the new card immediately, and the title goes into the
template's primary field as well, because a card with a title and no fields is not
yet a card and typing the word twice is not a workflow.

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

## Two things his #11 and #1 found by RUNNING them

Both were invisible to reading, and both changed what shipped.

### Renaming a field would have silently killed decision 29

`src/template/resolve.ts` binds `<<Field>>` **by NAME**. So the template editor's
rename rewrites the body and every generator prompt in the same transaction — that
much was designed. What running it found is the second binding: **`src/review/mode.ts`
finds the `Reading` field by name too** (`READING_FIELD = "Reading"`, plus a type
check for `boolean`).

So renaming that one field would have flipped all **692** of decision 29's `produce`
cards into `identify` — autoplay on entry, the accent handed over before he has
produced it, which is the exact defect decision 29 exists to prevent. And the body
rewrite makes it WORSE, not better: `<<#Reading>>` follows the rename perfectly, so
the template still renders and only the exercise is wrong. Nothing to see.

It is refused, scoped to templates that declare an `accent` field. 漢字 declares a
PLAIN field called `Reading` holding コウ / ショウ on 1,662 cards and is untouched.

```plaintext
rename Reading on 単語   refused, body unchanged at 498 bytes
rename Reading -> X      (before the guard) 8 references rewritten, mode silently flipped
```

### The dashboard works, and costs 81 seconds

Measured, in Chromium, over the real corpus. The port itself was a TYPE —
`src/dashboard/metrics.ts` was already a pinned browser entry point and only named
better-sqlite3's `Db` where it needed the shared `SqliteHandle`.

```plaintext
collect + render, worker (sqlite-wasm on OPFS)   81,060 ms   454 KB, zero JavaScript
collect + render, Node (better-sqlite3)          10,298 ms   same document
```

An 8x wasm penalty over roughly fourteen full passes of 102,020 rows. **The cost that
matters is not the wait**: sqlite-wasm is synchronous and there is one worker, so for
that whole time nothing can grade, load a card or save a field. A control that
silently freezes grading for a minute and a half is worse than one that says so, so it
asks first and quotes the last measured run. `notes/archive/NEXT-retired-2026-10-30.md` carries where the time goes and
why a cache is the wrong repair.

It renders in an `<iframe srcdoc sandbox="">`: the dashboard is a complete document
with its own stylesheet setting rules on `body`, `table` and `h1`, and two full
stylesheets in one document restyle each other. It runs no script, so the empty
sandbox costs it nothing.

## Installing it — the PWA, and the one trap that will bite

Built 2026-09-12. `app/public/` carries `manifest.webmanifest`, `sw.js` and the
icons; `app/install.ts` owns the button. `python`-free: `node tools/icons.mjs`
rasterises the mark into the four PNGs.

**The button is hidden until the browser offers.** `beforeinstallprompt` fires
only when Chromium has already decided the page is installable, and the control
appears then and not before — a button that cannot work is the dead-`<audio>`
mistake in different clothes. iOS never fires it; there the route is the Share
sheet and the app says nothing rather than lying.

> [!warning] **OPFS IS KEYED BY ORIGIN, AND INSTALLING PINS THE ORIGIN.**
> An installed PWA launches at the `start_url` of the origin it was installed
> FROM. A **quick** cloudflared tunnel gets a new random hostname every run, so
> installing from one produces a home-screen icon pointing at a host that will
> not exist tomorrow — and, being a different origin, a second empty database and
> another ~300 MB download if it ever did resolve.
>
> **Install from the FIXED hostname** — `.tunnel-named`, i.e. `tailscale serve`.
> The app says so itself: the install row carries a ⚠ note naming the reason
> whenever the current origin is `localhost` or `*.trycloudflare.com`.

**The service worker caches the shell and NEVER the databases.** That is not
tidiness. `/hashigo-app-blobs.db` is ~224 MB and Cache Storage shares the origin
quota with OPFS, so a cached copy would make the app hold ~600 MB to use ~300 —
on a phone, the difference between fitting and being evicted, and decision 17
exists because eviction has already happened once. The seed manifest `hashigo-app.json` is
bypassed too: it is the seed manifest `db.worker.ts` compares against OPFS, and a
cached one makes a stale database look current. `test/pwa.test.ts` checks the
worker's refusal list against the config's own served list, so adding a fourth
seeded file fails the suite until `sw.js` knows about it.

**The precache list is written by the build, and it has to be.** Runtime caching
only stores what actually crossed the network — measured 2026-09-12, the shell
and the CSS cached and the wordmark font did not, purely because that load never
re-requested it. The hole only appears on the train. `serviceWorkerPrecache()` in
`vite.app.config.ts` prepends the emitted asset list (the fonts, the wasm, the
worker, the icons — `npm run app:build` prints the count) to `sw.js`, hashed into the cache name so a new
build retires the old cache.

```bash
node tools/icons.mjs           # regenerate the icons from the mark
node tools/icons.mjs --compare # both colourways into build/icon-compare/
npm run app:build              # writes the precache list into build/app-dist/sw.js
```

**What is verified and what is not.** Registration, scope, shell caching and the
database bypass were measured in a real browser on the dev origin; the build's
precache list and emitted files were measured too. **The install prompt itself
was NOT** — the embedded browser pane never fires `beforeinstallprompt`, so the
button's reveal was exercised with a synthetic event. Whether Samsung Internet
offers the install, and with which icon, needs his handset on the tailscale
origin. That is one tap to find out and nothing else depends on it.

## What is NOT here yet

* **Sync (stage 11).** The last structural gap. Stage 10 is now complete: field
  editing (`e`), template and field editing (his #11), deck CRUD including `move`
  (his #14). The `Reading` toggle was the FIRST editor-shaped thing the shell had,
  because decision 29's audit loop dies without it.
* ~~A service worker / manifest.~~ **BUILT 2026-09-12**, at his request — see
  "Installing it" below. The spike's pair cached nothing on purpose; this one
  caches the shell and never the databases.
* Nothing else on the critical path. Eviction detection landed 2026-08-23 — see
  below.
* **A tap target on the head word.** Decision 23 deliberately does not settle
  where the head word pins after the reveal, where a decision-13 re-ask re-enters
  the session, or type and spacing detail. Those are Zach's.
