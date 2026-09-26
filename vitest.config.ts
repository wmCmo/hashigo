/**
 * DO NOT DELETE THIS FILE, even though it looks empty of intent.
 *
 * Vitest has no config of its own to find until this file exists, and in that
 * case it reads `vite.config.ts`. `vite.config.ts` sets `root: "spike"` for the
 * stage-0.5 harness — which silently moved test discovery into `spike/`:
 *
 *     RUN  v3.2.7 C:/DEV/WEB/hashigo/spike
 *     No test files found, exiting with code 1
 *
 * A green suite that runs zero tests is worse than a red one. `vitest.config.*`
 * takes precedence over `vite.config.*`, so this file's whole job is to keep the
 * test root at the repository root, where `test/` is.
 *
 * Everything else was Vitest's default, deliberately — until 2026-08-20, when the
 * suite reached 14 files and FIVE of them began sweeping the real 7,716-card
 * corpus (`template`, `render`, `japanese-render`, `reveal`, `search`) alongside
 * the scheduler backtest. Two defaults stopped holding, and both were measured
 * rather than guessed.
 *
 * `testTimeout: 120_000`. The default is 5,000 ms per test. Each corpus sweep
 * decodes a 21 MB transit export and resolves every card — 2–7 s on its own — and
 * they run in PARALLEL workers, so the suite started failing 6–8 corpus tests per
 * run on the timeout while every one of them passed in isolation. That is the
 * worst failure shape available: red for a reason that has nothing to do with the
 * code, non-deterministically, in whichever file lost the CPU race. A corpus sweep
 * is a minutes-scale budget by nature; 120 s still fails a real hang.
 *
 * `maxWorkers: 6`. Raising the timeout then exposed the next layer: with all 16
 * cores taken, ~330 s of test work compressed into ~85 s of wall clock, and
 * several workers each holding a decoded corpus, the WORKER RPC itself timed out —
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` — which vitest counts as an
 * unhandled error and exits 1 on. **All 541 tests passed and `npm test` still
 * failed**, which is exactly as bad as a false green. Measured, three runs each:
 *
 *   16 workers (the default)      74.6 / 82.3 / 86.8 s wall, 297-363 s of test
 *                                 time · exit 1 in 4 of 5 runs, 1-2 RPC errors
 *   6, via `--maxWorkers=6`       48.9 / 52.7 / 59.3 s · exit 0, 0 RPC errors
 *   6, via the config below       32.2 / 42.4 / 46.0 s · exit 0, 0 RPC errors
 *
 * (The last two are the same limit measured at different times; the spread is the
 * machine, not the setting. Ranges, not best runs.)
 *
 * Fewer workers is both greener AND faster here, because the binding constraint is
 * memory per worker (a decoded 21 MB export plus 27,352 rendered sides) rather
 * than cores: with 16 workers the machine spends its time in GC and page faults.
 * A fixed 6 rather than a percentage so the numbers above reproduce.
 *
 * ── 2026-08-26: `maxWorkers: 6` WAS OUTGROWN, AND THE DIAGNOSIS ABOVE IS WRONG ──
 *
 * The suite went 541 -> 767 tests and the RPC errors came back. `npm test` exited 1
 * on a fully passing run again, and both `CLAUDE.md` and `NEXT.md` had grown a bold
 * warning saying so and telling the reader to ignore the exit code.
 *
 * That warning attributed it to "Vitest's reporter RPC under load". **It is not the
 * reporter, and it is not load.** Measured cause, from the birpc source:
 *
 *   node_modules/vitest/dist/chunks/index.*.js:3   const DEFAULT_TIMEOUT = 6e4
 *
 * 60 seconds, and `onTaskUpdate` is an awaited CALL rather than a fire-and-forget
 * event, so any test file whose own wall time crosses 60 s throws
 * `Timeout calling "onTaskUpdate"` in its worker. Vitest counts that as an unhandled
 * error and exits 1 on it. Nothing in the vitest config reaches that timeout —
 * `getRpcOptions()` never passes one, in any of the four pool workers.
 *
 * The evidence is a count, not an argument. Exactly TWO files ran over 60 s:
 *
 *   test/roundtrip.test.ts   90,197 ms      (five full corpus imports)
 *   test/dashboard.test.ts   64,180 ms
 *   test/scheduler.test.ts   48,119 ms      <- under, and silent
 *
 * and there were exactly TWO errors, on every single run.
 *
 * FIVE CONFIGURATIONS, TWO RUNS EACH, ON A CLEAN TREE:
 *
 *   forks, maxWorkers 6 (as above)   exit 1 / 1   ·  2, 2 RPC errors  ·  98, 91 s
 *   forks, maxWorkers 4              exit 1 / 1   ·  2, 2             ·  97, 95 s
 *   forks, --reporter=dot            exit 1 / 1   ·  2, 2             ·  90, 102 s
 *   forks, --no-isolate              exit 1 / 1   ·  5, 2             ·  98, 95 s
 *   THREADS, maxThreads 6            exit 0 / 0   ·  0, 0             ·  97, 97 s
 *
 * Two of those rule out the old explanation on their own: cutting the worker count
 * changed nothing (so it is not contention) and quieting the reporter changed
 * nothing (so it is not reporter chatter). `--no-isolate` made it WORSE, which fits
 * — sharing a worker across files makes the synchronous stretches longer, not
 * shorter.
 *
 * ── AND THREADS IS NOT THE FIX. IT SEGFAULTS. DO NOT SET IT. ──
 *
 * `pool: "threads"` was applied on the strength of the two green runs above and then
 * killed the suite on the third:
 *
 *   npm test   EXIT=139   Segmentation fault
 *              after `✓ test/roundtrip.test.ts (13 tests) 82394ms`, no summary printed
 *
 * 139 is SIGSEGV. **`better-sqlite3` is a native addon and this suite loads it in six
 * threads of one process**, which is the classic way to crash a module that is not
 * context-aware. Forks give each worker its own process and its own copy, which is
 * why the default is forks and why it must stay forks.
 *
 * Two runs are not a measurement when the failure is a race. The first two runs of
 * `--pool=threads` were green and reported zero RPC errors, which is exactly what a
 * nondeterministic native-addon crash looks like before it happens to you.
 *
 * ── SO THE STATE IS: FORKS, AND THE EXIT CODE IS STILL WRONG ──
 *
 * There is no configuration that fixes this. The 60 s ceiling is unreachable from
 * config, and the only real fix is for no single test file to need 60 s of its own
 * wall clock — `test/roundtrip.test.ts` needs 82 s and runs `importExports` over the
 * full corpus five times. Splitting it is the honest repair and it is not done here,
 * because moving tests that share a `beforeAll` import between files is where test
 * coverage silently changes, and these are the oracle tests.
 *
 * WHAT IS DONE INSTEAD: `npm run gates` reads the RESULT rather than the exit code —
 * the same thing the docs have always told a human to do, in a form a script can
 * chain on. It requires a complete summary line and zero failed tests, so it reports
 * green only when the suite actually finished and actually passed. That is what
 * caught the segfault: a crash prints no summary, so it fails there rather than
 * passing quietly.
 *
 * `npm test` on its own still exits 1 with everything passing. Do not chain on it.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    // THE SUITE MUST NOT DEPEND ON HIS `.env`. Since 2026-09-26 the real `.env`
    // carries the Cloudflare mailbox's address and key, and Vitest loads `VITE_`
    // variables from it — so `app/sync-client.ts` aimed every test at
    // `*.workers.dev` instead of the local `/sync/` routes the tests mock, and
    // six of them failed with 404. Empty here means "the laptop mailbox", which
    // is what the tests describe.
    env: { VITE_MAILBOX_URL: "", VITE_MAILBOX_TOKEN: "" },
    // ─── A WORKTREE INSIDE THE REPO IS NOT PART OF THIS SUITE ────────────────
    //
    // The desktop app puts a spawned session's git worktree under
    // `.claude/worktrees/<name>/`, which is a FULL second checkout — including
    // its own `test/`. Vitest's default discovery walks into it, and on
    // 2026-09-15 that turned one green run into "83 files, 1 FAILED": the suite
    // doubled, and the copy failed on `exports/日本語/data.json`, which is
    // gitignored and therefore exists only in the real working tree.
    //
    // The failure is worth naming because it looks like a code regression and is
    // not one. It appears the moment a second session is started and disappears
    // when that worktree is cleaned up, so it is intermittent in the way that
    // wastes the most time.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
    testTimeout: 120_000,
    // `test.maxWorkers` alone does NOT do it — measured: with only that key set,
    // the run still spent 297–363 s of test time inside ~70–87 s of wall clock,
    // which is 14 files at once, and still exited 1. The pool option is the one
    // that lands. Both spellings are set so the limit survives a `--pool` change.
    maxWorkers: 6,
    // FORKS. Not threads — see the header. `pool: "threads"` removes the RPC errors
    // and then SEGFAULTS (exit 139), because better-sqlite3 is a native addon and
    // this suite loads it in six threads of one process.
    poolOptions: {
      forks: { maxForks: 6 },
      threads: { maxThreads: 6 },
    },
  },
});
