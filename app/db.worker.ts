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
import {
  databaseFilesInOpfs,
  importDatabaseBrowser,
  installPool,
  openDatabaseBrowser,
  schemaVersion,
  sqliteVersion,
  type BrowserDb,
} from "../src/db/browser.js";
import { cardAudioResolver } from "../src/cards/index.js";
import { directionForTrackKind } from "../src/cards/index.js";
import { prepareCard } from "../src/review/index.js";
import { buildSession, type ReviewSession } from "../src/session/index.js";

import type {
  AnswerRequest,
  ResetRequest,
  AppMessage,
  AppRequest,
  BackupRequest,
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

/** Served by `vite.app.config.ts` middleware from `build/app/`. */
const CARD_URL = "/hashigo-app.db";
const STORE_URL = "/hashigo-app-blobs.db";

let cards: BrowserDb | null = null;
let payloads: BrowserDb | null = null;
let store: SqliteBlobStore | null = null;
let session: ReviewSession | null = null;

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
async function ensureFile(
  name: string,
  url: string,
  reimport: boolean,
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
  const bytes = new Uint8Array(await response.arrayBuffer());
  // The SQLite header is 16 bytes of magic; anything else here is an HTML error
  // page with a 200, which `importDb` reports as an unhelpful malformed-database.
  const magic = new TextDecoder("ascii").decode(bytes.subarray(0, 15));
  if (magic !== "SQLite format 3") {
    throw new Error(
      `${url} returned ${bytes.length} bytes that are not a SQLite file ` +
        `(header ${JSON.stringify(magic)}). A dev server 200 with an HTML body ` +
        `looks exactly like this.`,
    );
  }
  const written = await importDatabaseBrowser(name, bytes);
  log(`  imported ${written.toLocaleString()} bytes into ${name}`, "good");
  return written;
}

async function open(request: OpenRequest): Promise<void> {
  log(`sqlite ${await sqliteVersion()}`);
  await installPool();
  log(`pool holds ${JSON.stringify(await databaseFilesInOpfs())}`);

  // Asked BEFORE either fetch, because `ensureFile` is what changes the answer.
  const cardsWerePresent = (await databaseFilesInOpfs()).includes(CARD_DB);
  const imported =
    (await ensureFile(CARD_DB, CARD_URL, request.reimport)) +
    (await ensureFile(STORE_DB, STORE_URL, request.reimport));

  // `applySchema: false` on both: these arrive fully formed. An empty pool plus a
  // failed fetch must NOT quietly create a blank database and call it success.
  cards ??= await openDatabaseBrowser({ filename: CARD_DB, applySchema: false });
  payloads ??= await openDatabaseBrowser({ filename: STORE_DB, applySchema: false });
  store ??= new SqliteBlobStore(payloads, { create: false });

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

function next(request: NextRequest): void {
  const active = requireSession();
  const db = requireCards();
  const item = active.current();
  if (item === null) {
    post({
      kind: "card",
      id: request.id,
      card: null,
      deckPath: "",
      isNew: false,
      reask: false,
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
  const result = active.answer(request.remembered, {
    ...(request.durationMs === null ? {} : { durationMs: request.durationMs }),
  });
  const writeMs = performance.now() - started;
  post({
    kind: "answered",
    id: request.id,
    graded: result.graded,
    queuedReask: result.queuedReask,
    dueAt: result.review?.dueAt ?? null,
    scheduledDays: result.review?.intervalDays ?? null,
    progress: active.progress(),
    writeMs,
    openStatements: requireCards().openStatements,
    cachedStatements: requireCards().cachedStatements,
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

/** Decision 17's archive. Read-only; the page turns it into a file. */
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
