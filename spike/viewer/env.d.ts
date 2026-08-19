/// <reference types="vite/client" />

/**
 * THROWAWAY (spike harness) — ambient types for the bundler features this slice
 * uses: `import.meta.env.DEV` and the `?url` import of the payload database.
 *
 * `vite/client` supplies both; the repo's tsconfig.json does not include spike/,
 * so nothing outside `spike/viewer/tsconfig.json` picks this up.
 */

export {};
