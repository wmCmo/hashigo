import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import { SqliteBlobStore } from "../src/blobs/sqlite.js";
import { primaryLabelFor } from "../src/accent/store.js";
import { contentAddress } from "../src/import/blobs.js";
import { measureAudio, mib } from "./audio-gc-core.js";

process.stdout.setDefaultEncoding("utf8");

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : argv[at + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
};

const cardSource = resolve(flag("db", "build/hashigo.db"));
const storeSource = resolve(flag("store", `${flag("db", "build/hashigo.db")}.blobs.db`));
const outDir = resolve(flag("out", "build/app"));

if (argv.includes("--allow-orphans")) {
  console.log("audio check SKIPPED (--allow-orphans) — unreached clips may ship to every device");
} else {
  const audit = await measureAudio({ db: cardSource, storeDb: storeSource, graceDays: 14 });
  const left = audit.plan.doomed.length + audit.rowless.length;
  if (left > 0) {
    console.error(
      `refusing to build a seed: ${audit.plan.doomed.length} unreached clip(s) and ` +
        `${audit.rowless.length} payload(s) with no row (${mib(audit.doomedBytes + audit.rowlessBytes)}).\n` +
        `  npx vite-node scripts/audio-gc.ts             # see them\n` +
        `  npx vite-node scripts/audio-gc.ts -- --apply  # archive and remove, then run this again`,
    );
    process.exit(1);
  }
  console.log(
    `audio check: nothing unreached across ${audit.sources.length} device payload(s) · ` +
      `${audit.plan.kept.recent} recent clip(s) kept for unsynced devices`,
  );
}
const speechBudget = Number(flag("speech-bytes", String(200 * 1024 * 1024)));

const cardOut = resolve(outDir, "hashigo-app.db");
const storeOut = resolve(outDir, "hashigo-app-blobs.db");
const genOut = resolve(outDir, "hashigo-app-gen.db");
const fieldsOut = resolve(outDir, "hashigo-app-fields.db");
let genRows = 0;
let genBytes = 0;
let fieldRows = 0;
let fieldValueRows = 0;
let fieldCorrectionRows = 0;

function journalMode(file: string): { write: number; read: number } {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(20);
    readSync(fd, head, 0, 20, 0);
    return { write: head[18] ?? 0, read: head[19] ?? 0 };
  } finally {
    closeSync(fd);
  }
}

function need(file: string, how: string): void {
  if (existsSync(file)) return;
  process.stdout.write(`app-bootstrap: ${file} does not exist.\n  ${how}\n`);
  process.exit(1);
}

need(
  cardSource,
  "npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報",
);
need(storeSource, "the blob store is written by the same import; check --store");

mkdirSync(outDir, { recursive: true });

for (const stale of [cardOut, `${cardOut}-wal`, `${cardOut}-shm`]) {
  if (existsSync(stale)) rmSync(stale);
}

const source = new Database(cardSource, { readonly: true, fileMustExist: true });
try {
  const cards = Number(
    (source.prepare("SELECT count(*) AS n FROM cards").get() as { n: number }).n,
  );
  const reviews = Number(
    (source.prepare("SELECT count(*) AS n FROM reviews").get() as { n: number }).n,
  );
  source.prepare("VACUUM INTO ?").run(cardOut);
  const mode = journalMode(cardOut);
  if (mode.write === 2 || mode.read === 2) {
    process.stdout.write(
      `app-bootstrap: ${cardOut} came out in WAL mode (${mode.write}/${mode.read}). ` +
        `opfs-sahpool cannot import that — it stores one file per name and the -wal ` +
        `sidecar would be lost silently. Refusing to ship it.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `cards   ${cardOut}\n` +
      `        ${statSync(cardOut).size.toLocaleString()} bytes · ` +
      `${cards.toLocaleString()} cards · ${reviews.toLocaleString()} reviews · ` +
      `journal ${mode.write}/${mode.read}\n`,
  );
} finally {
  source.close();
}

const previousAudio = ((): { created: string; hashes: string } | null => {
  if (!existsSync(storeOut)) return null;
  const old = new Database(storeOut, { readonly: true });
  try {
    const created = old.prepare("SELECT value FROM blob_store_meta WHERE key = 'created'").pluck().get();
    if (typeof created !== "string") return null;
    const hashes = (old.prepare("SELECT hash FROM blob_payloads ORDER BY hash").pluck().all() as string[]).join(",");
    return { created, hashes };
  } catch {
    return null;
  } finally {
    old.close();
  }
})();

for (const stale of [storeOut, `${storeOut}-wal`, `${storeOut}-shm`]) {
  if (existsSync(stale)) rmSync(stale);
}

interface Candidate {
  readonly hash: string;
  readonly kind: string;
  readonly bytes: number;
}

const from = new Database(storeSource, { readonly: true, fileMustExist: true });
const target = new Database(storeOut);
const cardDb = new Database(cardOut, { readonly: true, fileMustExist: true });
try {
  target.pragma("journal_mode = delete");
  const store = new SqliteBlobStore(target as never);

  const kindByHash = new Map(
    (cardDb.prepare("SELECT hash, kind FROM blobs").all() as {
      hash: string;
      kind: string;
    }[]).map((row) => [row.hash, row.kind]),
  );

  const speechByCard = new Map<string, string[]>();
  for (const row of cardDb
    .prepare(
      `SELECT r.card_id AS card, b.hash AS hash
         FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash
        WHERE b.kind = 'speech'`,
    )
    .all() as { card: string; hash: string }[]) {
    speechByCard.set(row.card, [...(speechByCard.get(row.card) ?? []), row.hash]);
  }
  const storeSize = new Map(
    (from.prepare("SELECT hash, byte_size FROM blob_payloads").all() as {
      hash: string;
      byte_size: number;
    }[]).map((row) => [row.hash, row.byte_size]),
  );
  const firstWave = new Set<string>();
  for (const hashes of speechByCard.values()) {
    const present = hashes.filter((hash) => storeSize.has(hash));
    if (present.length === 0) continue;
    let cheapest = present[0] as string;
    for (const hash of present) {
      if ((storeSize.get(hash) as number) < (storeSize.get(cheapest) as number)) cheapest = hash;
    }
    firstWave.add(cheapest);
  }

  const candidates = (
    from
      .prepare("SELECT hash, byte_size AS bytes FROM blob_payloads ORDER BY byte_size ASC")
      .all() as { hash: string; bytes: number }[]
  ).map<Candidate>((row) => ({
    hash: row.hash,
    kind: kindByHash.get(row.hash) ?? "orphan",
    bytes: row.bytes,
  }));

  let written = 0;
  let bytes = 0;
  let speechBytes = 0;
  let skipped = 0;
  const kinds = new Map<string, number>();
  const readBytes = from.prepare("SELECT bytes FROM blob_payloads WHERE hash = ?").pluck();

  const waves = [
    candidates.filter((c) => c.kind !== "speech" || firstWave.has(c.hash)),
    candidates.filter((c) => c.kind === "speech" && !firstWave.has(c.hash)),
  ];
  for (const candidate of waves.flat()) {
    const isSpeech = candidate.kind === "speech";
    if (isSpeech && speechBytes + candidate.bytes > speechBudget) {
      skipped += 1;
      continue;
    }
    if (candidate.kind === "orphan") {
      skipped += 1;
      continue;
    }
    const payload = readBytes.get(candidate.hash) as Uint8Array | undefined;
    if (payload === undefined) {
      skipped += 1;
      continue;
    }
    const address = contentAddress(payload);
    if (address !== candidate.hash) {
      process.stdout.write(
        `app-bootstrap: ${candidate.hash} re-hashes to ${address}. ` +
          `The source store is corrupt; refusing to ship it.\n`,
      );
      process.exit(1);
    }
    store.write(candidate.hash, payload);
    written += 1;
    bytes += candidate.bytes;
    if (isSpeech) speechBytes += candidate.bytes;
    kinds.set(candidate.kind, (kinds.get(candidate.kind) ?? 0) + 1);
  }

  const shipped = new Set(
    (target.prepare("SELECT hash FROM blob_payloads").all() as { hash: string }[]).map(
      (row) => row.hash,
    ),
  );
  const rows = cardDb
    .prepare(
      `SELECT r.card_id AS card, b.hash AS hash
         FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash
        WHERE b.kind = 'speech'`,
    )
    .all() as { card: string; hash: string }[];
  const byCard = new Map<string, string[]>();
  for (const row of rows) byCard.set(row.card, [...(byCard.get(row.card) ?? []), row.hash]);
  let reachable = 0;
  for (const [, list] of byCard) if (list.some((hash) => shipped.has(hash))) reachable += 1;
  const total = byCard.size;

  if (previousAudio !== null && previousAudio.hashes === [...shipped].sort().join(",")) {
    target.prepare("UPDATE blob_store_meta SET value = ? WHERE key = 'created'").run(previousAudio.created);
    process.stdout.write(`audio   unchanged since ${previousAudio.created} — devices will not re-fetch it\n`);
  }

  {
    const genDb = new Database(genOut);
    genDb.exec("PRAGMA journal_mode = DELETE");
    genDb.exec(`
      DROP TABLE IF EXISTS generations;
      DROP TABLE IF EXISTS gen_meta;
      CREATE TABLE generations (
        hash        TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        mime        TEXT NOT NULL,
        byte_size   INTEGER NOT NULL,
        source_text TEXT,
        voice       TEXT,
        lang        TEXT,
        options     TEXT NOT NULL,
        bytes       BLOB NOT NULL,
        refcount    INTEGER NOT NULL
      );
      CREATE TABLE gen_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const insert = genDb.prepare(
      `INSERT INTO generations
         (hash, kind, mime, byte_size, source_text, voice, lang, options, bytes, refcount)
       VALUES (@hash, @kind, @mime, @byte_size, @source_text, @voice, @lang, @options, @bytes, @refcount)`,
    );
    const rows = cardDb
      .prepare(
        `SELECT hash, kind, mime, byte_size, source_text, voice, lang, options, bytes, refcount
           FROM blobs
          WHERE kind IN ('ai', 'translate', 'furigana', 'dictionary')
            AND bytes IS NOT NULL AND byte_size > 0`,
      )
      .all() as Record<string, unknown>[];
    genDb.transaction(() => {
      for (const row of rows) insert.run(row);
      genDb
        .prepare("INSERT INTO gen_meta (key, value) VALUES ('created', ?)")
        .run(new Date().toISOString());
    })();
    genDb.exec("VACUUM");
    genDb.close();
    genRows = rows.length;
    genBytes = rows.reduce((n, row) => n + Number(row["byte_size"] ?? 0), 0);
  }

  {
    const fieldsDb = new Database(fieldsOut);
    fieldsDb.exec("PRAGMA journal_mode = DELETE");
    fieldsDb.exec(`
      DROP TABLE IF EXISTS local_fields;
      DROP TABLE IF EXISTS local_values;
      DROP TABLE IF EXISTS field_meta;
      CREATE TABLE local_fields (
        template_id     TEXT NOT NULL,
        id              TEXT NOT NULL,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL,
        source_field_id TEXT,
        options         TEXT,
        pos             INTEGER NOT NULL,
        PRIMARY KEY (template_id, id)
      );
      CREATE TABLE local_values (
        card_id  TEXT NOT NULL,
        field_id TEXT NOT NULL,
        value    TEXT NOT NULL,
        PRIMARY KEY (card_id, field_id)
      );
      CREATE TABLE field_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- 端末の値が was のままなら value に置き換える。app/local-fields.ts の見出し
      -- 「ひとつだけの例外」を参照。
      DROP TABLE IF EXISTS local_corrections;
      CREATE TABLE local_corrections (
        card_id  TEXT NOT NULL,
        field_id TEXT NOT NULL,
        was      TEXT NOT NULL,
        value    TEXT NOT NULL,
        PRIMARY KEY (card_id, field_id)
      );
    `);
    const fieldDefs = cardDb
      .prepare(
        `SELECT template_id, id, name, type, source_field_id, options, pos
           FROM template_fields WHERE local = 1`,
      )
      .all() as Record<string, unknown>[];
    const values = cardDb
      .prepare(
        `SELECT v.card_id, v.field_id, v.value
           FROM card_field_values v
           JOIN cards c ON c.id = v.card_id
           JOIN template_fields f ON f.template_id = c.template_id AND f.id = v.field_id
          WHERE f.local = 1`,
      )
      .all() as Record<string, unknown>[];
    const putField = fieldsDb.prepare(
      `INSERT INTO local_fields (template_id, id, name, type, source_field_id, options, pos)
       VALUES (@template_id, @id, @name, @type, @source_field_id, @options, @pos)`,
    );
    const putValue = fieldsDb.prepare(
      `INSERT INTO local_values (card_id, field_id, value) VALUES (@card_id, @field_id, @value)`,
    );
    const accentValues = cardDb
      .prepare(
        `SELECT v.card_id, v.field_id, v.value, head.value AS head
           FROM card_field_values v
           JOIN cards c ON c.id = v.card_id
           JOIN template_fields f ON f.template_id = c.template_id AND f.id = v.field_id
           JOIN card_field_values head ON head.card_id = v.card_id AND head.field_id = f.source_field_id
          WHERE f.local = 1 AND f.type = 'accent'`,
      )
      .all() as { card_id: string; field_id: string; value: string; head: string }[];
    const corrections = accentValues.flatMap((row) => {
      const was = primaryLabelFor(cardDb, row.head);
      return was === null || was === row.value
        ? []
        : [{ card_id: row.card_id, field_id: row.field_id, was, value: row.value }];
    });
    const putCorrection = fieldsDb.prepare(
      `INSERT INTO local_corrections (card_id, field_id, was, value)
       VALUES (@card_id, @field_id, @was, @value)`,
    );
    fieldsDb.transaction(() => {
      for (const row of fieldDefs) putField.run(row);
      for (const row of values) putValue.run(row);
      for (const row of corrections) putCorrection.run(row);
      fieldsDb
        .prepare("INSERT INTO field_meta (key, value) VALUES ('created', ?)")
        .run(new Date().toISOString());
    })();
    fieldsDb.exec("VACUUM");
    fieldsDb.close();
    fieldRows = fieldDefs.length;
    fieldValueRows = values.length;
    fieldCorrectionRows = corrections.length;
  }

  const seedReviews = Number(
    (
      cardDb
        .prepare("SELECT count(*) AS n FROM reviews WHERE source <> 'local'")
        .get() as { n: number }
    ).n,
  );
  const manifestPath = resolve(dirname(cardOut), "hashigo-app.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        schemaVersion: Number(cardDb.pragma("user_version", { simple: true })),
        cards: Number(
          (cardDb.prepare("SELECT count(*) AS n FROM cards").get() as { n: number }).n,
        ),
        seedReviews,
        payloads: written,
        generations: genRows,
        genCreated: String(
          (
            new Database(genOut, { readonly: true })
              .prepare("SELECT value FROM gen_meta WHERE key = 'created'")
              .get() as { value: string } | undefined
          )?.value ?? "",
        ),
        fieldValues: fieldValueRows,
        fieldsCreated: String(
          (
            new Database(fieldsOut, { readonly: true })
              .prepare("SELECT value FROM field_meta WHERE key = 'created'")
              .get() as { value: string } | undefined
          )?.value ?? "",
        ),
        storeCreated: String(
          (
            new Database(storeOut, { readonly: true })
              .prepare("SELECT value FROM blob_store_meta WHERE key = 'created'")
              .get() as { value: string } | undefined
          )?.value ?? "",
        ),
      },
      null,
      2,
    )}
`,
    "utf8",
  );

  process.stdout.write(
    `fields  ${fieldsOut}
` +
      `        ${statSync(fieldsOut).size.toLocaleString()} bytes on disk · ` +
      `${fieldRows} local field(s) · ${fieldValueRows.toLocaleString()} value(s) · ${fieldCorrectionRows} correction(s)
` +
      `        ojad / 型 / 読み / かな主流 — authored here, in no Mochi export
`,
  );

  process.stdout.write(
    `text    ${genOut}\n` +
      `        ${statSync(genOut).size.toLocaleString()} bytes on disk · ` +
      `${genRows.toLocaleString()} generations · ${genBytes.toLocaleString()} payload bytes\n` +
      `        every ai / translate / furigana / dictionary row — no budget, it is 1.6 MiB\n`,
  );

  const mode = journalMode(storeOut);
  process.stdout.write(
    `audio   ${storeOut}\n` +
      `        ${statSync(storeOut).size.toLocaleString()} bytes on disk · ` +
      `${written.toLocaleString()} payloads · ${bytes.toLocaleString()} payload bytes\n` +
      `        kinds ${JSON.stringify(Object.fromEntries(kinds))} · ` +
      `${skipped.toLocaleString()} left out (speech budget ${speechBudget.toLocaleString()})\n` +
      `        journal ${mode.write}/${mode.read}\n` +
      `coverage ${reachable.toLocaleString()} of ${total.toLocaleString()} cards with speech ` +
      `can play something (${((100 * reachable) / Math.max(total, 1)).toFixed(1)}%)\n` +
      `\nServe them: npm run app:dev -- --host ::\n`,
  );
} finally {
  cardDb.close();
  target.close();
  from.close();
}
