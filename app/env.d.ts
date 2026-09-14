/// <reference types="vite/client" />

/**
 * Ambient types for the bundler features this slice uses — `?raw` text imports
 * and `import.meta.env`. `vite/client` supplies both, and this file exists so
 * `app/*.ts` typechecks on its own rather than only inside a `vite build`.
 *
 * `vite/client` already declares `*?raw` as `string`, so there is deliberately no
 * second declaration here: adding one would shadow it and then drift from it.
 *
 * `__SCHEMA_VERSION_FROM_NODE__` IS GONE FROM THIS SLICE, and the note that used to
 * stand here had already worked out why without finishing the job. It existed because
 * `src/schema/index.ts` read the DDL off disk with `node:fs` at module scope and so
 * could not be imported in a browser; the text moved to `src/schema/sources.ts` and
 * that stopped being true. `src/db/browser.ts` imports the real `SCHEMA_VERSION`
 * directly — the old note claimed the injected value was "consumed by
 * `src/db/browser.ts`", which was not so — and nothing in `app/` ever read the global,
 * so the declaration here and the `define` in `vite.app.config.ts` were a name with no
 * reader. `spike/` still uses it through `vite.config.ts`; that one is untouched.
 */

export {};
