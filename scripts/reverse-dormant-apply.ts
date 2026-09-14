/**
 * Turn OFF the reverse tracks the importer forced on, and only those.
 *
 *   npx vite-node scripts/reverse-dormant-apply.ts -- --db build/hashigo.db           # dry run
 *   npx vite-node scripts/reverse-dormant-apply.ts -- --db build/hashigo.db --apply   # writes
 *
 * Authorised by Zach 2026-09-07, after he read `exports/English/data.json`: *"yes,
 * turn those five off"*.
 *
 * ─── WHAT IT IS UNDOING, AND WHY THAT IS NOT A BUG IN THE IMPORTER ──────────
 *
 * SPEC's do-not-orphan rule: any card with a non-empty `reverse-reviews` array must
 * resolve `reverse = on`, or 43,596 reverse reviews are orphaned. Right at that
 * scale, and `src/import/entities.ts` implements it by writing `cards.reverse = 'on'`
 * onto the card.
 *
 * The cost lands on a handful of cards that carry **one or two** reverse reviews from
 * years ago and no setting of their own — a stray tap in Mochi, not a decision. They
 * get a reverse track he never asked for, and because that single review is old they
 * are deeply overdue, so they sort to the FRONT of his queue. Measured in
 * `English/Vocabulary`: `constraint` (2 reviews, 2023-03-01), `irksome` (1, 2024-04-08),
 * `extol` (1, 2023-08-08), `expulsion` (1, 2026-05-07), `impend` (1, 2023-10-15).
 * The first four cards the app served on 2026-08-26 were three of those five.
 *
 * **Do NOT "fix" this by putting a review-count threshold on the import rule.** That
 * silently drops history at corpus scale. This is a LOCAL decision about five cards,
 * applied after the fact, reversible, and re-appliable.
 *
 * ─── WHY IT READS THE EXPORT AND NOT THE DATABASE ──────────────────────────
 *
 * **The database cannot answer the question.** After import, a card he set to reverse
 * and a card the rule corrected both read `cards.reverse = 'on'` — the column is
 * exactly where the rule lands, so it flattens his choice and the rule's correction
 * into one value. That is how `app/README.md` came to claim "8 per-card overrides"
 * when three were his and five were not.
 *
 * Only `exports/` keeps them apart: his carry `review-reverse? = true` on the card.
 * So the set is DERIVED here, per run, from the export — not hardcoded — and it will
 * therefore be correct after decision 16's final import even if he turns reverse on
 * for more cards in Mochi in the meantime.
 *
 * ─── RUN IT AFTER EVERY REBUILD ─────────────────────────────────────────────
 *
 * `src/import/reviews.ts` computes `dormant` from the resolved reverse and writes
 * `dormant = excluded.dormant` on conflict, so **every import overwrites this**. It
 * belongs in the documented rebuild sequence beside `reading-apply` and
 * `accent-field-apply`, and `CLAUDE.md` lists it there. Idempotent and self-erasing:
 * run it twice and the second run says ALREADY APPLIED.
 *
 * ─── DO NOT REGENERATE `dashboard.html` AFTER RUNNING THIS ──────────────────
 *
 * Learned the hard way, 2026-09-07, by doing it and turning two oracle tests red.
 *
 * `test/dashboard.test.ts` imports `exports/` into an IN-MEMORY database and compares
 * the render byte-for-byte with the committed `dashboard.html`. That is the point of
 * the file: it is the IMPORTER'S ORACLE — *"Mochi's own dashboard is a known-correct
 * answer, so agreement means the import is right"* — which makes it a pure function of
 * `exports/` and nothing else.
 *
 * `reading-apply` and `accent-field-apply` are safe to run before regenerating it,
 * because head words and template bodies move no dashboard figure. **This script is
 * not**: `dormant` feeds deck progress, the backlog and the interval-cap ratio. Six
 * tracks moved five lines of the page — backlog 108 -> 102, overdue 76 -> 70, the
 * dormant column, and the cap denominator 8,956 -> 8,955 (only `constraint` carried a
 * `scheduled_days`; one review gives no interval).
 *
 * So the committed dashboard keeps describing the raw import, and the dashboard he
 * generates from his own database will legitimately differ by exactly these six
 * tracks. The app's own dashboard reads his real database and shows the lower number.
 * That is not drift; it is an oracle and a report answering two different questions.
 *
 * ─── WHAT IT WRITES, AND WHAT IT REFUSES TO ────────────────────────────────
 *
 * Per affected card: `cards.reverse = 'off'` and `dormant = 1` on the reverse track.
 * Both, because either alone is an inconsistent state — a card resolving `on` whose
 * track is dormant, or a card resolving `off` whose track is still scheduled. Together
 * they are exactly what `schema.sql` describes: *"dormant = retained, not scheduled.
 * Setting a card's reverse to 'off' must never destroy history, so the track stays and
 * merely stops being scheduled."*
 *
 * **It never deletes a review and never drops a track.** The history stays queryable;
 * only the scheduling stops. `src/scheduler`'s `liveTrack` filters `dormant = 0`, so a
 * dormant track leaves the queue and the dashboard's forecast, and nothing else.
 */

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
  /**
   * Cards whose OWN `review-reverse?` is true in the export — his choices.
   *
   * `walkDecks` is read as well, because a card under a deck that itself resolves
   * `on` is not a forced card either: its reverse comes from the deck, which is a
   * setting he made once for thousands of cards.
   */
  const chosen = new Set<string>();
  const deckReverse = new Map<string, boolean>();
  for (const dir of exportDirs) {
    const source = readSource(dir);
    for (const walked of walkDecks(source.root)) {
      const deck = walked.deck as Record<string, unknown>;
      const own = deck["review-reverse?"];
      // `true` only. `null` and absent both mean "no opinion here".
      if (own === true) deckReverse.set(asText(deck["id"]), true);
    }
    for (const walked of walkCards(source.root)) {
      const card = walked.card as Record<string, unknown>;
      if (card["review-reverse?"] === true) chosen.add(asText(card["id"]));
    }
  }
  out.push(`export: ${chosen.size} card(s) carry their own \`review-reverse? = true\``);

  /**
   * Live reverse tracks whose CARD resolves `on` while its DECK does not.
   *
   * That intersection is the forced set — a card reversing for a reason that is
   * neither his deck-level setting nor his card-level one. `deck_reverse_resolved`
   * walks the deck chain, so a child inheriting `on` from 言葉 is excluded correctly.
   */
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

  /**
   * Cards ALREADY in the applied state, counted separately — and this is not
   * decoration.
   *
   * Applying sets `cards.reverse = 'off'`, which takes the card OUT of the candidate
   * query above. So after a successful run `forced` is empty, and the first version
   * of this script reported that as "no forced reverse track found — either this ran
   * against the wrong database, or the import rule stopped firing". The scary
   * message, for the healthy state. In a script that belongs to the rebuild chore
   * that is how a skipped step goes unnoticed: the operator learns to ignore it.
   *
   * A card is in the applied state when its deck does not reverse, it resolves
   * `off`, and it still HAS a dormant reverse track — i.e. history retained,
   * scheduling stopped, which is exactly what this script writes.
   */
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
