/**
 * Where the database's addresses meet the store's payloads.
 *
 * `blobs` says WHAT a blob is — its address, its sniffed mime, its size, and
 * (when it came from a generator) the identity tuple that produced it. It never
 * says WHERE the payload is. These functions are the join: give them a store
 * and they resolve, audit, or reclaim.
 *
 * THE SELF-HEAL THAT MOCHI NEVER HAD. Mochi's failure mode was a card pointing
 * at an attachment that no longer existed, with nothing able to notice or fix
 * it: 7,974 dangling cache pointers and 8,958 tombstones in the corpus, and a
 * manual re-sync as the only remedy. Here a missing payload is (a) detectable,
 * because `auditBlobStore` compares the two sides, and (b) usually repairable
 * without asking the user anything, because `source_text`/`voice`/`lang`/
 * `options` are on the row — 10,799 of the corpus's 10,816 media blobs carry
 * the provenance needed to regenerate themselves. The other 17 are files whose
 * cache entry Mochi had already lost.
 *
 * REFCOUNTS, NOT TOMBSTONES. `blob_refs` triggers maintain `blobs.refcount`, so
 * "is anything still using this?" is a column read rather than a graph walk.
 * `sweepUnreferenced` is the only thing that deletes a payload, and it deletes
 * only at zero. There is no deleted flag anywhere.
 */

import type { SqliteHandle } from "../db/browser.js";

import { assertAddress } from "./address.js";
import { BlobMissingError, type BlobStore } from "./store.js";

export interface BlobRow {
  readonly hash: string;
  readonly kind: string;
  readonly mime: string;
  readonly byteSize: number;
  readonly refcount: number;
  /** True when the payload is in the row rather than the store. */
  readonly inline: boolean;
  /** Identity tuple, when this blob came from a generator. */
  readonly sourceText: string | null;
  readonly voice: string | null;
  readonly lang: string | null;
}

interface RawRow {
  hash: string;
  kind: string;
  mime: string;
  byte_size: number;
  refcount: number;
  inline: number;
  source_text: string | null;
  voice: string | null;
  lang: string | null;
}

const SELECT_ROW = `
  SELECT hash, kind, mime, byte_size, refcount,
         (bytes IS NOT NULL) AS inline, source_text, voice, lang
    FROM blobs`;

function shape(row: RawRow): BlobRow {
  return {
    hash: row.hash,
    kind: row.kind,
    mime: row.mime,
    byteSize: row.byte_size,
    refcount: row.refcount,
    inline: row.inline === 1,
    sourceText: row.source_text,
    voice: row.voice,
    lang: row.lang,
  };
}

/** The row, without its payload. Null when the address is unknown. */
export function blobRow(db: SqliteHandle, hash: string): BlobRow | null {
  const row = db.prepare(`${SELECT_ROW} WHERE hash = ?`).get(assertAddress(hash)) as
    | RawRow
    | undefined;
  return row === undefined ? null : shape(row);
}

/**
 * The payload. Inline bytes if the row carries them, otherwise the store's copy
 * — which is looked up by hash, so it does not matter where the store is today.
 */
export function readBlob(
  db: SqliteHandle,
  hash: string,
  store: BlobStore | null = null,
): Uint8Array {
  assertAddress(hash);
  const inline = db.prepare("SELECT bytes FROM blobs WHERE hash = ?").pluck().get(hash) as
    | Uint8Array
    | null
    | undefined;
  if (inline === undefined) throw new BlobMissingError(hash, "the database");
  if (inline !== null) return inline;
  if (store === null) {
    throw new BlobMissingError(hash, "no store was supplied and the row has no inline bytes");
  }
  return store.read(hash);
}

export interface StoreAudit {
  /** Rows in `blobs`. */
  readonly blobs: number;
  /** Rows whose payload is in the row itself. */
  readonly inline: number;
  /** Rows whose payload the store holds. */
  readonly present: number;
  /** Rows whose payload is nowhere. THIS IS THE NUMBER THAT MUST BE ZERO. */
  readonly missing: number;
  /** Missing payloads that carry enough provenance to be regenerated. */
  readonly missingRegenerable: number;
  /** Missing payloads with no identity tuple: genuinely lost. */
  readonly missingLost: number;
  /** Store payloads no row refers to — an interrupted import, or a swept row. */
  readonly orphaned: number;
  /** Rows at refcount 0: reclaimable by `sweepUnreferenced`. */
  readonly unreferenced: number;
  /** Store payloads whose size disagrees with the row. */
  readonly sizeMismatched: number;
  readonly missingHashes: readonly string[];
  readonly orphanedHashes: readonly string[];
}

/**
 * Compare both sides. Cheap: one table scan and one `stat` per blob, no reads.
 * Pass `verify: true` to rehash every payload instead, which is 657 MB of I/O
 * on the corpus and is what the acceptance test does once.
 */
export function auditBlobStore(
  db: SqliteHandle,
  store: BlobStore,
  options: { readonly verify?: boolean; readonly sampleLimit?: number } = {},
): StoreAudit {
  const limit = options.sampleLimit ?? 20;
  const rows = db.prepare(SELECT_ROW).all() as RawRow[];
  const known = new Set<string>();
  let inline = 0;
  let present = 0;
  let missing = 0;
  let missingRegenerable = 0;
  let missingLost = 0;
  let unreferenced = 0;
  let sizeMismatched = 0;
  const missingHashes: string[] = [];

  for (const row of rows) {
    known.add(row.hash);
    if (row.refcount === 0) unreferenced += 1;
    if (row.inline === 1) {
      inline += 1;
      continue;
    }
    const size = store.size(row.hash);
    const ok = size !== null && (options.verify === true ? store.verify(row.hash) : true);
    if (!ok) {
      missing += 1;
      if (row.source_text !== null) missingRegenerable += 1;
      else missingLost += 1;
      if (missingHashes.length < limit) missingHashes.push(row.hash);
      continue;
    }
    present += 1;
    if (size !== row.byte_size) sizeMismatched += 1;
  }

  const orphanedHashes: string[] = [];
  let orphaned = 0;
  for (const hash of store.list()) {
    if (known.has(hash)) continue;
    orphaned += 1;
    if (orphanedHashes.length < limit) orphanedHashes.push(hash);
  }

  return {
    blobs: rows.length,
    inline,
    present,
    missing,
    missingRegenerable,
    missingLost,
    orphaned,
    unreferenced,
    sizeMismatched,
    missingHashes,
    orphanedHashes,
  };
}

export interface SweepResult {
  readonly rowsDeleted: number;
  readonly payloadsRemoved: number;
  readonly bytesReclaimed: number;
  /** Unreferenced, but still inside the grace period. Reported, not deleted. */
  readonly heldByGrace: number;
  readonly bytesHeldByGrace: number;
}

/**
 * How long an unreferenced blob is kept before a sweep may remove it.
 *
 * 7 days, and the reason is a workflow rather than a safety margin: comparing
 * two TTS voices means generating both, pointing the card at one, and living
 * with it for a few days of actual reviews. With no grace period the loser's
 * payload is destroyed the instant the winner is pointed at, so going back costs
 * another billed request — which is Mochi's attachment behaviour, the fourth
 * pain point, rebuilt by accident.
 *
 * A day would be too short to survive a weekend of not studying; a month keeps
 * 657 MB of abandoned mp3 on a phone.
 */
export const SWEEP_GRACE_DAYS = 7;

export interface SweepOptions {
  readonly dryRun?: boolean;
  /**
   * Days an unreferenced blob is held. Default `SWEEP_GRACE_DAYS`. Pass 0 for
   * the old immediate behaviour — correct for a scratch database in a test, and
   * a mistake on a real one.
   */
  readonly graceDays?: number;
  /** ISO instant to measure the grace period against. Defaults to now. */
  readonly now?: string;
}

/**
 * Reclaim every blob nothing references AND nothing might still want: the row
 * first (the schema's `blobs_no_delete_while_referenced` trigger is the
 * backstop), then the payload. Deleting the row first means a crash between the
 * two leaves an orphaned payload, which `auditBlobStore` reports and a later
 * sweep removes — the failure mode is wasted disk, never a dangling reference.
 *
 * `unreferenced_at` rather than `created_at` decides eligibility. Using
 * `created_at` would sweep a clip generated a year ago and dereferenced a minute
 * ago, which is exactly the case the grace period exists for.
 *
 * THE NULL CASE: THE COMMENT WAS WRONG, THE BEHAVIOUR IS RIGHT. Corrected
 * 2026-08-22 after trying to "fix" the behaviour and finding there was nothing to
 * fix.
 *
 * This said a blob with `unreferenced_at` NULL and `refcount = 0` "predates the
 * column" and that "nothing in the corpus is in that state after a re-import".
 * Both halves are false. MEASURED: **48 such rows** -- 41 `translate`, 5 `ai`,
 * 2 `furigana`, 0 `speech`. They do not predate anything, and the triggers are
 * why they exist: `unreferenced_at` is stamped only on a 1 -> 0 refcount
 * transition (`schema.sql:588-589`, `:602-603`), never on a row that started at 0.
 *
 * SO WHY DO THEY DESERVE NO GRACE? Because they are not mid-write, they are
 * permanently unreferenced -- `test/blobs.test.ts` already explains them: where
 * ONE card cached two different outputs under the same normalised generation key,
 * the second reference is absorbed by `blob_refs_scope` and its blob lands at
 * refcount 0 forever. 45 of the 48 have an identity sibling that IS referenced.
 * Nothing will ever reference them, so the grace period has nothing to protect.
 *
 * The plausible-sounding alternative -- fall back to `created_at`, on the grounds
 * that a row inserted a minute ago and not yet referenced might be mid-write --
 * was implemented, measured, and reverted. That window does not exist: blob rows
 * and their refs are written in ONE transaction (`src/import/blobs.ts`, "phase 4:
 * write. One transaction."). All it did was hold 778 bytes of genuine debris for
 * a week after every import, and turn the corpus assertion red. Do not re-apply
 * it without first finding a writer that inserts a row outside its ref's
 * transaction.
 */
export function sweepUnreferenced(
  db: SqliteHandle,
  store: BlobStore | null = null,
  options: SweepOptions = {},
): SweepResult {
  const graceDays = options.graceDays ?? SWEEP_GRACE_DAYS;
  const candidates = db
    .prepare(
      `SELECT hash, byte_size, (bytes IS NOT NULL) AS inline, unreferenced_at
         FROM blobs WHERE refcount = 0`,
    )
    .all() as {
    hash: string;
    byte_size: number;
    inline: number;
    unreferenced_at: string | null;
  }[];

  const cutoff =
    graceDays <= 0
      ? null
      : new Date(
          (options.now === undefined ? Date.now() : Date.parse(options.now)) -
            graceDays * 86_400_000,
        ).toISOString();

  const doomed: typeof candidates = [];
  let heldByGrace = 0;
  let bytesHeldByGrace = 0;
  for (const row of candidates) {
    const held =
      cutoff !== null && row.unreferenced_at !== null && row.unreferenced_at > cutoff;
    if (held) {
      heldByGrace += 1;
      bytesHeldByGrace += row.byte_size;
    } else {
      doomed.push(row);
    }
  }
  if (options.dryRun === true) {
    return {
      rowsDeleted: 0,
      payloadsRemoved: 0,
      bytesReclaimed: doomed.reduce((sum, row) => sum + row.byte_size, 0),
      heldByGrace,
      bytesHeldByGrace,
    };
  }

  const remove = db.prepare("DELETE FROM blobs WHERE hash = ? AND refcount = 0");
  let rowsDeleted = 0;
  db.transaction(() => {
    for (const row of doomed) rowsDeleted += remove.run(row.hash).changes;
  })();

  let payloadsRemoved = 0;
  let bytesReclaimed = 0;
  if (store !== null) {
    // Batched when the store offers it: a sweep of the whole store would
    // otherwise be one transaction per payload. `?? removals()` keeps this
    // working for a store that has no batch (a directory, a Map).
    const removals = (): void => {
      for (const row of doomed) {
        if (row.inline === 1) continue;
        if (store.remove(row.hash)) {
          payloadsRemoved += 1;
          bytesReclaimed += row.byte_size;
        }
      }
    };
    if (store.batch === undefined) removals();
    else store.batch(removals);
  }
  return { rowsDeleted, payloadsRemoved, bytesReclaimed, heldByGrace, bytesHeldByGrace };
}

// ---------------------------------------------------------------------------
// The acceptance query: no LOCATION anywhere in the database.
// ---------------------------------------------------------------------------

/**
 * What a location looks like, as one regex, in one place.
 *
 * THIS PREDICATE USED TO BE A PAIR OF COPY-PASTED SQL `LIKE` CHAINS — one in
 * `src/blobs/cli.ts`, one in `test/blobs.test.ts` — and it caught four of the
 * eight shapes a Windows path can take. Probed directly, it missed:
 *
 *   C:/Users/Zach/media/x.mp3      drive letter with FORWARD slashes
 *   \\NAS\media\x.mp3             UNC share
 *   file:///D:/media/x.mp3         file URL, drive form
 *   file:///home/zach/x.mp3        file URL, POSIX form
 *
 * The forward-slash form is the one that mattered: it is what this CLI's own
 * `--store C:/elsewhere` usage line takes, what `path.posix` produces, and what
 * a hand-edited config would most likely contain. A check that green-lights the
 * shape its own documentation uses is not a check.
 *
 * THE HARD PART IS THE FALSE POSITIVES, WHICH IS WHY THIS IS NOT `%:/%`.
 * `https://jisho.org/search/...` and `https://takoboto.jp/` are all over the
 * corpus, and `s:/` inside `https:/` is a drive letter as far as a naive
 * pattern is concerned. A drive letter is a SINGLE letter with a non-letter (or
 * nothing) in front of it, which needs a lookbehind — so this is a JS regex
 * registered as a SQL function rather than a `LIKE` chain. SQLite cannot
 * express it, and pretending otherwise is what produced the half-blind version.
 *
 * `exports` counts only with a separator against it. Card `BE2i4rWu` in the
 * English deck defines *tariff* as "a tax or duty to be paid on a particular
 * class of imports or exports." — the user's own writing, and the one place the
 * bare word occurs in the corpus.
 */
export const LOCATION_PATTERN =
  // A regex LITERAL, not a built string: the escaping is hard enough once.
  //   [A-Za-z]:[\/]     C:\… and C:/…, with a lookbehind so `https://` is not
  //                     a drive called `s`. This is the branch the LIKE chain
  //                     could not express and therefore did not have.
  //   \\\\[^\\/\s]      \\server\share. TWO backslashes, so the single `\` the
  //                     基本情報 formula cards use for division — 変動費率＝変動費 \ 売上,
  //                     and LaTeX \times — is not a path. Getting this wrong
  //                     flags 45 rows of the user's own arithmetic.
  //   \/[^/\s]+\/[^/\s]  /home/zach/... at a BOUNDARY, not only at ^.
  //                     An embedded POSIX path slipped the anchored
  //                     version. Boundary still excludes https://host/p
  //                     (that / follows a colon) and the division rows.
  //   file:\/\/         both file:// forms.
  //   exports           only with a separator against it.
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\[^\\/\s]|(?:^|[\s"'(\[])\/[^/\s]+\/[^/\s]|file:\/\/|[\\/]exports|exports[\\/]/;

/** Bytes of a BLOB-typed value decoded and scanned. A path is short and early. */
export const LOCATION_SCAN_BYTES = 4096;

export interface LocationSweep {
  /** `table.column: n row(s)` for every column holding a location. Empty is the pass. */
  readonly offenders: readonly string[];
  readonly columns: number;
  readonly tables: number;
  /** `table.column: n row(s)` for each EXCLUDED column, so nothing is hidden. */
  readonly excluded: readonly string[];
}

export interface FindLocationsOptions {
  /**
   * `table.column` names to scan but not count as offenders.
   *
   * There is exactly one legitimate use and it is measured. The blob store's
   * `blob_payloads.bytes` is 625 MB of mp3, and 560 of the corpus's 10,816
   * payloads have a byte sequence in their first `LOCATION_SCAN_BYTES` that
   * decodes as something `LOCATION_PATTERN` matches — `C:/`-shaped pairs and
   * `//`-shaped runs occur constantly in compressed audio. Scanning a payload
   * column for a location is therefore not a check, it is a coin toss: the
   * payload IS bytes, and "these bytes are not a path" is not a property bytes
   * can have. Excluded columns are still scanned and still REPORTED, in
   * `excluded`, so the decision is visible rather than a silent hole. Every
   * other column, including the card database's 26,947 inline TEXT payloads in
   * `blobs.bytes`, stays in the check and comes back clean.
   */
  readonly exclude?: readonly string[];
}

/**
 * Sweep every column of every real table for a location.
 *
 * BLOB-typed columns are included, capped at `LOCATION_SCAN_BYTES` — the older
 * version skipped them by declared type, which left `blobs.bytes` (26,947
 * inline payloads, all of them text generations) unswept. The cap is what keeps
 * `--inline-blobs` from decoding 657 MB of mp3 as text; it is a real limit and
 * is stated rather than hidden.
 *
 * FTS shadow tables are skipped. They are a derived copy of `cards`, which is
 * swept directly, and their internal columns hold tokeniser state rather than
 * text.
 */
export function findLocations(
  db: SqliteHandle,
  options: FindLocationsOptions = {},
): LocationSweep {
  const exclude = new Set(options.exclude ?? []);
  db.function("hashigo_is_location", { deterministic: true }, (value: unknown) => {
    if (value === null || value === undefined) return 0;
    const text =
      typeof value === "string"
        ? value
        : value instanceof Uint8Array
          ? // TextDecoder, not Buffer#toString: this module is imported by the
            // browser build, where there is no Buffer. `fatal: false` is the
            // point — a truncated mp3 prefix is not valid UTF-8 and must decode
            // to replacement characters rather than throw and skip the column.
            new TextDecoder("utf-8", { fatal: false }).decode(
              value.subarray(0, LOCATION_SCAN_BYTES),
            )
          : String(value);
    return LOCATION_PATTERN.test(text) ? 1 : 0;
  });

  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql LIKE 'CREATE TABLE%'`,
      )
      .pluck()
      .all() as string[]
  ).filter((name) => !name.includes("_fts"));

  const offenders: string[] = [];
  const excluded: string[] = [];
  let columns = 0;
  for (const table of tables) {
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as {
      name: string;
      type: string;
    }[];
    for (const column of cols) {
      columns += 1;
      const quoted = `"${column.name.replace(/"/g, '""')}"`;
      const scanned = /BLOB/i.test(column.type)
        ? `substr(${quoted}, 1, ${LOCATION_SCAN_BYTES})`
        : quoted;
      const hits = db
        .prepare(
          `SELECT count(*) FROM ${JSON.stringify(table)}
            WHERE ${quoted} IS NOT NULL AND hashigo_is_location(${scanned}) = 1`,
        )
        .pluck()
        .get() as number;
      if (hits === 0) continue;
      const where = `${table}.${column.name}`;
      if (exclude.has(where)) excluded.push(`${where}: ${hits} row(s)`);
      else offenders.push(`${where}: ${hits} row(s)`);
    }
  }
  return { offenders, columns, tables: tables.length, excluded };
}
