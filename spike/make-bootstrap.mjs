/**
 * THROWAWAY (spike harness). Produce the prebuilt database the spike page fetches.
 *
 *   node spike/make-bootstrap.mjs [--db build/hashigo.db] [--out build/spike/hashigo-bootstrap.db]
 *
 * Why this exists at all: `build/hashigo.db` is in WAL mode (its header bytes 18
 * and 19 are both 2) and it has `-wal` / `-shm` sidecars. `opfs-sahpool` stores
 * one file per name, so a sidecar cannot be imported — anything still living only
 * in the `-wal` file would be silently missing in the browser. `VACUUM INTO`
 * reads through the WAL and writes one self-contained, checkpointed,
 * delete-journal file, which is exactly what `importDb()` wants.
 *
 * It opens the source READ-ONLY on purpose: other work in this repo uses
 * `build/hashigo.db` at the same time and a bootstrap step must not checkpoint,
 * relocate or otherwise touch it.
 */
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const source = resolve(flag("--db", "build/hashigo.db"));
const target = resolve(flag("--out", "build/spike/hashigo-bootstrap.db"));

if (!existsSync(source)) {
  console.error(
    `spike/make-bootstrap: ${source} does not exist. Build it first:\n` +
      `  npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報`,
  );
  process.exit(1);
}

/** Header bytes 18 and 19: 1 = rollback journal, 2 = WAL. */
function journalHeader(file) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(20);
    readSync(fd, head, 0, 20, 0);
    return { write: head[18], read: head[19] };
  } finally {
    closeSync(fd);
  }
}

mkdirSync(dirname(target), { recursive: true });
if (existsSync(target)) rmSync(target, { force: true });

const before = journalHeader(source);
console.log(`source ${source}`);
console.log(`  ${statSync(source).size.toLocaleString()} bytes, header write=${before.write} read=${before.read}` +
  `${before.write === 2 ? " (WAL)" : " (rollback journal)"}`);
for (const sidecar of ["-wal", "-shm"]) {
  if (existsSync(source + sidecar)) {
    console.log(`  sidecar ${sidecar}: ${statSync(source + sidecar).size.toLocaleString()} bytes` +
      ` — NOT importable into OPFS, which is why this script exists`);
  }
}

const started = Date.now();
const db = new Database(source, { readonly: true });
db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
db.close();

const after = journalHeader(target);
if (after.write !== 1) {
  // Belt and braces: VACUUM INTO is documented to emit a plain rollback-journal
  // file, but if that ever changes, fix it here rather than in the browser.
  const fix = new Database(target);
  fix.pragma("journal_mode = delete");
  fix.close();
}

const check = new Database(target, { readonly: true });
const totals = check.prepare("SELECT cards, reviews, retention, study_days, hours FROM study_totals").get();
const version = check.pragma("user_version", { simple: true });
check.close();

console.log(`target ${target}`);
console.log(
  `  ${statSync(target).size.toLocaleString()} bytes, header write=${journalHeader(target).write} ` +
    `read=${journalHeader(target).read}, user_version=${version}, in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
console.log(
  `  cards ${totals.cards.toLocaleString()} | reviews ${totals.reviews.toLocaleString()} | ` +
    `retention ${(totals.retention * 100).toFixed(2)}% | active days ${totals.study_days} | ` +
    `hours ${totals.hours.toFixed(1)}`,
);
