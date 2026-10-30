# Release — the version, and the gates before Hashigo opens to other people

Moved out of `NEXT.md` on 2026-10-30, when that file was retired (it is at
`notes/archive/NEXT-retired-2026-10-30.md`). This is the ONE place a version
decision or a gate result is recorded. Status otherwise lives in git, the code and
`DECISIONS.md` — not in a hand-kept status file, which is what `NEXT.md` became.

## Publishing gates — when Hashigo opens to other people (agreed 2026-10-27)

Zach, 2026-10-27: *"if i use this for like another month, and there's rarely any change,
then i think it would be a good sign to publish it right?"* Three gates, in order. The
landing page (`site/index.html`) shows them as the rungs still to climb, so if one
passes, update the page too.

1. **A month of daily use with almost nothing to fix.** Checked **2026-11-27** by a
   scheduled routine (`trig_01QTk6bozJ3LZu3kf1UFphUx`, a fresh session at 10:17 JST).
   It PASSES if, from 2026-11-13 to 2026-11-27: at most two commits fix something he hit
   while using the app; none of them involved a lost or corrupted review or a sync that
   lost data; and nothing suggests a workaround to finish a session. **Raw commit count
   is not the measure** — 2026-10-27 alone was 25 commits of design work, which says
   nothing about stability. New features do not count against it.
2. **A friend starts from an empty database without help.** Not yet possible: the app
   assumes his imported corpus and sits behind his passphrase.
3. **Cost, accounts, licence and support are settled.** The repository is already
   public (it has no licence, so all rights are reserved); the app is not.

Results:

- *(none yet — the first check runs 2026-11-27)*

## How the version moves (decision 59, 2026-10-31)

**Every deploy is a release.** `npm run release -- patch` (fixes only) or
`npm run release -- minor "what he can now do"` (a milestone), push the commit and the
tag, then deploy. `npm run app:build:cloud` refuses anything else.

| part | moves when |
|---|---|
| major | stays **0** until 1.0 (below). Asked for by name: `--one-point-oh` |
| minor | a milestone, OR a change to `SCHEMA_VERSION` / `SYNC_VERSION` / `ARCHIVE_VERSION` — both devices must update, and `release` refuses a patch for it |
| patch | a deploy that only fixes things — per deploy, not per commit |

**The changelog is the tags.** Each release's tag message lists every commit since the
last one: `git tag -n99 v0.6.0`. Nothing here repeats it.

## Version — 0.6.0, late alpha (2026-10-31)

0.5.0 → 0.6.0 was one catch-up bump for 35 days and ~100 commits: the cloud move, grade
deltas, the design system, 優先 and kanji-first, 出典, the accent helper, the writing
canvas, and templates from scratch. The tag lists them.

### Before that — 0.5.0, set 2026-09-25

Zach asked *"what version of hashigo should we be on? have we escape alpha yet?"* —
nothing had ever been numbered (`0.0.0`, no tags). The history was tagged after the fact,
local tags only, annotated with what each milestone was:

| tag | commit | milestone |
|---|---|---|
| `v0.1.0` | `16afee6` 08-23 | the shell RUNS over the real corpus |
| `v0.2.0` | `3e2a7bf` 08-26 | all fourteen of `notes/zach-wants.md` carry code |
| `v0.3.0` | `d03b66c` 09-12 | design brief (decision 32) + sync transport (33) |
| `v0.4.0` | `e7cd272` 09-13 | decision 41: the final import happened, Hashigo is the system of record |
| `v0.5.0` | `fd7358d` 09-25 | editor, search index, `[[` create, preview ⇄ editor |
| `v0.6.0` | its release commit, 10-31 | catch-up: cloud, deltas, design system, 優先, 出典, helper, canvas, templates — `git tag -n99 v0.6.0` |

`package.json`'s `version` is the number; `app/version.ts` shows it beside the build
commit in Settings → versions.

**Beta (0.9) is ALL of these. 1.0:** he could hand a friend the link and explain nothing.

| criterion | state, checked 2026-10-30 | evidence |
|---|---|---|
| fields-as-modules stages C-G landed | **met** 2026-09-25 | archived NEXT.md, "FIELDS ARE MODULES": A-G landed, one item skipped on purpose |
| sync carries blobs | **met in substance** | every generated clip and text is stored in KV by its generation key; a second device's request returns the stored copy, not a new one (`cloud/mailbox/src/generate.ts`). There is no user upload to carry; a recorded take never leaves the device (decision 40) |
| it runs without the laptop (decision 49's cloud move) | **met** 2026-09-26 | `cloud/README.md`. Filling 読み / 型 / OJAD on a new card still needs the laptop's helper (decision 56) |
| one friend has started from an empty database on their own device | **not met** | read from the code, not tried: the first run always fetches HIS seed from R2; everything is behind his passphrase; and there is ONE mailbox that every device merges whole, so a friend's device would pull his collection and push their reviews into it. Making a template from nothing became possible 2026-10-30 (`e71c51b`) |
