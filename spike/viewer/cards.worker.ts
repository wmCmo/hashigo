/**
 * THROWAWAY (spike harness) — the viewer's dedicated Worker. Every SQL statement
 * in this slice runs here, because `opfs-sahpool` refuses to install anywhere
 * else (measured: spike/README.md, "Can it run on the main thread? No").
 *
 * Two databases, and the split is production's:
 *
 *   /hashigo.db                 the card database. Fetched once from
 *                               `/hashigo-bootstrap.db` (vite.config.ts serves it
 *                               from build/spike/) and imported into OPFS. It is
 *                               the SAME OPFS filename spike/ uses, so if the
 *                               stage-0.5 page has already run, this reattaches
 *                               in ~2 ms and downloads nothing.
 *   /hashigo-viewer-blobs.db    a real SqliteBlobStore holding the audio
 *                               payloads, built by make-viewer-db.ts. Separate
 *                               file because payloads are separate — decision 4.
 *
 * WHAT THIS WORKER WILL NOT DO: mint an object URL. `URL.createObjectURL` exists
 * here (measured in spike/audio: a URL minted in a worker does resolve in the
 * document), and it is still wrong — the worker cannot know when an `<audio>`
 * element is finished, so it cannot be the thing holding the handle. Bytes cross
 * as a transferred ArrayBuffer and the page owns the lease.
 */

import payloadDatabaseUrl from "./hashigo-viewer-blobs.db?url";

import { readBlob } from "../../src/blobs/db.js";
import { sha256Hex } from "../../src/blobs/sha256.js";
import { SqliteBlobStore } from "../../src/blobs/sqlite.js";
import {
  DEFAULT_DATABASE,
  databaseFilesInOpfs,
  importDatabaseBrowser,
  inDedicatedWorker,
  openDatabaseBrowser,
  sqliteVersion,
  type BrowserDb,
} from "../../src/db/browser.js";

import type {
  AttachmentRow,
  CardBrief,
  CardBundle,
  DeckBrief,
  FieldRow,
  LogMessage,
  TemplateRow,
  ViewerMessage,
  ViewerRequest,
} from "./protocol.js";

const CARDS_FILE = DEFAULT_DATABASE;
const CARDS_URL = "/hashigo-bootstrap.db";
const PAYLOAD_FILE = "/hashigo-viewer-blobs.db";

const post = (message: ViewerMessage, transfer: Transferable[] = []): void => {
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(message, transfer);
};
const line = (level: LogMessage["level"], text: string): void => post({ kind: "log", level, text });
const log = (text: string): void => line("info", text);
const step = (text: string): void => line("step", text);
const good = (text: string): void => line("good", text);
const bad = (text: string): void => line("bad", text);
const ms = (from: number): string => `${(performance.now() - from).toFixed(1)}ms`;
const n = (value: unknown): string => Number(value).toLocaleString("en-US");

let cards: BrowserDb | null = null;
let payloads: BrowserDb | null = null;
let store: SqliteBlobStore | null = null;
/** Every address this harness store holds. Built once; see the note in `open`. */
let held = new Set<string>();
/** The resolved deck list, built once: `card` needs a deck path per load. */
let deckCache: DeckBrief[] | null = null;

self.onmessage = (event: MessageEvent<ViewerRequest>): void => {
  const request = event.data;
  const fail = (error: unknown): void => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    bad(`FAILED (${request.kind}): ${message}`);
    post({ kind: "fail", id: request.id, error: message });
  };
  try {
    switch (request.kind) {
      case "open":
        void open(request.id, request.reimport).catch(fail);
        return;
      case "browse":
        browse(request.id, request.deckId, request.limit);
        return;
      case "card":
        card(request.id, request.cardId, request.deckId, request.withAudio);
        return;
      case "payload":
        payload(request.id, request.hash);
        return;
    }
  } catch (error) {
    fail(error);
  }
};

function db(): BrowserDb {
  if (cards === null) throw new Error("open the card database first");
  return cards;
}

/** Fetch a prebuilt database into OPFS, unless OPFS already holds it. */
async function ensureInOpfs(name: string, url: string, reimport: boolean, hint: string): Promise<void> {
  if ((await databaseFilesInOpfs()).includes(name) && !reimport) {
    log(`  ${name} is already in OPFS — not re-importing`);
    return;
  }
  const fetchStart = performance.now();
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}. ${hint}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  log(`  fetched ${n(bytes.byteLength)} bytes for ${name} in ${ms(fetchStart)}`);
  const importStart = performance.now();
  const written = await importDatabaseBrowser(name, bytes);
  log(`  importDb -> OPFS: ${n(written)} bytes in ${ms(importStart)}`);
}

async function open(id: number, reimport: boolean): Promise<void> {
  step("1. environment");
  const facts: [string, string][] = [
    ["inDedicatedWorker()", String(inDedicatedWorker())],
    ["isSecureContext", String(self.isSecureContext)],
    ["crossOriginIsolated", String(self.crossOriginIsolated)],
    ["sqlite", await sqliteVersion()],
  ];
  for (const [term, value] of facts) log(`  ${term.padEnd(24)} ${value}`);

  step("2. the two databases -> OPFS");
  await ensureInOpfs(CARDS_FILE, CARDS_URL, reimport, "Build it first: npm run spike:bootstrap");
  await ensureInOpfs(
    PAYLOAD_FILE,
    payloadDatabaseUrl,
    reimport,
    "Build it first: npx vite-node spike/viewer/make-viewer-db.ts",
  );
  log(`  pool holds ${JSON.stringify(await databaseFilesInOpfs())}`);

  step("3. open both; the production store over the payload database");
  const openStart = performance.now();
  cards ??= await openDatabaseBrowser({ filename: CARDS_FILE, applySchema: false });
  payloads ??= await openDatabaseBrowser({ filename: PAYLOAD_FILE, applySchema: false });
  store ??= new SqliteBlobStore(payloads, { create: false });
  log(`  opened both in ${ms(openStart)}; store ${store.describe}`);
  const storeStats = store.stats();
  log(`  payload store: ${n(storeStats.payloads)} rows, ${n(storeStats.bytes)} bytes, journal ${storeStats.journalMode}`);

  step("4. the oracle, from OPFS, by my own SQL");
  const one = <T>(sql: string): T => db().prepare(sql).get() as T;
  const oracle: [string, string][] = [];
  const totals = one<{ cards: number; decks: number; templates: number }>(
    "SELECT (SELECT count(*) FROM cards) AS cards, (SELECT count(*) FROM decks) AS decks, " +
      "(SELECT count(*) FROM templates) AS templates",
  );
  oracle.push(["cards", n(totals.cards)], ["decks", n(totals.decks)], ["templates", n(totals.templates)]);
  const reviews = one<{ reviews: number; ok: number }>(
    "SELECT count(*) AS reviews, sum(remembered) AS ok FROM reviews",
  );
  oracle.push(
    ["reviews", n(reviews.reviews)],
    ["retention", `${((reviews.ok / reviews.reviews) * 100).toFixed(2)}%`],
  );
  const links = one<{ links: number }>("SELECT count(*) AS links FROM card_links");
  oracle.push(["card_links", n(links.links)]);
  const paths = one<{ paths: number }>("SELECT count(*) AS paths FROM blobs WHERE path IS NOT NULL");
  oracle.push(["blobs.path non-NULL", n(paths.paths)]);
  const audio = one<{ blobs: number; cards: number }>(
    "SELECT count(DISTINCT b.hash) AS blobs, count(DISTINCT r.card_id) AS cards " +
      "FROM blobs b JOIN blob_refs r ON r.blob_hash = b.hash WHERE b.kind = 'speech'",
  );
  oracle.push(["speech blobs / cards", `${n(audio.blobs)} / ${n(audio.cards)}`]);
  // `store.has()` per row would be 10,791 round trips through the OPFS handle —
  // 9.2 s of blocked worker, measured on the first run of this harness. One pass
  // over the store's own index and a Set intersection is 1,206 rows and ~5 ms.
  held = new Set(store.list());
  const present = db().prepare("SELECT hash FROM blobs WHERE kind = 'speech'").all() as {
    hash: string;
  }[];
  let inStore = 0;
  for (const row of present) if (held.has(row.hash)) inStore += 1;
  oracle.push(["speech payloads in this harness store", `${n(inStore)} of ${n(present.length)}`]);
  for (const [term, value] of oracle) good(`  ${term.padEnd(38)} ${value}`);

  step("5. decks");
  const decks = deckList();
  log(`  ${decks.length} decks, ${n(decks.reduce((sum, deck) => sum + deck.cards, 0))} cards between them`);
  post({ kind: "opened", id, facts, oracle, decks });
}

/** `親 / 子` paths, resolved in one pass so the deck select reads properly. */
function deckList(): DeckBrief[] {
  if (deckCache !== null) return deckCache;
  const rows = db().prepare("SELECT id, parent_id, name FROM decks").all() as {
    id: string;
    parent_id: string | null;
    name: string;
  }[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path = (id: string): string => {
    const parts: string[] = [];
    let at: string | undefined = id;
    // Depth-bounded: a cycle would hang the worker, and the schema only CHECKs
    // that a deck is not its own parent.
    for (let guard = 0; at !== undefined && guard < 16; guard += 1) {
      const row = byId.get(at);
      if (row === undefined) break;
      parts.unshift(row.name);
      at = row.parent_id ?? undefined;
    }
    return parts.join(" / ");
  };
  const counts = new Map(
    (db().prepare("SELECT deck_id, count(*) AS n FROM cards GROUP BY deck_id").all() as {
      deck_id: string;
      n: number;
    }[]).map((row) => [row.deck_id, row.n]),
  );
  const withAudio = new Map(
    (db()
      .prepare(
        "SELECT c.deck_id AS deck_id, count(DISTINCT c.id) AS n FROM cards c " +
          "JOIN blob_refs r ON r.card_id = c.id JOIN blobs b ON b.hash = r.blob_hash " +
          "WHERE b.kind = 'speech' GROUP BY c.deck_id",
      )
      .all() as { deck_id: string; n: number }[]).map((row) => [row.deck_id, row.n]),
  );
  deckCache = rows
    .map((row) => ({
      id: row.id,
      path: path(row.id),
      cards: counts.get(row.id) ?? 0,
      withAudio: withAudio.get(row.id) ?? 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path, "ja"));
  return deckCache;
}

function browse(id: number, deckId: string | null, limit: number): void {
  const sql =
    "SELECT c.id AS id, c.name AS name, t.name AS templateName, " +
    "(SELECT count(*) FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash " +
    " WHERE r.card_id = c.id AND b.kind = 'speech') AS audioBlobs " +
    "FROM cards c LEFT JOIN templates t ON t.id = c.template_id " +
    (deckId === null ? "" : "WHERE c.deck_id = ? ") +
    "ORDER BY c.pos, c.name LIMIT ?";
  const rows = (
    deckId === null ? db().prepare(sql).all(limit) : db().prepare(sql).all(deckId, limit)
  ) as CardBrief[];
  post({ kind: "cards", id, cards: rows });
}

function card(id: number, cardId: string | null, deckId: string | null, withAudio: boolean): void {
  let target = cardId;
  if (target === null) {
    // Random, honestly random: ORDER BY random() over the candidate set rather
    // than an offset, so a deck's tail is as reachable as its head.
    const clauses = ["1 = 1"];
    const params: unknown[] = [];
    if (deckId !== null) {
      clauses.push("c.deck_id = ?");
      params.push(deckId);
    }
    if (withAudio) {
      clauses.push(
        "EXISTS (SELECT 1 FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash " +
          "WHERE r.card_id = c.id AND b.kind = 'speech')",
      );
    }
    target =
      (db()
        .prepare(`SELECT c.id FROM cards c WHERE ${clauses.join(" AND ")} ORDER BY random() LIMIT 1`)
        .pluck()
        .get(...(params as [])) as string | undefined) ?? null;
    if (target === null) throw new Error("no card matches that filter");
  }

  const row = db()
    .prepare(
      "SELECT c.id AS id, c.name AS name, c.content AS content, c.deck_id AS deckId, " +
        "c.template_id AS templateId, c.reverse AS cardReverse, d.reverse AS deckReverse " +
        "FROM cards c JOIN decks d ON d.id = c.deck_id WHERE c.id = ?",
    )
    .get(target) as
    | {
        id: string;
        name: string;
        content: string;
        deckId: string;
        templateId: string | null;
        cardReverse: string;
        deckReverse: string;
      }
    | undefined;
  if (row === undefined) throw new Error(`no card with id ${target}`);

  let template: TemplateRow | null = null;
  if (row.templateId !== null) {
    const templateRow = db()
      .prepare(
        "SELECT id, name, content, reverse_permutation AS reversePermutation FROM templates WHERE id = ?",
      )
      .get(row.templateId) as
      | { id: string; name: string; content: string; reversePermutation: string | null }
      | undefined;
    if (templateRow !== undefined) {
      const fields = db()
        .prepare(
          "SELECT id, name, type, source_field_id AS sourceFieldId, options, pos " +
            "FROM template_fields WHERE template_id = ? ORDER BY pos",
        )
        .all(row.templateId) as FieldRow[];
      let permutation: number[] | null = null;
      if (templateRow.reversePermutation !== null) {
        try {
          const parsed: unknown = JSON.parse(templateRow.reversePermutation);
          if (Array.isArray(parsed)) permutation = parsed.filter((v): v is number => Number.isInteger(v));
        } catch {
          permutation = null;
        }
      }
      template = {
        id: templateRow.id,
        name: templateRow.name,
        content: templateRow.content,
        reversePermutation: permutation,
        fields,
      };
    }
  }

  const values = (
    db().prepare("SELECT field_id, value FROM card_field_values WHERE card_id = ?").all(target) as {
      field_id: string;
      value: string;
    }[]
  ).map((value) => [value.field_id, value.value] as const);

  const attachments = (
    db()
      .prepare(
        "SELECT b.hash AS hash, b.kind AS kind, b.mime AS mime, b.byte_size AS byteSize, " +
          "b.source_text AS sourceText, b.voice AS voice, b.lang AS lang, " +
          "r.ref_key AS refKey, r.field_id AS fieldId, (b.bytes IS NOT NULL) AS inline " +
          "FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash WHERE r.card_id = ? " +
          "ORDER BY b.kind, b.byte_size",
      )
      .all(target) as (Omit<AttachmentRow, "payloadPresent"> & { inline: number })[]
  ).map((attachment) => ({
    hash: attachment.hash,
    kind: attachment.kind,
    mime: attachment.mime,
    byteSize: attachment.byteSize,
    sourceText: attachment.sourceText,
    voice: attachment.voice,
    lang: attachment.lang,
    refKey: attachment.refKey,
    fieldId: attachment.fieldId,
    payloadPresent: attachment.inline === 1 || held.has(attachment.hash),
  }));

  const links = (
    db()
      .prepare(
        "SELECT l.to_card_id AS toCardId, c.name AS name FROM card_links l " +
          "LEFT JOIN cards c ON c.id = l.to_card_id WHERE l.from_card_id = ? ORDER BY l.ordinal",
      )
      .all(target) as { toCardId: string; name: string | null }[]
  ).map((link) => [link.toCardId, link.name] as const);

  const deckPath = deckList().find((deck) => deck.id === row.deckId)?.path ?? row.deckId;
  const reviews = db()
    .prepare(
      "SELECT count(*) AS n FROM reviews WHERE track_id IN (SELECT id FROM card_tracks WHERE card_id = ?)",
    )
    .pluck()
    .get(target) as number;

  const bundle: CardBundle = {
    id: row.id,
    name: row.name,
    content: row.content,
    deckId: row.deckId,
    deckPath,
    cardReverse: row.cardReverse,
    deckReverse: row.deckReverse,
    template,
    values,
    attachments,
    links,
    reviews,
  };
  post({ kind: "card", id, card: bundle });
}

/**
 * Bytes for one address.
 *
 * `readBlob` looks inline first and only then asks the store, which is what makes
 * the 26,947 inline text generations free: they are already in the card database.
 * The bytes are re-hashed here, in the browser, so "these are the corpus's bytes"
 * is checked rather than asserted, and then TRANSFERRED — the worker keeps no
 * copy, and no object URL is minted on this side of the line.
 */
function payload(id: number, hash: string): void {
  const readStart = performance.now();
  let bytes: Uint8Array;
  try {
    bytes = readBlob(db(), hash, store);
  } catch (error) {
    post({
      kind: "payload",
      id,
      hash,
      bytes: null,
      mime: "",
      readMs: performance.now() - readStart,
      addressOk: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const readMs = performance.now() - readStart;
  const mime = (db().prepare("SELECT mime FROM blobs WHERE hash = ?").pluck().get(hash) as string) ?? "";
  const addressOk = sha256Hex(bytes) === hash;
  // A fresh Uint8Array over its own buffer: better-sqlite3-shaped handles can
  // hand back a view into a larger buffer, and transferring that would move more
  // than the payload.
  const copy = bytes.slice();
  post({ kind: "payload", id, hash, bytes: copy, mime, readMs, addressOk }, [copy.buffer]);
}
