/**
 * THROWAWAY (spike harness). The dedicated Worker: everything that touches
 * SQLite happens here and nowhere else.
 *
 * What it proves, in order:
 *
 *   1. `@sqlite.org/sqlite-wasm` loads from a Vite BUNDLE (dev and built), with
 *      no COOP/COEP headers and no cross-origin isolation.
 *   2. `src/schema/schema.sql` and `src/schema/views.sql`, imported as text by the
 *      bundler and byte-for-byte unmodified, create the whole schema in a fresh
 *      OPFS database — and the table/view/trigger counts say so.
 *   3. What `PRAGMA journal_mode = WAL` actually does on `opfs-sahpool`. This is
 *      the claim `src/db/open.ts` used to make and nobody had tested.
 *   4. The real 7,716-card database, imported into OPFS once, reproduces the
 *      oracle — and reproduces it again after a reload with no re-import.
 */

import schemaSql from "../src/schema/schema.sql?raw";
import viewsSql from "../src/schema/views.sql?raw";

import {
  DEFAULT_DATABASE,
  POOL_INITIAL_CAPACITY,
  SCHEMA_VERSION,
  applySchema,
  checkIntegrity,
  databaseFilesInOpfs,
  deleteDatabaseBrowser,
  importDatabaseBrowser,
  inDedicatedWorker,
  installPool,
  openDatabaseBrowser,
  sqlite3,
  sqliteVersion,
  type BrowserDb,
} from "../src/db/browser.js";

import type { DoneMessage, LogMessage, RowsMessage, SpikeRequest } from "./protocol.js";

const FRESH_DATABASE = "/spike-fresh.db";
const BOOTSTRAP_URL = "/hashigo-bootstrap.db";
const PROBE_KEY = "_spike_probe";

const post = (message: LogMessage | DoneMessage | RowsMessage): void => {
  self.postMessage(message);
};
const log = (text: string): void => post({ kind: "log", level: "info", text });
const step = (text: string): void => post({ kind: "log", level: "step", text });
const good = (text: string): void => post({ kind: "log", level: "good", text });
const bad = (text: string): void => post({ kind: "log", level: "bad", text });

const ms = (from: number): string => `${(performance.now() - from).toFixed(1)}ms`;
const n = (value: unknown): string => Number(value).toLocaleString("en-US");

/** The schema version vite.config.ts parsed out of src/schema/index.ts. */
declare const __SCHEMA_VERSION_FROM_NODE__: number;

self.onmessage = (event: MessageEvent<SpikeRequest>): void => {
  const request = event.data;
  if (request.kind === "query") {
    void runQuery(request.id, request.sql);
    return;
  }
  if (request.kind === "exhaust") {
    void exhaustPool(request.id);
    return;
  }
  void run(request);
};

/**
 * How does a pool that has run out of slots fail? This is the question
 * POOL_INITIAL_CAPACITY exists to answer, and the answer decides whether a
 * second (blob) database is safe.
 */
async function exhaustPool(id: number): Promise<void> {
  const opened: BrowserDb[] = [];
  const names: string[] = [];
  try {
    const pool = await installPool();
    step("POOL EXHAUSTION PROBE");
    log(`  capacity ${pool.getCapacity()}, files ${pool.getFileCount()} before`);
    for (let index = 0; index < 40; index += 1) {
      const name = `/probe-${index}.db`;
      const db = await openDatabaseBrowser({ filename: name, applySchema: false });
      opened.push(db);
      names.push(name);
      // A write forces a rollback journal, which needs a slot of its own.
      db.exec("CREATE TABLE IF NOT EXISTS t (x)");
      db.transaction(() => db.prepare("INSERT INTO t (x) VALUES (1)").run())();
      log(`  opened and wrote ${name}; files now ${pool.getFileCount()}`);
    }
    bad("  the pool never refused, which contradicts a fixed capacity");
  } catch (error) {
    good(`  refused after ${opened.length} extra database(s): ${String(error)}`);
    log("  ^ this is what a blob database beyond capacity looks like at runtime");
  } finally {
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // best effort
      }
    }
    for (const name of names) await deleteDatabaseBrowser(name);
    const pool = await installPool();
    log(`  cleaned up; capacity ${pool.getCapacity()}, files ${pool.getFileCount()}: ${JSON.stringify(pool.getFileNames())}`);
    post({ kind: "done", id, ok: true, oracle: null });
  }
}

async function runQuery(id: number, sql: string): Promise<void> {
  try {
    const db = await openDatabaseBrowser({ applySchema: false });
    try {
      post({ kind: "rows", id, rows: db.prepare(sql).all() });
    } finally {
      db.close();
    }
  } catch (error) {
    post({ kind: "rows", id, rows: [], error: String(error) });
  }
}

async function run(request: SpikeRequest & { kind: "run" }): Promise<void> {
  const oracle: Record<string, string | number> = {};
  try {
    // ── 1. where are we ────────────────────────────────────────────────────
    step("1. environment");
    log(`  inDedicatedWorker()      ${inDedicatedWorker()}`);
    log(`  isSecureContext          ${self.isSecureContext}`);
    log(`  crossOriginIsolated      ${self.crossOriginIsolated}  <- no COOP/COEP is set`);
    log(`  SharedArrayBuffer        ${typeof SharedArrayBuffer}`);
    log(`  navigator.storage.persist in WORKER: ${typeof navigator.storage.persist}`);
    log(`  page reported persisted(): ${request.persisted}`);
    if (self.crossOriginIsolated) {
      bad("  crossOriginIsolated is TRUE — something set COOP/COEP. The point of sahpool is that it need not be set.");
    }

    // ── 2. the wasm build ─────────────────────────────────────────────────
    step("2. sqlite-wasm, loaded through the bundler");
    const t0 = performance.now();
    const api = await sqlite3();
    log(`  sqlite ${await sqliteVersion()} initialised in ${ms(t0)}`);
    log(`  wasm entry: ${api.version.downloadVersion} / ${api.version.sourceId.slice(0, 20)}`);
    const scratch = new api.oo1.DB(":memory:");
    const options = scratch.selectValues("PRAGMA compile_options") as string[];
    scratch.close();
    const wanted = ["ENABLE_FTS5", "ENABLE_RTREE", "ENABLE_MATH_FUNCTIONS", "THREADSAFE=0"];
    for (const option of wanted) {
      const present = options.some((value) => value === option || value.endsWith(option));
      (present ? good : bad)(`  compile option ${option}: ${present ? "present" : "MISSING"}`);
    }

    // ── 3. the pool ───────────────────────────────────────────────────────
    step("3. opfs-sahpool");
    const tInstall = performance.now();
    const pool = await installPool();
    log(`  installed as vfs ${JSON.stringify(pool.vfsName)} in ${ms(tInstall)}`);
    log(
      `  capacity ${n(pool.getCapacity())} (requested ${POOL_INITIAL_CAPACITY}, ` +
        `sqlite-wasm default is 6), files ${n(pool.getFileCount())}`,
    );
    log(`  files: ${JSON.stringify(pool.getFileNames())}`);

    // ── 4. the real schema, unmodified, into a fresh OPFS database ────────
    step("4. src/schema/*.sql -> a fresh OPFS database");
    log(`  schema.sql ${n(schemaSql.length)} chars, views.sql ${n(viewsSql.length)} chars (bundled as ?raw text)`);
    await deleteDatabaseBrowser(FRESH_DATABASE);
    const tFresh = performance.now();
    const fresh = await openDatabaseBrowser({
      filename: FRESH_DATABASE,
      schema: [
        { name: "schema.sql", sql: schemaSql },
        { name: "views.sql", sql: viewsSql },
      ],
    });
    try {
      log(`  created and applied in ${ms(tFresh)}`);
      const counts = fresh
        .prepare(
          "SELECT type, count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type",
        )
        .all() as { type: string; n: number }[];
      for (const row of counts) log(`  ${row.type.padEnd(8)} ${row.n}`);
      const tables = counts.find((row) => row.type === "table")?.n ?? 0;
      const views = counts.find((row) => row.type === "view")?.n ?? 0;
      const triggers = counts.find((row) => row.type === "trigger")?.n ?? 0;
      oracle["fresh tables"] = tables;
      oracle["fresh views"] = views;
      oracle["fresh triggers"] = triggers;

      const ftsDdl = fresh
        .prepare("SELECT sql FROM sqlite_schema WHERE name = 'card_fts'")
        .pluck()
        .get() as string | undefined;
      (ftsDdl?.includes("trigram") === true ? good : bad)(
        `  card_fts tokenizer: ${ftsDdl?.replace(/\s+/g, " ").slice(0, 120) ?? "MISSING"}`,
      );

      const version = Number(fresh.pragma("user_version", { simple: true }));
      const agree = version === SCHEMA_VERSION && version === __SCHEMA_VERSION_FROM_NODE__;
      (agree ? good : bad)(
        `  user_version ${version}; src/db/browser.ts says ${SCHEMA_VERSION}, ` +
          `src/schema/index.ts says ${__SCHEMA_VERSION_FROM_NODE__}` +
          (agree ? "" : "  <- DRIFT"),
      );
      oracle["schema version"] = version;

      // The claim src/db/open.ts used to make, tested.
      const before = String(fresh.pragma("journal_mode", { simple: true }));
      const asked = String(fresh.pragma("journal_mode = WAL", { simple: true }));
      const after = String(fresh.pragma("journal_mode", { simple: true }));
      log(`  journal_mode: ${before} -> asked for WAL -> reported ${asked} -> now ${after}`);
      (after === "wal" ? bad : good)(
        after === "wal"
          ? "  WAL TOOK on sahpool — src/db/open.ts's old comment would be right after all"
          : `  WAL does NOT take on sahpool; it stays ${after}. open.ts's comment was wrong.`,
      );
      oracle["journal mode"] = after;

      const problems = checkIntegrity(fresh);
      (problems.length === 0 ? good : bad)(
        `  integrity_check + foreign_key_check: ${problems.length === 0 ? "ok" : problems.join("; ")}`,
      );

      // applySchema is idempotent — the same guarantee open.ts makes.
      applySchema(fresh, [{ name: "schema.sql", sql: "SELECT 'not reached'" }]);
      good("  applySchema on an already-stamped database applied nothing");
    } finally {
      fresh.close();
    }

    // ── 5. the real database ─────────────────────────────────────────────
    step("5. the real 7,716-card database in OPFS");
    const held = await databaseFilesInOpfs();
    const alreadyThere = held.includes(DEFAULT_DATABASE);
    if (alreadyThere && !request.reimport) {
      good(`  ${DEFAULT_DATABASE} is already in OPFS — NOT re-importing (this is the reload path)`);
      oracle["import"] = "reattached, no re-import";
    } else {
      const tFetch = performance.now();
      const response = await fetch(BOOTSTRAP_URL);
      if (!response.ok) {
        throw new Error(
          `GET ${BOOTSTRAP_URL} -> ${response.status}. Run: npm run spike:bootstrap`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      log(`  fetched ${n(bytes.byteLength)} bytes in ${ms(tFetch)}`);
      log(`  header write=${bytes[18]} read=${bytes[19]} (1 = rollback journal, 2 = WAL)`);
      const tImport = performance.now();
      const written = await importDatabaseBrowser(DEFAULT_DATABASE, bytes);
      log(`  importDb -> OPFS: ${n(written)} bytes in ${ms(tImport)}`);
      oracle["import"] = `${n(written)} bytes imported`;
    }

    const tOpen = performance.now();
    const db = await openDatabaseBrowser({ applySchema: false });
    log(`  opened ${db.name} in ${ms(tOpen)}`);
    try {
      reportOracle(db, oracle);
      probeDurability(db);
      searchProbe(db);
    } finally {
      db.close();
    }

    // ── 6. pool and quota afterwards ─────────────────────────────────────
    step("6. pool and quota");
    log(`  capacity ${n(pool.getCapacity())}, files ${n(pool.getFileCount())}: ${JSON.stringify(pool.getFileNames())}`);
    const estimate = await navigator.storage.estimate();
    log(
      `  navigator.storage.estimate(): usage ${(Number(estimate.usage) / 1048576).toFixed(1)} MiB / ` +
        `quota ${(Number(estimate.quota) / 1073741824).toFixed(2)} GiB`,
    );
    log(`  persisted() in worker: ${await navigator.storage.persisted()}`);

    good("ALL STEPS COMPLETED");
    post({ kind: "done", id: request.id, ok: true, oracle });
  } catch (error) {
    bad(`FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    post({
      kind: "done",
      id: request.id,
      ok: false,
      oracle: null,
      error: String(error),
    });
  }
}

/** The oracle, from the OPFS-backed database. Numbers that must not move. */
function reportOracle(db: BrowserDb, oracle: Record<string, string | number>): void {
  const timings: string[] = [];
  const timed = <T,>(label: string, run: () => T): T => {
    const started = performance.now();
    const value = run();
    timings.push(`${label} ${(performance.now() - started).toFixed(1)}ms`);
    return value;
  };
  const totals = timed("study_totals", () => db
    .prepare(
      "SELECT cards, reviews, retention, hours, study_days, first_review_date, last_review_date FROM study_totals",
    )
    .get()) as {
    cards: number;
    reviews: number;
    retention: number;
    hours: number;
    study_days: number;
    first_review_date: string;
    last_review_date: string;
  };
  const kinds = timed("track split", () => db
    .prepare(
      "SELECT ct.kind AS kind, count(*) AS n FROM reviews r JOIN card_tracks ct ON ct.id = r.track_id GROUP BY ct.kind ORDER BY ct.kind",
    )
    .all()) as { kind: string; n: number }[];
  const one = (label: string, sql: string): number =>
    timed(label, () => Number(db.prepare(sql).pluck().get()));
  const decks = one("decks", "SELECT count(*) FROM decks");
  const tagRows = one("tags", "SELECT count(*) FROM tags");
  // cards_direct, not cards_subtree: the oracle's 19 is tags that are on a card
  // themselves. The 20th row is a parent path that only its children use.
  const tagsWithCards = one("tag_usage", "SELECT count(*) FROM tag_usage WHERE cards_direct > 0");
  const links = one("card_links", "SELECT count(*) FROM card_links");
  const templates = one("templates", "SELECT count(*) FROM templates");
  const blobs = one("blobs", "SELECT count(*) FROM blobs");
  const blobPaths = one("blobs.path", "SELECT count(*) FROM blobs WHERE path IS NOT NULL");
  const forward = kinds.find((row) => row.kind === "forward")?.n ?? 0;
  const reverse = kinds.find((row) => row.kind === "reverse")?.n ?? 0;

  const expected: Record<string, number> = {
    cards: 7716,
    reviews: 102020,
    forward: 58937,
    reverse: 43083,
    decks: 39,
    tags: 19,
    card_links: 8744,
    active_days: 1317,
  };
  const actual: Record<string, number> = {
    cards: totals.cards,
    reviews: totals.reviews,
    forward,
    reverse,
    decks,
    tags: tagsWithCards,
    card_links: links,
    active_days: totals.study_days,
  };

  log(`  cards        ${n(totals.cards)}`);
  log(`  reviews      ${n(totals.reviews)}`);
  log(`  fwd / rev    ${n(forward)} / ${n(reverse)}`);
  log(`  retention    ${(totals.retention * 100).toFixed(2)}%`);
  log(`  decks        ${n(decks)}   templates ${n(templates)}`);
  log(`  tags         ${n(tagsWithCards)} with cards (${n(tagRows)} rows)`);
  log(`  card_links   ${n(links)}`);
  log(`  active days  ${n(totals.study_days)}  ${totals.first_review_date} -> ${totals.last_review_date}`);
  log(`  study hours  ${totals.hours.toFixed(1)}`);
  log(`  blobs        ${n(blobs)}, with a path: ${n(blobPaths)}`);

  const wrong = Object.keys(expected).filter((key) => expected[key] !== actual[key]);
  if (wrong.length === 0) good("  ORACLE MATCHES on every figure, from OPFS");
  else bad(`  ORACLE MOVED: ${wrong.map((key) => `${key} ${actual[key]} != ${expected[key]}`).join(", ")}`);
  if (blobPaths !== 0) bad(`  ${blobPaths} blobs carry a path — locked decision 4 says zero`);

  oracle["cards"] = totals.cards;
  oracle["reviews"] = totals.reviews;
  oracle["forward / reverse"] = `${forward} / ${reverse}`;
  oracle["retention"] = `${(totals.retention * 100).toFixed(2)}%`;
  oracle["decks"] = decks;
  oracle["tags"] = tagsWithCards;
  oracle["card_links"] = links;
  oracle["active days"] = totals.study_days;
  oracle["study hours"] = totals.hours.toFixed(1);

  // Every figure above, timed individually. The dashboard's collect() takes ~7s
  // in Node over the same data, so these are the numbers stage 7 has to live
  // with, and study_totals (which reads all 102,020 rows through review_log) is
  // the one that matters.
  log(`  query times: ${timings.join(" | ")}`);
  oracle["study_totals ms"] = timings[0] ?? "";
}

/** Write, commit, and report what the previous run left behind. */
function probeDurability(db: BrowserDb): void {
  const previous = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .pluck()
    .get(PROBE_KEY) as string | undefined;
  if (previous === undefined) log("  no probe row from an earlier run (first run in this OPFS)");
  else good(`  probe row from an earlier run SURVIVED: ${previous}`);

  const stamp = new Date().toISOString();
  const t0 = performance.now();
  const write = db.transaction(() => {
    const result = db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(PROBE_KEY, stamp);
    return result.changes;
  });
  const changes = write();
  log(`  wrote probe ${stamp} (${changes} row) and committed in ${ms(t0)}`);
}

/** FTS5 trigram over the real corpus, from OPFS. What Ctrl+K depends on. */
function searchProbe(db: BrowserDb): void {
  const fts = db.prepare("SELECT count(*) FROM card_fts WHERE card_fts MATCH ?").pluck();
  for (const query of ["気持ち", "ありがとう", "勉強"]) {
    const t0 = performance.now();
    const hits = Number(fts.get(query));
    log(`  MATCH ${JSON.stringify(query)} (len ${[...query].length}) -> ${hits} in ${ms(t0)}`);
  }
  const t1 = performance.now();
  const like = Number(
    db.prepare("SELECT count(*) FROM cards WHERE search_text LIKE ?").pluck().get("%意味%"),
  );
  log(`  LIKE fallback '意味' -> ${like} in ${ms(t1)}`);
}
