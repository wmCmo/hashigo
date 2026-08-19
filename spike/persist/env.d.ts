/// <reference types="vite/client" />

/**
 * THROWAWAY (spike harness) — ambient types for the two bundler features this
 * slice uses: `import.meta.env.DEV` and `?raw` text imports.
 *
 * `vite/client` supplies both, and this file exists so `spike/persist/*.ts`
 * typechecks on its own rather than only inside a `vite build`. The repo's
 * `tsconfig.json` does not include `spike/`, so nothing else picks this up.
 *
 *   npx tsc --noEmit --strict --lib ES2023,DOM,DOM.Iterable \
 *     --module preserve --moduleResolution bundler --skipLibCheck \
 *     spike/persist/main.ts spike/persist/db.worker.ts spike/persist/protocol.ts
 *
 * `vite/client` already declares `*?raw` as `string`, so there is deliberately
 * no second declaration here — adding one would shadow it and drift.
 */

export {};
