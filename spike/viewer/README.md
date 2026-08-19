# `spike/viewer/` — THROWAWAY

**Everything in this directory is disposable harness**, like the rest of `spike/`.
Nothing in `src/` imports it and deleting it costs nothing — verified: `grep -rn
"spike/" src/ test/ scripts/` returns prose references only, never an import, and
the repo `tsconfig.json` includes `src/`, `test/`, `scripts/` and nothing else. It
is not the review UI: there is **no grading, no queue and no scheduler** here.
Those are stage 7 and they need Zach's taste, not an agent's.

It exists to put one question in front of a real browser:

> Is the clip silent when a side appears, and does it fire on the reveal?

That is the 高低アクセント shadowing drill — look at the kanji, recall whether each
mora is high or low, say it aloud, and only *then* hear it. Autoplay is the default
in most flashcard renderers and it destroys the exercise silently. So this page
counts, live, four things that would each have to happen for a clip to be heard
early, and prints them before and after every reveal.

## READ THIS BEFORE QUOTING THIS PAGE AS EVIDENCE

**This harness implements its own reveal sequencing.** `main.ts` has
`revealSide()` and `armSide()`; it does NOT import `shadowingLoop` from
`src/render/reveal.ts`, which is the loop that ships. So a green gate panel here
is evidence about **Chromium** — that a real `<audio>`, a real `blob:` URL and a
real gesture do not produce sound before the reveal — and it is **not** evidence
about the production loop.

What pins the production loop is `test/reveal.test.ts`, which drives
`shadowingLoop` directly, sweeps all 7,716 cards, and has been shown to have
teeth: putting `audio.play(...)` inside `enter()` turns 8 of its tests red,
including the corpus sweep (450 violations) and the grep that counts the
playback call sites. Adding an `autoplay` attribute in `src/render/nodes.ts`
turns 8 tests red across three files. Both mutations were applied and reverted
by the integrator on 2026-08-20.

Rewiring this page onto `shadowingLoop` would make the browser evidence cover
the shipping code as well. It has not been done, deliberately: this directory is
throwaway and the review UI is stage 7, so the loop that ships is worth wiring
once, into the real shell, rather than twice.

```
spike/viewer/
  index.html          the page. Plain on purpose — see "What is deliberately ugly".
  main.ts             main thread: render, step, reveal, attach, instrument
  cards.worker.ts     the dedicated Worker: both databases, every SQL statement
  protocol.ts         the messages between them
  speech-bridge.ts    the speech-FIELD bridge, and the finding behind it. READ THIS.
  make-viewer-db.ts   builds the bounded audio subset the page fetches
  tsconfig.json       this slice's own gate; the repo's tsconfig excludes spike/
```

## Run it

```bash
npm run spike:bootstrap                                # once: build/spike/hashigo-bootstrap.db (69 MB)
npx vite-node spike/viewer/make-viewer-db.ts           # once: spike/viewer/hashigo-viewer-blobs.db (32 MiB)
npm run spike:dev -- --host 127.0.0.1                  # http://127.0.0.1:5273/viewer/
npx tsc -p spike/viewer                                # this slice's typecheck
```

Bind IPv4 explicitly. A dev server on `::1` looks fine to `localhost` and is
refused by `127.0.0.1`, which has cost this project time twice.

For the phone, put it behind a **cloudflared HTTPS tunnel** and add the hostname to
`server.allowedHosts` in `vite.config.ts`. `PHONE-TEST.md` has the reasoning: on a
LAN address (`http://192.168.x.x`) `navigator.storage` is **absent outright**, and
USB port-forwarding stalls when the RSA prompt never appears.

`#/card/<id>` is a real route — it is the href `src/render` mints for a wiki-link,
so tapping a `[[link]]` inside a card loads that card. Bookmarkable.

## The two databases, and why only one of them is built here

| in OPFS as | from | size |
|---|---|---|
| `/hashigo.db` | `/hashigo-bootstrap.db`, already served by `vite.config.ts` | 69 MB |
| `/hashigo-viewer-blobs.db` | `make-viewer-db.ts`, imported with `?url` | 32 MiB |

The card database is the same OPFS filename the stage-0.5 spike uses, so if that
page has already run, this one reattaches in ~20 ms and downloads nothing.

Every TEXT generation is already **inline** in `blobs.bytes` — 15,958 ai, 7,749
translate, 3,233 furigana, 7 dictionary — so it rides along in the 69 MB. Audio
does not: 10,791 speech payloads, 647,952,288 bytes. `make-viewer-db.ts` therefore
ships a bounded subset, smallest-first, and prints the coverage it bought:

```
cards with playable audio in this subset: 1,031 of 5,708 that have any (18.1%)
```

Raise `--speech-bytes` for more. A card whose clip is outside the subset says so on
the element, in words, rather than failing quietly.

## The finding this harness exists to have made

`speech-bridge.ts` has the full version with the numbers. Short form:

**A `speech` FIELD renders to nothing, so the drill's audio is unreachable from
`RenderResult`.** 単語's `<< Speech >>` is a `template_fields` row of type `speech`;
generator fields carry no value in this corpus (`card_field_values` has **0 rows**
for 単語's `Speech` and `Audio`); the resolver substitutes the value, correctly,
and substitutes nothing. No element, no `MediaMount`, no `data-state="pending"`.
The clip is on the card in `blob_refs` and nothing in the rendered DOM can hold it.

Toggle **Speech-field bridge** to see both states on the same card:

```
bridge OFF   media mounts 0 · <audio> in the card 0 · both clips "present" in the store
bridge ON    media mounts 2 · the word clip on side 2, matched by source_text
```

The bridge is a rewrite of the TEMPLATE BODY before stage 3 runs —
`<< Speech >>` becomes `<speech lang="ja-JP" voice="ja-JP-NanamiNeural"><<単語>></speech>`,
which is what the same author wrote by hand in 敬語 and Polysemy. Everything after
that is the real parser, the real resolver, a real `GeneratorMount` and the real
`src/blobs/url.ts`. It is not a second renderer, and stage 4 is not touched.

## What is deliberately ugly

Correct typography, legible spacing, thumb-sized controls, and nothing else. No
colour identity, no motion, no shadows. **How a cloze should read before and after
reveal, and how the 漢字 canvas should feel under a finger, are Zach's calls** — an
agent guessing at them produces a guess that is then hard to argue with. The
provisional bits, flagged so they are easy to throw away:

* the cloze mask is a grey box; the revealed cloze gets an underline;
* the drawing surface is plain pointer strokes with the authored `brushColor` and
  `brushRadius`, sized to `devicePixelRatio` at mount because the renderer
  deliberately emits no `width`/`height`. No smoothing, no pressure, no undo;
* an empty `<rt>` shows an em dash so pending furigana is visible rather than absent.

Every class on a card is `hashigo-*` and comes from `src/render`'s `CLASS`. Every
class this harness adds is `viewer-*`. The only DOM the harness puts inside a card
is one `<span class="viewer-audio-note">` per media element.

## Two harness policies worth knowing before you trust a screenshot

1. **Every payload attaches on reveal, images included.** For audio that is the
   whole point. For an `<img>` it is a simplification: a card whose front is a
   picture would want the image attached on side entry. Stage 7's call.
2. **One clip per side is started.** If a side carries two, both attach, the first
   plays, and the log says so. No card in the corpus has two audio elements on one
   side except Polysemy's, where the second is the example sentence.

## Scripting it

`window.hashigoViewer.snapshot()` returns exactly what the gate panel shows, as
data — including per-element `src`/`currentSrc`/`networkState`/`readyState`/`played`
and the global `play()` / object-URL / payload-read counters. `hashigoViewer.audit()`
walks every media element in the document. That is how the evidence in the report
was collected, and it works in the phone's own dev console too.
