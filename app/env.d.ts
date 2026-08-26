/// <reference types="vite/client" />

/**
 * Ambient types for the bundler features this slice uses — `?raw` text imports
 * and `import.meta.env`. `vite/client` supplies both, and this file exists so
 * `app/*.ts` typechecks on its own rather than only inside a `vite build`.
 *
 * `vite/client` already declares `*?raw` as `string`, so there is deliberately no
 * second declaration here: adding one would shadow it and then drift from it.
 *
 * `__SCHEMA_VERSION_FROM_NODE__` is injected by `vite.app.config.ts` and consumed by
 * `src/db/browser.ts`.
 *
 * **The reason given here was stale and is corrected.** It used to say
 * `src/schema/index.ts` "reads `node:fs` at module load and therefore cannot be
 * imported in a browser". That WAS true and has not been since the DDL text moved to
 * `src/schema/sources.ts`; that file now opens with "THIS FILE HAS NO NODE IMPORTS,
 * AND MUST NOT ACQUIRE ANY" and `test/schema.test.ts` pins the absence.
 *
 * The injection still works and is left alone. What it no longer has is a reason —
 * importing `SCHEMA_VERSION` directly would now be browser-safe, so this is a
 * candidate for deletion rather than a constraint to design around.
 */
declare const __SCHEMA_VERSION_FROM_NODE__: number;

export {};
