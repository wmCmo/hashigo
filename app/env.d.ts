/// <reference types="vite/client" />

/**
 * Ambient types for the bundler features this slice uses — `?raw` text imports
 * and `import.meta.env`. `vite/client` supplies both, and this file exists so
 * `app/*.ts` typechecks on its own rather than only inside a `vite build`.
 *
 * `vite/client` already declares `*?raw` as `string`, so there is deliberately no
 * second declaration here: adding one would shadow it and then drift from it.
 *
 * `__SCHEMA_VERSION_FROM_NODE__` is injected by `vite.app.config.ts` because
 * `src/schema/index.ts` reads `node:fs` at module load and therefore cannot be
 * imported in a browser. `src/db/browser.ts` consumes it.
 */
declare const __SCHEMA_VERSION_FROM_NODE__: number;

export {};
