# notes/archive — point-in-time reports. NOT the current state.

**Every number in this directory is a sample, not a fact.** These files were
accurate when written and were never rewritten afterwards. Where a figure here
disagrees with `CLAUDE.md`, `DECISIONS.md`, `NEXT.md`, `BACKTEST.md` or a
`src/*/README.md`, **those are right and this is stale** — the direction is one-way.

They live under a path that says so on purpose. Moved here 2026-08-22 because the
hazard is not that the files exist, it is that a `grep` hit reads like current
truth: a retracted argument was found that day still standing in a *live*
document (`BACKTEST.md`'s Recommendation, quoting the withdrawn 454-day cap
reasoning) with the correction sitting 200 lines above it. Prose does not move
when code does. A path can at least warn you.

| file | what it recorded | read it for |
|---|---|---|
| `FIXES.md` | a defect sweep and its repairs | why `src/search` and `src/blobs` are shaped as they are (§3.1, §3.5) |
| `STAGE4.md` | the renderer's build-out | the orphan list and the math/furigana basis traps (§3) |
| `OVERNIGHT.md` | a gap audit | §4's list of calls an agent had made without authority — five were later ratified |
| `PHONE-TEST.md` | a handset session | what was actually observed on the phone, once |
| `SPIKE.md` | what the browser spike settled | why `spike/` is a throwaway harness and not the app shell |
| `persistence.md` | OPFS durability | the one-tap export prescription (`:204`) that decision 17 rests on |
| `next-history.md` | the bottom three quarters of `NEXT.md`, moved 2026-08-26 | why the app is shaped as it is — the landed-work notes and the reasoning behind them. 803 lines, byte-identical to what sat under `NEXT.md`'s own HISTORY heading |
| `browser-feasibility.md` | OPFS measurements | §4's blob-store numbers; §5 is **superseded** — it called `crypto.subtle` "the one genuinely invasive change" and `src/blobs/sha256.ts` had already made that false |

**Two specific things in here that are known-wrong and were acted on anyway,
listed so nobody re-derives them:** `browser-feasibility.md` §5's async-rewrite
claim (closed by moving the key to `src/blobs/generation.ts`, no signature
changed, 36,398 identities pinned), and any use of **454 days** as the edge of
observed support — that is the ELAPSED basis being used to bound a PLANNED
quantity, which decision 6 forbids. On the planned basis the edge is 365.

Nothing here is deleted, and nothing here should be edited: a snapshot that gets
updated stops being a record of what was believed at the time.
