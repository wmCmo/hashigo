/**
 * Decision 17 — the local backup. Everything `exports/` cannot rebuild.
 *
 *     import { exportLocalArchive, applyLocalArchive } from "hashigo/backup";
 *
 *     const archive = exportLocalArchive(db, new Date().toISOString());
 *     // the shell turns it into a file; this module returns data, not a Blob
 *     applyLocalArchive(db, archive);            // idempotent
 *
 * Today this is insurance. After decision 16's ONE final import it is the only
 * copy of his review history: `exports/` stops receiving it, and OPFS is
 * browser-owned storage that "clear site data" takes with it.
 *
 * `./archive.ts`'s header has the two decisions worth reading first — why it
 * archives ROWS rather than the database file (a binary file is only restorable
 * into the schema version it came from, and `applySchema` refuses any other, so a
 * schema bump would strand every older backup), and why every row is keyed on
 * `(card_id, kind)` and never on `track_id`.
 */

export {
  ARCHIVE_VERSION,
  ArchiveError,
  applyLocalArchive,
  exportLocalArchive,
  verifyLocalArchive,
  type ApplyReport,
  type ArchivedCardState,
  type ArchivedField,
  type ArchivedFieldValue,
  type ArchivedReview,
  type ArchivedSetting,
  type ArchivedTrackState,
  type LocalArchive,
  type TrackKey,
} from "./archive.js";
