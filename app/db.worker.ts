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
import { searchCards } from "../src/search/index.js";

import type {
  AnswerRequest,
  BrowseRequest,
  CardOpRequest,
  CreateCardRequest,
  DeckOpRequest,
  DecksRequest,
  PreviewRequest,
  SetFieldRequest,
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
  const card = db.prepare("SELECT id, name, deck_id, template_id, archived FROM cards WHERE id = ?").get(
    request.cardId,
  ) as
    | { id: string; name: string; deck_id: string; template_id: string | null; archived: number }
    | undefined;
  if (card === undefined) throw new Error(`no card ${request.cardId}`);

  const name = card.name === "" ? card.id : card.name;
  let resultCardId = card.id;
  let undo: { op: "archive" | "unarchive" | "delete" | "duplicate"; cardId: string } | null = null;
  let describe = "";

  switch (request.op) {
    case "archive":
      db.prepare("UPDATE cards SET archived = 1 WHERE id = ?").run(card.id);
      undo = { op: "unarchive", cardId: card.id };
      describe = `archived ${name}`;
      break;
    case "unarchive":
      db.prepare("UPDATE cards SET archived = 0 WHERE id = ?").run(card.id);
      undo = { op: "archive", cardId: card.id };
      describe = `unarchived ${name}`;
      break;
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
            `INSERT INTO cards (id, deck_id, template_id, name, content, archived)
             SELECT ?, deck_id, template_id, name, content, 0 FROM cards WHERE id = ?`,
          ).run(copyId, card.id);
          db.prepare(
            `INSERT INTO card_field_values (card_id, field_id, value)
             SELECT ?, field_id, value FROM card_field_values WHERE card_id = ?`,
          ).run(copyId, card.id);
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
  post({ kind: "cardOp", id: request.id, op: request.op, cardId: card.id, resultCardId, undo, describe });
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
  let undo: { op: "archive" | "unarchive" | "rename" | "create" | "delete"; deckId: string; name?: string } | null =
    null;
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
        // The deck AND its cards. The queue filters on the card, so marking only
        // the deck would archive nothing he can see — two predicates that
        // disagree is worse than one that is blunt.
        db.transaction(() => {
          db.prepare("UPDATE decks SET archived = ? WHERE id = ?").run(to, deckId);
          db.prepare("UPDATE cards SET archived = ? WHERE deck_id = ?").run(to, deckId);
        })();
        describe = `${request.op}d ${deck.name} and its cards`;
        undo = { op: request.op === "archive" ? "unarchive" : "archive", deckId };
        break;
      }
      case "rename":
        db.prepare("UPDATE decks SET name = ? WHERE id = ?").run(request.name ?? deck.name, deckId);
        describe = `renamed ${deck.name} to ${request.name ?? deck.name}`;
        undo = { op: "rename", deckId, name: deck.name };
        break;
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
      `INSERT INTO cards (id, deck_id, template_id, name, content, archived)
       VALUES (?, ?, ?, ?, '', 0)`,
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
                WHERE c2.deck_id = dp.deck_id AND t.dormant = 0 AND c2.archived = 0
                  AND t.due_at IS NOT NULL
                  AND date(t.due_at) <= date('now','localtime')) AS due
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
                (SELECT count(*) FROM template_fields f WHERE f.template_id = t.id) AS fields
           FROM templates t ORDER BY t.name`,
      )
      .all() as { id: string; name: string; fields: number }[],
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
 * With no query it is a deck listing instead, ordered by name — a browse, not a
 * ranking, so imposing a relevance order on it would be a lie.
 */
function browse(request: BrowseRequest): void {
  const db = requireCards();
  const started = performance.now();

  if (request.query.trim() === "") {
    const rows = db
      .prepare(
        `SELECT c.id AS id, c.name AS name, c.archived AS archived, dp.path AS deck
           FROM cards c LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id
          WHERE (? IS NULL OR c.deck_id = ?)
          ORDER BY c.name LIMIT ?`,
      )
      .all(request.deckId, request.deckId, request.limit) as {
      id: string;
      name: string;
      archived: number;
      deck: string | null;
    }[];
    const total = Number(
      (
        db
          .prepare("SELECT count(*) AS n FROM cards c WHERE (? IS NULL OR c.deck_id = ?)")
          .get(request.deckId, request.deckId) as { n: number }
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
        snippet: null,
      })),
      total,
      mode: null,
      elapsedMs: performance.now() - started,
    });
    return;
  }

  const result = searchCards(db, request.query, { limit: request.limit });
  const deckPaths = new Map(
    (db.prepare("SELECT deck_id, path FROM deck_paths").all() as {
      deck_id: string;
      path: string;
    }[]).map((row) => [row.deck_id, row.path]),
  );
  const filtered =
    request.deckId === null
      ? result.hits
      : result.hits.filter((hit) => hit.deckId === request.deckId);
  post({
    kind: "browse",
    id: request.id,
    hits: filtered.map((hit) => ({
      cardId: hit.cardId,
      name: hit.name,
      deckPath: deckPaths.get(hit.deckId) ?? "",
      archived: hit.archived,
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
  const existed =
    db
      .prepare("SELECT 1 FROM card_field_values WHERE card_id = ? AND field_id = ?")
      .get(request.cardId, request.fieldId) !== undefined;
  db.prepare(
    `INSERT INTO card_field_values (card_id, field_id, value)
     VALUES (?, ?, ?)
     ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value`,
  ).run(request.cardId, request.fieldId, request.value);
  post({
    kind: "setField",
    id: request.id,
    cardId: request.cardId,
    fieldId: request.fieldId,
    value: request.value,
    created: !existed,
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
function preview(request: PreviewRequest): void {
  const db = requireCards();
  const card = prepareCard({ db, cardId: request.cardId, direction: "forward" });
  post({
    kind: "preview",
    id: request.id,
    card,
    deckPath: card?.loaded.deckPath ?? "",
    name: card?.loaded.name ?? request.cardId,
  });
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
        case "preview":
          preview(request);
          break;
        case "setField":
          setField(request);
          break;
        case "decks":
          decks(request);
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
