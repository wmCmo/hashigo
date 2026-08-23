# `spike/audio/` — THROWAWAY

**Everything in this directory is disposable harness**, exactly like `spike/`
itself. It exists to settle one question that could not be settled by reasoning:
does a real mp3 out of Zach's corpus actually reach an `<audio>` element and
decode, when the bytes live in a database and there is no path to give the
element? `notes/archive/browser-feasibility.md` §7 listed this as untested and was
explicit that the bytes it had stored were "synthetic, not the real mp3s".

The PRODUCTION half of this work is **`src/blobs/url.ts`** — object URLs and
their revocation. Nothing in `src/` imports anything here. Delete this directory
once the PWA shell can play a card.

```
spike/audio/
  pick-clips.py       reads DECLARED attachment types out of the real exports and
                      picks 18 clips that cover every declaration Mochi made
  make-audio-db.ts    builds the two databases the page fetches, using the real
                      SqliteBlobStore class rather than a copy of its DDL
  index.html          the page (plus a ?nohmr=1 escape hatch, see Caveats)
  main.ts             the DOM side: <audio>, AudioContext, and src/blobs/url.ts
  blobs.worker.ts     the dedicated Worker: OPFS, both databases, the store
  protocol.ts         the messages between them
  hashigo-audio-*.db  GENERATED, gitignored. Rebuild them; never commit them.
```

## Run it

```bash
PYTHONIOENCODING=utf-8 python spike/audio/pick-clips.py \
    --out build/spike/audio-clips.json \
    exports/日本語 exports/English exports/基本情報
npx vite-node spike/audio/make-audio-db.ts
npm run spike:dev            # the same dev server spike/ uses, port 5273
# then open http://localhost:5273/audio/ and click Run
```

`?auto=1` runs the suite without waiting for a click. `?nohmr=1` hands Vite's HMR
client a dead socket, because the dev server full-reloads this page whenever
another agent saves anything under `src/`, and a 15-second run of real audio
cannot survive that.

## The path the bytes travel — all production code except the page itself

```
build/hashigo.db                     the real 7,716-card database
build/hashigo.db.blobs/<2>/<sha256>  the existing content-addressed store
  |  make-audio-db.ts: read by hash, re-hash, refuse on mismatch
  v
hashigo-audio-store.db   SqliteBlobStore  (src/blobs/sqlite.ts) — BLOB rows
hashigo-audio-meta.db    `blobs` rows: address, sniffed mime, provenance,
                         bytes NULL, path NULL
  |  fetch() + pool.importDb()          (src/db/browser.ts)
  v
OPFS /spike-audio-store.db + /spike-audio-meta.db, opfs-sahpool, in a Worker
  |  readBlob(metaDb, hash, store)      (src/blobs/db.ts)
  |  sha256Hex(bytes) === hash          (src/blobs/sha256.ts) — in the browser
  |  postMessage(…, [buffer])           transferred, not copied
  v
BlobUrlScope.claim() -> blob: URL       (src/blobs/url.ts)  <- THE NEW CODE
attachMedia(<audio>, lease)             -> canplay, playing, currentTime
attachment.detach()                     -> pause, clear src, load(), revoke
```

## What it settled

| question | answer, measured |
|---|---|
| Does a real corpus mp3 decode from a blob URL? | **Yes.** 15 of 15, `duration` 1.560 s – 28.968 s, 80.4 s of audio, clock advancing ~0.37 s per 400 ms. |
| Is `duration` enough to prove decode? | No, and it is not relied on: `decodeAudioData` returned 1 channel at 48,000 Hz with matching durations, and one clip reached `ended` after a seek. |
| Does the wrong mime break `<audio>`? | **No — SPEC.html is wrong about this.** It says "A browser handed `text/xml` in an `<audio>` element will not play it, so this breaks playback outright". The same mp3 played when labelled `audio/mpeg`, `text/xml`, `application/octet-stream`, `""` and `audio/mpeg; codecs="mp3"`. Chromium sniffs and ignores the label. |
| Is there a shape where it *is* fatal? | **Yes: `<source type=…>`.** `type="text/xml"` → the `<source>` errors, `networkState` 3, `duration` NaN, and `element.error` stays **null**. So `attachMedia` sets `src`, never `<source>`. |
| Who revokes, and when? | The scope that minted it, after the element has been cleared. Revoking before load → `MEDIA_ERR_SRC_NOT_SUPPORTED`. Revoking after `canplay` → playback continues, but the next `load()` on the still-assigned URL fails the same way. |
| Can the worker mint the URL? | It resolves in the document (same origin, one blob URL store) — but the worker cannot know when the element is done, so `src/blobs/url.ts` lives on the DOM side. |
| Does a review session leak? | Not with a scope per card: 40 presentations × 3 clips = 120 URLs minted and revoked, peak 67,392 live bytes. The cap (`maxLive` 32 / `maxLiveBytes` 32 MiB) is a backstop for a caller who forgets. |
| What happens with TWO tabs open on the same origin? | **The second tab cannot open the database at all** — hit by accident here, reproducibly. `opfs-sahpool` holds an exclusive sync access handle per pool file, so the second install fails once per slot with `NoModificationAllowedError: Access Handles cannot be created if there is another open Access Handle…`, and then `removeVfs()` fails too, logging *"failed with no recovery strategy"*. `notes/archive/browser-feasibility.md` §7 listed multi-tab as unexercised; this is the shape of it. Transcript: `build/spike/audio/multi-tab-failure.txt`, console: `build/spike/audio/multi-tab-console.log`. |
| How fast is a payload out of an OPFS SQLite store? | 0.33 ms per payload, 18 payloads / 1,487,398 bytes in 5.9 ms — consistent with `notes/archive/browser-feasibility.md` §4's 0.54 ms. |

## Caveats — read these before quoting anything above

* **No phone.** Chromium 151 on Windows 11, driven by Playwright. Zach reviews on
  Android and nothing here was run there.
* **The autoplay policy went unmeasured.** `navigator.userActivation.isActive` is
  already `true` on a fresh load in this automated browser, `play()` resolved with
  no gesture at all, and `navigator.getAutoplayPolicy` does not even exist in it.
  So the *blocked* case could not be produced. The run reported below is still
  driven by a real Playwright click, so the evidence is gesture-backed either way
  — but **on the phone the policy applies**, and the app must call `play()` inside
  the tap that graded the card. That is not proven; it is the known rule.
* **Dev server, not the built bundle.** `spike/` proved the bundle already; adding
  a second page to `vite build` means editing `vite.config.ts`, which this spike
  does not own. Nothing in the audio path depends on the bundling mode.
* **18 clips, 1.5 MB — not 10,816 clips and 625 MB.** This measures decode and
  lifecycle, not the full-corpus store.
* The audio players in the screenshot all read `0:00 / 0:00` because `detach()`
  cleared their `src` afterwards. That is the revocation working, not the audio
  failing.
* The multi-tab failure above is a real observation but an accidental one: I did not set out
  to test it, and I did not test what happens to the FIRST tab afterwards, whether a reload
  of the second tab recovers, or whether a shared worker would fix it. Stage 7 needs its own
  experiment.
* Clicking **Re-import** calls `pool.importDb()` on files this worker already has
  open handles for. It worked (the audit passed and every payload read back), but
  it is not something production should do — close first.

## The real output, pasted

`npm run spike:dev` → `http://localhost:5273/audio/?nohmr=1` → click **Run**.
Chromium 151 via Playwright. Full transcript, nothing removed
(`build/spike/audio/run-final.txt`; the screenshot is
`build/spike/audio/hashigo-audio-spike.png`).

```
1. environment
  inDedicatedWorker()            true
  isSecureContext                true
  crossOriginIsolated            false
  sqlite                         3.53.0
  URL.createObjectURL in WORKER  function
2. the two prebuilt databases -> OPFS
  /spike-audio-meta.db is already in OPFS — not re-importing
  /spike-audio-store.db is already in OPFS — not re-importing
  pool holds ["/spike-fresh.db","/spike-audio-meta.db","/spike-audio-store.db","/blobs.db","/hashigo.db"]
3. open both, and put the production store over the payload database
  opened both in 13.2ms
  store sqlite:/spike-audio-store.db
  store user_version 1 (src/blobs/sqlite.ts ships 1)
  blob_payloads 18 rows, 1,487,398 bytes
  blobs rows 18, of which inline (bytes NOT NULL): 0
4. the acceptance checks, run in the browser
  audit: blobs 18 | present 18 | inline 0 | missing 0 | orphaned 0 | size mismatched 0
  every address in `blobs` resolves to a payload in the store
  blobs.path non-NULL: 0
  findLocations swept 16 column(s) across 2 table(s): NO location anywhere
5. read every payload through the store, and re-hash it here
  18 payload(s), 1,487,398 bytes, 5.5ms total (0.31ms per payload)
  all 18 payload(s) re-hash to their address, computed in the browser
6. handing the bytes to the page (the object URL is minted there)

18 clip(s) came back from the worker:
  日本語    4zZm3biV.mp3     speech  declared audio/mpeg                 sniffed audio/mpeg                  17,568B - ja-JP "彼はその町で有名な殿様のような存在だ。"
  日本語    6D0QT9cO.mp3     speech  declared audio/mpeg                 sniffed audio/mpeg                  23,328B - ja-JP "彼は重要な情報を発信するためにSNSを利用しています。"
  日本語    02EvaUGo.mp3     speech  declared (nothing)                  sniffed audio/mpeg                  26,496B ja-JP-NanamiNeural ja-JP "狙う"
  日本語    01yeiIUr.mp3     speech  declared (nothing)                  sniffed audio/mpeg                  27,072B ja-JP-NanamiNeural ja-JP "昨夜"
  日本語    00J8QDCH.mp3     speech  declared text/xml                   sniffed audio/mpeg                  31,200B ja-JP-NanamiNeural ja-JP "雪崩"
  日本語    02HWu9cG.mp3     speech  declared text/xml                   sniffed audio/mpeg                  38,400B ja-JP-NanamiNeural ja-JP "生活圏"
  日本語    02NHSEJy.mp3     speech  declared text/xml                   sniffed audio/mpeg                  64,320B ja-JP-NanamiNeural ja-JP "彼は優れた視覚を持っている。"
  日本語    03exFTMF.mp3     speech  declared (nothing)                  sniffed audio/mpeg                  65,088B ja-JP-NanamiNeural ja-JP "彼女は毎日注射を打たなければなりません。"
  日本語    01MPmlvM.mp3     speech  declared text/xml                   sniffed audio/mpeg                  70,080B ja-JP-NanamiNeural ja-JP "期待はずれな映画を見てがっかりした。"
  日本語    06egnufT.mp3     speech  declared application/octet-stream   sniffed audio/mpeg                  76,320B ja-JP-NanamiNeural ja-JP "飲食店で美味しい料理を楽しんだ。"
  日本語    073RBZIK.mp3     speech  declared application/octet-stream   sniffed audio/mpeg                  84,000B ja-JP-NanamiNeural ja-JP "今日はちょっと変な格好で学校に来てしまった。"
  日本語    00HqId3N.mp3     speech  declared text/xml                   sniffed audio/mpeg                  90,720B ja-JP-NanamiNeural ja-JP "裁判官は被告に有罪判決を言い渡した。"
  日本語    0B7k5TBy.mp3     speech  declared application/octet-stream   sniffed audio/mpeg                  95,040B ja-JP-NanamiNeural ja-JP "彼の特徴は、明るい笑顔と優しい性格です。"
  日本語    01JmNbRB.mp3     speech  declared text/xml                   sniffed audio/mpeg                 126,240B ja-JP-NanamiNeural ja-JP "彼は半面のみを見せて、本当の気持ちを隠している。"
  基本情報   H7iiyObg.mp3     speech  declared application/octet-stream   sniffed audio/mpeg                 579,360B - ja-JP "連関図法は、複雑な要因の絡み合う事象について、その事象間の因果関係や相互関係を整理していくことで問題や原因を明らかにし、課題解決のための糸口を発見する手法。中央に課題を置き、その周りに事象を置いていく作成方法が一般的。 特性要因図とは、事象同士の因果関係を表現できる点で異なっている。"
  English 3Y7tGIes.mp3     speech  declared text/xml                   sniffed application/octet-stream         0B en-US-AIGenerate1Neural en-US "he defiantly refused to give in </speech>"
  English 1O4P02.jpg       image   declared image/jpeg                 sniffed image/jpeg                  31,982B - - "clarinet"
  日本語    c6pLUd.jpg       image   declared (nothing)                  sniffed image/jpeg                  40,184B - - "crane or stork"

7. BEFORE any click: does decode need a gesture, and does playback?
  navigator.getAutoplayPolicy("mediaelement") = unavailable
  navigator.userActivation.hasBeenActive = true
  without a gesture: canplay, duration 4.392s, readyState HAVE_ENOUGH_DATA
  DECODE DOES NOT NEED A GESTURE: metadata and a full buffer arrived unprompted
  play() RESOLVED with no user gesture and reached 0.228s. This browser is NOT enforcing the autoplay policy — Playwright's Chromium is launched with it off — so the blocked case could not be observed here at all. A phone WILL enforce it.
  events: loadstart loadedmetadata suspend loadeddata canplay canplaythrough play playing
  after detach: lease.revoked true, scope.live 0

READY — click Run (a real click is a user gesture, which is what the
autoplay policy wants). The driver clicks it; a human can too.

user gesture recorded: navigator.userActivation.isActive = true
8. every clip, through src/blobs/url.ts, judged on decode and on the clock
  OK   audio/mpeg -> audio/mpeg 4zZm3biV.mp3 17,568B | canplay | duration 4.392s | play playing | reached 0.367s (+0.367s in the last 400ms) | timeupdate x1 | read 0.50ms | address ok
  OK   audio/mpeg -> audio/mpeg 6D0QT9cO.mp3 23,328B | canplay | duration 5.832s | play playing | reached 0.369s (+0.369s in the last 400ms) | timeupdate x1 | read 0.20ms | address ok
  OK   (nothing) -> audio/mpeg 02EvaUGo.mp3 26,496B | canplay | duration 1.656s | play playing | reached 0.379s (+0.379s in the last 400ms) | timeupdate x1 | read 0.20ms | address ok
  OK   (nothing) -> audio/mpeg 01yeiIUr.mp3 27,072B | canplay | duration 1.692s | play playing | reached 0.381s (+0.381s in the last 400ms) | timeupdate x1 | read 0.20ms | address ok
  OK   text/xml -> audio/mpeg 00J8QDCH.mp3 31,200B | canplay | duration 1.560s | play playing | reached 0.371s (+0.371s in the last 400ms) | timeupdate x1 | read 0.10ms | address ok
  OK   text/xml -> audio/mpeg 02HWu9cG.mp3 38,400B | canplay | duration 1.920s | play playing | reached 0.372s (+0.372s in the last 400ms) | timeupdate x1 | read 0.20ms | address ok
  OK   text/xml -> audio/mpeg 02NHSEJy.mp3 64,320B | canplay | duration 3.216s | play playing | reached 0.375s (+0.375s in the last 400ms) | timeupdate x1 | read 0.20ms | address ok
  OK   (nothing) -> audio/mpeg 03exFTMF.mp3 65,088B | canplay | duration 4.068s | play playing | reached 0.386s (+0.386s in the last 400ms) | timeupdate x1 | read 0.30ms | address ok
  OK   text/xml -> audio/mpeg 01MPmlvM.mp3 70,080B | canplay | duration 3.504s | play playing | reached 0.368s (+0.368s in the last 400ms) | timeupdate x1 | read 0.40ms | address ok
  OK   application/octet-stream -> audio/mpeg 06egnufT.mp3 76,320B | canplay | duration 3.816s | play playing | reached 0.367s (+0.367s in the last 400ms) | timeupdate x1 | read 0.20ms | address ok
  OK   application/octet-stream -> audio/mpeg 073RBZIK.mp3 84,000B | canplay | duration 4.200s | play playing | reached 0.365s (+0.365s in the last 400ms) | timeupdate x1 | read 0.20ms | address ok
  OK   text/xml -> audio/mpeg 00HqId3N.mp3 90,720B | canplay | duration 4.536s | play playing | reached 0.376s (+0.376s in the last 400ms) | timeupdate x1 | read 0.30ms | address ok
  OK   application/octet-stream -> audio/mpeg 0B7k5TBy.mp3 95,040B | canplay | duration 4.752s | play playing | reached 0.362s (+0.362s in the last 400ms) | timeupdate x1 | read 0.20ms | address ok
  OK   text/xml -> audio/mpeg 01JmNbRB.mp3 126,240B | canplay | duration 6.312s | play playing | reached 0.375s (+0.375s in the last 400ms) | timeupdate x1 | read 0.40ms | address ok
  OK   application/octet-stream -> audio/mpeg H7iiyObg.mp3 579,360B | canplay | duration 28.968s | play playing | reached 0.366s (+0.366s in the last 400ms) | timeupdate x1 | read 1.00ms | address ok
  OK   text/xml -> application/octet-stream 3Y7tGIes.mp3 0B | error MEDIA_ERR_SRC_NOT_SUPPORTED | duration NaN | play - | reached 0.000s (+0.000s in the last 400ms) | timeupdate x0 | read 0.10ms | address ok
  OK   image/jpeg -> image/jpeg 1O4P02.jpg 31,982B | error MEDIA_ERR_SRC_NOT_SUPPORTED | duration NaN | play - | reached 0.000s (+0.000s in the last 400ms) | timeupdate x0 | read 0.60ms | address ok
  OK   (nothing) -> image/jpeg c6pLUd.jpg 40,184B | error MEDIA_ERR_SRC_NOT_SUPPORTED | duration NaN | play - | reached 0.000s (+0.000s in the last 400ms) | timeupdate x0 | read 0.20ms | address ok
  scope after 18 clips: live 0, liveBytes 0, stats {"claimed":18,"reused":0,"revoked":18,"evicted":0}
  every URL this phase minted has been revoked
  15/15 real mp3s decoded AND advanced their clock
9. one clip seeked near its end and played out — 'ended' has to arrive
  duration 4.392s, seeked to 3.992s, ended at currentTime 4.392s
  'ended' fired: the decoder ran to the end of a real clip
10. the same bytes through AudioContext.decodeAudioData — PCM, not a promise
  4zZm3biV.mp3 17,568B -> 1 channel(s), 48,000 Hz, 210,816 samples, 4.392s in 6.5ms
  6D0QT9cO.mp3 23,328B -> 1 channel(s), 48,000 Hz, 279,936 samples, 5.832s in 8.1ms
  02EvaUGo.mp3 26,496B -> 1 channel(s), 48,000 Hz, 79,488 samples, 1.656s in 2.7ms
  AudioContext state running, sampleRate 48,000
11. THE MIME QUESTION: one real mp3, five labels, <audio src=blob:…>
  clip 00J8QDCH.mp3, declared text/xml, sniffed audio/mpeg
  Blob type "audio/mpeg"               canPlayType "probably"   -> canplay duration 1.560s   reached 0.232s (+0.232s)
  Blob type "text/xml"                 canPlayType ""           -> canplay duration 1.560s   reached 0.229s (+0.229s)
  Blob type "application/octet-stream" canPlayType ""           -> canplay duration 1.560s   reached 0.233s (+0.233s)
  Blob type ""                         canPlayType ""           -> canplay duration 1.560s   reached 0.228s (+0.228s)
  Blob type "audio/mpeg; codecs=\"mp3\"" canPlayType "probably"   -> canplay duration 1.560s   reached 0.231s (+0.231s)
  playableMime() of each: "audio/mpeg"->"audio/mpeg" "text/xml"->"" "application/octet-stream"->"" ""->"" "application/xml"->"" "text/plain"->""
12. the same bytes behind <source type=…>, which IS filtered by canPlayType
  <source type="text/xml"> -> source error, networkState 3 (3 = NETWORK_NO_SOURCE), duration NaN, element.error null
  <source type="audio/mpeg"> -> canplay, networkState 1 (3 = NETWORK_NO_SOURCE), duration 1.560s, element.error null
13. revocation: who revokes, when, and what breaks if it is done wrongly
  (a) revoke BEFORE load -> error MEDIA_ERR_SRC_NOT_SUPPORTED, duration NaN
  (a) attachMedia() on a revoked lease refuses: blob bf586f8aacd712cd3f000a9af740d84fc08983d401057fb2534676fec768928
  (b) revoke AFTER canplay, then play -> reached 0.236s (the resource was already fetched; revoking does not reclaim it mid-play)
  (b) then load() again with the dead URL still on src -> error MEDIA_ERR_SRC_NOT_SUPPORTED — this is why detach() clears src BEFORE revoking
  (c) claiming the same address twice: same URL true, live 1, stats {"claimed":1,"reused":1,"revoked":0,"evicted":0}
  (c) revoke twice: revoked true, stats {"claimed":1,"reused":1,"revoked":1,"evicted":0}
  (d) same address, different bytes -> BlobConflictError
  (e) maxLive 3, claimed 6: live 3, liveBytes 96,672, stats {"claimed":6,"reused":0,"revoked":3,"evicted":3}
  (e) oldest lease revoked by eviction: true; newest still live: true
  (e) maxLiveBytes 65,536: live 1, liveBytes 38,400 (one clip may exceed the cap on its own; the cap yields rather than hand back a dead URL)
  (e) releaseAll() revoked 3 + 1
  (f) 40 card presentations x 3 clips: 120 URLs minted and revoked, peak live 67,392 bytes — a session's ceiling is one card, not the session
14. an object URL minted in the WORKER, consumed in the document
  worker minted blob:http://localhost:5273/c457d047-229a-4d43-9dcd-1c0333757fab
  blob:http://… -> canplay, duration 4.392s, reached 0.235s
  a worker-minted URL DOES resolve in the document (same origin, one blob URL store) — but the worker cannot know when the element is done with it, which is why src/blobs/url.ts lives on the side that owns the element
15. the non-audio controls, through the same code path
  1O4P02.jpg as <img>: load, 500x333, declared image/jpeg sniffed image/jpeg
  the same BlobUrlScope serves images; the earlier <audio> failure was the CONTENT

16. verdict
  real mp3s from the corpus played: 15/15
  total audio decoded: 80.424s, longest 28.968s, furthest position reached on any one clip 0.386s
  failures recorded on this page: 0
  ALL STEPS COMPLETED — real corpus mp3, out of a SQLite blob store in OPFS,
  through URL.createObjectURL, decoded and played in a real browser.
```


The first load of the same page, which imports instead of reattaching (the
**Re-import** button takes the same path):

```
2. the two prebuilt databases -> OPFS
  fetched 20,480 bytes for /spike-audio-meta.db in 5.8ms
  importDb -> OPFS: 20,480 bytes in 1.5ms
  fetched 1,572,864 bytes for /spike-audio-store.db in 15.7ms
  importDb -> OPFS: 1,572,864 bytes in 4.1ms
  pool holds ["/spike-fresh.db","/spike-audio-meta.db","/spike-audio-store.db","/hashigo.db"]
```

And the two build steps that produce what it fetches:

```
$ PYTHONIOENCODING=utf-8 python spike/audio/pick-clips.py --out build/spike/audio-clips.json exports/日本語 exports/English exports/基本情報
exports/日本語: 7,958 live attachments
exports/English: 2,397 live attachments
exports/基本情報: 532 live attachments

live attachments total 10,887
declared types, as Mochi recorded them:
  application/octet-stream    4,979
  text/xml                    3,443
  (nothing)                   2,424
  audio/mpeg                     36
  image/jpeg                      4
  image/png                       1

picked 18 clips, 1,487,398 bytes

$ npx vite-node spike/audio/make-audio-db.ts
store    18 payload(s) written in 7.0ms, 1,487,398 bytes, 18/18 verified by rehash
declared -> sniffed, in what the page will play:
! text/xml                   -> audio/mpeg                6 clip(s), 420,960 B
! application/octet-stream   -> audio/mpeg                4 clip(s), 834,720 B
! (nothing)                  -> audio/mpeg                3 clip(s), 118,656 B
  audio/mpeg                 -> audio/mpeg                2 clip(s), 40,896 B
! (nothing)                  -> image/jpeg                1 clip(s), 40,184 B
  image/jpeg                 -> image/jpeg                1 clip(s), 31,982 B
! text/xml                   -> application/octet-stream  1 clip(s), 0 B
  declared type WRONG on 15 of 18 clips
  1,527,808 / 20,480 bytes, header write=1 read=1 (rollback journal — importable into OPFS)
```

`36 + 4 + 1 = 41` correct declarations out of 10,887, which is the figure
`src/import/blobs.ts` states — reproduced here from the raw export, independently.
