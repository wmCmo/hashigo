/// <reference lib="webworker" />

import { SqliteBlobStore } from "../src/blobs/sqlite.js";
import { count } from "./plural.js";
import { exportLocalArchive } from "../src/backup/index.js";
import {
  deltaPayload,
  exportDelta,
  exportEditDelta,
  exportSync,
  indexPayload,
  isDelta,
  maxLocalReviewId,
  mergeSync,
  parseSentIndex,
} from "../src/sync/index.js";
import {
  resolveDescriptorText,
  storeDescriptorText,
  storeGeneratedSpeech,
  stripThinking,
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
import {
  backlinksOf,
  createCard as createCardRow,
  createTemplate,
  DuplicateCardError,
  foundInOf,
  newCardId,
  reconcileCardLinks,
} from "../src/cards/index.js";
import { decodeFieldOptions, recordFoundIn } from "../src/cards/index.js";
import { cardAudioResolver } from "../src/cards/index.js";
import { directionForTrackKind } from "../src/cards/index.js";
import { ACCENT_FIELD_TYPE, READING_FIELD, cardGaps, prepareCard, readingSwitch, wordPronunciation } from "../src/review/index.js";
import {
  buildSession,
  readSessionSettings,
  upcomingCardIds,
  writeSetting,
  type AnswerResult,
  type ReviewSession,
} from "../src/session/index.js";
import { searchCards } from "../src/search/index.js";
import { refreshSearchText } from "../src/generate/index.js";
import { refreshCardTags } from "../src/cards/tags.js";
import { collect, collectGlance, compareDeckPaths, renderDashboard } from "../src/dashboard/index.js";
import {
  countReferences,
  promptDependencies,
  renameFieldEverywhere,
  sideIndex,
} from "../src/template/index.js";
import { positionKeys, FIELD_TYPES, type FieldType } from "../src/schema/index.js";
import { effectiveRole, fieldKind, kindOf, ROLE_KEY, roleOf, withRole } from "../src/fields/index.js";
import { dueOnOrBefore, liveTrack } from "../src/scheduler/index.js";

import {
  archiveSubtree,
  restoreArchive,
  scopeToSubtree,
  scopeToTag,
  subtreeDeckIds,
} from "./deck-scope.js";
import { isCatalogueVoice } from "../src/generate/voices.js";
import { retireBlob, unretireBlob } from "../src/blobs/retire.js";
import { audioHashCandidates } from "../src/cards/audio.js";
import { suggestCards, type SuggestRow } from "./recent.js";
import { GIST_FIELDS, gistOf } from "./gist.js";
import { readingOverride } from "./reading-override.js";
import { audioIsStale } from "./seed-freshness.js";
import {
  COUNT_HELD,
  mergeLocalFields,
  readSeedFields,
  reapplyCorrections,
  type LocalCorrectionRow,
} from "./local-fields.js";
import {
  describePrice,
  describeVoicePrice,
  kindChange,
  optionsRefusal,
  sameExceptRole,
  staleDerived,
  fieldOutputs,
  type KindChange,
  priceFieldChange,
  priceVoiceChange,
  resolvedVoices,
  searchReach,
  sourceRefusal,
  templateFields,
  writeFieldOptions,
  writeFieldSource,
} from "./field-ops.js";

import { applyAccentFill, planAccentFill } from "../src/accent/fill.js";
import type { Db } from "../src/db/index.js";
import type {
  AccentFillRequest,
  AccentPlanRequest,
  AnswerRequest,
  PriceFieldRequest,
  RedoInfoRequest,
  PronunciationRequest,
  CardGapsRequest,
  UpcomingCardsRequest,
  RecordFoundInRequest,
  FieldOutputsRequest,
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
  ReplanRequest,
  FocusRequest,
  FocusCountsRequest,
  SyncDeltaRequest,
  LogLevel,
  NextRequest,
  OpenRequest,
  PayloadRequest,
  ReadingRequest,
} from "./protocol.js";

const CARD_DB = "/hashigo.db";
const STORE_DB = "/hashigo-blobs.db";
const GEN_DB = "/hashigo-gen.db";
const FIELDS_DB = "/hashigo-fields.db";

const CARD_URL = "/hashigo-app.db";
const STORE_URL = "/hashigo-app-blobs.db";
const GEN_URL = "/hashigo-app-gen.db";
const FIELDS_URL = "/hashigo-app-fields.db";
const SEED_URL = "/hashigo-app.json";

let cards: BrowserDb | null = null;
let payloads: BrowserDb | null = null;
let store: SqliteBlobStore | null = null;
let session: ReviewSession | null = null;

let answers: AnswerResult[] = [];

function post(message: AppMessage): void {
  self.postMessage(message);
}

function log(text: string, level: LogLevel = "info"): void {
  post({ kind: "log", level, text });
}

interface FetchPlan {
  readonly index: number;
  readonly of: number;
}

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

interface SeedManifest {
  readonly generatedAt: string;
  readonly schemaVersion: number;
  readonly cards: number;
  readonly seedReviews: number;
  readonly payloads: number;
  readonly storeCreated?: string;
  readonly genCreated?: string;
  readonly generations?: number;
  readonly fieldsCreated?: string;
  readonly fieldValues?: number;
}

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

let seedCorrections: readonly LocalCorrectionRow[] = [];

async function applyLocalFields(): Promise<number> {
  const db = cards;
  if (db === null) return 0;
  if (!(await databaseFilesInOpfs()).includes(FIELDS_DB)) return 0;
  const seed = await openDatabaseBrowser({ filename: FIELDS_DB, applySchema: false });
  try {
    const { fields, values, corrections } = readSeedFields(seed);
    seedCorrections = corrections;
    if (values.length === 0) return 0;
    const have = Number((db.prepare(COUNT_HELD).get() as { n: number }).n);
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

  const present = await databaseFilesInOpfs();
  const cardsWerePresent = present.includes(CARD_DB);
  const storeWasPresent = present.includes(STORE_DB);

  let reimport = request.reimport;
  let refetchStore = request.reimport;
  const manifest = reimport && refetchStore ? null : await seedManifest();

  if (cardsWerePresent && !reimport && cards === null) {
    if (manifest !== null) {
      const held = await openDatabaseBrowser({ filename: CARD_DB, applySchema: false });
      const count = (sql: string): number =>
        Number((held.prepare(sql).get() as { n: number }).n);
      const heldSeed = count("SELECT count(*) AS n FROM reviews WHERE source <> 'local'");
      const localReviews = count("SELECT count(*) AS n FROM reviews WHERE source = 'local'");
      if (heldSeed !== manifest.seedReviews) {
        if (localReviews === 0) {
          held.close();
          reimport = true;
          log(
            `  the database here holds ${heldSeed.toLocaleString()} seeded reviews and the ` +
              `server is serving ${manifest.seedReviews.toLocaleString()} — re-fetching`,
            "step",
          );
        } else {
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

  if (storeWasPresent && !refetchStore && payloads === null && manifest !== null) {
    const serving = manifest.storeCreated ?? "";
    const held = await openDatabaseBrowser({ filename: STORE_DB, applySchema: false });
    const heldCreated =
      (
        held.prepare("SELECT value FROM blob_store_meta WHERE key = 'created'").get() as
          | { value: string }
          | undefined
      )?.value ?? "";
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

  cards ??= await openDatabaseBrowser({ filename: CARD_DB, applySchema: false });
  payloads ??= await openDatabaseBrowser({ filename: STORE_DB, applySchema: false });
  store ??= new SqliteBlobStore(payloads, { create: false });

  await applyGenerations(refetchGen);
  await applyLocalFields();
  try {
    const tagged = (
      cards.prepare("SELECT DISTINCT card_id FROM card_field_values WHERE instr(value, '#') > 0").all() as {
        card_id: string;
      }[]
    ).map((row) => row.card_id);
    refreshCardTags(cards, tagged);
  } catch (cause) {
    log(`tags: could not read #tags off the cards — ${(cause as Error).message}`);
  }

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

function collectionState(db: BrowserDb, cardId: string): { pinned: boolean; archived: boolean } {
  const row = db.prepare("SELECT pinned, archived FROM cards WHERE id = ?").get(cardId) as
    | { pinned: number; archived: number }
    | undefined;
  return { pinned: row?.pinned === 1, archived: row?.archived === 1 };
}

function next(request: NextRequest): void {
  const active = requireSession();
  const db = requireCards();
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
    isNew: item.origin === "new",
    reask: item.reask,
    overdueDays: item.origin === "new" ? 0 : item.track.overdueDays,
    dueAt: item.track.dueAt,
    lastReviewedAt: item.track.lastReviewedAt,
    ...collectionState(db, item.cardId),
    progress: active.progress(),
  });
}

async function payload(request: PayloadRequest): Promise<void> {
  const db = requireCards();
  if (store === null) throw new Error("no payload store — send `open` first");
  const resolve = cardAudioResolver(db, request.cardId, { store });
  const found = await resolve(request.address);
  post({ kind: "payload", id: request.id, payload: found });
}

function answer(request: AnswerRequest): void {
  const active = requireSession();
  const started = performance.now();
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

function ungrade(request: UngradeRequest): void {
  const active = requireSession();
  const last = answers.pop();
  if (last === undefined) throw new Error("nothing graded this session to undo");
  try {
    active.unanswer(last);
  } catch (cause) {
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

function readingFieldOf(db: BrowserDb, cardId: string): { id: string } | undefined {
  const rows = db
    .prepare(
      `SELECT tf.id AS id, tf.name AS name, tf.type AS type, tf.options AS options
         FROM cards c JOIN template_fields tf ON tf.template_id = c.template_id
        WHERE c.id = ? ORDER BY tf.pos, tf.id`,
    )
    .all(cardId) as { id: string; name: string; type: string; options: string | null }[];
  return readingSwitch(
    rows.map((row) => ({ ...row, options: decodeFieldOptions(row.options ?? "{}") })),
  );
}

function touchCard(db: ReturnType<typeof requireCards>, cardId: string): void {
  db.prepare("UPDATE cards SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(cardId);
}

function setReading(request: ReadingRequest): void {
  const db = requireCards();
  const field = readingFieldOf(db, request.cardId);
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
  touchCard(db, request.cardId);
  refreshSearchText(db, [request.cardId]);
  post({ kind: "reading", id: request.id, cardId: request.cardId, value: request.value });
}

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
      if (!("templateId" in request)) throw new Error("setTemplate needs a templateId");
      const to = request.templateId ?? null;
      if (to !== null && db.prepare("SELECT 1 FROM templates WHERE id = ?").get(to) === undefined) {
        throw new Error(`no template ${to}`);
      }
      if (to === card.template_id) {
        describe = `${name} is already on that template`;
        undo = null;
        break;
      }
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
        `moved ${name} to ${toName} — ${count(kept, "value")} carried over` +
        (hidden === 0 ? "" : `, ${hidden} now hidden (kept, not deleted)`);
      undo = { op: "setTemplate", cardId: card.id, templateId: card.template_id };
      break;
    }
    case "delete":
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
        undo = null;
        describe = `deleted ${name} and ${count(reviews, "review")} — not undoable`;
      }
      break;
    case "duplicate":
      {
        const copyId = newCardId(db);
        db.transaction(() => {
          db.prepare(
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
          refreshCardTags(db, [copyId]);
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

function deckOp(request: DeckOpRequest): void {
  const db = requireCards();
  let describe = "";
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
        let result = { deckIds: [] as string[], changed: [] as string[] };
        db.transaction(() => {
          result = archiveSubtree(db, deckId, to);
        })();
        const { deckIds, changed } = result;
        const subdecks = deckIds.length === 1 ? "" : ` and ${count(deckIds.length - 1, "subdeck")}`;
        describe = `${request.op}d ${deck.name}${subdecks} — ${count(changed.length, "card")}`;
        undo = { op: "restoreArchive", deckId, cardIds: changed };
        break;
      }
      case "restoreArchive": {
        const cardIds = request.cardIds ?? [];
        db.transaction(() => {
          restoreArchive(db, deckId, cardIds);
        })();
        describe = `restored ${deck.name} — ${count(cardIds.length, "card")}`;
        undo = null;
        break;
      }
      case "rename":
        db.prepare("UPDATE decks SET name = ? WHERE id = ?").run(request.name ?? deck.name, deckId);
        describe = `renamed ${deck.name} to ${request.name ?? deck.name}`;
        undo = { op: "rename", deckId, name: deck.name };
        break;
      case "move": {
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

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function createCard(request: CreateCardRequest): void {
  const db = requireCards();
  let created;
  try {
    created = createCardRow(
      db,
      {
        deckId: request.deckId,
        templateId: request.templateId,
        name: request.name,
        ...(request.values === undefined ? {} : { values: request.values }),
        ...(request.source === undefined ? {} : { source: request.source }),
      },
      { allowDuplicate: request.allowDuplicate === true },
    );
  } catch (cause) {
    if (!(cause instanceof DuplicateCardError)) throw cause;
    post({
      kind: "createCard",
      id: request.id,
      cardId: null,
      tracks: [],
      card: null,
      duplicate: { message: cause.message, existing: cause.existing },
    });
    return;
  }
  post({
    kind: "createCard",
    id: request.id,
    cardId: created.cardId,
    tracks: created.tracks,
    card: prepareCard({ db, cardId: created.cardId, direction: "forward" }),
    duplicate: null,
  });
}

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
    decks: rows
      .map((row) => ({ ...row, archived: row.archived === 1 }))
      .sort((a, b) => compareDeckPaths(a.path, b.path)),
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

function gistsFor(db: BrowserDb, cardIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (cardIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT v.card_id AS id, v.value AS value
         FROM card_field_values v JOIN template_fields f ON f.id = v.field_id
        WHERE f.type = 'plain' AND v.value <> ''
          AND f.name IN (${GIST_FIELDS.map(() => "?").join(", ")})
          AND v.card_id IN (SELECT value FROM json_each(?))
        ORDER BY ${GIST_FIELDS.map(() => "f.name = ? DESC").join(", ")}`,
    )
    .all(...GIST_FIELDS, JSON.stringify(cardIds), ...GIST_FIELDS) as {
    id: string;
    value: string;
  }[];
  for (const row of rows) {
    if (out.has(row.id)) continue;
    const gist = gistOf(row.value);
    if (gist !== null) out.set(row.id, gist);
  }
  return out;
}

function browse(request: BrowseRequest): void {
  const db = requireCards();
  const started = performance.now();

  const deckScope = scopeToSubtree(db, request.deckId);
  const tagScope =
    request.tagPath === undefined || request.tagPath === null
      ? { sql: "1 = 1", args: [] as string[] }
      : scopeToTag(request.tagPath);
  const scopeSql = `(${deckScope.sql}) AND (${tagScope.sql})`;
  const scopeArgs = [...deckScope.args, ...tagScope.args];
  const includeArchived = request.includeArchived !== false;
  const archivedSql = includeArchived ? "" : " AND c.archived = 0";

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
              WHERE ${scopeSql}${archivedSql}
              ORDER BY c.name LIMIT ?`,
          )
          .all(...scopeArgs, request.limit) as SuggestRow[]);
    const total = Number(
      (
        db
          .prepare(`SELECT count(*) AS n FROM cards c WHERE ${scopeSql}${archivedSql}`)
          .get(...scopeArgs) as { n: number }
      ).n,
    );
    const gists = gistsFor(db, rows.map((row) => row.id));
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
        gist: gists.get(row.id) ?? null,
      })),
      total,
      mode: null,
      elapsedMs: performance.now() - started,
    });
    return;
  }

  const result = searchCards(db, request.query, {
    limit: request.limit,
    includeArchived,
    ...(request.deckId === null ? {} : { deckIds: scopeArgs }),
  });
  const searchGists = gistsFor(db, result.hits.map((hit) => hit.cardId));
  const deckPaths = new Map(
    (db.prepare("SELECT deck_id, path FROM deck_paths").all() as {
      deck_id: string;
      path: string;
    }[]).map((row) => [row.deck_id, row.path]),
  );
  const filtered = result.hits;
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
      gist: searchGists.get(hit.cardId) ?? null,
    })),
    total: result.total,
    mode: result.mode,
    elapsedMs: result.elapsedMs,
  });
}

const EDITABLE_TYPES = new Set(["plain", "boolean", "number", "accent"]);

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
  const before = db
    .prepare("SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?")
    .get(request.cardId, request.fieldId) as { value: string } | undefined;
  const existed = before !== undefined;

  if (request.value === null) {
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
  const changed = (before?.value ?? null) !== request.value;
  const cleared: { fieldId: string; name: string; previous: string | null }[] = [];
  if (changed) {
    const templateId = (db.prepare("SELECT template_id FROM cards WHERE id = ?").get(request.cardId) as
      | { template_id: string | null }
      | undefined)?.template_id;
    const downstream = templateId == null ? [] : staleDerived(templateFields(db, templateId), request.fieldId);
    const held = db.prepare("SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?");
    const empty = db.prepare("UPDATE card_field_values SET value = '' WHERE card_id = ? AND field_id = ?");
    for (const target of downstream) {
      const row = held.get(request.cardId, target.id) as { value: string } | undefined;
      if (row === undefined || row.value === "") continue;
      empty.run(request.cardId, target.id);
      cleared.push({ fieldId: target.id, name: target.name, previous: row.value });
    }
  }
  touchCard(db, request.cardId);
  refreshSearchText(db, [request.cardId]);
  refreshCardTags(db, [request.cardId]);
  post({
    kind: "setField",
    id: request.id,
    cardId: request.cardId,
    fieldId: request.fieldId,
    value: request.value,
    created: !existed,
    previous: before?.value ?? null,
    cleared,
  });
}

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

function backlinks(request: BacklinksRequest): void {
  if (linksStale) {
    try {
      const { cards, rows } = reconcileCardLinks(requireCards());
      if (cards > 0) log(`links: re-indexed ${cards} card(s), ${rows} row(s)`);
    } catch (error) {
      log(`links: re-index failed — ${String(error)}`, "bad");
    }
    linksStale = false;
  }
  post({
    kind: "backlinks",
    id: request.id,
    cards: backlinksOf(requireCards(), request.cardId),
    foundIn: foundInOf(requireCards(), request.cardId),
  });
}

function syncExport(request: SyncExportRequest): void {
  const db = requireCards();
  const mark = maxLocalReviewId(db);
  const payload = exportSync(db, new Date().toISOString());
  const index = JSON.stringify(indexPayload(payload));
  const json = request.indexOnly === true ? "" : JSON.stringify(payload);
  post({
    kind: "syncExport",
    id: request.id,
    json,
    bytes: new TextEncoder().encode(json).length,
    mark,
    index,
  });
}

function syncDelta(request: SyncDeltaRequest): void {
  const db = requireCards();
  const sent = request.sent === undefined ? null : parseSentIndex(request.sent);
  if (request.sent !== undefined && sent === null) {
    throw new Error("syncDelta: the sent fingerprint is not readable — send the full payload");
  }
  const edit = sent === null ? null : exportEditDelta(db, request.after, sent, new Date().toISOString());
  const delta = edit === null ? exportDelta(db, request.after) : edit.delta;
  const json = JSON.stringify(delta);
  post({
    kind: "syncDelta",
    id: request.id,
    json,
    bytes: new TextEncoder().encode(json).length,
    mark: delta.mark,
    count: delta.reviews.length,
    edits: edit?.rows ?? 0,
    ...(edit === null ? {} : { index: JSON.stringify(edit.index) }),
  });
}

function replan(request: ReplanRequest): void {
  const db = requireCards();
  if (answers.length > 0) {
    throw new Error("refusing to replan a session that has already been graded");
  }
  session = buildSession(db);
  post({ kind: "replan", id: request.id, planned: session.progress().planned });
}

function focus(request: FocusRequest): void {
  const db = requireCards();
  session = buildSession(db, {
    ...(request.deckId === null ? {} : { deckId: request.deckId }),
    silent: request.silent,
  });
  answers = [];
  const progress = session.progress();
  post({
    kind: "focus",
    id: request.id,
    planned: progress.planned,
    dueCount: progress.dueCount,
    newCount: progress.newCount,
  });
}

function focusCounts(request: FocusCountsRequest): void {
  const db = requireCards();
  const scope = request.deckId === null ? {} : { deckId: request.deckId };
  const count = (silent: boolean) => {
    const p = buildSession(db, { ...scope, silent }).progress();
    return { due: p.dueCount, fresh: p.newCount };
  };
  post({ kind: "focusCounts", id: request.id, all: count(false), silent: count(true) });
}

function syncMerge(request: SyncMergeRequest): void {
  const db = requireCards();
  const before = (
    db.prepare("SELECT count(*) AS n FROM reviews WHERE source = 'local'").get() as {
      n: number;
    }
  ).n;
  const markBefore = maxLocalReviewId(db);
  const payload = isDelta(request.payload)
    ? deltaPayload(request.payload, new Date().toISOString())
    : request.payload;
  const report = db.transaction(() => {
    const merged = mergeSync(db, payload as never);
    const fixed = reapplyCorrections(db, seedCorrections);
    if (fixed > 0) log(`  sync: ${fixed} corrected value(s) a peer carried back were re-corrected`);
    return merged;
  })();
  const after = (
    db.prepare("SELECT count(*) AS n FROM reviews WHERE source = 'local'").get() as {
      n: number;
    }
  ).n;
  post({
    kind: "syncMerge",
    id: request.id,
    reviewsAdded: after - before,
    flagsTaken: report.flagsTaken,
    trackStateTaken: report.trackStateTaken,
    orphaned: report.flagsOrphaned + report.applied.reviewsOrphaned,
    markBefore,
    markAfter: maxLocalReviewId(db),
  });
}

function generatedText(request: GeneratedTextRequest): void {
  const db = requireCards();
  let yomi: string | null | undefined;
  const texts = request.slots.map((slot) => {
    const stored = resolveDescriptorText(db, {
      kind: slot.kind as never,
      text: slot.text,
      lang: slot.lang,
      voice: slot.voice,
      options: slot.options,
    });
    if (stored !== null) return stripThinking(stored);
    if (slot.kind !== "furigana" || request.cardId === undefined) return stored;
    if (yomi === undefined) yomi = readingOverride(db, request.cardId);
    return yomi;
  });
  post({ kind: "generatedText", id: request.id, texts });
}

function accentPlan(request: AccentPlanRequest): void {
  const db = requireCards() as unknown as Db;
  post({ kind: "accentPlan", id: request.id, items: planAccentFill(db, request.cardIds) });
}

function accentFill(request: AccentFillRequest): void {
  const db = requireCards() as unknown as Db;
  const report = applyAccentFill(db, request.items, new Map(request.derived), request.lines);
  if (report.labels + report.yomi + report.ojad > 0) {
    refreshSearchText(requireCards(), request.items.map((item) => item.cardId));
  }
  post({ kind: "accentFill", id: request.id, report });
}

function cardGapsFor(request: CardGapsRequest): void {
  const db = requireCards();
  const row = db.prepare("SELECT local FROM cards WHERE id = ?").get(request.cardId) as
    | { local: number }
    | undefined;
  const local = row?.local === 1;
  post({ kind: "cardGaps", id: request.id, local, gaps: cardGaps(db, request.cardId) });
}

function upcomingCardsFor(request: UpcomingCardsRequest): void {
  post({ kind: "upcomingCards", id: request.id, cardIds: upcomingCardIds(requireCards(), { days: request.days }) });
}

function recordFoundInFor(request: RecordFoundInRequest): void {
  const db = requireCards();
  const outcome = recordFoundIn(db, request.cardId, { cardId: request.sourceCardId, sentence: request.sentence });
  if (outcome === "recorded") {
    touchCard(db, request.cardId);
    refreshSearchText(db, [request.cardId]);
  }
  post({ kind: "recordFoundIn", id: request.id, outcome });
}

function fieldOutputsFor(request: FieldOutputsRequest): void {
  const outputs = fieldOutputs(requireCards(), request.cardId).map((output) =>
    output.text === null ? output : { ...output, text: stripThinking(output.text) },
  );
  post({ kind: "fieldOutputs", id: request.id, outputs });
}

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
      stripThinking(request.text),
    );
  } catch (cause) {
    log(`could not cache the generation: ${(cause as Error).message}`, "bad");
  }
  if (hash !== null && request.cardId !== undefined) refreshSearchText(db, [request.cardId]);
  post({ kind: "storeGeneration", id: request.id, hash });
}

function storeClip(request: StoreClipRequest): void {
  const db = requireCards();
  let hash: string | null = null;
  try {
    if (store === null) throw new Error("no payload store — send `open` first");
    const binary = atob(request.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    if (request.retire !== undefined) retireBlob(db, request.retire);
    hash = storeGeneratedSpeech(db, store, request.slot, bytes);
  } catch (cause) {
    log(`could not cache the clip: ${(cause as Error).message}`, "bad");
  }
  const same = request.retire !== undefined && hash === request.retire;
  if (same && hash !== null) unretireBlob(db, hash);
  post({ kind: "storeClip", id: request.id, hash, ...(same ? { same: true } : {}) });
}

function redoInfo(request: RedoInfoRequest): void {
  const db = requireCards();
  const candidates = audioHashCandidates(db, request.cardId, {
    origin: "generator",
    request: { kind: "speech", ...request.request },
  });
  const present = candidates.find((hash) => store?.has(hash) ?? false) ?? candidates[0] ?? null;
  const voice =
    present === null
      ? null
      : ((db.prepare("SELECT voice FROM blobs WHERE hash = ?").get(present) as { voice: string | null } | undefined)
          ?.voice ?? null);

  const head = db
    .prepare(
      `SELECT v.value AS value FROM cards c
         LEFT JOIN template_fields a ON a.template_id = c.template_id AND a.type = 'accent'
         JOIN card_field_values v ON v.card_id = c.id AND v.field_id = COALESCE(a.source_field_id, 'name')
        WHERE c.id = ? LIMIT 1`,
    )
    .get(request.cardId) as { value: string } | undefined;
  const base = head?.value.replace(/[\u200b-\u200f\ufeff]/g, "").trim() ?? "";
  let alias = readingOverride(db, request.cardId) ?? "";
  if (alias === "" && base !== "") {
    const row = db.prepare("SELECT reading FROM accents WHERE text = ? AND reading IS NOT NULL LIMIT 1").get(base) as
      | { reading: string }
      | undefined;
    alias = row?.reading ?? "";
  }
  const readings = base !== "" && alias !== "" && base !== alias ? [{ base, alias }] : [];
  const word = wordPronunciation(db, request.cardId, request.request.text);
  const pronounce = word !== null && word.waiting === false ? (word.pronounce ?? null) : null;
  post({ kind: "redoInfo", id: request.id, hash: present, voice, readings, pronounce });
}

function pronunciationFor(request: PronunciationRequest): void {
  const db = requireCards();
  const word = wordPronunciation(db, request.cardId, request.text);
  post({
    kind: "pronunciation",
    id: request.id,
    waiting: word?.waiting === true,
    pronounce: word !== null && word.waiting === false ? (word.pronounce ?? null) : null,
  });
}

function backup(request: BackupRequest): void {
  const db = requireCards();
  const archive = exportLocalArchive(db, new Date().toISOString());
  const json = `${JSON.stringify(archive, null, 1)}\n`;
  post({
    kind: "backup",
    id: request.id,
    json,
    bytes: new TextEncoder().encode(json).length,
    counts: archive.counts,
  });
}

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

  let persisted = false;
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    persisted = await navigator.storage.persisted();
    const estimate = await navigator.storage.estimate();
    usageBytes = estimate.usage ?? null;
    quotaBytes = estimate.quota ?? null;
  } catch {
  }

  post({
    kind: "settings",
    id: request.id,
    values,
    resolved: {
      newLimit: resolved.newLimit,
      interleave: resolved.interleave,
      examTarget: resolved.examTarget,
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

function refreshTemplateSearch(db: BrowserDb, templateId: string): void {
  const ids = (db.prepare("SELECT id FROM cards WHERE template_id = ?").all(templateId) as {
    id: string;
  }[]).map((row) => row.id);
  refreshSearchText(db, ids);
}

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

  const guardReadingField = (target: TemplateFieldRow, verb: string): void => {
    const drills = before.fields.some((entry) => entry.type === ACCENT_FIELD_TYPE);
    if (!drills) return;
    const switchField = readingSwitch(
      before.fields.map((entry) => ({ ...entry, options: decodeFieldOptions(entry.options) })),
    );
    if (switchField === undefined || switchField.id !== target.id) return;
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
      db.prepare("UPDATE templates SET content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(content, before.id);
      describe = `edited ${before.name}'s body (${before.cards.toLocaleString()} cards render it)`;
      undo = { op: "body", templateId: before.id, content: before.content };
      break;
    }

    case "addField": {
      const name = (request.name ?? "").trim();
      const asked = request.fieldType ?? "plain";
      const type = asked === "reading" ? "plain" : asked;
      const options = asked === "reading" ? JSON.stringify({ [ROLE_KEY]: "reading" }) : "{}";
      let source: string | null = null;
      if (asked === "reading" || asked === "accent") {
        source =
          templateFields(db, before.id).find(
            (entry) =>
              entry.type === "plain" &&
              effectiveRole({ ...entry, options: decodeFieldOptions(entry.options) }) === null,
          )?.id ?? null;
        if (source === null) {
          throw new Error(`${before.name} has no Text field for it to read from — add the word's field first`);
        }
      }
      if (name === "") throw new Error("a field needs a name");
      if (before.fields.some((entry) => entry.name === name)) {
        throw new Error(`${before.name} already has a field called ${name}`);
      }
      if (!(FIELD_TYPES as readonly string[]).includes(type)) {
        throw new Error(`${type} is not a field type`);
      }
      const id = newFieldId(db, before.id);
      const keys = positionKeys(before.fields.length + 1);
      db.transaction(() => {
        db.prepare(
          `INSERT INTO template_fields (template_id, id, name, type, source_field_id,
                                        options, pos, local)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(before.id, id, name, type, source, options, keys[before.fields.length]);
        renumber(db, before.id, [...before.fields.map((entry) => entry.id), id]);
      })();
      const kindLabel = fieldKind({ type, options: decodeFieldOptions(options) }).label;
      const reads = before.fields.find((entry) => entry.id === source)?.name;
      describe =
        `added ${name} (${kindLabel}${reads === undefined ? "" : `, reading ${reads}`}) to ${before.name}` +
        ` — put <<${name}>> in the body to show it`;
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
          : ` and rewrote ${count(rewritten.rewrites, "reference")}`);
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
          : ` — its ${count(target.values, "value")} stay saved and come back if you undo`);
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
      const targetOptions = decodeFieldOptions(target.options);
      const pinRole = effectiveRole({ ...target, options: targetOptions }) === "reading" && roleOf({ options: targetOptions }) === null;
      db.transaction(() => {
        if (pinRole) writeFieldOptions(db, before.id, target.id, JSON.stringify(withRole(targetOptions, "reading")));
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

    case "setFieldType": {
      const target = field(request.fieldId ?? "");
      const to = request.fieldType ?? "";
      const cost = kindOf(target.type)?.convertsTo[to as FieldType];
      if (cost !== "free") {
        throw new Error(
          `${target.name} cannot become ${to} from here — ` +
            (cost === "priced"
              ? "that conversion reinterprets its stored values and needs a migration with a diff, not a form control."
              : "the two kinds do not convert."),
        );
      }
      guardReadingField(target, "retyping");
      db.prepare(
        "UPDATE template_fields SET type = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE template_id = ? AND id = ?",
      ).run(to, before.id, target.id);
      describe = `${target.name} is now ${kindOf(to)?.label ?? to} (was ${kindOf(target.type)?.label ?? target.type}) — no value changed`;
      undo = { op: "setFieldType", templateId: before.id, fieldId: target.id, fieldType: target.type };
      break;
    }

    case "setFieldKind": {
      const target = field(request.fieldId ?? "");
      const fields = templateFields(db, before.id);
      let change: KindChange | string;
      if (request.options !== undefined) {
        change =
          target.type === "plain" && sameExceptRole(target.options, request.options)
            ? { options: request.options, sourceFieldId: request.sourceFieldId ?? null }
            : `${target.name}'s kind cannot be restored to that`;
      } else {
        change = kindChange(fields, target.id, request.fieldType === "reading" ? "reading" : "plain");
      }
      if (typeof change === "string") throw new Error(change);
      const next = change;
      if (next.sourceFieldId !== null) {
        const refusal = sourceRefusal(
          fields.map((entry) => (entry.id === target.id ? { ...entry, options: next.options } : entry)),
          target.id,
          next.sourceFieldId,
        );
        if (refusal !== null) throw new Error(refusal);
      }
      db.transaction(() => {
        writeFieldOptions(db, before.id, target.id, next.options);
        writeFieldSource(db, before.id, target.id, next.sourceFieldId);
      })();
      const kindNow = fieldKind({ ...target, options: decodeFieldOptions(next.options) }).label;
      const sourceName = before.fields.find((entry) => entry.id === next.sourceFieldId)?.name;
      describe = `${target.name} is now ${kindNow}${sourceName === undefined ? "" : `, reading ${sourceName}`} — no value changed`;
      undo = {
        op: "setFieldKind",
        templateId: before.id,
        fieldId: target.id,
        options: target.options,
        sourceFieldId: target.sourceFieldId,
      };
      break;
    }

    case "orderFields": {
      const order = request.order ?? [];
      const known = new Set(before.fields.map((entry) => entry.id));
      if (order.length !== known.size || order.some((id) => !known.has(id))) {
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

function renumber(db: BrowserDb, templateId: string, order: readonly string[]): void {
  const keys = positionKeys(order.length);
  const update = db.prepare(
    `UPDATE template_fields SET pos = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE template_id = ? AND id = ? AND pos IS NOT ?`,
  );
  order.forEach((fieldId, index) => {
    update.run(keys[index], templateId, fieldId, keys[index]);
  });
}

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

let linksStale = true;
const LINK_SAFE: ReadonlySet<string> = new Set([
  "next",
  "payload",
  "generatedText",
  "answer",
  "backup",
  "syncExport",
  "syncDelta",
  "replan",
  "focus",
  "focusCounts",
  "preview",
  "backlinks",
  "redoInfo",
  "pronunciation",
  "cardGaps",
  "upcomingCards",
  "fieldOutputs",
  "accentPlan",
  "decks",
  "browse",
  "template",
  "priceField",
  "glance",
  "dashboard",
]);

self.onmessage = (event: MessageEvent<AppRequest>): void => {
  const request = event.data;
  if (!LINK_SAFE.has(request.kind)) linksStale = true;
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
        case "replan":
          replan(request);
          break;
        case "focus":
          focus(request);
          break;
        case "focusCounts":
          focusCounts(request);
          break;
        case "syncDelta":
          syncDelta(request);
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
        case "redoInfo":
          redoInfo(request);
          break;
        case "pronunciation":
          pronunciationFor(request);
          break;
        case "cardGaps":
          cardGapsFor(request);
          break;
        case "upcomingCards":
          upcomingCardsFor(request);
          break;
        case "recordFoundIn":
          recordFoundInFor(request);
          break;
        case "fieldOutputs":
          fieldOutputsFor(request);
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
        case "createTemplate":
          post({
            kind: "createTemplate",
            id: request.id,
            templateId: createTemplate(requireCards(), request.name).templateId,
          });
          break;
        case "accentPlan":
          accentPlan(request);
          break;
        case "accentFill":
          accentFill(request);
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
