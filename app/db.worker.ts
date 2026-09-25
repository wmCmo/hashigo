/// <reference lib="webworker" />
/**
 * The app's database side. Everything that touches SQLite happens here and
 * nowhere else.
 *
 * ─── WHY A WORKER AT ALL, AND WHY THE WHOLE DATABASE ────────────────────────
 *
 * `opfs-sahpool` needs `createSyncAccessHandle`, which the platform restricts to
 * dedicated workers. Hashigo deliberately sets no COOP/COEP headers — the VFS
 * needs neither `SharedArrayBuffer` nor cross-origin isolation, and `vite.config`
 * asserts `crossOriginIsolated === false` so that a header cannot quietly become
 * load-bearing. Between those two facts there is no way to reach a synchronous
 * `SqliteHandle` from the page, so this is not a performance choice. It is the
 * only place a query can run.
 *
 * ONE POOL PER WORKER. `installPool` refuses a second pool over the same
 * directory, because two pools over one directory is documented as unsupported
 * and the failure mode is corruption rather than an exception. So both databases
 * — the cards and the 617.9 MiB payload store — are two FILES in one pool.
 *
 * ─── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 *
 * It never renders, never mints an object URL and never plays anything. It hands
 * out `PreparedCard`s (`src/review`'s worker half) and, on request and only on
 * request, the bytes for one clip. `app/protocol.ts` explains why that makes the
 * message log itself evidence for the hard rule.
 *
 * It also does not request persistence: `navigator.storage.persist` is
 * **Window-only** and absent from `StorageManager.prototype` in a worker —
 * confirmed on Zach's own handset 2026-08-23, not merely on a desktop profile. So
 * `persisted()` and `estimate()` are readable here and the GRANT has to be asked
 * for by the page. That is an architectural constraint, not a detail.
 */

import { SqliteBlobStore } from "../src/blobs/sqlite.js";
import { exportLocalArchive } from "../src/backup/index.js";
import { exportSync, mergeSync } from "../src/sync/index.js";
import {
  resolveDescriptorText,
  storeDescriptorText,
  storeGeneratedSpeech,
} from "../src/generate/index.js";
import {
  databaseFilesInOpfs,
  importDatabaseBrowser,
  installPool,
  openDatabaseBrowser,
  schemaVersion,
  sqliteVersion,
  type BrowserDb,
} from "../src/db/browser.js";
import { backlinksOf } from "../src/cards/index.js";
import { decodeFieldOptions } from "../src/cards/index.js";
import { cardAudioResolver } from "../src/cards/index.js";
import { directionForTrackKind } from "../src/cards/index.js";
import { ACCENT_FIELD_TYPE, READING_FIELD, prepareCard } from "../src/review/index.js";
import {
  buildSession,
  readSessionSettings,
  writeSetting,
  type AnswerResult,
  type ReviewSession,
} from "../src/session/index.js";
import { searchCards } from "../src/search/index.js";
// After every write that changes what a card SAYS. The index view prefers
// `cards.search_text` over the live fields, so a write that skips this leaves an
// edited card findable only by its OLD text — see src/generate/search-text.ts.
import { refreshSearchText } from "../src/generate/index.js";
import { collect, collectGlance, renderDashboard } from "../src/dashboard/index.js";
import {
  countReferences,
  promptDependencies,
  renameFieldEverywhere,
  sideIndex,
} from "../src/template/index.js";
import { positionKeys, FIELD_TYPES } from "../src/schema/index.js";
// The SQL fragments for "live" and "due", from the module that owns them. This
// query is why that module exists: it used to spell the due comparison with
// `date()`, which converts an offset timestamp to UTC and made this count 704
// where the scheduler counted 646.
import { dueOnOrBefore, liveTrack } from "../src/scheduler/index.js";

import {
  archiveSubtree,
  restoreArchive,
  scopeToSubtree,
  scopeToTag,
  subtreeDeckIds,
} from "./deck-scope.js";
import { isCatalogueVoice } from "../src/generate/voices.js";
import { suggestCards, type SuggestRow } from "./recent.js";
import { audioIsStale } from "./seed-freshness.js";
import { COUNT_HELD, mergeLocalFields, readSeedFields } from "./local-fields.js";
import {
  describePrice,
  describeVoicePrice,
  optionsRefusal,
  priceFieldChange,
  priceVoiceChange,
  resolvedVoices,
  searchReach,
  sourceRefusal,
  templateFields,
  writeFieldOptions,
  writeFieldSource,
} from "./field-ops.js";

import type {
  AnswerRequest,
  PriceFieldRequest,
  VoiceRequest,
  BrowseRequest,
  CardOpMessage,
  CardOpRequest,
  CreateCardRequest,
  DeckOpMessage,
  DeckOpRequest,
  DecksRequest,
  UngradeRequest,
  PreviewRequest,
  BacklinksRequest,
  StoreClipRequest,
  StoreGenerationRequest,
  SetFieldRequest,
  TemplateChoice,
  TemplateDetail,
  TemplateFieldRow,
  TemplateOpMessage,
  TemplateOpRequest,
  TemplateRequest,
  DashboardRequest,
  GlanceRequest,
  SettingsRequest,
  SetSettingRequest,
  ResetRequest,
  AppMessage,
  AppRequest,
  BackupRequest,
  GeneratedTextRequest,
  SyncExportRequest,
  SyncMergeRequest,
  LogLevel,
  NextRequest,
  OpenRequest,
  PayloadRequest,
  ReadingRequest,
} from "./protocol.js";

/**
 * Both files live in ONE pool. The names are absolute inside the pool, which is
 * not a filesystem path — the pool maps a name to an opaque slot.
 */
const CARD_DB = "/hashigo.db";
const STORE_DB = "/hashigo-blobs.db";
const GEN_DB = "/hashigo-gen.db";
const FIELDS_DB = "/hashigo-fields.db";

/** Served by `vite.app.config.ts` middleware from `build/app/`. */
const CARD_URL = "/hashigo-app.db";
const STORE_URL = "/hashigo-app-blobs.db";
const GEN_URL = "/hashigo-app-gen.db";
const FIELDS_URL = "/hashigo-app-fields.db";
/** A few hundred bytes describing the two above. See `seedManifest`. */
const SEED_URL = "/hashigo-app.json";

let cards: BrowserDb | null = null;
let payloads: BrowserDb | null = null;
let store: SqliteBlobStore | null = null;
let session: ReviewSession | null = null;

/**
 * Every `AnswerResult` this session has produced, newest last.
 *
 * The undo of a grade needs the session's cursor and its decision-13 re-ask queue as
 * well as the two database rows, and the session lives here — so the stack does too,
 * and the page's undo entry carries nothing but its own intent. Cleared with the
 * session in `open`.
 */
let answers: AnswerResult[] = [];

function post(message: AppMessage): void {
  self.postMessage(message);
}

function log(text: string, level: LogLevel = "info"): void {
  post({ kind: "log", level, text });
}

/**
 * Fetch one database and put it into the pool, unless the pool already has it.
 *
 * A WAL-mode file cannot be imported — `importDb` wants a single self-contained
 * checkpointed file, and anything living only in a `-wal` sidecar would be
 * silently missing. `scripts/app-bootstrap.ts` produces both files with
 * `VACUUM INTO`, which is what makes them importable; this only has to notice
 * when the fetch went wrong.
 */
/**
 * Which file of how many, so the page can say "2 of 2" without knowing the plan.
 */
interface FetchPlan {
  readonly index: number;
  readonly of: number;
}

/**
 * Read a response body to completion, reporting bytes as they arrive.
 *
 * `response.arrayBuffer()` is one await that resolves when the LAST byte lands,
 * so a 224 MB file over 5G is several silent minutes — measured on Zach's phone
 * 2026-09-08, and indistinguishable from a hang. Streaming the body costs one
 * loop and turns that into a progress bar.
 *
 * Chunks are collected and joined at the end rather than written incrementally
 * because `importDatabaseBrowser` takes one contiguous `Uint8Array`; this changes
 * what the user SEES, not how the import works.
 *
 * `Content-Length` is what the middleware sets (`vite.app.config.ts`), but a
 * proxy may drop it or re-encode — `tailscale serve` sits in front of this on the
 * phone. So `total` is `null` when it is absent or unparseable, and the page
 * renders an indeterminate bar instead of dividing by zero. A body with no
 * `getReader` (very old browsers, some test doubles) falls back to
 * `arrayBuffer()`, which is the old behaviour and still correct.
 */
async function readWithProgress(
  response: Response,
  url: string,
  plan: FetchPlan,
): Promise<Uint8Array> {
  const header = response.headers.get("Content-Length");
  const parsed = header === null ? Number.NaN : Number(header);
  const total = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    post({ kind: "fetching", url, ...plan, received: bytes.length, total, done: true });
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  // Throttled to ~10/s: one postMessage per 64 KB chunk is thousands of messages
  // and repaints for a 224 MB file, which would make the bar itself the slow part.
  let lastPost = 0;
  post({ kind: "fetching", url, ...plan, received: 0, total, done: false });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    received += value.length;
    const now = Date.now();
    if (now - lastPost >= 100) {
      lastPost = now;
      post({ kind: "fetching", url, ...plan, received, total, done: false });
    }
  }
  post({ kind: "fetching", url, ...plan, received, total, done: true });

  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

async function ensureFile(
  name: string,
  url: string,
  reimport: boolean,
  plan: FetchPlan,
): Promise<number> {
  if (!reimport && (await databaseFilesInOpfs()).includes(name)) {
    log(`  ${name} is already in OPFS — not re-fetching`, "good");
    return 0;
  }
  log(`  fetching ${url}`, "step");
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `${url} answered ${response.status}. Build the bootstrap files first:\n` +
        `  npx vite-node scripts/app-bootstrap.ts`,
    );
  }
  const bytes = await readWithProgress(response, url, plan);
  // The SQLite header is 16 bytes of magic; anything else here is an HTML error
  // page with a 200, which `importDb` reports as an unhelpful malformed-database.
  //
  // ─── AND THE CAUSE IS ALMOST ALWAYS THE SAME ONE ──────────────────────────
  //
  // A single-page app's fallback answers an unknown route with `index.html` and
  // a 200, on purpose — so `response.ok` cannot catch this and the header is the
  // first thing that can. **The route is unknown because the SERVER is older
  // than the client**: `vite.app.config.ts` builds its asset map once at
  // startup, while the bundle is read from disk per request. A new seed file is
  // therefore reachable by a page served from the same process that has never
  // heard of it.
  //
  // This has now cost Zach a round trip three times — the sync mailbox
  // (2026-09-13), `/generate/` (2026-09-15) and `/hashigo-app-gen.db`
  // (2026-09-16) — so the repair goes IN THE MESSAGE rather than in a comment he
  // would have to be at a keyboard to read. `app/sync-client.ts` says the same
  // sentence for the same reason.
  const magic = new TextDecoder("ascii").decode(bytes.subarray(0, 15));
  if (magic !== "SQLite format 3") {
    throw new Error(
      `${url} returned ${bytes.length} bytes that are not a SQLite file ` +
        `(header ${JSON.stringify(magic)}). That is this server's index.html: it ` +
        `started before ${url} existed and answers unknown routes with the app. ` +
        `On the laptop: npx kill-port 4274, then npm run phone`,
    );
  }
  const written = await importDatabaseBrowser(name, bytes);
  log(`  imported ${written.toLocaleString()} bytes into ${name}`, "good");
  return written;
}

/** What `scripts/app-bootstrap.ts` wrote beside the two databases. */
interface SeedManifest {
  readonly generatedAt: string;
  readonly schemaVersion: number;
  readonly cards: number;
  readonly seedReviews: number;
  readonly payloads: number;
  /**
   * `blob_store_meta.created` of the audio file the server is serving. Absent on
   * a manifest written before 2026-09-12, which is why every use is optional.
   */
  readonly storeCreated?: string;
  /**
   * `gen_meta.created` of the TEXT GENERATION file the server is serving. Absent
   * on a manifest written before 2026-09-16, which is why every use is optional
   * — an older seed must keep working rather than re-fetching on every boot.
   */
  readonly genCreated?: string;
  readonly generations?: number;
  /**
   * `field_meta.created` of the LOCAL FIELD file the server is serving. Absent on
   * a manifest written before 2026-09-17, which is why every use is optional —
   * an older seed must keep working rather than re-fetching on every boot.
   */
  readonly fieldsCreated?: string;
  readonly fieldValues?: number;
}

/**
 * Is the database already in OPFS the one this server is serving?
 *
 * THE BUG THIS EXISTS FOR, seen 2026-09-08 on a real phone-shaped run.
 * `ensureFile` skips the fetch whenever OPFS already holds the file, which is
 * right — the whole point is that the app is local and offline after the first
 * load. But it made a re-import INVISIBLE: after the 2026-09-05 export landed,
 * the page went on reporting "102,020 reviews" from the August seed, and the only
 * way to notice was to read the boot log. On a phone that is a whole session
 * reviewed against stale due dates, and decision 16's final import would have
 * done it again, louder.
 *
 * **The comparison is on `seedReviews`, which counts rows that are NOT locally
 * graded.** That is the one number local reviewing cannot move, so this stays
 * correct once he is actually grading here — comparing `count(*)` would start
 * reporting a mismatch the moment he answered his first card, and "re-fetch"
 * would then mean "delete his grades".
 *
 * A manifest that is missing or unreadable returns null and changes nothing: an
 * older bootstrap, or a static host that only has the two databases, must keep
 * working rather than refusing to open.
 */
async function seedManifest(): Promise<SeedManifest | null> {
  try {
    const response = await fetch(SEED_URL, { cache: "no-store" });
    if (!response.ok) return null;
    const parsed = (await response.json()) as Partial<SeedManifest>;
    return typeof parsed.seedReviews === "number" ? (parsed as SeedManifest) : null;
  } catch {
    return null;
  }
}

/**
 * Copy the locally-authored fields from file 4 into the card database.
 *
 * ─── INSERT-ONLY, AND THAT IS THE WHOLE SAFETY ARGUMENT ─────────────────────
 *
 * `ON CONFLICT DO NOTHING` on both tables. A value this device already holds is
 * left exactly as it is, because **this device authors values too**: `setField`
 * is the card editor, and `flipReading` is decision 29's audit loop — the one he
 * uses constantly, the `Reading → true` button. Overwriting would take those
 * back, silently, on a boot that looked like a download.
 *
 * `Reading` is `local = 0` (Mochi owns it) so it is not in this file at all, and
 * that is belt as well as braces. `型` is `local = 1` and he CAN edit it here.
 *
 * ─── WHAT INSERT-ONLY DOES NOT SOLVE, STATED RATHER THAN HIDDEN ─────────────
 *
 * A value that CHANGED on the laptop does not cross. That is not an oversight
 * and it is not fixable here: the device may hold his edit of the same row, and
 * choosing between them needs a clock. `card_field_values` has none — decision
 * 33 named that gap and deferred it to a schema bump. So this delivers every
 * value the device has never seen, which is the reported case (the nine `ojad`
 * annotations of 2026-09-17 were absent, not stale), and stops exactly where
 * guessing would begin.
 *
 * Returns how many rows were new.
 */
async function applyLocalFields(): Promise<number> {
  const db = cards;
  if (db === null) return 0;
  if (!(await databaseFilesInOpfs()).includes(FIELDS_DB)) return 0;
  const seed = await openDatabaseBrowser({ filename: FIELDS_DB, applySchema: false });
  try {
    const { fields, values, corrections } = readSeedFields(seed);
    if (values.length === 0) return 0;
    const have = Number((db.prepare(COUNT_HELD).get() as { n: number }).n);
    // ONE TRANSACTION over both tables, so a boot that dies half way leaves
    // nothing partial — and so a value can never land ahead of the field
    // declaration that makes it render.
    const report = db.transaction(() => mergeLocalFields(db, fields, values, corrections))();
    log(
      `  local fields: ${have.toLocaleString()} here, ${values.length.toLocaleString()} served — ` +
        `${report.added.toLocaleString()} taken in` +
        (report.corrected > 0 ? `, ${report.corrected.toLocaleString()} corrected` : "") +
        (report.differs > 0 ? `, ${report.differs.toLocaleString()} differ and were LEFT ALONE` : ""),
      report.differs > 0 ? "bad" : report.added > 0 ? "good" : undefined,
    );
    return report.added + report.corrected;
  } finally {
    seed.close();
  }
}

/**
 * Copy the text generations from file 3 into `blobs`.
 *
 * Returns how many rows were new. See the call site for why a write into the
 * card database is safe here and what keeps it that way.
 */
async function applyGenerations(fetched: boolean): Promise<number> {
  const db = cards;
  if (db === null) return 0;
  if (!(await databaseFilesInOpfs()).includes(GEN_DB)) return 0;
  const gen = await openDatabaseBrowser({ filename: GEN_DB, applySchema: false });
  try {
    const total = Number(
      (gen.prepare("SELECT count(*) AS n FROM generations").get() as { n: number }).n,
    );
    if (total === 0) return 0;
    // A boot that did not re-fetch has already applied these; asking for the
    // count is cheaper than 28,676 conflicting inserts.
    if (!fetched) {
      const have = Number(
        (
          db
            .prepare(
              `SELECT count(*) AS n FROM blobs
                WHERE kind IN ('ai', 'translate', 'furigana', 'dictionary')`,
            )
            .get() as { n: number }
        ).n,
      );
      if (have >= total) return 0;
    }
    const rows = gen
      .prepare(
        `SELECT hash, kind, mime, byte_size, source_text, voice, lang, options, bytes, refcount
           FROM generations`,
      )
      .all() as Record<string, unknown>[];
    const insert = db.prepare(
      `INSERT INTO blobs
         (hash, kind, mime, byte_size, source_text, voice, lang, options, bytes, refcount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (hash) DO NOTHING`,
    );
    // Counted around the transaction rather than per row: `BrowserDb` exposes no
    // `changes()`, and one COUNT either side is cheaper than 28,676 calls anyway.
    const countText = (): number =>
      Number(
        (
          db
            .prepare(
              `SELECT count(*) AS n FROM blobs
                WHERE kind IN ('ai', 'translate', 'furigana', 'dictionary')`,
            )
            .get() as { n: number }
        ).n,
      );
    const before = countText();
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        insert.run(
          row["hash"],
          row["kind"],
          row["mime"],
          row["byte_size"],
          row["source_text"],
          row["voice"],
          row["lang"],
          row["options"],
          row["bytes"],
          row["refcount"],
        );
      }
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
    const added = countText() - before;
    if (added > 0) log(`  ${added.toLocaleString()} text generations taken in`, "good");
    return added;
  } finally {
    gen.close();
  }
}

async function open(request: OpenRequest): Promise<void> {
  log(`sqlite ${await sqliteVersion()}`);
  await installPool();
  log(`pool holds ${JSON.stringify(await databaseFilesInOpfs())}`);

  // Asked BEFORE either fetch, because `ensureFile` is what changes the answer.
  const present = await databaseFilesInOpfs();
  const cardsWerePresent = present.includes(CARD_DB);
  const storeWasPresent = present.includes(STORE_DB);

  // ── is what we already have still what the server is serving? ──
  let reimport = request.reimport;
  // THE AUDIO FILE IS A SEPARATE QUESTION AND USED TO HAVE NO ANSWER AT ALL.
  //
  // Zach, 2026-09-12, having reported it three times: *"the example sentence audio
  // is not there"*. The clip was genuinely absent from the shipped subset — and a
  // bigger `--speech-bytes` would not have reached him either, because the
  // freshness check below is entirely about the CARD database. `seedReviews` is
  // deliberately a property of that file (it is the one number local grading
  // cannot move), so it does not move when only the audio changes, and
  // `ensureFile` skips any file OPFS already holds. Both devices would have gone
  // on playing the old subset for ever, with the boot log cheerfully saying
  // "already in OPFS — not re-fetching".
  //
  // Replacing it destroys nothing: the store is content-addressed, the worker
  // only ever READS it (`{ create: false }`), and no local grade or card lives in
  // it. So this needs none of the refuse-loudly machinery the card database has.
  let refetchStore = request.reimport;
  // One fetch, two questions. The card database and the audio file change for
  // different reasons and are compared on different things.
  const manifest = reimport && refetchStore ? null : await seedManifest();

  // `cards === null` as well: a second `open` in one session must not put a
  // SECOND handle on the same pool file just to read two counts off it.
  if (cardsWerePresent && !reimport && cards === null) {
    if (manifest !== null) {
      const held = await openDatabaseBrowser({ filename: CARD_DB, applySchema: false });
      const count = (sql: string): number =>
        Number((held.prepare(sql).get() as { n: number }).n);
      const heldSeed = count("SELECT count(*) AS n FROM reviews WHERE source <> 'local'");
      const localReviews = count("SELECT count(*) AS n FROM reviews WHERE source = 'local'");
      if (heldSeed !== manifest.seedReviews) {
        if (localReviews === 0) {
          // Nothing of his to lose: the local copy is purely a cached seed.
          held.close();
          reimport = true;
          log(
            `  the database here holds ${heldSeed.toLocaleString()} seeded reviews and the ` +
              `server is serving ${manifest.seedReviews.toLocaleString()} — re-fetching`,
            "step",
          );
        } else {
          // REFUSE, LOUDLY. Re-importing would delete grades that exist nowhere
          // else; reconciling them is stage 11's job, not this function's.
          log(
            `  the server has a NEWER seed (${manifest.seedReviews.toLocaleString()} reviews ` +
              `vs ${heldSeed.toLocaleString()} here) but this device holds ` +
              `${localReviews.toLocaleString()} local grades. Keeping what is here — ` +
              `replacing it would destroy them. Export a backup, then re-seed.`,
            "bad",
          );
          cards ??= held;
        }
      } else {
        cards ??= held;
      }
    }
  }

  // ── and is the AUDIO still what the server is serving? ──
  // Compared on `blob_store_meta.created`, one row, written fresh by the store's
  // own DDL on every bootstrap — so it changes exactly when the file does.
  // `count(*)` over `blob_payloads` answers the same question by walking every
  // overflow page of a half-gigabyte file.
  if (storeWasPresent && !refetchStore && payloads === null && manifest !== null) {
    const serving = manifest.storeCreated ?? "";
    const held = await openDatabaseBrowser({ filename: STORE_DB, applySchema: false });
    const heldCreated =
      (
        held.prepare("SELECT value FROM blob_store_meta WHERE key = 'created'").get() as
          | { value: string }
          | undefined
      )?.value ?? "";
    // The rule itself is in `./seed-freshness.ts`, with no imports, so `test/`
    // can reach it — including the arm that must NOT fire (an older manifest
    // with no such field), which otherwise re-downloads 640 MB on every boot.
    if (audioIsStale(serving, heldCreated)) {
      held.close();
      refetchStore = true;
      log(
        `  the audio here was built ${heldCreated || "(unknown)"} and the server is ` +
          `serving ${serving} — re-fetching it`,
        "step",
      );
    } else {
      payloads ??= held;
    }
  }

  // ── and are the TEXT GENERATIONS still what the server is serving? ──
  //
  // ─── THE THIRD FILE, AND THE BUG THAT EARNED IT — 2026-09-16 ──────────────
  //
  // Zach filled 1,631 emoji, translations and furigana on 2026-09-15, rebuilt the
  // seed, and got none of them. A text generation is a `blobs` row in the CARD
  // database; the card database is re-fetched only when `seedReviews` differs;
  // filling a generation moves `seedReviews` by exactly zero. So `ensureFile`
  // said "already in OPFS — not re-fetching", in green, for ever.
  //
  // That is the audio bug of 2026-09-12 one layer up, and it would have been
  // just as silent. **Re-fetching the card database is not the repair** — it is
  // 74 MB and holds his grades, and the branch above refuses it outright while
  // any local review exists, correctly. The content he was missing is 1.60 MiB.
  //
  // So it ships as its own file on the AUDIO's terms: content-addressed,
  // read-only, no grade or card in it, therefore free to replace. Same staleness
  // rule, same reason a COUNT would be wrong — he fills generations on the device
  // from the card button, so a local count stops matching the server's and never
  // recovers.
  let refetchGen = request.reimport;
  const genWasPresent = present.includes(GEN_DB);
  if (genWasPresent && !refetchGen && manifest !== null) {
    const serving = manifest.genCreated ?? "";
    const held = await openDatabaseBrowser({ filename: GEN_DB, applySchema: false });
    const heldCreated =
      (
        held.prepare("SELECT value FROM gen_meta WHERE key = 'created'").get() as
          | { value: string }
          | undefined
      )?.value ?? "";
    held.close();
    if (audioIsStale(serving, heldCreated)) {
      refetchGen = true;
      log(
        `  the text generations here were built ${heldCreated || "(unknown)"} and the ` +
          `server is serving ${serving} — re-fetching them`,
        "step",
      );
    }
  }

  // ── AND THE LOCAL FIELDS (file 4), on the same rule ─────────────────────
  //
  // `ojad`, `型`, `読み`, `かな主流` — everything `template_fields.local = 1`.
  // Zach, 2026-09-17: *"somehow ojad field is not here..."*. It had been fixed on
  // the laptop an hour earlier and could not cross, because the card database is
  // re-fetched only on `seedReviews` and a field value moves that by zero.
  let refetchFields = request.reimport;
  const fieldsWerePresent = present.includes(FIELDS_DB);
  if (fieldsWerePresent && !refetchFields && manifest !== null) {
    const serving = manifest.fieldsCreated ?? "";
    const held = await openDatabaseBrowser({ filename: FIELDS_DB, applySchema: false });
    const heldCreated =
      (
        held.prepare("SELECT value FROM field_meta WHERE key = 'created'").get() as
          | { value: string }
          | undefined
      )?.value ?? "";
    held.close();
    if (audioIsStale(serving, heldCreated)) {
      refetchFields = true;
      log(
        `  the local fields here were built ${heldCreated || "(unknown)"} and the ` +
          `server is serving ${serving} — re-fetching them`,
        "step",
      );
    }
  }

  const imported =
    (await ensureFile(CARD_DB, CARD_URL, reimport, { index: 1, of: 4 })) +
    (await ensureFile(GEN_DB, GEN_URL, refetchGen, { index: 2, of: 4 })) +
    (await ensureFile(FIELDS_DB, FIELDS_URL, refetchFields, { index: 3, of: 4 })) +
    (await ensureFile(STORE_DB, STORE_URL, refetchStore, { index: 4, of: 4 }));

  // `applySchema: false` on all: these arrive fully formed. An empty pool plus a
  // failed fetch must NOT quietly create a blank database and call it success.
  cards ??= await openDatabaseBrowser({ filename: CARD_DB, applySchema: false });
  payloads ??= await openDatabaseBrowser({ filename: STORE_DB, applySchema: false });
  store ??= new SqliteBlobStore(payloads, { create: false });

  // ── FILE 3 INTO THE CARD DATABASE ───────────────────────────────────────
  //
  // The generations have to END UP in `blobs`, because that is where
  // `resolveDescriptorText` looks and changing the read path would mean teaching
  // every resolver about a second handle. So this is a write into the card
  // database — the one file that holds his grades — and the safety is in how
  // narrow it is:
  //
  //   · `INSERT ... ON CONFLICT (hash) DO NOTHING` and NOTHING ELSE. No UPDATE,
  //     no DELETE, no other table touched. A generation he made on the device is
  //     left exactly as it is; an identical one is a no-op by content address.
  //   · `reviews`, `card_tracks` and `cards` are never named in this statement,
  //     so no path here can move a grade or a due date.
  //   · idempotent, so a boot that half-finished simply finishes.
  //
  // It runs on the boot that FETCHED the file. `hasGenerations` is asked first so
  // an unchanged file costs one count rather than 28,676 no-op inserts.
  await applyGenerations(refetchGen);
  // File 4, insert-only. See `applyLocalFields` for why it may never overwrite.
  await applyLocalFields();

  const cardCount = Number(
    (cards.prepare("SELECT count(*) AS n FROM cards").get() as { n: number }).n,
  );
  const reviewCount = Number(
    (cards.prepare("SELECT count(*) AS n FROM reviews").get() as { n: number }).n,
  );
  const storeRows = Number(
    (payloads.prepare("SELECT count(*) AS n FROM blob_payloads").get() as { n: number }).n,
  );
  if (cardCount === 0) {
    throw new Error(
      "the card database opened but holds 0 cards. That is a bad bootstrap file, " +
        "not an empty session — refusing to start a review over nothing.",
    );
  }

  session = buildSession(cards);
  answers = [];
  post({
    kind: "opened",
    id: request.id,
    sqliteVersion: await sqliteVersion(),
    schemaVersion: schemaVersion(cards),
    files: await databaseFilesInOpfs(),
    cards: cardCount,
    reviews: reviewCount,
    imported,
    storeRows,
    cardsWerePresent,
    localReviews: Number(
      (
        cards.prepare("SELECT count(*) AS n FROM reviews WHERE source = 'local'").get() as {
          n: number;
        }
      ).n,
    ),
    progress: session.progress(),
  });
}

function requireSession(): ReviewSession {
  if (session === null) throw new Error("no session yet — send `open` first");
  return session;
}

function requireCards(): BrowserDb {
  if (cards === null) throw new Error("no database yet — send `open` first");
  return cards;
}

/**
 * `pinned` and `archived` for one card, as booleans.
 *
 * Sent with every card and every preview so the screen's controls can label
 * themselves — "pin" or "unpin", "archive" or "unarchive". The page could remember
 * what it last did instead; it must not. Two surfaces act on the same card (the
 * gallery tile and the review bar), a duplicate lands unpinned while its original
 * is pinned, and an undo flips a row the page never touched. The row is the truth
 * and it is one join-free read.
 */
function collectionState(db: BrowserDb, cardId: string): { pinned: boolean; archived: boolean } {
  const row = db.prepare("SELECT pinned, archived FROM cards WHERE id = ?").get(cardId) as
    | { pinned: number; archived: number }
    | undefined;
  return { pinned: row?.pinned === 1, archived: row?.archived === 1 };
}

function next(request: NextRequest): void {
  const active = requireSession();
  const db = requireCards();
  // offset 0 is `current()`; anything else LOOKS without moving (his #9).
  const item = active.peek(request.offset ?? 0);
  if (item === null) {
    post({
      kind: "card",
      id: request.id,
      card: null,
      deckPath: "",
      isNew: false,
      reask: false,
      overdueDays: 0,
      dueAt: null,
      lastReviewedAt: null,
      pinned: false,
      archived: false,
      progress: active.progress(),
    });
    return;
  }
  const card = prepareCard({
    db,
    cardId: item.cardId,
    direction: directionForTrackKind(item.kind),
  });
  if (card === null) {
    throw new Error(
      `the session is on card ${item.cardId} and the database has no such card. ` +
        `That is a queue built against a different database, not a skippable card.`,
    );
  }
  post({
    kind: "card",
    id: request.id,
    card,
    deckPath: card.loaded.deckPath,
    // Decision 25: the label is per TRACK, and `origin` already is.
    isNew: item.origin === "new",
    reask: item.reask,
    // The scheduler's own figure, counted in LOCAL DATES. Passed through rather
    // than derived on the page — `app/overdue.ts` carries why those differ.
    // A new track has no due date and `dueTracks` never yields it, so 0 here is
    // "not late" and not a missing value.
    overdueDays: item.origin === "new" ? 0 : item.track.overdueDays,
    dueAt: item.track.dueAt,
    // Null on a new track, which is a fact and not a missing value: there is
    // no last time. `app/last-seen.ts` renders nothing for it.
    lastReviewedAt: item.track.lastReviewedAt,
    ...collectionState(db, item.cardId),
    progress: active.progress(),
  });
}

/**
 * Bytes for one clip.
 *
 * The resolver is built PER CARD on purpose — `cardAudioResolver` closes over the
 * card id, and a test in `src/cards` proves the same `ref_key` against another
 * card resolves to null. Passing the id in the message rather than remembering
 * "the current card" keeps that property across an out-of-order reply.
 */
async function payload(request: PayloadRequest): Promise<void> {
  const db = requireCards();
  if (store === null) throw new Error("no payload store — send `open` first");
  const resolve = cardAudioResolver(db, request.cardId, { store });
  const found = await resolve(request.address);
  post({ kind: "payload", id: request.id, payload: found });
}

function answer(request: AnswerRequest): void {
  const active = requireSession();
  // P1's second half: the per-grade OPFS write, measured where it happens rather
  // than inferred from the page's round trip, which would include postMessage.
  const started = performance.now();
  // `answerAt(0)` IS `answer()` — one path, so an out-of-order grade cannot drift
  // from an in-order one. It swaps the target into the cursor and grades there,
  // which is why undo needs no special case.
  const outcome = active.answerAt(request.offset, request.remembered, {
    ...(request.durationMs === null ? {} : { durationMs: request.durationMs }),
  });
  const writeMs = performance.now() - started;

  if ("refused" in outcome) {
    post({
      kind: "answered",
      id: request.id,
      graded: false,
      queuedReask: false,
      refused: outcome.refused,
      dueAt: null,
      scheduledDays: null,
      progress: active.progress(),
      writeMs,
      openStatements: requireCards().openStatements,
      cachedStatements: requireCards().cachedStatements,
    });
    return;
  }

  answers.push(outcome);
  post({
    kind: "answered",
    id: request.id,
    graded: outcome.graded,
    queuedReask: outcome.queuedReask,
    refused: null,
    dueAt: outcome.review?.dueAt ?? null,
    scheduledDays: outcome.review?.intervalDays ?? null,
    progress: active.progress(),
    writeMs,
    openStatements: requireCards().openStatements,
    cachedStatements: requireCards().cachedStatements,
  });
}

/**
 * Undo the last grade — delete the review, restore the schedule, rewind the cursor.
 *
 * `ReviewSession.unanswer` does the database work first, so a refusal leaves the
 * session and the database still agreeing. `ungradeTrack` refuses anything but the
 * newest review on a track, which is why this pops rather than searching.
 */
function ungrade(request: UngradeRequest): void {
  const active = requireSession();
  const last = answers.pop();
  if (last === undefined) throw new Error("nothing graded this session to undo");
  try {
    active.unanswer(last);
  } catch (cause) {
    // Put it back: the undo did not happen, so the stack must still describe reality.
    answers.push(last);
    throw cause;
  }
  post({
    kind: "ungraded",
    id: request.id,
    describe: last.graded
      ? `un-graded ${last.item.cardId} — the review is gone and the schedule is back`
      : `stepped back over a re-ask (nothing was graded)`,
    cardId: last.item.cardId,
    progress: active.progress(),
  });
}

/**
 * Decision 29's audit loop: flip `Reading` on the card in front of him.
 *
 * `cardMode` is what read this, and it insists on a BOOLEAN field named `Reading`
 * declared by the card's own template — 漢字 has a PLAIN field of the same name
 * over 1,662 cards. The same insistence is repeated here rather than trusted from
 * the page, because the page's `readingFieldId` came from a message and a write
 * that lands on 漢字's reading text would destroy data.
 */
function setReading(request: ReadingRequest): void {
  const db = requireCards();
  const field = db
    .prepare(
      `SELECT tf.id AS id FROM cards c
         JOIN template_fields tf ON tf.template_id = c.template_id
        WHERE c.id = ? AND trim(tf.name) = 'Reading' AND tf.type = 'boolean'`,
    )
    .get(request.cardId) as { id: string } | undefined;
  if (field === undefined) {
    throw new Error(
      `card ${request.cardId} has no BOOLEAN field named Reading on its own template, ` +
        `so there is nothing to flip. (言葉 declares none at all; 漢字's Reading is ` +
        `plain text and must never be written here.)`,
    );
  }
  db.prepare(
    `INSERT INTO card_field_values (card_id, field_id, value)
     VALUES (?, ?, ?)
     ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value`,
  ).run(request.cardId, field.id, request.value ? "true" : "false");
  refreshSearchText(db, [request.cardId]);
  post({ kind: "reading", id: request.id, cardId: request.cardId, value: request.value });
}

/**
 * Throw away the whole pool.
 *
 * The order matters and each step is load-bearing: count the loss BEFORE
 * destroying it, `close()` both handles so no sync access handle is still open
 * (`WasmDb.close` finalizes every statement first, which upstream's own close does
 * not), then `removeVfs()`. A per-file `unlink()` would report success and free
 * nothing — measured at 0.0 MiB of 639.0 MiB.
 */
async function reset(request: ResetRequest): Promise<void> {
  const localReviews =
    cards === null
      ? 0
      : Number(
          (
            cards.prepare("SELECT count(*) AS n FROM reviews WHERE source = 'local'").get() as {
              n: number;
            }
          ).n,
        );
  const pool = await installPool();
  const removed = await databaseFilesInOpfs();
  session = null;
  store = null;
  cards?.close();
  payloads?.close();
  cards = null;
  payloads = null;
  await pool.removeVfs();
  log(`removed ${JSON.stringify(removed)} — ${localReviews} local grade(s) gone`, "bad");
  post({ kind: "reset", id: request.id, removed, localReviews });
}

/**
 * One operation on one card — his #7 and #14, and every one of them was already
 * possible in the schema and unreachable from anywhere.
 *
 * `archive` is `cards.archived`, which the queue (`src/scheduler/queue.ts:139`),
 * the dashboard and the backtest all already honour — 234 imported cards prove the
 * machinery works. Nothing could SET it until now.
 *
 * `delete` is one statement, because every foreign key pointing at `cards` is
 * `ON DELETE CASCADE` (field values, tracks, tags, links, blob refs) and the FTS
 * index has triggers on all three of its sources. `blob_refs_ad` decrements the
 * refcount so the card's audio is released, and `blobs_no_delete_while_referenced`
 * stops a payload something else still uses from going with it.
 *
 * **`delete` is the one that cannot be undone**, and it says so rather than
 * offering a reversal it cannot honour: the reviews go with the card.
 */
function cardOp(request: CardOpRequest): void {
  const db = requireCards();
  const card = db
    .prepare("SELECT id, name, deck_id, template_id, archived, pinned FROM cards WHERE id = ?")
    .get(request.cardId) as
    | {
        id: string;
        name: string;
        deck_id: string;
        template_id: string | null;
        archived: number;
        pinned: number;
      }
    | undefined;
  if (card === undefined) throw new Error(`no card ${request.cardId}`);

  const name = card.name === "" ? card.id : card.name;
  let resultCardId = card.id;
  // Taken from the MESSAGE type rather than restated, so a new field there cannot
  // be added and forgotten here — the mistake `deckOp`'s `restoreArchive` made once.
  let undo: CardOpMessage["undo"] = null;
  let describe = "";

  switch (request.op) {
    case "archive":
      db.prepare("UPDATE cards SET archived = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(card.id);
      undo = { op: "unarchive", cardId: card.id };
      describe = `archived ${name}`;
      break;
    case "unarchive":
      db.prepare("UPDATE cards SET archived = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(card.id);
      undo = { op: "archive", cardId: card.id };
      describe = `unarchived ${name}`;
      break;
    // PIN IS NOT ARCHIVE'S OPPOSITE and the two are deliberately independent.
    // Archive means "stop scheduling this"; pin means "keep this in front of me".
    // A card can be both — an archived card he is still looking at — so neither
    // clears the other.
    //
    // It touches NO schedule and writes no review, which is why it is safe to hang
    // on a bare keystroke in review.
    case "pin":
      db.prepare("UPDATE cards SET pinned = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(card.id);
      undo = { op: "unpin", cardId: card.id };
      describe = `pinned ${name}`;
      break;
    case "unpin":
      db.prepare("UPDATE cards SET pinned = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(card.id);
      undo = { op: "pin", cardId: card.id };
      describe = `unpinned ${name}`;
      break;
    case "setTemplate": {
      // `templateId` is REQUIRED to be present, and `null` is a legal value meaning
      // "no template" — so `undefined` is the error and `?? null` would hide it.
      if (!("templateId" in request)) throw new Error("setTemplate needs a templateId");
      const to = request.templateId ?? null;
      if (to !== null && db.prepare("SELECT 1 FROM templates WHERE id = ?").get(to) === undefined) {
        throw new Error(`no template ${to}`);
      }
      if (to === card.template_id) {
        // Not an error, and not a write either: a picker that re-selects the current
        // option must not put a no-op on the undo stack.
        describe = `${name} is already on that template`;
        undo = null;
        break;
      }
      // NO VALUE IS DELETED. `card_field_values` is keyed `(card_id, field_id)` and
      // is deliberately not foreign-keyed to `template_fields`, so this changes which
      // values RENDER and nothing else — see `CardOp`'s `setTemplate` for the field-id
      // overlap that makes the number worth saying out loud.
      const before = new Set(
        (
          db
            .prepare("SELECT field_id FROM card_field_values WHERE card_id = ? AND value <> ''")
            .all(card.id) as { field_id: string }[]
        ).map((row) => row.field_id),
      );
      const after = new Set(
        to === null
          ? []
          : (
              db.prepare("SELECT id FROM template_fields WHERE template_id = ?").all(to) as {
                id: string;
              }[]
            ).map((row) => row.id),
      );
      let kept = 0;
      for (const fieldId of before) if (after.has(fieldId)) kept += 1;
      const hidden = before.size - kept;

      db.prepare("UPDATE cards SET template_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(to, card.id);
      const toName =
        to === null
          ? "no template"
          : (
              db.prepare("SELECT name FROM templates WHERE id = ?").get(to) as { name: string }
            ).name;
      describe =
        `moved ${name} to ${toName} — ${kept} value(s) carried over` +
        (hidden === 0 ? "" : `, ${hidden} now hidden (kept, not deleted)`);
      undo = { op: "setTemplate", cardId: card.id, templateId: card.template_id };
      break;
    }
    case "delete":
      // The cascades do the rest. Counted first so the message can say what went.
      {
        const reviews = Number(
          (
            db
              .prepare(
                `SELECT count(*) AS n FROM reviews r JOIN card_tracks t ON t.id = r.track_id
                  WHERE t.card_id = ?`,
              )
              .get(card.id) as { n: number }
          ).n,
        );
        db.prepare("DELETE FROM cards WHERE id = ?").run(card.id);
        // NO UNDO. The reviews went with it, and offering a reversal that
        // silently loses them is worse than saying so.
        undo = null;
        describe = `deleted ${name} and ${reviews} review(s) — not undoable`;
      }
      break;
    case "duplicate":
      {
        const copyId = newCardId(db);
        db.transaction(() => {
          db.prepare(
            // `reverse` and `voice` come with the copy: they describe the CARD, and
            // dropping `reverse` silently gave the duplicate the deck's default —
            // losing the override on the 14 cards that carry one, which for a card
            // overridden to `on` means the copy has no reverse track at all.
            // `pinned` and `archived` deliberately do NOT come: those describe a
            // relationship with the collection, and a fresh copy has none yet.
            // `local = 1` on the COPY whatever the original was: the duplicate exists
            // only here, so it needs the same protection a created card does. The
            // original's own flag is irrelevant to that.
            `INSERT INTO cards (id, deck_id, template_id, name, content, reverse, voice,
                                archived, local)
             SELECT ?, deck_id, template_id, name, content, reverse, voice, 0, 1
               FROM cards WHERE id = ?`,
          ).run(copyId, card.id);
          db.prepare(
            `INSERT INTO card_field_values (card_id, field_id, value)
             SELECT ?, field_id, value FROM card_field_values WHERE card_id = ?`,
          ).run(copyId, card.id);
          refreshSearchText(db, [copyId]);
          // Fresh tracks, NOT the original's schedule: a duplicate is a new card
          // he has never seen, and inheriting a 300-day interval would hide it.
          const reverse = db
            .prepare("SELECT reverse FROM card_reverse_resolved WHERE card_id = ?")
            .get(copyId) as { reverse: string } | undefined;
          for (const kind of reverse?.reverse === "on" ? ["forward", "reverse"] : ["forward"]) {
            db.prepare(
              `INSERT INTO card_tracks (card_id, kind, dormant, needs_rereview, due_at,
                 scheduled_days, reps, lapses, last_reviewed_at, scheduler, scheduler_state)
               VALUES (?, ?, 0, 0, NULL, NULL, 0, 0, NULL, NULL, NULL)`,
            ).run(copyId, kind);
          }
        })();
        resultCardId = copyId;
        undo = { op: "delete", cardId: copyId };
        describe = `duplicated ${name}`;
      }
      break;
  }
  // If the operation took the card the session is SHOWING, move past it here rather
  // than leaving the page holding a card whose track may no longer exist. `delete`
  // cascades to `card_tracks`, so without this every later grade throws invisibly.
  let advanced = false;
  if (
    (request.op === "delete" || request.op === "archive") &&
    session !== null &&
    session.current()?.cardId === card.id
  ) {
    advanced = session.skipCurrent();
  }

  post({
    kind: "cardOp",
    id: request.id,
    op: request.op,
    cardId: card.id,
    resultCardId,
    undo,
    describe,
    advanced,
  });
}

/**
 * Deck operations — his #14, and the ANSWER to his #8.
 *
 * `decks.archived` has existed in the schema since v1 and **nothing has ever read
 * or written it**. That is why his 数字 deck kept appearing: Mochi has no
 * deck-level archive flag at all (`src/import/entities.ts:326` writes `archived: 0`
 * unconditionally and says so), so a deck he archived in Mochi arrived here
 * unarchived and there was no way to say otherwise.
 *
 * Archiving a deck here marks the DECK. `queueRespectsDeckArchive` in the page is
 * not a thing — the queue filters on the CARD — so archiving a deck also archives
 * its cards, which is the honest reading of "stop reviewing this" and keeps one
 * predicate rather than two.
 */
function deckOp(request: DeckOpRequest): void {
  const db = requireCards();
  let describe = "";
  // Taken from the message type rather than restated, so a new DeckOp cannot be
  // added here and forgotten there. The duplicated union is how `restoreArchive`
  // first failed to compile.
  let undo: DeckOpMessage["undo"] = null;
  let deckId = request.deckId;

  if (request.op === "create") {
    deckId = newDeckId(db);
    db.prepare(
      `INSERT INTO decks (id, parent_id, name, reverse, archived, pos)
       VALUES (?, ?, ?, 'inherit', 0, '000000')`,
    ).run(deckId, request.parentId ?? null, request.name ?? "new deck");
    describe = `made deck ${request.name ?? "new deck"}`;
    undo = { op: "delete", deckId };
  } else {
    const deck = db.prepare("SELECT id, name, archived FROM decks WHERE id = ?").get(deckId) as
      | { id: string; name: string; archived: number }
      | undefined;
    if (deck === undefined) throw new Error(`no deck ${deckId}`);
    switch (request.op) {
      case "archive":
      case "unarchive": {
        const to = request.op === "archive" ? 1 : 0;
        // The deck AND its cards, THROUGH THE WHOLE SUBTREE. The queue filters on
        // the card, so marking only the deck would archive nothing he can see —
        // two predicates that disagree is worse than one that is blunt.
        //
        // It used to say `WHERE deck_id = ?`, the deck's OWN cards only, while
        // reporting "and its cards". Measured: 日本語 owns 3 of the 5,947 in its
        // subtree and English owns 0 of 1,258, so archiving either did essentially
        // nothing and said it worked. His #8 is exactly this operation.
        let result = { deckIds: [] as string[], changed: [] as string[] };
        db.transaction(() => {
          result = archiveSubtree(db, deckId, to);
        })();
        const { deckIds, changed } = result;
        const subdecks = deckIds.length === 1 ? "" : ` and ${deckIds.length - 1} subdeck(s)`;
        describe = `${request.op}d ${deck.name}${subdecks} — ${changed.length} card(s)`;
        undo = { op: "restoreArchive", deckId, cardIds: changed };
        break;
      }
      case "restoreArchive": {
        // The undo of the two above. It puts back EXACTLY the rows that were flipped
        // and nothing else, so a card he archived by hand inside the deck keeps its
        // state. `archived` is read from the card itself, inverted per row, because
        // one restore may span both directions after a mixed operation.
        const cardIds = request.cardIds ?? [];
        db.transaction(() => {
          restoreArchive(db, deckId, cardIds);
        })();
        describe = `restored ${deck.name} — ${cardIds.length} card(s)`;
        undo = null;
        break;
      }
      case "rename":
        db.prepare("UPDATE decks SET name = ? WHERE id = ?").run(request.name ?? deck.name, deckId);
        describe = `renamed ${deck.name} to ${request.name ?? deck.name}`;
        undo = { op: "rename", deckId, name: deck.name };
        break;
      case "move": {
        // ─── THE CYCLE GUARD IS THE WHOLE OF THIS OPERATION ──────────────────
        //
        // `decks.parent_id` has no constraint that can stop a deck becoming its own
        // ancestor, and the damage is not a bad row — it is `deck_ancestry`, a
        // RECURSIVE view with no depth bound, which every path, count, reverse
        // resolution and target-retention lookup goes through. One cycle and those
        // queries do not return. The page has a cycle report in its tree walk for
        // the same reason; this is the write side of it, and it is cheaper to
        // refuse here than to detect there.
        //
        // `deck_ancestry` includes the deck itself at depth 0, so this one check
        // covers both "into itself" and "into its own descendant".
        const target = request.parentId ?? null;
        if (target !== null) {
          const wouldCycle = db
            .prepare("SELECT 1 FROM deck_ancestry WHERE deck_id = ? AND ancestor_id = ? LIMIT 1")
            .get(target, deckId);
          if (wouldCycle !== undefined) {
            throw new Error(
              `${deck.name} cannot go inside itself or one of its own sub-decks — ` +
                `that makes the deck tree a loop, and every path and count query ` +
                `walks it recursively.`,
            );
          }
          if (db.prepare("SELECT 1 FROM decks WHERE id = ?").get(target) === undefined) {
            throw new Error(`no deck ${target} to move into`);
          }
        }
        const from = db.prepare("SELECT parent_id FROM decks WHERE id = ?").get(deckId) as {
          parent_id: string | null;
        };
        db.prepare("UPDATE decks SET parent_id = ? WHERE id = ?").run(target, deckId);
        // The NAME, not the id. `say()` puts this in front of him and an 8-character
        // base62 id is not a place he can recognise — and it is the string the undo
        // button then repeats back.
        const into =
          target === null
            ? "the top level"
            : ((
                db.prepare("SELECT path FROM deck_paths WHERE deck_id = ?").get(target) as
                  | { path: string }
                  | undefined
              )?.path ?? target);
        describe = `moved ${deck.name} into ${into}`;
        undo = { op: "move", deckId, parentId: from.parent_id };
        break;
      }
      case "delete": {
        // `cards.deck_id` is ON DELETE RESTRICT, deliberately: deleting a deck
        // must never silently take its cards. So this refuses rather than
        // cascading, and says how many are in the way.
        const held = Number(
          (db.prepare("SELECT count(*) AS n FROM cards WHERE deck_id = ?").get(deckId) as {
            n: number;
          }).n,
        );
        if (held > 0) {
          throw new Error(
            `${deck.name} still holds ${held} card(s). Move or delete them first — ` +
              `the schema refuses to take cards with a deck (ON DELETE RESTRICT), and ` +
              `that is deliberate.`,
          );
        }
        db.prepare("DELETE FROM decks WHERE id = ?").run(deckId);
        describe = `deleted deck ${deck.name}`;
        undo = null;
        break;
      }
      default:
        break;
    }
  }
  post({ kind: "deckOp", id: request.id, op: request.op, deckId, describe, undo });
}

function newDeckId(db: BrowserDb): string {
  const taken = db.prepare("SELECT 1 FROM decks WHERE id = ?");
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let id = "";
    for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
    if (taken.get(id) === undefined) return id;
  }
  throw new Error("could not find a free deck id");
}

/**
 * A card id. Eight base62 characters, the same shape Mochi uses.
 *
 * **Deliberately NOT namespaced**, and an earlier version of this file argued at
 * length for a `local-` prefix to make collision impossible. That was solving a
 * problem Zach does not have and has now said four times: he never imports a
 * single card or deck. The import is WHOLESALE, and after decision 16's one final
 * import no Mochi id ever arrives again. Uniqueness inside this database is the
 * entire requirement, and `cards.id UNIQUE` enforces it — a repeat is a failed
 * insert, not silent corruption.
 *
 * Same shape as Mochi's because uniformity is free here: ids appear in
 * wiki-links, in the search index and in the backup, and one format is one thing
 * to reason about.
 */
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function newCardId(db: BrowserDb): string {
  const taken = db.prepare("SELECT 1 FROM cards WHERE id = ?");
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let id = "";
    for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
    if (taken.get(id) === undefined) return id;
  }
  throw new Error("could not find a free card id in 32 tries, which should be impossible");
}

/**
 * Make a card, and OPEN ITS TRACKS — which is the half that is easy to forget.
 *
 * A card with no `card_tracks` row is invisible to the scheduler forever: it is
 * never due, never new, and never appears in a session. So this opens `forward`
 * always and `reverse` when the deck resolves to it, using the SAME view the
 * importer and the loader use (`card_reverse_resolved`) rather than re-deriving
 * the inheritance walk — a second definition is how two answers start to differ.
 *
 * `due_at` is NULL and `reps` is 0, which is exactly what `newTracks` looks for:
 * the card enters the NEW queue and is subject to decision 12's 10-a-day limit,
 * rather than arriving already overdue.
 */
function createCard(request: CreateCardRequest): void {
  const db = requireCards();
  const deck = db.prepare("SELECT id FROM decks WHERE id = ?").get(request.deckId);
  if (deck === undefined) throw new Error(`no deck ${request.deckId}`);
  if (
    request.templateId !== null &&
    db.prepare("SELECT id FROM templates WHERE id = ?").get(request.templateId) === undefined
  ) {
    throw new Error(`no template ${request.templateId}`);
  }

  const cardId = newCardId(db);
  const tracks: string[] = [];
  db.transaction(() => {
    db.prepare(
      // `local = 1`: schema v9, and the reason is the backup. `src/backup/archive.ts`
      // carries only what `exports/` cannot rebuild, so it archives no cards — right
      // for the 7,716 imported ones and silent loss for this one. Nothing else can
      // tell them apart; a locally-created card is otherwise an ordinary row.
      `INSERT INTO cards (id, deck_id, template_id, name, content, archived, local)
       VALUES (?, ?, ?, ?, '', 0, 1)`,
    ).run(cardId, request.deckId, request.templateId, request.name);

    // The template's PRIMARY field carries the head word on every template here
    // (`name` is its id, and it is what `<<単語>>` / `<<言葉>>` / `<<Kanji>>`
    // resolve to), so the title he typed goes there as well — otherwise the card
    // renders blank and he has to type it twice.
    if (request.templateId !== null && request.name !== "") {
      const primary = db
        .prepare("SELECT id FROM template_fields WHERE template_id = ? AND id = 'name'")
        .get(request.templateId) as { id: string } | undefined;
      if (primary !== undefined) {
        db.prepare(
          "INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, 'name', ?)",
        ).run(cardId, request.name);
      }
    }

    const reverse = db
      .prepare("SELECT reverse FROM card_reverse_resolved WHERE card_id = ?")
      .get(cardId) as { reverse: string } | undefined;
    const kinds = reverse?.reverse === "on" ? ["forward", "reverse"] : ["forward"];
    for (const kind of kinds) {
      db.prepare(
        `INSERT INTO card_tracks
           (card_id, kind, dormant, needs_rereview, due_at, scheduled_days, reps, lapses,
            last_reviewed_at, scheduler, scheduler_state)
         VALUES (?, ?, 0, 0, NULL, NULL, 0, 0, NULL, NULL, NULL)`,
      ).run(cardId, kind);
      tracks.push(kind);
    }
  })();

  // Indexed with its generations from the start, not left on the raw-field
  // fallback — so a card made on the laptop is found the same way an imported one is.
  refreshSearchText(db, [cardId]);
  // The session was built before this card existed, so it will not appear until
  // the next one. Said in the reply rather than silently rebuilt: rebuilding
  // mid-session would reshuffle the queue under him.
  post({
    kind: "createCard",
    id: request.id,
    cardId,
    tracks,
    card: prepareCard({ db, cardId, direction: "forward" }),
  });
}

/**
 * The deck tree with counts. 39 rows, one query, sent once.
 *
 * `due` uses the SAME predicate the queue does — `dormant = 0 AND archived = 0`
 * — so the sidebar cannot disagree with the session about what is waiting. 234
 * archived cards carrying 451 live tracks are excluded from `due` and INCLUDED in
 * `cards`, because archiving means "stop reviewing", not "stop existing".
 */
function decks(request: DecksRequest): void {
  const db = requireCards();
  const rows = db
    .prepare(
      `SELECT dp.deck_id AS id, dp.path AS path, d.parent_id AS parentId,
              d.name AS name, d.archived AS archived,
              (SELECT count(*) FROM cards c WHERE c.deck_id = dp.deck_id) AS cards,
              (SELECT count(*) FROM card_tracks t JOIN cards c2 ON c2.id = t.card_id
                WHERE c2.deck_id = dp.deck_id AND ${liveTrack("t", "c2")}
                  AND t.due_at IS NOT NULL
                  AND ${dueOnOrBefore("t", "date('now','localtime')")}) AS due
         FROM deck_paths dp JOIN decks d ON d.id = dp.deck_id
        ORDER BY dp.path`,
    )
    .all() as {
    id: string;
    path: string;
    cards: number;
    due: number;
    parentId: string | null;
    name: string;
    archived: number;
  }[];
  post({
    kind: "decks",
    id: request.id,
    // EVERY deck now, not just non-empty ones: the sidebar nests (his #2/#5) and
            // a parent with no cards of its own is still a node its children hang from.
    decks: rows.map((row) => ({ ...row, archived: row.archived === 1 })),
    cards: Number((db.prepare("SELECT count(*) AS n FROM cards").get() as { n: number }).n),
    templates: db
      .prepare(
        `SELECT t.id AS id, t.name AS name,
                (SELECT count(*) FROM template_fields f WHERE f.template_id = t.id) AS fields,
                -- The deck holding most of this template's cards: where a NEW card
                -- of it most likely belongs. See TemplateBrief.homeDeckId in protocol.ts.
                (SELECT c.deck_id FROM cards c
                  WHERE c.template_id = t.id AND c.archived = 0
                  GROUP BY c.deck_id ORDER BY count(*) DESC, c.deck_id LIMIT 1) AS homeDeckId
           FROM templates t ORDER BY t.name`,
      )
      .all() as { id: string; name: string; fields: number; homeDeckId: string | null }[],
  });
}

/**
 * Search, or list a deck.
 *
 * The query path is `src/search`, untouched — it already answers the thing that
 * is easy to get wrong here: a 1-2 character query. `card_fts` uses FTS5's
 * trigram tokeniser and CANNOT serve one, and two characters is the commonest
 * search unit in Japanese (意味, する, ない all return 0 from MATCH and 3, 228 and
 * 74 from the ranked scan). It routes and reports which path ran.
 *
 * With no query it depends on WHO ASKED. For the gallery (`suggest` false) it is a
 * deck listing ordered by name — a browse, not a ranking, so imposing a relevance
 * order on it would be a lie. For Ctrl+K and the `@` picker (`suggest` true) the
 * alphabet is not neutral, it is noise, and `suggestCards` answers instead: pinned,
 * then opened here, then recently edited. See `app/recent.ts`.
 */
function browse(request: BrowseRequest): void {
  const db = requireCards();
  const started = performance.now();

  // THE DECK SCOPE IS THE SUBTREE, because the badge beside the deck is a subtree
  // total. It used to be `c.deck_id = ?`, an exact match, so clicking a parent
  // opened a gallery that disagreed with the number he clicked: English showed
  // "1258" and listed 0 cards, 日本語 showed "5947" and listed 3. Every deck with
  // children was affected, which is every deck he actually navigates through.
  const deckScope = scopeToSubtree(db, request.deckId);
  // Both scopes AND together, so a tag tapped inside a deck gallery narrows
  // rather than replaces. Nothing sends both today; writing it as an `and` costs
  // one line and removes the question.
  const tagScope =
    request.tagPath === undefined || request.tagPath === null
      ? { sql: "1 = 1", args: [] as string[] }
      : scopeToTag(request.tagPath);
  const scopeSql = `(${deckScope.sql}) AND (${tagScope.sql})`;
  const scopeArgs = [...deckScope.args, ...tagScope.args];

  if (request.query.trim() === "") {
    const rows = request.suggest
      ? suggestCards(db, {
          scopeSql,
          scopeArgs,
          visited: request.visited,
          limit: request.limit,
        })
      : (db
          .prepare(
            `SELECT c.id AS id, c.name AS name, c.archived AS archived, c.pinned AS pinned,
                    dp.path AS deck
               FROM cards c LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id
              WHERE ${scopeSql}
              ORDER BY c.name LIMIT ?`,
          )
          .all(...scopeArgs, request.limit) as SuggestRow[]);
    const total = Number(
      (
        db
          .prepare(`SELECT count(*) AS n FROM cards c WHERE ${scopeSql}`)
          .get(...scopeArgs) as { n: number }
      ).n,
    );
    post({
      kind: "browse",
      id: request.id,
      hits: rows.map((row) => ({
        cardId: row.id,
        name: row.name,
        deckPath: row.deck ?? "",
        archived: row.archived === 1,
        pinned: row.pinned === 1,
        snippet: null,
      })),
      total,
      mode: null,
      elapsedMs: performance.now() - started,
    });
    return;
  }

  // Scoped IN THE QUERY, not after it. Filtering the page under-reported: the top
  // 300 matches across 7,716 cards can hold almost none from the deck he is in.
  const result = searchCards(db, request.query, {
    limit: request.limit,
    ...(request.deckId === null ? {} : { deckIds: scopeArgs }),
  });
  const deckPaths = new Map(
    (db.prepare("SELECT deck_id, path FROM deck_paths").all() as {
      deck_id: string;
      path: string;
    }[]).map((row) => [row.deck_id, row.path]),
  );
  // No post-filter any more — `searchCards` did the scoping, so `result.total` is the
  // real number of matches INSIDE the deck rather than across the collection.
  const filtered = result.hits;
  // The whole pinned set, not a lookup per hit. `cards_pinned` is a PARTIAL index
  // (`WHERE pinned = 1`) so this reads exactly the pinned rows — and pinning is a
  // hand operation, so the set is the size of his attention, not of the corpus.
  // `searchCards` deliberately does not carry it: pinning is a property of the
  // collection, not of the match.
  const pinnedIds = new Set(
    (db.prepare("SELECT id FROM cards WHERE pinned = 1").all() as { id: string }[]).map(
      (row) => row.id,
    ),
  );
  post({
    kind: "browse",
    id: request.id,
    hits: filtered.map((hit) => ({
      cardId: hit.cardId,
      name: hit.name,
      deckPath: deckPaths.get(hit.deckId) ?? "",
      archived: hit.archived,
      pinned: pinnedIds.has(hit.cardId),
      snippet: hit.snippet?.text ?? null,
    })),
    total: result.total,
    mode: result.mode,
    elapsedMs: result.elapsedMs,
  });
}

/**
 * Field types whose STORED VALUE is the content, and so may be edited.
 *
 * The exclusions are not caution, they are measured: `speech`, `translate` and
 * `ai` have **zero non-empty values across the entire corpus** (10 + 5 + 4 fields,
 * 0 values). Mochi keeps generated output in `component-cache`, addressed by
 * generation identity — the field's own value has always been the empty string.
 * Writing one would change nothing on screen and would put a value somewhere the
 * renderer treats as a marker, so the editor shows them read-only instead.
 *
 *     plain    79,739 fields   79,549 non-empty
 *     accent    7,660           7,660     (derived, but LOCAL — decision 9)
 *     text      7,390           7,377
 *     boolean   1,635           1,611
 *     number       90              90
 *     speech/translate/ai          0      <- these
 */
const EDITABLE_TYPES = new Set(["plain", "text", "boolean", "number", "accent"]);

/**
 * Write one field value.
 *
 * **Validated here rather than trusted from the page**, for the same reason the
 * `Reading` toggle is: the page's field id arrived in a message, and a write that
 * lands on the wrong field destroys data with no error. Two checks, and both have
 * a real case behind them:
 *
 *   1. the field must be DECLARED on this card's own template — otherwise an edit
 *      creates one of the 235 orphan values this corpus already carries, invisible
 *      because nothing renders it;
 *   2. the type must be one whose stored value is the content (see above).
 */
function setField(request: SetFieldRequest): void {
  const db = requireCards();
  const field = db
    .prepare(
      `SELECT tf.id AS id, tf.name AS name, tf.type AS type
         FROM cards c JOIN template_fields tf ON tf.template_id = c.template_id
        WHERE c.id = ? AND tf.id = ?`,
    )
    .get(request.cardId, request.fieldId) as { id: string; name: string; type: string } | undefined;
  if (field === undefined) {
    throw new Error(
      `card ${request.cardId} has no field ${request.fieldId} on its own template. ` +
        `Refusing to write — that would create an orphan value nothing renders.`,
    );
  }
  if (!EDITABLE_TYPES.has(field.type)) {
    throw new Error(
      `${field.name} is a ${field.type} field: its content lives in the generation ` +
        `cache, not in card_field_values, and every such field in this corpus stores ` +
        `the empty string. Refusing to write.`,
    );
  }
  // Read BEFORE the write — this is the whole of what makes an edit undoable, and
  // the page cannot supply it: its copy is whatever it last rendered.
  const before = db
    .prepare("SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?")
    .get(request.cardId, request.fieldId) as { value: string } | undefined;
  const existed = before !== undefined;

  if (request.value === null) {
    // Undoing an edit that CREATED the row: remove it rather than writing "". A
    // present-but-empty value is not the same thing — `<<#field>>` gates on presence.
    db.prepare("DELETE FROM card_field_values WHERE card_id = ? AND field_id = ?").run(
      request.cardId,
      request.fieldId,
    );
  } else {
    db.prepare(
      `INSERT INTO card_field_values (card_id, field_id, value)
       VALUES (?, ?, ?)
       ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value`,
    ).run(request.cardId, request.fieldId, request.value);
  }
  refreshSearchText(db, [request.cardId]);
  post({
    kind: "setField",
    id: request.id,
    cardId: request.cardId,
    fieldId: request.fieldId,
    value: request.value,
    created: !existed,
    previous: before?.value ?? null,
  });
}

/**
 * One card by id, for a preview layer.
 *
 * A missing card is a REPLY, not an error: this corpus carries 8,958 tombstones,
 * so a wiki-link into a card Mochi deleted is expected rather than exceptional and
 * the page should say "that card is gone" rather than fail a boot.
 *
 * Always `forward`. A preview shows every side at once (decision 30), so the
 * direction only permutes an order the reader can see all of anyway — and the
 * AUTHORED order is the one that reads correctly.
 */
/**
 * What moving THIS card to each template would cost.
 *
 * Computed per card rather than per template pair, because the answer depends on
 * which fields the card actually has a value for — a 単語 card with only its head
 * word filled in loses nothing by moving, and one with seven values loses six.
 *
 * Only NON-EMPTY values count. An empty row is not authored text and reporting it
 * as something at risk would inflate every number here.
 */
function templateChoices(db: BrowserDb, cardId: string): TemplateChoice[] {
  const card = db.prepare("SELECT template_id FROM cards WHERE id = ?").get(cardId) as
    | { template_id: string | null }
    | undefined;
  if (card === undefined) return [];

  const held = new Set(
    (
      db
        .prepare("SELECT field_id FROM card_field_values WHERE card_id = ? AND value <> ''")
        .all(cardId) as { field_id: string }[]
    ).map((row) => row.field_id),
  );

  return (
    db
      .prepare(
        `SELECT t.id AS id, t.name AS name,
                (SELECT count(*) FROM template_fields f WHERE f.template_id = t.id) AS fields
           FROM templates t ORDER BY t.name`,
      )
      .all() as { id: string; name: string; fields: number }[]
  ).map((template): TemplateChoice => {
    const theirs = new Set(
      (
        db
          .prepare("SELECT id FROM template_fields WHERE template_id = ?")
          .all(template.id) as { id: string }[]
      ).map((row) => row.id),
    );
    let keeps = 0;
    for (const fieldId of held) if (theirs.has(fieldId)) keeps += 1;
    return {
      templateId: template.id,
      name: template.name,
      fields: Number(template.fields),
      keeps,
      hides: held.size - keeps,
      current: template.id === card.template_id,
    };
  });
}

function preview(request: PreviewRequest): void {
  const db = requireCards();
  const card = prepareCard({ db, cardId: request.cardId, direction: "forward" });
  post({
    kind: "preview",
    id: request.id,
    card,
    deckPath: card?.loaded.deckPath ?? "",
    name: card?.loaded.name ?? request.cardId,
    ...collectionState(db, request.cardId),
    templates: templateChoices(db, request.cardId),
  });
}

/**
 * WHAT LINKS HERE — Zach, 2026-09-14.
 *
 * The rule, the SQL and the measurements are in `src/cards/backlinks.ts`, not
 * here. This file holds no SQL of its own anywhere else and should not start now:
 * a query in the worker is a query `test/` cannot reach, and every reason this
 * one is shaped the way it is (the `DISTINCT`, the self-link, the inner join)
 * is a claim about his corpus that wants measuring rather than asserting.
 */
function backlinks(request: BacklinksRequest): void {
  post({
    kind: "backlinks",
    id: request.id,
    cards: backlinksOf(requireCards(), request.cardId),
  });
}

/** Decision 17's archive. Read-only; the page turns it into a file. */
/**
 * Stage 11, the worker half. Two verbs, and neither knows about the network.
 *
 * `syncExport` reads this device's database into a payload; `syncMerge` applies a
 * peer's. Which device, and how the two met, is the page's business — decision
 * 33 chose a mailbox on the laptop's Vite server, and this file would not change
 * if that choice did.
 */
function syncExport(request: SyncExportRequest): void {
  const db = requireCards();
  const payload = exportSync(db, new Date().toISOString());
  const json = JSON.stringify(payload);
  post({
    kind: "syncExport",
    id: request.id,
    json,
    // UTF-8 bytes, not `.length` — decision 6, name the basis. This payload is
    // mostly Japanese and `.length` counts UTF-16 code units.
    bytes: new TextEncoder().encode(json).length,
  });
}

function syncMerge(request: SyncMergeRequest): void {
  const db = requireCards();
  const before = (
    db.prepare("SELECT count(*) AS n FROM reviews WHERE source = 'local'").get() as {
      n: number;
    }
  ).n;
  // ─── ONE TRANSACTION, AND ITS ABSENCE COST HIM A DAY ───────────────────────
  //
  // `applyLocalArchive`'s own header says it: *"The caller owns the
  // transaction."* `src/backup/cli.ts` opens one and says why — *"a foreign-key
  // surprise must not leave a half restore"* — and this, the OTHER caller, never
  // did. Two consequences, and both were observed rather than reasoned about:
  //
  //   * **A half merge.** Zach, 2026-09-13: *"but i still can't see ojad
  //     field...? both on desktop and mobile"*. His phone's own payload showed
  //     the `ojad` FIELD on 4 templates and all 3,718 VALUES applied, and the
  //     template BODIES not applied — one merge, partly done, left standing.
  //     With no transaction each statement autocommits, so an interrupted merge
  //     keeps whatever it had already written.
  //   * **The speed that interrupts it.** A payload is now 7,566 field values,
  //     7,716 card flags and 244 card-state rows; four peers is ~30,000 upserts,
  //     each its own implicit transaction and its own OPFS flush. Measured in
  //     the browser pane: a single sync ran over SEVEN MINUTES and had still not
  //     pushed. On a phone that is a tab the system is free to suspend, which is
  //     how the half merge above happens in the first place.
  //
  // So the fix is the same line for both faults.
  const report = db.transaction(() => mergeSync(db, request.payload as never))();
  const after = (
    db.prepare("SELECT count(*) AS n FROM reviews WHERE source = 'local'").get() as {
      n: number;
    }
  ).n;
  post({
    kind: "syncMerge",
    id: request.id,
    // Counted from the table rather than taken from the apply report, because
    // "how many of my grades arrived" is the number he would check, and it is
    // the one a bug in the union would move.
    reviewsAdded: after - before,
    flagsTaken: report.flagsTaken,
    trackStateTaken: report.trackStateTaken,
    orphaned: report.flagsOrphaned + report.applied.reviewsOrphaned,
  });
}

/**
 * The text for a card's empty generator slots — see `src/review/text.ts`.
 *
 * Resolution only. This reads `blobs` and writes nothing, and it cannot reach a
 * media element: the page only sends slots whose mount has no `MediaMount`.
 */
function generatedText(request: GeneratedTextRequest): void {
  const db = requireCards();
  const texts = request.slots.map((slot) =>
    resolveDescriptorText(db, {
      kind: slot.kind as never,
      text: slot.text,
      lang: slot.lang,
      voice: slot.voice,
      options: slot.options,
    }),
  );
  post({ kind: "generatedText", id: request.id, texts });
}

/**
 * CACHE A GENERATION THE LAPTOP JUST MADE — Zach, 2026-09-14.
 *
 * `vite.generate.ts` owns the API key and has already written this into
 * `build/hashigo.db`, which is the copy that survives a seed rebuild. This is the
 * device's own copy, so the card is still filled the next time he opens it.
 *
 * IT NEVER GENERATES AND NEVER FETCHES. It is handed finished text and files it
 * under the identity `resolveDescriptorText` will look it up by —
 * `storeDescriptorText` derives that identity itself rather than taking one, so
 * the round trip is closed by construction. A non-text kind throws there; this
 * reports the throw as `hash: null` rather than failing the request, because a
 * cache that could not write is not a reason to lose the text already on screen.
 */
function storeGeneration(request: StoreGenerationRequest): void {
  const db = requireCards();
  let hash: string | null = null;
  try {
    hash = storeDescriptorText(
      db,
      {
        kind: request.slot.kind as never,
        text: request.slot.text,
        lang: request.slot.lang,
        voice: request.slot.voice,
        options: request.slot.options,
      },
      request.text,
    );
  } catch (cause) {
    log(`could not cache the generation: ${(cause as Error).message}`, "bad");
  }
  // The card this was filled FROM, when the page says. A generation is keyed by
  // its own text and not owned by a card, but a fill made from the review screen
  // has one in front of it — so its sentence is searchable at once, not at the
  // next rebuild.
  if (hash !== null && request.cardId !== undefined) refreshSearchText(db, [request.cardId]);
  post({ kind: "storeGeneration", id: request.id, hash });
}

/**
 * CACHE A CLIP THE LAPTOP JUST MADE — Zach, 2026-09-15.
 *
 * The sibling of `storeGeneration`, and the differences are all consequences of
 * audio not being text. The bytes arrive base64 (they crossed HTTP that way and
 * decoding once here keeps them off the page), and they go to the PAYLOAD store
 * rather than inline into `blobs.bytes` — two handles, which this worker already
 * holds and the page never will.
 *
 * IT NEVER SYNTHESISES AND NEVER FETCHES. `vite.generate.ts` owns the Google key
 * and has already written this into `build/hashigo.db`, the copy that survives a
 * seed rebuild. A failure to cache is logged rather than thrown: the clip is
 * already playing from the response he asked for, and losing it at the next boot
 * is a smaller harm than failing the request he can see.
 */
function storeClip(request: StoreClipRequest): void {
  const db = requireCards();
  let hash: string | null = null;
  try {
    if (store === null) throw new Error("no payload store — send `open` first");
    const binary = atob(request.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    hash = storeGeneratedSpeech(db, store, request.slot, bytes);
  } catch (cause) {
    log(`could not cache the clip: ${(cause as Error).message}`, "bad");
  }
  post({ kind: "storeClip", id: request.id, hash });
}

function backup(request: BackupRequest): void {
  const db = requireCards();
  const archive = exportLocalArchive(db, new Date().toISOString());
  const json = `${JSON.stringify(archive, null, 1)}\n`;
  post({
    kind: "backup",
    id: request.id,
    json,
    // UTF-8 bytes, not `json.length`: `.length` counts UTF-16 code units and
    // under-reports this mostly-Japanese archive by 15,402 on the real corpus.
    // Decision 6 — name the basis.
    bytes: new TextEncoder().encode(json).length,
    counts: archive.counts,
  });
}

/**
 * His #12, read side. Every `settings` row, what the session will resolve them to,
 * and the three things he would open a settings screen to check that are not rows.
 *
 * ─── THE AUDIO NUMBER IS MEASURED, NOT REMEMBERED ───────────────────────────
 *
 * `scripts/app-bootstrap.ts` prints a coverage figure when it builds the subset
 * ("5,607 of 5,708 cards with speech can play something"), and quoting that here
 * would be quoting a build-time constant as a device fact. The subset is bounded by
 * `--speech-bytes`, the store is a SEPARATE database in the same pool, and a
 * re-import replaces it — so the honest answer is a join across the two, now.
 *
 * It is two queries and a set rather than one join because the card database and
 * the payload store cannot see each other: they are two files in one pool, opened
 * as two handles. That is the same boundary `app-bootstrap` crosses in Node.
 */
async function settings(request: SettingsRequest): Promise<void> {
  const db = requireCards();
  if (payloads === null) throw new Error("no payload store — send `open` first");

  const values: Record<string, string> = {};
  for (const row of db.prepare("SELECT key, value FROM settings ORDER BY key").all() as {
    key: string;
    value: string;
  }[]) {
    values[row.key] = row.value;
  }
  const resolved = readSessionSettings(db);

  const held = new Set(
    (payloads.prepare("SELECT hash FROM blob_payloads").all() as { hash: string }[]).map(
      (row) => row.hash,
    ),
  );
  const speech = db
    .prepare(
      `SELECT r.card_id AS card, b.hash AS hash
         FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash
        WHERE b.kind = 'speech'`,
    )
    .all() as { card: string; hash: string }[];
  const wanting = new Set<string>();
  const playable = new Set<string>();
  for (const row of speech) {
    wanting.add(row.card);
    if (held.has(row.hash)) playable.add(row.card);
  }

  // `persisted()` is READABLE in a worker even though `persist()` is not — the
  // grant has to be asked for by the page (see this file's header), but the answer
  // can be read here. `estimate()` is likewise fine.
  let persisted = false;
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    persisted = await navigator.storage.persisted();
    const estimate = await navigator.storage.estimate();
    usageBytes = estimate.usage ?? null;
    quotaBytes = estimate.quota ?? null;
  } catch {
    /* a browser that refuses to say leaves the screen saying "unknown" */
  }

  post({
    kind: "settings",
    id: request.id,
    values,
    resolved: {
      newLimit: resolved.newLimit,
      interleave: resolved.interleave,
      rejected: resolved.rejected,
    },
    storage: { persisted, usageBytes, quotaBytes },
    audio: {
      cardsWithSpeech: wanting.size,
      cardsThatCanPlay: playable.size,
      payloads: held.size,
    },
    schemaVersion: schemaVersion(db),
    sqliteVersion: await sqliteVersion(),
    localReviews: Number(
      (
        db.prepare("SELECT count(*) AS n FROM reviews WHERE source = 'local'").get() as {
          n: number;
        }
      ).n,
    ),
  });
}

/**
 * Write one setting.
 *
 * **It does NOT rebuild the session, and that is the decision.** `new.limit` and
 * `session.interleave` are read by `buildSession`, which runs once per `open`;
 * rebuilding here would reshuffle the plan underneath a card he is halfway through
 * — the same reason `createCard` says a new card does not appear until the next
 * session. The page says "takes effect next session" rather than pretending.
 *
 * `target_retention.default` is different and needs no rebuild at all: it is read
 * per card at grade time through `deck_target_retention_resolved`, so it applies to
 * the very next grade.
 */
function setSetting(request: SetSettingRequest): void {
  const db = requireCards();
  const previous = writeSetting(db, request.key, request.value);
  post({
    kind: "setSetting",
    id: request.id,
    key: request.key,
    value: request.value,
    previous,
    describe:
      previous === null
        ? `set ${request.key} to ${request.value}`
        : `${request.key}: ${previous} → ${request.value}`,
  });
}


// ─── his #11: templates and their fields ────────────────────────────────────

/**
 * One template, everything the editor needs to make an informed change.
 *
 * The three derived numbers per field are the point. Each one answers a question
 * the editor would otherwise have to ask him:
 *
 *   `values`      how many cards carry a value for it. `card_field_values` is
 *                 deliberately NOT foreign-keyed to `template_fields` — a value
 *                 must survive its field being deleted (schema.sql says losing four
 *                 years of authored text is worse than an orphan row) — so a delete
 *                 hides text rather than destroying it, and the count is how much.
 *   `references`  how many `<<Field>>` tokens in the body name it. A rename rewrites
 *                 exactly these, and 0 means the field renders nowhere.
 *   `dependents`  fields whose `source_field_id` is this one. The composite FK is
 *                 ON DELETE SET NULL, so deleting a source SILENTLY unbinds every
 *                 generator that fed on it. That is refused, not warned about.
 */
function templateDetail(db: BrowserDb, templateId: string): TemplateDetail | null {
  const row = db.prepare("SELECT id, name, content FROM templates WHERE id = ?").get(templateId) as
    | { id: string; name: string; content: string }
    | undefined;
  if (row === undefined) return null;

  const fields = db
    .prepare(
      `SELECT f.id AS id, f.name AS name, f.type AS type, f.source_field_id AS source,
              f.options AS options, f.pos AS pos, f.local AS local,
              (SELECT count(*) FROM card_field_values v
                WHERE v.field_id = f.id
                  AND v.card_id IN (SELECT id FROM cards WHERE template_id = f.template_id)
                  AND v.value <> '') AS values_
         FROM template_fields f
        WHERE f.template_id = ?
        ORDER BY f.pos, f.id`,
    )
    .all(templateId) as {
    id: string;
    name: string;
    type: string;
    source: string | null;
    options: string;
    pos: string;
    local: number;
    values_: number;
  }[];

  // BOTH kinds of dependency. The column is one of them; the other lives inside
  // an `ai` field's prompt, which names its input BY NAME (`src/generate/fields.ts`
  // substitutes `<<Field>>` markers there). Building this from the column alone is
  // why the editor never said that `単語` feeds `例文` — and `schema.sql` calls that
  // out as the reason `source_field_id` is legitimately NULL on four fields.
  const byName = new Map(fields.map((field) => [field.name.trim(), field.id]));
  const dependentsOf = new Map<string, string[]>();
  const dependsOn = (targetId: string, consumer: string): void => {
    const list = dependentsOf.get(targetId) ?? [];
    if (!list.includes(consumer)) list.push(consumer);
    dependentsOf.set(targetId, list);
  };
  for (const field of fields) {
    if (field.source !== null) dependsOn(field.source, field.name);
    const prompt = decodeFieldOptions(field.options)["ai-custom-prompt"];
    if (typeof prompt !== "string") continue;
    for (const name of promptDependencies(prompt)) {
      const targetId = byName.get(name.trim());
      // A marker naming no field of this template resolves to nothing — silently,
      // which is the trap this whole line of work exists to surface. It is shown
      // by the body's own unknown-marker check, not invented as a dependency here.
      if (targetId !== undefined && targetId !== field.id) dependsOn(targetId, field.name);
    }
  }

  const sidesOf = sideIndex(row.content);

  return {
    id: row.id,
    name: row.name,
    content: row.content,
    cards: Number(
      (
        db.prepare("SELECT count(*) AS n FROM cards WHERE template_id = ?").get(templateId) as {
          n: number;
        }
      ).n,
    ),
    fields: fields.map(
      (field): TemplateFieldRow => ({
        id: field.id,
        name: field.name,
        type: field.type,
        sourceFieldId: field.source,
        options: field.options,
        pos: field.pos,
        local: field.local === 1,
        values: Number(field.values_),
        references: countReferences(row.content, field.name),
        sides: sidesOf.get(field.name.trim()) ?? [],
        dependents: dependentsOf.get(field.id) ?? [],
      }),
    ),
  };
}

/** Every card on a template, re-indexed. After a change that moves resolved text. */
function refreshTemplateSearch(db: BrowserDb, templateId: string): void {
  const ids = (db.prepare("SELECT id FROM cards WHERE template_id = ?").all(templateId) as {
    id: string;
  }[]).map((row) => row.id);
  refreshSearchText(db, ids);
}

/**
 * A voice override on a card or a deck, priced and optionally written. See
 * `VoiceRequest` in `./protocol.ts`.
 *
 * `after` is MEASURED, not predicted: the write is made inside a savepoint, every
 * covered card's resolved voice is read back through `card_voice_resolved`, and
 * the savepoint is rolled back. So clearing a deck's override is priced as
 * whatever its parent then supplies, which is the inheritance rule the view owns
 * and this does not re-implement.
 */
function voiceOp(request: VoiceRequest): void {
  const db = requireCards();
  if (request.voice !== null && !isCatalogueVoice(request.voice)) {
    throw new Error(
      `${request.voice} is not a voice this project can speak with — an override exists to make new clips`,
    );
  }
  const table = request.target === "card" ? "cards" : "decks";
  const row = db.prepare(`SELECT name, voice FROM ${table} WHERE id = ?`).get(request.targetId) as
    | { name: string; voice: string | null }
    | undefined;
  if (row === undefined) throw new Error(`no ${request.target} ${request.targetId}`);
  const previous = row.voice === null || row.voice.trim() === "" ? null : row.voice;

  let cardIds: string[];
  if (request.target === "card") {
    cardIds = [request.targetId];
  } else {
    const decks = subtreeDeckIds(db, request.targetId);
    const read = db.prepare("SELECT id FROM cards WHERE deck_id = ? ORDER BY id");
    cardIds = decks.flatMap((deckId) => (read.all(deckId) as { id: string }[]).map((r) => r.id));
  }

  const write = (): void => {
    db.prepare(
      `UPDATE ${table} SET voice = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(request.voice, request.targetId);
  };
  const before = resolvedVoices(db, cardIds);
  db.exec("SAVEPOINT voice_price");
  let after: Map<string, string | null>;
  try {
    write();
    after = resolvedVoices(db, cardIds);
  } finally {
    db.exec("ROLLBACK TO voice_price");
    db.exec("RELEASE voice_price");
  }
  const price = priceVoiceChange(
    db,
    cardIds,
    (id) => before.get(id) ?? null,
    (id) => after.get(id) ?? null,
  );
  if (!request.dry) write();

  const what = request.target === "card" ? `card ${row.name}` : `deck ${row.name}`;
  post({
    kind: "voice",
    id: request.id,
    target: request.target,
    targetId: request.targetId,
    voice: request.voice,
    previous,
    price,
    lines: describeVoicePrice(price, request.voice),
    describe:
      request.voice === null
        ? `${what} inherits its voice again`
        : `${what} now speaks new clips in ${request.voice}`,
  });
}

/** What a proposed field change costs. Writes nothing — see `app/field-ops.ts`. */
function priceField(request: PriceFieldRequest): void {
  const db = requireCards();
  const started = performance.now();
  const price = priceFieldChange(db, request.templateId, request.fieldId, {
    ...(request.options === undefined ? {} : { options: request.options }),
    ...(request.sourceFieldId === undefined ? {} : { sourceFieldId: request.sourceFieldId }),
  });
  post({
    kind: "priceField",
    id: request.id,
    price,
    lines: describePrice(price),
    ms: Math.round(performance.now() - started),
  });
}

function template(request: TemplateRequest): void {
  post({
    kind: "template",
    id: request.id,
    template: templateDetail(requireCards(), request.templateId),
  });
}

/** A field id that cannot collide with Mochi's, and says where it came from. */
function newFieldId(db: BrowserDb, templateId: string): string {
  const taken = db.prepare("SELECT 1 FROM template_fields WHERE template_id = ? AND id = ?");
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let id = "local-";
    for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
    if (taken.get(templateId, id) === undefined) return id;
  }
  throw new Error("could not mint a field id in 32 attempts");
}

/**
 * Every template and field edit, each one atomic and each one undoable.
 *
 * ─── WHAT THIS DELIBERATELY REFUSES ─────────────────────────────────────────
 *
 * **Changing a field's TYPE.** `template_fields.type` decides how the resolver
 * reads a value and how the renderer draws it, and the stored text does not
 * change with it: a `boolean` holds `"true"`, a `number` holds digits, and a
 * `speech` field's value has always been EMPTY because Mochi keeps generated output
 * in `component-cache` addressed by generation identity (measured: 19 generated
 * fields, zero non-empty values). Flipping a type reinterprets every existing value
 * at once, which is a migration and not a form control. Add a field and move the
 * values if that is what he wants — that is a decision with a diff.
 *
 * **Deleting a field another field generates from.** The composite foreign key is
 * ON DELETE SET NULL, so it would succeed and quietly leave `Speech` with no input.
 *
 * **Settings and inputs ARE writable, since stage C** — `setFieldOptions` and
 * `setFieldSource`, checked by `app/field-ops.ts` (only editable declared keys,
 * no loops) and priced by the page before it asks.
 *
 * ─── AND WHAT IT ALLOWS THAT LOOKS RISKIER THAN IT IS ───────────────────────
 *
 * Deleting a field does not delete its values, by schema design. So a delete is
 * recoverable: `restoreField` puts the row back and the values are still under it.
 * That is why delete here has an undo and card `delete` does not.
 */
function templateOp(request: TemplateOpRequest): void {
  const db = requireCards();
  const before = templateDetail(db, request.templateId);
  if (before === null) throw new Error(`no template ${request.templateId}`);

  let describe = "";
  let undo: TemplateOpMessage["undo"] = null;

  const field = (id: string): TemplateFieldRow => {
    const found = before.fields.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`no field ${id} on ${before.name}`);
    return found;
  };

  /**
   * ─── ONE FIELD IS LOAD-BEARING BY NAME, IN CODE ─────────────────────────────
   *
   * Found by running this editor rather than by reading it. `src/review/mode.ts`
   * decides decision 29's two modes with `READING_FIELD = "Reading"` — a NAME
   * comparison, against a field that must also be `boolean`. So renaming or
   * removing it on an accent-drill template does not break a render; it flips all
   * **692** `produce` cards to `identify`, which means autoplay on entry and the
   * accent given away before he has produced it. That is the exact defect decision
   * 29 exists to prevent, arriving from a text box, with no error anywhere.
   *
   * The body rewrite makes it MORE dangerous, not less: `<<#Reading>>` follows the
   * rename perfectly, so the template still renders and only the mode is wrong.
   *
   * Refused rather than warned. Making it work needs a code change (the constant),
   * and a UI that lets him do half of a two-part change is a UI that breaks the
   * app on his behalf. Scoped to templates that actually run the drill, so 漢字 —
   * which declares a PLAIN field called `Reading` holding コウ / ショウ on 1,662
   * cards — is untouched, and so is any template of his own.
   */
  const guardReadingField = (target: TemplateFieldRow, verb: string): void => {
    const drills = before.fields.some((entry) => entry.type === ACCENT_FIELD_TYPE);
    if (!drills) return;
    if (target.name.trim() !== READING_FIELD || target.type !== "boolean") return;
    throw new Error(
      `${verb} ${READING_FIELD} on ${before.name} would silently change what these ` +
        `cards DRILL. src/review/mode.ts finds it by name and type to choose ` +
        `decision 29's two modes, so the cards would still render and every ` +
        `produce card would start autoplaying its answer instead. Changing this ` +
        `needs the code constant changed with it.`,
    );
  };

  switch (request.op) {
    case "rename": {
      const name = (request.name ?? "").trim();
      if (name === "") throw new Error("a template needs a name");
      db.prepare("UPDATE templates SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(name, before.id);
      describe = `renamed template ${before.name} to ${name}`;
      undo = { op: "rename", templateId: before.id, name: before.name };
      break;
    }

    case "body": {
      const content = request.content ?? "";
      // NO PARSE CHECK, and that is deliberate rather than an omission. `parseTemplate`
      // accepts essentially any text — an unknown `<<X>>` resolves to nothing and a
      // stray `---` makes a side — so "does it parse" would pass everything and read
      // as a validation that happened. What the editor shows instead is which field
      // names the new body references and which of them do not exist, which is the
      // question a body edit can actually get wrong.
      db.prepare("UPDATE templates SET content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(content, before.id);
      describe = `edited ${before.name}'s body (${before.cards.toLocaleString()} cards render it)`;
      undo = { op: "body", templateId: before.id, content: before.content };
      break;
    }

    case "addField": {
      const name = (request.name ?? "").trim();
      const type = request.fieldType ?? "plain";
      if (name === "") throw new Error("a field needs a name");
      if (before.fields.some((entry) => entry.name === name)) {
        // The resolver binds by name and takes the FIRST match, so a duplicate name
        // makes the second field unreachable rather than ambiguous.
        throw new Error(`${before.name} already has a field called ${name}`);
      }
      if (!(FIELD_TYPES as readonly string[]).includes(type)) {
        throw new Error(`${type} is not a field type`);
      }
      const id = newFieldId(db, before.id);
      const keys = positionKeys(before.fields.length + 1);
      db.transaction(() => {
        db.prepare(
          // `local = 1` is decision 9, and it is not cosmetic: `pruneFieldValues`
          // deletes any `card_field_values` row the export does not carry, which is
          // right for a field Mochi DELETED and catastrophic for one Mochi never
          // had. Without it a re-import silently threw away 3,454 型 labels.
          `INSERT INTO template_fields (template_id, id, name, type, source_field_id,
                                        options, pos, local)
           VALUES (?, ?, ?, ?, NULL, '{}', ?, 1)`,
        ).run(before.id, id, name, type, keys[before.fields.length]);
        renumber(db, before.id, [...before.fields.map((entry) => entry.id), id]);
      })();
      describe = `added ${name} (${type}) to ${before.name} — put <<${name}>> in the body to show it`;
      undo = { op: "deleteField", templateId: before.id, fieldId: id };
      break;
    }

    case "renameField": {
      const target = field(request.fieldId ?? "");
      const name = (request.name ?? "").trim();
      if (name === "") throw new Error("a field needs a name");
      if (name !== target.name) guardReadingField(target, "renaming");
      if (name !== target.name && before.fields.some((entry) => entry.name === name)) {
        throw new Error(`${before.name} already has a field called ${name}`);
      }
      // THE BODY AND THE PROMPTS GO WITH IT, IN ONE TRANSACTION. See this file's
      // header and `src/template/rename.ts`: the resolver binds by name, so leaving
      // the body alone unbinds every marker silently.
      const rewritten = renameFieldEverywhere(
        before.content,
        before.fields.map((entry) => ({ fieldId: entry.id, options: entry.options })),
        target.name,
        name,
      );
      db.transaction(() => {
        db.prepare(
          "UPDATE template_fields SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE template_id = ? AND id = ?",
        ).run(name, before.id, target.id);
        db.prepare("UPDATE templates SET content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(rewritten.body, before.id);
        for (const entry of rewritten.options) {
          db.prepare(
            "UPDATE template_fields SET options = ? WHERE template_id = ? AND id = ?",
          ).run(entry.options, before.id, entry.fieldId);
        }
      })();
      describe =
        `renamed ${target.name} to ${name}` +
        (rewritten.rewrites === 0
          ? " — nothing referenced it"
          : ` and rewrote ${rewritten.rewrites} reference(s)`);
      undo = { op: "renameField", templateId: before.id, fieldId: target.id, name: target.name };
      break;
    }

    case "deleteField": {
      const target = field(request.fieldId ?? "");
      guardReadingField(target, "removing");
      if (target.dependents.length > 0) {
        throw new Error(
          `${target.name} is the source for ${target.dependents.join(", ")}. The foreign ` +
            `key is ON DELETE SET NULL, so deleting it would succeed and leave those ` +
            `generators with no input — silently. Repoint them first.`,
        );
      }
      db.transaction(() => {
        db.prepare("DELETE FROM template_fields WHERE template_id = ? AND id = ?").run(
          before.id,
          target.id,
        );
        renumber(
          db,
          before.id,
          before.fields.filter((entry) => entry.id !== target.id).map((entry) => entry.id),
        );
      })();
      describe =
        `removed ${target.name} from ${before.name}` +
        (target.values === 0
          ? ""
          : ` — its ${target.values.toLocaleString()} value(s) are KEPT and come back if you undo`);
      undo = { op: "restoreField", templateId: before.id, field: target };
      break;
    }

    case "restoreField": {
      const row = request.field;
      if (row === undefined) throw new Error("restoreField needs the field it is restoring");
      db.transaction(() => {
        db.prepare(
          `INSERT INTO template_fields (template_id, id, name, type, source_field_id,
                                        options, pos, local)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          before.id,
          row.id,
          row.name,
          row.type,
          row.sourceFieldId,
          row.options,
          row.pos,
          row.local ? 1 : 0,
        );
      })();
      describe = `restored ${row.name} to ${before.name}`;
      undo = { op: "deleteField", templateId: before.id, fieldId: row.id };
      break;
    }

    case "setFieldOptions": {
      const target = field(request.fieldId ?? "");
      const options = request.options ?? "";
      const refusal = optionsRefusal(target.type, target.options, options);
      if (refusal !== null) throw new Error(refusal);
      if (options === target.options) throw new Error(`${target.name}'s settings did not change`);
      const fields = templateFields(db, before.id);
      db.transaction(() => {
        writeFieldOptions(db, before.id, target.id, options);
        // `search_text` holds resolved ai/translate text, so re-addressing one of
        // those changes what these cards are found by.
        if (searchReach(fields, target.id)) refreshTemplateSearch(db, before.id);
      })();
      describe = `changed ${target.name}'s settings on ${before.name}`;
      undo = { op: "setFieldOptions", templateId: before.id, fieldId: target.id, options: target.options };
      break;
    }

    case "setFieldSource": {
      const target = field(request.fieldId ?? "");
      const sourceId = request.sourceFieldId ?? null;
      const fields = templateFields(db, before.id);
      const refusal = sourceRefusal(fields, target.id, sourceId);
      if (refusal !== null) throw new Error(refusal);
      if (sourceId === target.sourceFieldId) throw new Error(`${target.name} already reads from that`);
      db.transaction(() => {
        writeFieldSource(db, before.id, target.id, sourceId);
        if (searchReach(fields, target.id)) refreshTemplateSearch(db, before.id);
      })();
      const nameOf = (id: string | null): string =>
        id === null ? "nothing" : (before.fields.find((entry) => entry.id === id)?.name ?? id);
      describe = `${target.name} now reads from ${nameOf(sourceId)} (was ${nameOf(target.sourceFieldId)})`;
      undo = {
        op: "setFieldSource",
        templateId: before.id,
        fieldId: target.id,
        sourceFieldId: target.sourceFieldId,
      };
      break;
    }

    case "orderFields": {
      const order = request.order ?? [];
      const known = new Set(before.fields.map((entry) => entry.id));
      if (order.length !== known.size || order.some((id) => !known.has(id))) {
        // A partial order would renumber some rows and leave others, which sorts
        // into an arrangement nobody asked for. Refuse rather than approximate.
        throw new Error(
          `the order must name all ${known.size} field(s) of ${before.name}, once each`,
        );
      }
      db.transaction(() => {
        renumber(db, before.id, order);
      })();
      describe = `reordered ${before.name}'s fields`;
      undo = {
        op: "orderFields",
        templateId: before.id,
        order: before.fields.map((entry) => entry.id),
      };
      break;
    }
  }

  post({
    kind: "templateOp",
    id: request.id,
    op: request.op,
    describe,
    template: templateDetail(db, request.templateId),
    undo,
  });
}

/**
 * Rewrite every `pos` in a template from an explicit order.
 *
 * The whole template, not one row: `src/schema/order.ts` explains why renumbering
 * beats a fractional insert for 11 rows edited from one screen. The caller owns the
 * transaction — a half-renumbered template sorts into an arrangement nobody chose.
 */
function renumber(db: BrowserDb, templateId: string, order: readonly string[]): void {
  const keys = positionKeys(order.length);
  // The clock moves only on rows whose position actually changed — decision 33's
  // field merge is whole-row LWW, and bumping every row on a reorder would let a
  // move on one device take back a setting edited on the other.
  const update = db.prepare(
    `UPDATE template_fields SET pos = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE template_id = ? AND id = ? AND pos IS NOT ?`,
  );
  order.forEach((fieldId, index) => {
    update.run(keys[index], templateId, fieldId, keys[index]);
  });
}

/**
 * His #1. The whole dashboard, computed here and handed over as one string.
 *
 * ─── WHY THIS IS NOT STREAMED, PAGED, OR CACHED ─────────────────────────────
 *
 * It is one pass over 103,110 reviews and it produces a document with no script in
 * it, so there is nothing to stream INTO and nothing to update afterwards. The
 * elapsed time comes back with it rather than being guessed at: if it turns out to
 * cost more than a card mount on his handset, that is a measurement to act on, not
 * a reason to build a cache before anyone has felt it slow.
 *
 * `source` says where the numbers came from, because the standalone file names a
 * path and this one cannot — the database is a slot in an OPFS pool.
 */
/**
 * The daily numbers. Every query here is bounded by a date window or an index —
 * see `src/dashboard/glance.ts`, which also records why the full report's "obvious"
 * optimisation was measured and found to be five times SLOWER.
 */
function glance(request: GlanceRequest): void {
  const started = performance.now();
  const result = collectGlance(requireCards());
  post({
    kind: "glance",
    id: request.id,
    glance: result,
    elapsedMs: performance.now() - started,
  });
}

function dashboard(request: DashboardRequest): void {
  const db = requireCards();
  const started = performance.now();
  const data = collect(db, { source: "OPFS · this device" });
  const html = renderDashboard(data, { locale: request.locale === "ja" ? "ja" : "en" });
  post({
    kind: "dashboard",
    id: request.id,
    html,
    bytes: new TextEncoder().encode(html).length,
    elapsedMs: performance.now() - started,
  });
}

self.onmessage = (event: MessageEvent<AppRequest>): void => {
  const request = event.data;
  void (async () => {
    try {
      switch (request.kind) {
        case "open":
          await open(request);
          break;
        case "next":
          next(request);
          break;
        case "payload":
          await payload(request);
          break;
        case "answer":
          answer(request);
          break;
        case "reading":
          setReading(request);
          break;
        case "backup":
          backup(request);
          break;
        case "generatedText":
          generatedText(request);
          break;
        case "syncExport":
          syncExport(request);
          break;
        case "syncMerge":
          syncMerge(request);
          break;
        case "preview":
          preview(request);
          break;
        case "backlinks":
          backlinks(request);
          break;
        case "storeGeneration":
          storeGeneration(request);
          break;
        case "storeClip":
          storeClip(request);
          break;
        case "setField":
          setField(request);
          break;
        case "glance":
          glance(request);
          break;
        case "dashboard":
          dashboard(request);
          break;
        case "template":
          template(request);
          break;
        case "templateOp":
          templateOp(request);
          break;
        case "priceField":
          priceField(request);
          break;
        case "voice":
          voiceOp(request);
          break;
        case "settings":
          await settings(request);
          break;
        case "setSetting":
          setSetting(request);
          break;
        case "decks":
          decks(request);
          break;
        case "ungrade":
          ungrade(request);
          break;
        case "browse":
          browse(request);
          break;
        case "createCard":
          createCard(request);
          break;
        case "cardOp":
          cardOp(request);
          break;
        case "deckOp":
          deckOp(request);
          break;
        case "reset":
          await reset(request);
          break;
      }
    } catch (cause) {
      const error = cause as Error;
      post({
        kind: "error",
        id: request.id,
        message: error.message ?? String(cause),
        stack: error.stack ?? null,
      });
    }
  })();
};
