/**
 * ADD CARDS WITHOUT A BROWSER — through the mailbox, like `ojad-fill.ts`.
 *
 *     npx vite-node scripts/cards-add.ts -- --in cards.jsonl            # what it would send
 *     npx vite-node scripts/cards-add.ts -- --in cards.jsonl --apply    # send it
 *
 * One card per line:
 *
 *     {"deck":"日本語/単語","template":"単語","name":"停滞",
 *      "values":{"読み":"ていたい","意味":"stagnation","Reading":"false","優先":"true"}}
 *
 * `deck` is a path or an id, `template` a name or an id, and `values` are keyed
 * by FIELD NAME (an id works too). `"allowDuplicate": true` makes a card whose
 * name the template already has; without it the line is refused and the existing
 * card is printed — the same rule the app's form follows.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Until 2026-10-29 the only way to add a 漢検 batch was to drive the live app in
 * Chrome: the database is single-tab, so Zach had to close his own window for
 * the length of the batch, every browser call timed out at 45 s, and a fill that
 * lost its race left a card with empty fields. The devices already merge whatever
 * any sync slot holds (`ojad-fill.ts` relies on it), and a merge INSERTS a card
 * created elsewhere with its values and tracks. So a card can arrive the same way.
 *
 * ─── WHAT IT DOES ───────────────────────────────────────────────────────────
 *
 *   1. Pull the freshest real device's payload and this slot's own previous one,
 *      and merge both into a scratch copy of `build/hashigo.db` — so a card this
 *      script sent earlier, not yet merged by any device, still counts as existing
 *      (a kanji made in one run is linkable, by id, in the next).
 *   2. Make each card with `createCard` (`src/cards/create.ts`) — the app's own
 *      code: one transaction, values included, tracks opened, duplicates refused.
 *   3. Build a payload of ONLY those cards (plus any this slot sent before that
 *      no device has merged yet — never one a device already holds, or a card
 *      he deleted would come back on the next send), and merge it
 *      into a second fresh copy exactly as a device would. Refuse to send unless
 *      every card lands with every value and NOTHING ELSE changed.
 *
 * Dry by default. Cards reach a device on its next pull (decision 50: the boot
 * screen, or "sync now").
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { createCard, DuplicateCardError } from "../src/cards/index.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { exportSync, mergeSync, type SyncPayload } from "../src/sync/index.js";

const SLOT = "dev-cards-add";
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const inFile = args[args.indexOf("--in") + 1];
if (!args.includes("--in") || inFile === undefined) {
  console.error("usage: cards-add.ts -- --in cards.jsonl [--apply]");
  process.exit(2);
}

if (existsSync(".env")) process.loadEnvFile(".env");
const base = (process.env["VITE_MAILBOX_URL"] ?? "").replace(/\/+$/, "");
const token = process.env["VITE_MAILBOX_TOKEN"] ?? "";
if (base === "" || token === "") {
  console.error("VITE_MAILBOX_URL and VITE_MAILBOX_TOKEN must be in .env");
  process.exit(2);
}
const headers = { Authorization: `Bearer ${token}` };

interface Line {
  readonly deck: string;
  readonly template: string;
  readonly name: string;
  readonly values?: Readonly<Record<string, string | boolean>>;
  readonly allowDuplicate?: boolean;
}
const lines = readFileSync(inFile, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Line);

async function payloadOf(id: string): Promise<SyncPayload | null> {
  const response = await fetch(`${base}/sync/${encodeURIComponent(id)}`, { headers });
  if (!response.ok) return null;
  let bytes = Buffer.from(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  return JSON.parse(bytes.toString("utf8")) as SyncPayload;
}

// ── 1. the freshest device, plus what this slot already sent ───────────────
const listing = (await (await fetch(`${base}/sync/`, { headers })).json()) as {
  peers: { deviceId: string }[];
};
let freshest: SyncPayload | null = null;
for (const { deviceId } of listing.peers) {
  // Real devices only — `dev-` + 12 hex. The tool slots carry fragments.
  if (!/^dev-[0-9a-f]{12}$/.test(deviceId)) continue;
  const payload = await payloadOf(deviceId);
  if (payload !== null && (freshest === null || payload.archive.createdAt > freshest.archive.createdAt)) {
    freshest = payload;
  }
}
if (freshest === null) throw new Error("no device payload in the mailbox");
const previous = await payloadOf(SLOT);
console.log(`freshest payload: ${freshest.archive.createdAt}` + (previous === null ? "" : ` · this slot: ${previous.archive.createdAt}`));

const scratchDir = mkdtempSync(join(tmpdir(), "cards-add-"));
const fresh = (file: string): Db => {
  const path = join(scratchDir, file);
  copyFileSync("build/hashigo.db", path);
  const db = openDatabase(path, { applySchema: false });
  mergeSync(db, freshest!);
  if (previous !== null) mergeSync(db, previous);
  return db;
};

const db = fresh("hashigo.db");
try {
  // ── 2. make the cards ─────────────────────────────────────────────────────
  const deckId = (key: string): string => {
    const row = db.prepare("SELECT deck_id AS id FROM deck_paths WHERE deck_id = ? OR path = ?").get(key, key) as
      | { id: string }
      | undefined;
    if (row === undefined) throw new Error(`no deck ${key}`);
    return row.id;
  };
  const templateId = (key: string): string => {
    const rows = db.prepare("SELECT id FROM templates WHERE id = ? OR name = ?").all(key, key) as { id: string }[];
    if (rows.length !== 1) throw new Error(`template ${key} matches ${rows.length} templates`);
    return rows[0]!.id;
  };

  const made: { cardId: string; name: string; values: Record<string, string> }[] = [];
  let refused = 0;
  for (const line of lines) {
    const template = templateId(line.template);
    const fields = db
      .prepare("SELECT id, name FROM template_fields WHERE template_id = ?")
      .all(template) as { id: string; name: string }[];
    const values: Record<string, string> = {};
    for (const [key, raw] of Object.entries(line.values ?? {})) {
      const field = fields.find((entry) => entry.id === key) ?? fields.find((entry) => entry.name === key);
      if (field === undefined) throw new Error(`${line.name}: ${line.template} has no field ${key}`);
      values[field.id] = typeof raw === "boolean" ? String(raw) : raw;
    }
    try {
      const card = createCard(
        db,
        { deckId: deckId(line.deck), templateId: template, name: line.name, values },
        { allowDuplicate: line.allowDuplicate === true },
      );
      made.push({ cardId: card.cardId, name: line.name, values });
      console.log(`  + ${line.name}  ${card.cardId}  ${card.tracks.join("+")}`);
    } catch (cause) {
      if (!(cause instanceof DuplicateCardError)) throw cause;
      refused += 1;
      const ids = cause.existing.map((card) => card.cardId + (card.archived ? " (archived)" : "")).join(", ");
      console.log(`  = ${line.name}  ALREADY EXISTS: ${ids} — not made ("allowDuplicate": true to make it anyway)`);
    }
  }
  console.log(`${made.length} card(s) made · ${refused} refused as existing`);
  if (made.length === 0) {
    console.log("nothing to send");
    process.exitCode = refused > 0 ? 1 : 0;
  } else {
    // ── 3. the payload: these cards, plus what this slot carried before ──────
    const now = new Date().toISOString();
    // What this slot sent before is carried again ONLY while no device has it.
    // Once the freshest device holds a card, its own payload carries it to every
    // other device, and re-sending it here would be the one way a card he has
    // since DELETED comes back: a delete leaves no tombstone, a merge re-inserts
    // any app-made card a payload holds, and a device re-merges a slot whenever
    // its sha changes — which is every time this script sends.
    const onDevice = new Set((freshest.archive.localCards ?? []).map((card) => card.id));
    const pending = new Set(
      (previous?.archive.localCards ?? []).map((card) => card.id).filter((id) => !onDevice.has(id)),
    );
    const prior = {
      localCards: (previous?.archive.localCards ?? []).filter((card) => pending.has(card.id)),
      fieldValues: (previous?.archive.fieldValues ?? []).filter((value) => pending.has(value.cardId)),
      cardFlags: (previous?.cardFlags ?? []).filter((flags) => pending.has(flags.cardId)),
    };
    const ids = new Set(made.map((card) => card.cardId));
    const all = exportSync(db, now);
    const keep = <T>(rows: readonly T[], key: (row: T) => string, prior: readonly T[]): T[] => {
      const byKey = new Map(prior.map((row) => [key(row), row]));
      for (const row of rows) byKey.set(key(row), row);
      return [...byKey.values()];
    };
    const localCards = keep(
      (all.archive.localCards ?? []).filter((card) => ids.has(card.id)),
      (card) => card.id,
      prior.localCards,
    );
    const fieldValues = keep(
      all.archive.fieldValues.filter((value) => ids.has(value.cardId)),
      (value) => `${value.cardId}|${value.fieldId}`,
      prior.fieldValues,
    );
    const cardFlags = keep(
      all.cardFlags.filter((flags) => ids.has(flags.cardId)),
      (flags) => flags.cardId,
      prior.cardFlags,
    );
    const payload: SyncPayload = {
      syncVersion: freshest.syncVersion,
      archive: {
        archiveVersion: all.archive.archiveVersion,
        schemaVersion: all.archive.schemaVersion,
        createdAt: now,
        reviews: [],
        trackState: [],
        localFields: [],
        localCards,
        templates: [],
        fieldValues,
        settings: [],
        cardState: [],
        counts: {
          reviews: 0,
          trackState: 0,
          localFields: 0,
          localCards: localCards.length,
          templates: 0,
          fieldValues: fieldValues.length,
          settings: 0,
          cardState: 0,
        },
      },
      cardFlags,
      deckFlags: [],
      // `voicesCarried` left out ON PURPOSE: absent means "says nothing about voices".
      retiredClips: [],
    };

    // ── SELF-CHECK: merge it into a fresh copy exactly as a device would ─────
    const check = fresh("check.db");
    try {
      const snapshot = (): Map<string, string> =>
        new Map(
          (check.prepare("SELECT card_id || '|' || field_id AS k, value FROM card_field_values").all() as {
            k: string;
            value: string;
          }[]).map((row) => [row.k, row.value]),
        );
      const before = snapshot();
      const cardsBefore = (check.prepare("SELECT count(*) AS n FROM cards").get() as { n: number }).n;
      mergeSync(check, payload);
      const after = snapshot();
      const cardsAfter = (check.prepare("SELECT count(*) AS n FROM cards").get() as { n: number }).n;
      const problems: string[] = [];
      for (const card of made) {
        const row = check.prepare("SELECT name FROM cards WHERE id = ?").get(card.cardId) as { name: string } | undefined;
        if (row?.name !== card.name) problems.push(`${card.name}: the card did not land`);
        for (const [fieldId, value] of Object.entries(card.values)) {
          if (after.get(`${card.cardId}|${fieldId}`) !== value) problems.push(`${card.name}: ${fieldId} did not land`);
        }
        const tracks = (check.prepare("SELECT count(*) AS n FROM card_tracks WHERE card_id = ?").get(card.cardId) as { n: number }).n;
        if (tracks === 0) problems.push(`${card.name}: no tracks, so it would never be shown`);
      }
      const touched = [...before].filter(([key, value]) => after.get(key) !== value);
      if (touched.length > 0) problems.push(`${touched.length} value(s) on other cards changed`);
      if (cardsAfter !== cardsBefore + made.length) {
        problems.push(`expected ${made.length} new card(s), the merge made ${cardsAfter - cardsBefore}`);
      }
      console.log(`self-check: ${made.length} card(s), ${cardsAfter - cardsBefore} landed · ${touched.length} other value(s) changed`);
      if (problems.length > 0) {
        for (const problem of problems) console.error(`  ! ${problem}`);
        throw new Error("self-check failed — nothing sent");
      }
    } finally {
      check.close();
    }

    if (!apply) {
      console.log(`DRY RUN — would send ${made.length} new card(s) (${localCards.length} in the slot) from ${SLOT}. Add --apply to send.`);
    } else {
      const response = await fetch(`${base}/sync/${SLOT}`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log(`sent ${made.length} new card(s) from ${SLOT}: ${response.status} ${await response.text()}`);
      if (!response.ok) process.exitCode = 1;
    }
  }
} finally {
  db.close();
  rmSync(scratchDir, { recursive: true, force: true });
}
