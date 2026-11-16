import { resolve } from "node:path";

import Database from "better-sqlite3";

import { defaultStoreDatabase } from "../src/blobs/index.js";
import { measureAudio, mib, ROOT } from "./audio-gc-core.js";

const DB = resolve(ROOT, "build/hashigo.db");
const OUT = resolve(ROOT, "build/audio-gc");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const graceArg = args.indexOf("--grace-days");
const GRACE_DAYS = graceArg >= 0 ? Number(args[graceArg + 1]) : 14;
if (!Number.isFinite(GRACE_DAYS) || GRACE_DAYS < 0) throw new Error("--grace-days must be a number >= 0");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const audit = await measureAudio({ db: DB, storeDb: defaultStoreDatabase(DB), graceDays: GRACE_DAYS });
const { plan, rowless, rowlessBytes, doomedBytes, store } = audit;
for (const source of audit.sources) console.log(`merged  ${source}`);

console.log("");
console.log(`cards ${audit.reachMerged.cards} · audio mounts ${audit.reachMerged.mounts} · with no clip at all ${audit.reachMerged.silentMounts}`);
console.log(`audio rows ${audit.rows.length}`);
console.log(`  kept: reached ${plan.kept.reached} · retired ${plan.kept.retired} · made in the last ${GRACE_DAYS} days ${plan.kept.recent}`);
console.log(`  unreached by any device        ${plan.doomed.length}  ${mib(doomedBytes)}`);
console.log(`payloads with no row             ${rowless.length}  ${mib(rowlessBytes)}`);
console.log(`reached only through a device's edits (the laptop alone would have lost these) ${audit.reachedOnlyOnDevices}`);

if (!APPLY) {
  console.log("\nreport only — nothing changed. Run with --apply to archive and remove.");
  process.exit(0);
}
if (plan.doomed.length === 0 && rowless.length === 0) {
  console.log("\nnothing to remove.");
  process.exit(0);
}
const archivePath = resolve(OUT, `removed-${stamp}.db`);
const archive = new Database(archivePath);

const main = new Database(DB);
main.exec(`ATTACH '${archivePath.replace(/'/g, "''")}' AS gc`);
main.exec(`CREATE TABLE gc.blobs AS SELECT * FROM blobs WHERE 0`);
main.exec(`CREATE TABLE gc.blob_refs AS SELECT * FROM blob_refs WHERE 0`);
archive.exec(`CREATE TABLE IF NOT EXISTS blob_payloads (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL, had_row INTEGER NOT NULL)`);
const doomed = plan.doomed.map((row) => row.hash);
const inDoomed = `hash IN (SELECT value FROM json_each(?))`;
const list = JSON.stringify(doomed);
main.prepare(`INSERT INTO gc.blobs SELECT * FROM blobs WHERE ${inDoomed}`).run(list);
main.prepare(`INSERT INTO gc.blob_refs SELECT * FROM blob_refs WHERE blob_hash IN (SELECT value FROM json_each(?))`).run(list);
const putPayload = archive.prepare(`INSERT OR IGNORE INTO blob_payloads (hash, bytes, had_row) VALUES (?, ?, ?)`);
archive.transaction(() => {
  for (const hash of doomed) if (store.has(hash)) putPayload.run(hash, store.read(hash), 1);
  for (const hash of rowless) putPayload.run(hash, store.read(hash), 0);
})();
const archived = archive.prepare(`SELECT count(*) AS n FROM blob_payloads`).get() as { n: number };
archive.close();
console.log(`\narchived ${doomed.length} row(s) and ${archived.n} payload(s) to ${archivePath}`);

main.transaction(() => {
  main.prepare(`DELETE FROM blob_refs WHERE blob_hash IN (SELECT value FROM json_each(?))`).run(list);
  main.prepare(`UPDATE blobs SET refcount = 0 WHERE ${inDoomed}`).run(list);
  const gone = main.prepare(`DELETE FROM blobs WHERE ${inDoomed}`).run(list).changes;
  if (gone !== doomed.length) throw new Error(`deleted ${gone} rows, planned ${doomed.length} — rolled back`);
})();
main.exec("DETACH gc");
main.close();

let removed = 0;
for (const hash of [...doomed, ...rowless]) if (store.remove(hash)) removed += 1;
console.log(`removed ${doomed.length} row(s) and ${removed} payload(s) (${mib(doomedBytes + rowlessBytes)})`);
console.log(`undo: the rows and bytes are in ${archivePath}`);
