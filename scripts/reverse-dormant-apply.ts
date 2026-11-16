import { readSource } from "../src/import/index.js";
import { asText, walkCards, walkDecks } from "../src/import/transit.js";
import { openDatabase } from "../src/db/index.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};
const apply = args.includes("--apply");
const dbPath = flag("db", "build/hashigo.db");
const exportDirs =
  args.filter((a) => a.startsWith("exports/")).length > 0
    ? args.filter((a) => a.startsWith("exports/"))
    : ["exports/日本語", "exports/English", "exports/基本情報"];

const out: string[] = [];
const db = openDatabase(dbPath, { readOnly: !apply, applySchema: false });

try {
  const chosen = new Set<string>();
  const deckReverse = new Map<string, boolean>();
  for (const dir of exportDirs) {
    const source = readSource(dir);
    for (const walked of walkDecks(source.root)) {
      const deck = walked.deck as Record<string, unknown>;
      const own = deck["review-reverse?"];
      if (own === true) deckReverse.set(asText(deck["id"]), true);
    }
    for (const walked of walkCards(source.root)) {
      const card = walked.card as Record<string, unknown>;
      if (card["review-reverse?"] === true) chosen.add(asText(card["id"]));
    }
  }
  out.push(`export: ${chosen.size} card(s) carry their own \`review-reverse? = true\``);

  const candidates = db
    .prepare(
      `SELECT c.id, c.name, dp.path AS deck, t.id AS track_id, t.dormant,
              (SELECT count(*) FROM reviews v WHERE v.track_id = t.id) AS revs
         FROM cards c
         JOIN card_tracks t              ON t.card_id  = c.id AND t.kind = 'reverse'
         JOIN card_reverse_resolved  cr  ON cr.card_id = c.id
         JOIN deck_reverse_resolved  dr  ON dr.deck_id = c.deck_id
         LEFT JOIN deck_paths dp         ON dp.deck_id = c.deck_id
        WHERE cr.reverse = 'on' AND dr.reverse <> 'on'
        ORDER BY revs DESC, c.id`,
    )
    .all() as {
    id: string;
    name: string;
    deck: string | null;
    track_id: number;
    dormant: number;
    revs: number;
  }[];

  const forced = candidates.filter((row) => !chosen.has(row.id));
  const his = candidates.filter((row) => chosen.has(row.id));

  const applied = (
    db
      .prepare(
        `SELECT c.id FROM cards c
           JOIN card_tracks t             ON t.card_id  = c.id AND t.kind = 'reverse'
           JOIN card_reverse_resolved cr  ON cr.card_id = c.id
           JOIN deck_reverse_resolved dr  ON dr.deck_id = c.deck_id
          WHERE cr.reverse <> 'on' AND dr.reverse <> 'on' AND t.dormant = 1`,
      )
      .all() as { id: string }[]
  ).filter((row) => !chosen.has(row.id));

  out.push(
    `database: ${candidates.length} card(s) reverse against their deck — ` +
      `${his.length} his, ${forced.length} forced`,
  );
  for (const row of his) {
    out.push(`  KEEP    ${row.id}  ${String(row.name).slice(0, 16).padEnd(17)} ${row.revs} rev  (his)`);
  }

  const setReverse = db.prepare("UPDATE cards SET reverse = 'off' WHERE id = ?");
  const setDormant = db.prepare("UPDATE card_tracks SET dormant = 1 WHERE id = ?");
  let changed = 0;
  let already = 0;

  db.transaction(() => {
    for (const row of forced) {
      if (row.dormant === 1) {
        already += 1;
        out.push(
          `  already ${row.id}  ${String(row.name).slice(0, 16).padEnd(17)} ${row.revs} rev`,
        );
        continue;
      }
      out.push(
        `  ${apply ? "OFF    " : "would  "} ${row.id}  ` +
          `${String(row.name).slice(0, 16).padEnd(17)} ${row.revs} rev  ${row.deck ?? "?"}`,
      );
      if (apply) {
        setReverse.run(row.id);
        setDormant.run(row.track_id);
      }
      changed += 1;
    }
  })();

  out.push("");
  if (forced.length === 0 && applied.length > 0) {
    out.push(
      `ALREADY APPLIED — ${applied.length} forced track(s) are dormant and their cards ` +
        `resolve off. Nothing to do.`,
    );
  } else if (forced.length === 0) {
    out.push(
      "NO forced reverse track, and none already turned off. Either this ran against " +
        "the wrong database, or the import rule stopped firing — check before assuming " +
        "it is done.",
    );
  } else if (changed === 0) {
    out.push(`ALREADY APPLIED — all ${already} forced track(s) are already dormant.`);
  } else {
    out.push(
      apply
        ? `APPLIED — ${changed} track(s) now dormant, ${already} already were. ` +
          `Re-run after every rebuild: the importer recomputes \`dormant\`.`
        : `DRY RUN — ${changed} track(s) would go dormant. Pass --apply.`,
    );
  }
  out.push("No review was deleted and no track was dropped; only the scheduling stops.");
} finally {
  process.stdout.write(out.join("\n") + "\n");
  db.close();
}
