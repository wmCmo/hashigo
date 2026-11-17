/**
 * PUT BACK THE TEMPLATE A CARD'S VALUES BELONG TO — Zach, 2026-11-17, showing
 * `dogmatic` as plain text on the phone: *"why is this template less"*, then
 * *"yes please"* to repairing all of them.
 *
 * Decision 66 made a card's template travel in sync and expected the repair to
 * be automatic. It was not: no device held these cards' templates, so there was
 * nothing to travel. Read across every device's payload on 2026-11-17, 35 cards
 * were template-less EVERYWHERE while holding field values of exactly one
 * template (27 単語, 5 New Vocab, 1 言葉), plus すずらん with values of two — it
 * sits in the 単語 deck, so a tie goes to the template named like its deck.
 *
 * HOW: one payload from its own slot, `dev-template-heal`, carrying only those
 * cards' flag rows with `templateId` set and `templatesCarried`. Each row is the
 * freshest device's row COPIED, clock included, so the archived / pinned rule
 * (last write wins on the clock) keeps every device's own values, while the
 * template rule takes it on any device where the card has none (`mergeSync`).
 * Sync never removes a template, so this is undone only per card, in the app.
 *
 * Dry by default; `--apply` sends. Self-checked first on a copy of the corpus
 * merged with the freshest device: every named card lands on its template, and
 * no other card's template, flags or values move.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { openDatabase } from "../src/db/index.js";
import { mergeSync, type SyncPayload } from "../src/sync/index.js";

const SLOT = "dev-template-heal";
const apply = process.argv.includes("--apply");

process.loadEnvFile(".env");
const base = (process.env["VITE_MAILBOX_URL"] ?? "").replace(/\/+$/, "");
const headers = { Authorization: `Bearer ${process.env["VITE_MAILBOX_TOKEN"] ?? ""}` };

async function payloadOf(id: string): Promise<SyncPayload | null> {
  const response = await fetch(`${base}/sync/${encodeURIComponent(id)}`, { headers });
  if (!response.ok) return null;
  let bytes = Buffer.from(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  return JSON.parse(bytes.toString("utf8")) as SyncPayload;
}

const corpus = openDatabase("build/hashigo.db", { readOnly: true, applySchema: false });
const fieldTemplate = new Map(
  (corpus.prepare("SELECT id, template_id FROM template_fields").all() as { id: string; template_id: string }[]).map(
    (r) => [r.id, r.template_id],
  ),
);
const templateName = new Map(
  (corpus.prepare("SELECT id, name FROM templates").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]),
);
const cardInfo = new Map(
  (
    corpus.prepare("SELECT c.id, c.name, d.name AS deck FROM cards c JOIN decks d ON d.id = c.deck_id").all() as {
      id: string;
      name: string;
      deck: string;
    }[]
  ).map((r) => [r.id, r]),
);
corpus.close();

const peers = (
  (await (await fetch(`${base}/sync/`, { headers })).json()) as { peers: { deviceId: string }[] }
).peers.filter((p) => /^dev-[0-9a-f]{12}$/.test(p.deviceId));

let freshest: SyncPayload | null = null;
const hasTemplate = new Set<string>();
const valueTemplates = new Map<string, Set<string>>();
for (const { deviceId } of peers) {
  const payload = await payloadOf(deviceId);
  if (payload === null) continue;
  if (freshest === null || payload.archive.createdAt > freshest.archive.createdAt) freshest = payload;
  for (const flag of payload.cardFlags) if (flag.templateId !== undefined) hasTemplate.add(flag.cardId);
  for (const local of payload.archive.localCards ?? []) hasTemplate.add(local.id);
  for (const value of payload.archive.fieldValues) {
    if (value.fieldId === "name") continue; // shared by every template
    const template = fieldTemplate.get(value.fieldId);
    if (template === undefined) continue;
    if (!valueTemplates.has(value.cardId)) valueTemplates.set(value.cardId, new Set());
    valueTemplates.get(value.cardId)!.add(template);
  }
}
if (freshest === null) throw new Error("no device payload in the mailbox");
if (freshest.templatesCarried !== true) throw new Error("the freshest device does not carry templates yet");

const flags = new Map(freshest.cardFlags.map((f) => [f.cardId, f]));
const heal = new Map<string, string>();
const skipped: string[] = [];
for (const [cardId, templates] of valueTemplates) {
  if (hasTemplate.has(cardId) || !flags.has(cardId)) continue;
  let pick = templates.size === 1 ? [...templates][0] : undefined;
  if (pick === undefined) {
    const deck = cardInfo.get(cardId)?.deck;
    pick = [...templates].find((t) => templateName.get(t) === deck);
  }
  if (pick === undefined) skipped.push(cardId);
  else heal.set(cardId, pick);
}

const payload: SyncPayload = {
  syncVersion: freshest.syncVersion,
  archive: {
    archiveVersion: freshest.archive.archiveVersion,
    schemaVersion: freshest.archive.schemaVersion,
    createdAt: new Date().toISOString(),
    reviews: [],
    trackState: [],
    localFields: [],
    localCards: [],
    templates: [],
    fieldValues: [],
    settings: [],
    cardState: [],
    counts: {
      reviews: 0,
      trackState: 0,
      localFields: 0,
      localCards: 0,
      templates: 0,
      fieldValues: 0,
      settings: 0,
      cardState: 0,
    },
  },
  cardFlags: [...heal].map(([cardId, templateId]) => ({ ...flags.get(cardId)!, templateId })),
  deckFlags: [],
  retiredClips: [],
  templatesCarried: true,
};

// SELF-CHECK on a copy: the corpus as the freshest device has it, then this payload.
const dir = mkdtempSync(join(tmpdir(), "template-heal-"));
const file = join(dir, "check.db");
copyFileSync("build/hashigo.db", file);
const db = openDatabase(file, { applySchema: false });
try {
  mergeSync(db, freshest);
  const snapshot = (): Map<string, string> =>
    new Map(
      (
        db.prepare("SELECT id, coalesce(template_id, '') || '|' || archived || '|' || pinned AS s FROM cards").all() as {
          id: string;
          s: string;
        }[]
      ).map((r) => [r.id, r.s]),
    );
  const values = (): number =>
    (db.prepare("SELECT count(*) AS n FROM card_field_values").get() as { n: number }).n;
  const before = snapshot();
  const valuesBefore = values();
  mergeSync(db, payload);
  const after = snapshot();
  const landed = [...heal].filter(([id, t]) => after.get(id)?.startsWith(`${t}|`)).length;
  const others = [...before].filter(([id, s]) => !heal.has(id) && after.get(id) !== s).length;
  const flagMoves = [...heal].filter(([id]) => before.get(id)?.split("|").slice(1).join("|") !== after.get(id)?.split("|").slice(1).join("|")).length;
  for (const [id, t] of heal) {
    const info = cardInfo.get(id);
    console.log(`  ${info?.name ?? id} (${info?.deck ?? "?"}) -> ${templateName.get(t)}`);
  }
  for (const id of skipped) console.log(`  SKIPPED ${cardInfo.get(id)?.name ?? id}: values of several templates, none named like its deck`);
  console.log(
    `self-check: ${landed}/${heal.size} landed · ${others} other card(s) changed · ${flagMoves} archived/pinned moved · ` +
      `field values ${valuesBefore} -> ${values()}`,
  );
  if (landed !== heal.size || others > 0 || flagMoves > 0 || values() !== valuesBefore) {
    throw new Error("self-check failed — nothing sent");
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

if (!apply) {
  console.log(`DRY RUN — would put ${heal.size} card(s) on their template from ${SLOT}. Add --apply to send.`);
} else {
  const response = await fetch(`${base}/sync/${SLOT}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(`sent ${heal.size} card(s) from ${SLOT}: ${response.status} ${await response.text()}`);
}
