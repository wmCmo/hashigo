import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    env: { VITE_MAILBOX_URL: "", VITE_MAILBOX_TOKEN: "" },
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**", "docs-check/**"],
    testTimeout: 120_000,
    maxWorkers: 6,
    poolOptions: {
      forks: { maxForks: 6 },
      threads: { maxThreads: 6 },
    },
  },
});
