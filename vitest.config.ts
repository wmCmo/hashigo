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
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    testTimeout: 120_000,
    // `test.maxWorkers` alone does NOT do it — measured: with only that key set,
    // the run still spent 297–363 s of test time inside ~70–87 s of wall clock,
    // which is 14 files at once, and still exited 1. The pool option is the one
    // that lands. Both spellings are set so the limit survives a `--pool` change.
    maxWorkers: 6,
    poolOptions: {
      forks: { maxForks: 6 },
      threads: { maxThreads: 6 },
    },
  },
});
