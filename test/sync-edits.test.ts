/**
 * EDITS AS A DELTA — decision 64, `src/sync/sent.ts`. 2026-11-10.
 *
 * One card made on the laptop used to send the laptop's whole base (5.31 MB of
 * JSON, measured that day), and every other device downloaded and merged all of
 * it. Now the delta carries the groups that changed since the fingerprint of what
 * the laptop last sent.
 *
 * The property that matters is the one decision 33 already promises: NO MERGE CAN
 * LOSE A GRADE OR AN EDIT. The test of that here is EQUIVALENCE — a phone that
 * merges the base and then the edit delta ends up byte-for-byte where a phone that
 * merged the new full base would have. The delta is a subset of the full payload,
 * and these tests are what say the subset is enough.
 */
import { describe, expect, it } from "vitest";

import { createCard } from "../src/cards/index.js";
import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { gradeTrack } from "../src/scheduler/index.js";
import {
  deltaPayload,
  exportEditDelta,
  exportSync,
  indexPayload,
  maxLocalReviewId,
  mergeSync,
  type SyncDelta,
  type SyncPayload,
} from "../src/sync/index.js";

const EPOCH = "2020-01-01T00:00:00.000Z";
const NOW = "2026-11-10T12:00:00.000Z";
const LATER = "2026-11-10T13:00:00.000Z";
const CARDS = 200;

/**
 * A small copy of his corpus's shape: one deck, the 単語 template with a few
 * fields, CARDS imported cards with values. Every clock pinned (see sync.test.ts
 * on why a `now` default makes these comparisons depend on when the suite runs).
 */
function device(): Db {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name, updated_at) VALUES ('d', '日本語', ?)").run(EPOCH);
  db.prepare("INSERT INTO decks (id, name, updated_at) VALUES ('n', '数字', ?)").run(EPOCH);
  db.prepare(
    "INSERT INTO templates (id, name, content, updated_at) VALUES ('tango', '単語', '<<単語>>', ?)",
  ).run(EPOCH);
  const field = db.prepare(
    `INSERT INTO template_fields (template_id, id, name, type, pos, updated_at)
     VALUES ('tango', ?, ?, ?, ?, ?)`,
  );
  field.run("name", "単語", "plain", "a", EPOCH);
  field.run("imi", "意味", "plain", "b", EPOCH);
  field.run("reading", "Reading", "boolean", "c", EPOCH);
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('queue.new-per-day', '10', ?)").run(EPOCH);
  const card = db.prepare(
    "INSERT INTO cards (id, deck_id, template_id, name, updated_at) VALUES (?, 'd', 'tango', ?, ?)",
  );
  const value = db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?)");
  const track = db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES (?, 'forward')");
  for (let i = 0; i < CARDS; i += 1) {
    const id = `imp${String(i).padStart(4, "0")}`;
    card.run(id, `言葉${i}`, EPOCH);
    value.run(id, "name", `言葉${i}`);
    value.run(id, "imi", `meaning number ${i}, long enough to look like a real one`);
    value.run(id, "reading", i % 3 === 0 ? "true" : "false");
    track.run(id);
  }
  db.prepare("UPDATE cards SET archived = 1 WHERE id = 'imp0007'").run();
  return db;
}

/** Everything a merge can move, in a form two databases can be compared by. */
function dump(db: Db): unknown {
  const all = (sql: string): unknown[] => db.prepare(sql).all();
  return {
    cards: all(
      `SELECT id, deck_id, template_id, name, archived, pinned, voice, local, updated_at
         FROM cards ORDER BY id`,
    ),
    values: all("SELECT card_id, field_id, value FROM card_field_values ORDER BY card_id, field_id"),
    tracks: all(
      `SELECT card_id, kind, due_at, reps, lapses, last_reviewed_at, scheduler_state
         FROM card_tracks ORDER BY card_id, kind`,
    ),
    reviews: all(
      `SELECT t.card_id, t.kind, r.reviewed_at, r.remembered, r.source
         FROM reviews r JOIN card_tracks t ON t.id = r.track_id ORDER BY 1, 2, 3`,
    ),
    templates: all("SELECT id, name, content, updated_at FROM templates ORDER BY id"),
    // Not `created_at`: each copy of the phone is built at its own instant.
    fields: all(
      `SELECT template_id, id, name, type, source_field_id, options, pos, local, updated_at
         FROM template_fields ORDER BY template_id, id`,
    ),
    decks: all("SELECT id, archived, voice, updated_at FROM decks ORDER BY id"),
    settings: all("SELECT key, value FROM settings ORDER BY key"),
  };
}

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The laptop has pushed its full base (fingerprint kept), and the phone has
 * merged it. Returns both, the base and the fingerprint.
 */
function synced(): { laptop: Db; phone: Db; base: SyncPayload; sent: Record<string, string> } {
  const laptop = device();
  const phone = device();
  const base = exportSync(laptop, NOW);
  mergeSync(phone, base);
  return { laptop, phone, base, sent: indexPayload(base) };
}

/**
 * Merge the laptop's edit delta into one copy of the phone and the laptop's full
 * payload into another, and say whether they agree. Returns the delta.
 */
function equivalent(laptop: Db, phone: () => Db, sent: Record<string, string>): SyncDelta {
  const { delta } = exportEditDelta(laptop, 0, sent, NOW);
  const byDelta = phone();
  const byFull = phone();
  mergeSync(byDelta, deltaPayload(delta, NOW));
  mergeSync(byFull, exportSync(laptop, NOW));
  expect(dump(byDelta)).toEqual(dump(byFull));
  return delta;
}

/** A fresh phone that already merged `base`, optionally with its own edits after. */
const phoneFrom =
  (base: SyncPayload, after: (db: Db) => void = () => {}) =>
  (): Db => {
    const db = device();
    mergeSync(db, base);
    after(db);
    return db;
  };

describe("an edit travels as a delta, not as the whole base", () => {
  it("ONE NEW CARD carries that card and nothing else — and merges to where the full base would", () => {
    const { laptop, base, sent } = synced();
    const made = createCard(laptop, {
      deckId: "d",
      templateId: "tango",
      name: "停滞",
      values: { imi: "stagnation", reading: "false" },
    });
    const delta = equivalent(laptop, phoneFrom(base), sent);

    expect(delta.edits?.cardFlags.map((f) => f.cardId)).toEqual([made.cardId]);
    expect(delta.edits?.localCards.map((c) => c.id)).toEqual([made.cardId]);
    expect(new Set(delta.edits?.fieldValues.map((v) => v.cardId))).toEqual(new Set([made.cardId]));
    expect(delta.edits?.templates).toEqual([]);
    expect(delta.edits?.localFields).toEqual([]);
    expect(delta.edits?.deckFlags).toEqual([]);
    expect(delta.edits?.settings).toEqual([]);
    // The point of it: a card is a KB, the base is the whole collection.
    expect(bytes(delta)).toBeLessThan(2_000);
    expect(bytes(exportSync(laptop, NOW))).toBeGreaterThan(40 * bytes(delta));
  });

  it("the new card arrives whole on the phone: its values, its track, its clock", () => {
    const { laptop, phone, sent } = synced();
    const made = createCard(laptop, { deckId: "d", templateId: "tango", name: "停滞", values: { imi: "stagnation" } });
    const { delta } = exportEditDelta(laptop, 0, sent, NOW);
    mergeSync(phone, deltaPayload(delta, NOW));
    expect(phone.prepare("SELECT value FROM card_field_values WHERE card_id = ? AND field_id = 'imi'").get(made.cardId)).toEqual({ value: "stagnation" });
    expect(phone.prepare("SELECT reps, due_at FROM card_tracks WHERE card_id = ?").all(made.cardId)).toEqual([{ reps: 0, due_at: null }]);
    expect(phone.prepare("SELECT local FROM cards WHERE id = ?").get(made.cardId)).toEqual({ local: 1 });
  });

  it("a field value edited on an IMPORTED card carries that card's group only", () => {
    const { laptop, base, sent } = synced();
    laptop.prepare("UPDATE card_field_values SET value = '停滞' WHERE card_id = 'imp0042' AND field_id = 'imi'").run();
    laptop.prepare("UPDATE cards SET updated_at = ? WHERE id = 'imp0042'").run(NOW);
    const delta = equivalent(laptop, phoneFrom(base), sent);
    expect(delta.edits?.cardFlags.map((f) => f.cardId)).toEqual(["imp0042"]);
    // The flag row rides with the values: the merge keeps or takes a value by
    // its CARD's clock, and a value sent without it would always lose.
    expect(delta.edits?.fieldValues.map((v) => v.fieldId).sort()).toEqual(["imi", "name", "reading"]);
  });

  it("the phone's NEWER edit to the same card is kept — card-level LWW, exactly as the full base", () => {
    const { laptop, base, sent } = synced();
    laptop.prepare("UPDATE card_field_values SET value = 'laptop' WHERE card_id = 'imp0042' AND field_id = 'imi'").run();
    laptop.prepare("UPDATE cards SET updated_at = ? WHERE id = 'imp0042'").run(NOW);
    const phoneEdited = phoneFrom(base, (db) => {
      db.prepare("UPDATE card_field_values SET value = 'phone' WHERE card_id = 'imp0042' AND field_id = 'imi'").run();
      db.prepare("UPDATE cards SET updated_at = ? WHERE id = 'imp0042'").run(LATER);
    });
    equivalent(laptop, phoneEdited, sent);
    const phone = phoneEdited();
    mergeSync(phone, deltaPayload(exportEditDelta(laptop, 0, sent, NOW).delta, NOW));
    expect(phone.prepare("SELECT value FROM card_field_values WHERE card_id = 'imp0042' AND field_id = 'imi'").get()).toEqual({ value: "phone" });
  });

  it("an UNARCHIVE travels — the flag row is present, so a cleared flag is not an absence", () => {
    const { laptop, phone, base, sent } = synced();
    expect(phone.prepare("SELECT archived FROM cards WHERE id = 'imp0007'").get()).toEqual({ archived: 1 });
    laptop.prepare("UPDATE cards SET archived = 0, updated_at = ? WHERE id = 'imp0007'").run(NOW);
    const delta = equivalent(laptop, phoneFrom(base), sent);
    mergeSync(phone, deltaPayload(delta, NOW));
    expect(phone.prepare("SELECT archived FROM cards WHERE id = 'imp0007'").get()).toEqual({ archived: 0 });
  });

  it("an archive with its cardState row never travels without the flag row (the 2026-10-22 re-archive)", () => {
    const { laptop, base, sent } = synced();
    laptop.prepare("UPDATE cards SET archived = 1, updated_at = ? WHERE id = 'imp0099'").run(NOW);
    // The phone un-archived something else meanwhile; the delta must not touch it.
    const phoneEdited = phoneFrom(base, (db) => {
      db.prepare("UPDATE cards SET archived = 0, updated_at = ? WHERE id = 'imp0007'").run(LATER);
    });
    const delta = equivalent(laptop, phoneEdited, sent);
    const flagged = new Set(delta.edits?.cardFlags.map((f) => f.cardId));
    for (const state of delta.edits?.cardState ?? []) expect(flagged.has(state.cardId)).toBe(true);
  });

  it("a deck archive, a template body and a setting travel by their own groups", () => {
    const { laptop, base, sent } = synced();
    laptop.prepare("UPDATE decks SET archived = 1, updated_at = ? WHERE id = 'n'").run(NOW);
    laptop.prepare("UPDATE templates SET content = '<<単語>><<意味>>', updated_at = ? WHERE id = 'tango'").run(NOW);
    laptop.prepare("UPDATE settings SET value = '15' WHERE key = 'queue.new-per-day'").run();
    const delta = equivalent(laptop, phoneFrom(base), sent);
    expect(delta.edits?.deckFlags.map((d) => d.deckId)).toEqual(["n"]);
    expect(delta.edits?.templates.map((t) => t.id)).toEqual(["tango"]);
    expect(delta.edits?.settings.map((s) => s.key)).toEqual(["queue.new-per-day"]);
    expect(delta.edits?.cardFlags).toEqual([]);
  });

  it("grades and an edit in the same delta both arrive", () => {
    const { laptop, phone, sent } = synced();
    const track = laptop.prepare("SELECT id FROM card_tracks WHERE card_id = 'imp0001'").get() as { id: number };
    gradeTrack(laptop, { trackId: track.id, remembered: 1, reviewedAt: NOW });
    createCard(laptop, { deckId: "d", templateId: "tango", name: "停滞" });
    const { delta } = exportEditDelta(laptop, 0, sent, NOW);
    expect(delta.reviews).toHaveLength(1);
    // A grade writes `card_tracks`, never the card: imp0001 is NOT an edit.
    expect(delta.edits?.cardFlags.map((f) => f.cardId)).not.toContain("imp0001");
    mergeSync(phone, deltaPayload(delta, NOW));
    expect(phone.prepare("SELECT reps FROM card_tracks WHERE card_id = 'imp0001'").get()).toEqual({ reps: 1 });
    expect(phone.prepare("SELECT count(*) AS n FROM cards WHERE name = '停滞'").get()).toEqual({ n: 1 });
  });
});

describe("the fingerprint, not a clock, decides what changed", () => {
  it("a write that forgot to stamp the card clock is still SENT", () => {
    // Why a fingerprint: a `cards.updated_at` watermark would trust every writer
    // to stamp it, and one that forgot would never leave the device. (The phone
    // still applies it by the card-clock rule — exactly what the full base does.)
    const { laptop, sent } = synced();
    laptop.prepare("UPDATE card_field_values SET value = 'unstamped' WHERE card_id = 'imp0003' AND field_id = 'imi'").run();
    const { delta } = exportEditDelta(laptop, 0, sent, NOW);
    expect(delta.edits?.fieldValues.some((v) => v.cardId === "imp0003" && v.value === "unstamped")).toBe(true);
  });

  it("the next delta carries only what changed since the LAST send, not since the base", () => {
    const { laptop, sent } = synced();
    const first = createCard(laptop, { deckId: "d", templateId: "tango", name: "停滞" });
    const one = exportEditDelta(laptop, 0, sent, NOW);
    const second = createCard(laptop, { deckId: "d", templateId: "tango", name: "躊躇" });
    const two = exportEditDelta(laptop, maxLocalReviewId(laptop), one.index, NOW);
    expect(one.delta.edits?.cardFlags.map((f) => f.cardId)).toEqual([first.cardId]);
    expect(two.delta.edits?.cardFlags.map((f) => f.cardId)).toEqual([second.cardId]);
  });

  it("an edit undone before the send sends nothing — the database is back to what was sent", () => {
    const { laptop, sent } = synced();
    const was = laptop.prepare("SELECT value FROM card_field_values WHERE card_id = 'imp0005' AND field_id = 'imi'").get() as { value: string };
    laptop.prepare("UPDATE card_field_values SET value = 'oops' WHERE card_id = 'imp0005' AND field_id = 'imi'").run();
    laptop.prepare("UPDATE card_field_values SET value = ? WHERE card_id = 'imp0005' AND field_id = 'imi'").run(was.value);
    const { delta, rows } = exportEditDelta(laptop, 0, sent, NOW);
    expect(rows).toBe(0);
    expect(delta.edits).toBeUndefined();
  });

  it("an empty fingerprint makes every group new — the caller must never pass one for a real send", () => {
    // `pushGradesNow` sends the FULL payload when it holds no fingerprint; this
    // pins what would happen otherwise, so the guard stays.
    const { laptop } = synced();
    const { rows } = exportEditDelta(laptop, 0, {}, NOW);
    expect(rows).toBeGreaterThan(CARDS);
  });
});

describe("merging an edit delta moves nothing it does not carry", () => {
  it("the phone's own flags, values and settings are untouched by a delta about another card", () => {
    const { laptop, base, sent } = synced();
    createCard(laptop, { deckId: "d", templateId: "tango", name: "停滞" });
    const phone = phoneFrom(base, (db) => {
      db.prepare("UPDATE cards SET pinned = 1, updated_at = ? WHERE id = 'imp0010'").run(EPOCH);
      db.prepare("UPDATE card_field_values SET value = 'mine' WHERE card_id = 'imp0011' AND field_id = 'imi'").run();
      db.prepare("UPDATE settings SET value = '20' WHERE key = 'queue.new-per-day'").run();
    })();
    mergeSync(phone, deltaPayload(exportEditDelta(laptop, 0, sent, NOW).delta, NOW));
    expect(phone.prepare("SELECT pinned FROM cards WHERE id = 'imp0010'").get()).toEqual({ pinned: 1 });
    expect(phone.prepare("SELECT value FROM card_field_values WHERE card_id = 'imp0011' AND field_id = 'imi'").get()).toEqual({ value: "mine" });
    expect(phone.prepare("SELECT value FROM settings WHERE key = 'queue.new-per-day'").get()).toEqual({ value: "20" });
  });

  it("is idempotent — the delta stack is re-merged whole every time it changes", () => {
    const { laptop, phone, sent } = synced();
    createCard(laptop, { deckId: "d", templateId: "tango", name: "停滞" });
    const payload = deltaPayload(exportEditDelta(laptop, 0, sent, NOW).delta, NOW);
    mergeSync(phone, payload);
    const once = dump(phone);
    mergeSync(phone, payload);
    expect(dump(phone)).toEqual(once);
  });
});

describe("SYNC_VERSION 2", () => {
  it("still merges a version-1 payload — the slots written before the bump", () => {
    const { laptop, phone } = synced();
    laptop.prepare("UPDATE cards SET archived = 0, updated_at = ? WHERE id = 'imp0007'").run(NOW);
    mergeSync(phone, { ...exportSync(laptop, NOW), syncVersion: 1 });
    expect(phone.prepare("SELECT archived FROM cards WHERE id = 'imp0007'").get()).toEqual({ archived: 0 });
  });

  it("refuses a version it does not know, rather than guess", () => {
    const { laptop, phone } = synced();
    expect(() => mergeSync(phone, { ...exportSync(laptop, NOW), syncVersion: 3 })).toThrow(/version 3/);
    expect(() => mergeSync(phone, { ...exportSync(laptop, NOW), syncVersion: 0 })).toThrow(/version 0/);
  });
});
