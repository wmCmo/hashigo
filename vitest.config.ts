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
 * Everything else is Vitest's default, deliberately: the suite ran on defaults
 * before there was a bundler and it still does.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
  },
});
