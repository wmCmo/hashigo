/**
 * Stage 1 — database access. Node/better-sqlite3 today; the browser/OPFS half
 * lands with the PWA shell and will be added behind this same surface.
 */

export {
  MEMORY,
  applySchema,
  checkIntegrity,
  openDatabase,
  schemaVersion,
  type Db,
  type OpenOptions,
} from "./open.js";
