/**
 * Stage 11's merge, over two databases that diverged.
 *
 * THE PROPERTY THAT MATTERS IS THAT A GRADE CANNOT BE LOST. That is the whole
 * reason the review log is append-only per track, and it is the thing Zach would
 * discover weeks later and could never reconstruct. Every other rule here is
 * about the two devices AGREEING; this one is about his history surviving.
 *
 * The second property is CONVERGENCE: merge both ways and the two databases hold
 * the same reviews, the same schedule and the same flags. A merge that is not
 * symmetric is a merge that needs a "primary" device, which is the thing sync
 * exists to remove.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { gradeTrack } from "../src/scheduler/index.js";
import { exportSync, mergeSync, SYNC_VERSION } from "../src/sync/index.js";

/** Two cards, one forward track each, no history — the smallest divergence. */
function device(cards = 3): { db: Db; trackIds: number[] } {
  const db = openDatabase(MEMORY);
  // Clocks are pinned, never defaulted: these tests compare an incoming
  // timestamp against the local row's, and a `strftime('now')` default makes
  // the result depend on what time the suite runs. Found the hard way.
  db.prepare("INSERT INTO decks (id, name, updated_at) VALUES ('d', '日本語', ?)").run(EPOCH);
  const trackIds: number[] = [];
  for (let i = 0; i < cards; i += 1) {
    const id = `c${i}`;
    db.prepare("INSERT INTO cards (id, deck_id, name, updated_at) VALUES (?, 'd', ?, ?)").run(id, `橋${i}`, EPOCH);
    const row = db
      .prepare(
        "INSERT INTO card_tracks (card_id, kind) VALUES (?, 'forward') RETURNING id",
      )
      .get(id) as { id: number };
    trackIds.push(row.id);
  }
  return { db, trackIds };
}

const reviewsOf = (db: Db): { card: string; at: string; remembered: number }[] =>
  db
    .prepare(
      `SELECT t.card_id AS card, r.reviewed_at AS at, r.remembered
         FROM reviews r JOIN card_tracks t ON t.id = r.track_id
        WHERE r.source = 'local' ORDER BY t.card_id, r.reviewed_at`,
    )
    .all() as { card: string; at: string; remembered: number }[];

const stateOf = (db: Db, cardId: string): Record<string, unknown> =>
  db
    .prepare(
      `SELECT due_at, reps, lapses, last_reviewed_at FROM card_tracks
        WHERE card_id = ? AND kind = 'forward'`,
    )
    .get(cardId) as Record<string, unknown>;

const flagsOf = (db: Db, cardId: string): { archived: number; pinned: number } =>
  db.prepare("SELECT archived, pinned FROM cards WHERE id = ?").get(cardId) as {
    archived: number;
    pinned: number;
  };

/** Every locally-seeded row starts here, so every incoming clock is newer. */
const EPOCH = "2020-01-01T00:00:00.000Z";
const NOW = "2026-09-12T12:00:00.000Z";

describe("a grade can never be lost by a merge", () => {
  it("unions grades made on BOTH devices while they were apart", () => {
    const laptop = device();
    const phone = device();

    // Different cards, same session window — the ordinary case.
    gradeTrack(laptop.db, {
      trackId: laptop.trackIds[0] as number,
      remembered: 1,
      reviewedAt: "2026-09-12T09:00:00.000Z",
    });
    gradeTrack(phone.db, {
      trackId: phone.trackIds[1] as number,
      remembered: 0,
      reviewedAt: "2026-09-12T10:00:00.000Z",
    });

    mergeSync(laptop.db, exportSync(phone.db, NOW));
    mergeSync(phone.db, exportSync(laptop.db, NOW));

    // Both devices hold both grades, and they agree.
    expect(reviewsOf(laptop.db)).toHaveLength(2);
    expect(reviewsOf(laptop.db)).toEqual(reviewsOf(phone.db));
    laptop.db.close();
    phone.db.close();
  });

  it("keeps BOTH grades when the same track was graded on both devices", () => {
    const laptop = device();
    const phone = device();

    gradeTrack(laptop.db, {
      trackId: laptop.trackIds[0] as number,
      remembered: 1,
      reviewedAt: "2026-09-12T09:00:00.000Z",
    });
    gradeTrack(phone.db, {
      trackId: phone.trackIds[0] as number,
      remembered: 0,
      reviewedAt: "2026-09-12T11:00:00.000Z",
    });

    mergeSync(laptop.db, exportSync(phone.db, NOW));

    // Two rows for one track. Neither device's history was discarded, which is
    // the append-only guarantee doing its job.
    const rows = reviewsOf(laptop.db).filter((r) => r.card === "c0");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.remembered)).toEqual([1, 0]);
    laptop.db.close();
    phone.db.close();
  });

  it("is idempotent — merging the same payload twice changes nothing", () => {
    const laptop = device();
    const phone = device();
    gradeTrack(phone.db, {
      trackId: phone.trackIds[2] as number,
      remembered: 1,
      reviewedAt: "2026-09-12T10:00:00.000Z",
    });

    const payload = exportSync(phone.db, NOW);
    mergeSync(laptop.db, payload);
    const once = reviewsOf(laptop.db);
    mergeSync(laptop.db, payload);
    expect(reviewsOf(laptop.db)).toEqual(once);
    laptop.db.close();
    phone.db.close();
  });
});

describe("scheduler state follows the LAST REVIEW, not the last write", () => {
  it("the later grade's schedule wins, whichever device merged first", () => {
    const laptop = device();
    const phone = device();

    // The phone graded LATER. The laptop is the one running the merge, so a
    // naive last-write-wins would keep the laptop's state — the log and the
    // schedule would then disagree.
    gradeTrack(laptop.db, {
      trackId: laptop.trackIds[0] as number,
      remembered: 1,
      reviewedAt: "2026-09-12T09:00:00.000Z",
    });
    gradeTrack(phone.db, {
      trackId: phone.trackIds[0] as number,
      remembered: 0,
      reviewedAt: "2026-09-12T11:00:00.000Z",
    });

    const phoneState = stateOf(phone.db, "c0");
    const report = mergeSync(laptop.db, exportSync(phone.db, NOW));

    expect(report.trackStateTaken).toBeGreaterThan(0);
    expect(stateOf(laptop.db, "c0")["last_reviewed_at"]).toBe(phoneState["last_reviewed_at"]);
    expect(stateOf(laptop.db, "c0")["due_at"]).toBe(phoneState["due_at"]);
    laptop.db.close();
    phone.db.close();
  });

  it("keeps the LOCAL schedule when this device graded later", () => {
    const laptop = device();
    const phone = device();

    gradeTrack(phone.db, {
      trackId: phone.trackIds[0] as number,
      remembered: 1,
      reviewedAt: "2026-09-12T09:00:00.000Z",
    });
    gradeTrack(laptop.db, {
      trackId: laptop.trackIds[0] as number,
      remembered: 0,
      reviewedAt: "2026-09-12T11:00:00.000Z",
    });
    const before = stateOf(laptop.db, "c0");

    const report = mergeSync(laptop.db, exportSync(phone.db, NOW));

    expect(report.trackStateKept).toBeGreaterThan(0);
    expect(stateOf(laptop.db, "c0")).toEqual(before);
    // …and the phone's grade is still in the log. Kept state, kept history.
    expect(reviewsOf(laptop.db).filter((r) => r.card === "c0")).toHaveLength(2);
    laptop.db.close();
    phone.db.close();
  });

  it("converges: both devices end on the same schedule", () => {
    const laptop = device();
    const phone = device();
    gradeTrack(laptop.db, {
      trackId: laptop.trackIds[0] as number,
      remembered: 1,
      reviewedAt: "2026-09-12T09:00:00.000Z",
    });
    gradeTrack(phone.db, {
      trackId: phone.trackIds[0] as number,
      remembered: 0,
      reviewedAt: "2026-09-12T11:00:00.000Z",
    });

    // Exchange both ways, as a real sync does.
    const fromPhone = exportSync(phone.db, NOW);
    const fromLaptop = exportSync(laptop.db, NOW);
    mergeSync(laptop.db, fromPhone);
    mergeSync(phone.db, fromLaptop);

    expect(stateOf(laptop.db, "c0")).toEqual(stateOf(phone.db, "c0"));
    expect(reviewsOf(laptop.db)).toEqual(reviewsOf(phone.db));
    laptop.db.close();
    phone.db.close();
  });
});

describe("collection flags merge by clock, and CAN clear", () => {
  it("an archive made on one device reaches the other", () => {
    const laptop = device();
    const phone = device();
    phone.db
      .prepare("UPDATE cards SET archived = 1, updated_at = ? WHERE id = 'c1'")
      .run("2026-09-12T10:00:00.000Z");

    mergeSync(laptop.db, exportSync(phone.db, NOW));
    expect(flagsOf(laptop.db, "c1").archived).toBe(1);
    laptop.db.close();
    phone.db.close();
  });

  it("AN UNARCHIVE REACHES THE OTHER TOO — the case a backup cannot express", () => {
    // `applyLocalArchive` is additive by design: it uses `max(archived, ?)` and
    // only exports raised flags, so on its own it can set a flag and never clear
    // one. Merged with that alone, Zach could archive 数字 once and never undo it.
    const laptop = device();
    const phone = device();
    for (const db of [laptop.db, phone.db]) {
      db.prepare("UPDATE cards SET archived = 1, updated_at = ? WHERE id = 'c1'").run(
        "2026-09-12T09:00:00.000Z",
      );
    }
    // Later, on the phone, he changes his mind.
    phone.db
      .prepare("UPDATE cards SET archived = 0, updated_at = ? WHERE id = 'c1'")
      .run("2026-09-12T11:00:00.000Z");

    const report = mergeSync(laptop.db, exportSync(phone.db, NOW));
    expect(report.flagsTaken).toBeGreaterThan(0);
    expect(flagsOf(laptop.db, "c1").archived).toBe(0);
    laptop.db.close();
    phone.db.close();
  });

  it("the older clock loses, whichever direction it came from", () => {
    const laptop = device();
    const phone = device();
    laptop.db
      .prepare("UPDATE cards SET pinned = 1, updated_at = ? WHERE id = 'c2'")
      .run("2026-09-12T11:00:00.000Z");
    phone.db
      .prepare("UPDATE cards SET pinned = 0, updated_at = ? WHERE id = 'c2'")
      .run("2026-09-12T09:00:00.000Z");

    mergeSync(laptop.db, exportSync(phone.db, NOW));
    expect(flagsOf(laptop.db, "c2").pinned).toBe(1);
    laptop.db.close();
    phone.db.close();
  });
});

describe("the payload refuses what it cannot merge", () => {
  it("rejects a version it does not speak, rather than merging across it", () => {
    const laptop = device();
    const phone = device();
    const payload = { ...exportSync(phone.db, NOW), syncVersion: SYNC_VERSION + 1 };
    expect(() => mergeSync(laptop.db, payload)).toThrow(/version/);
    laptop.db.close();
    phone.db.close();
  });
});

/**
 * The case that prompted sync: he archived the 数字 DECK on his phone.
 *
 * `deckOp` archives the deck AND its cards, so a payload carrying only card
 * flags moves half the change — the cards go quiet and the tree still shows the
 * deck open. Half a change is worse than none, because nothing looks wrong.
 */
describe("a deck archive crosses too, not just its cards", () => {
  const deckArchivedOn = (db: Db, id: string): number =>
    (db.prepare("SELECT archived FROM decks WHERE id = ?").get(id) as { archived: number })
      .archived;

  it("carries decks.archived, which decision 17's backup does not", () => {
    const laptop = device();
    const phone = device();
    // As `deckOp` does it: the deck and its cards together.
    phone.db
      .prepare("UPDATE decks SET archived = 1, updated_at = ? WHERE id = 'd'")
      .run("2026-09-12T10:00:00.000Z");
    phone.db
      .prepare("UPDATE cards SET archived = 1, updated_at = ? WHERE deck_id = 'd'")
      .run("2026-09-12T10:00:00.000Z");

    const report = mergeSync(laptop.db, exportSync(phone.db, NOW));

    expect(report.deckFlagsTaken).toBe(1);
    expect(deckArchivedOn(laptop.db, "d")).toBe(1);
    // …and the cards with it, so the two halves agree.
    expect(flagsOf(laptop.db, "c0").archived).toBe(1);
    laptop.db.close();
    phone.db.close();
  });

  it("un-archives a deck too — the same direction the card flags go", () => {
    const laptop = device();
    const phone = device();
    for (const db of [laptop.db, phone.db]) {
      db.prepare("UPDATE decks SET archived = 1, updated_at = ? WHERE id = 'd'").run(
        "2026-09-12T09:00:00.000Z",
      );
    }
    phone.db
      .prepare("UPDATE decks SET archived = 0, updated_at = ? WHERE id = 'd'")
      .run("2026-09-12T11:00:00.000Z");

    mergeSync(laptop.db, exportSync(phone.db, NOW));
    expect(deckArchivedOn(laptop.db, "d")).toBe(0);
    laptop.db.close();
    phone.db.close();
  });

  it("a payload from before deck flags existed still merges", () => {
    // `deckFlags` is optional so an older peer's payload is not a crash.
    const laptop = device();
    const phone = device();
    const payload = exportSync(phone.db, NOW);
    const { deckFlags: _dropped, ...older } = payload;
    expect(() => mergeSync(laptop.db, older as typeof payload)).not.toThrow();
    laptop.db.close();
    phone.db.close();
  });
});

/**
 * ─── A STALE PEER MUST NOT REVERT A TEMPLATE BODY ───────────────────────────
 *
 * Zach, 2026-09-13: *"but i still can't see ojad field...? both on desktop and
 * mobile"*. His phone had the `ojad` FIELD on all four templates and all 3,718
 * annotations, and template bodies with no `<ojad>` in them.
 *
 * `applyLocalArchive` writes every template WHOLESALE — right for a restore,
 * where the archive is the only truth, and wrong for a merge. `syncNow` merges
 * each peer in turn, so with no clock **the last peer in the mailbox wins, not
 * the newest**. Reproduced in the browser pane: a test payload from 2026-09-12
 * sat alphabetically last in the mailbox and undid the change on every sync.
 *
 * The FIELD survived because fields and values are upserted per row and a
 * payload that lacks them deletes nothing. Only the bodies, replaced whole, were
 * lost — which is why the symptom was "the data is there and nothing renders".
 */
describe("a template body merges by clock, not by peer order", () => {
  function withTemplate(db: Db, content: string, updatedAt: string): void {
    db.prepare(
      "INSERT INTO templates (id, name, content, updated_at) VALUES ('t', '単語', ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
    ).run(content, updatedAt);
  }
  const bodyOf = (db: Db): string =>
    (db.prepare("SELECT content FROM templates WHERE id = 't'").get() as { content: string })
      .content;

  it("KEEPS the newer local body when a stale peer carries an older one", () => {
    const local = device().db;
    const stale = device().db;
    try {
      // The stale peer is the 2026-09-12 payload; this device has today's.
      withTemplate(stale, "><< 例文 >>", "2026-09-12T09:00:00.000Z");
      withTemplate(local, "><< 例文 >>\n><ojad></ojad>", "2026-09-13T18:00:00.000Z");

      const report = mergeSync(local, exportSync(stale, NOW));
      expect(bodyOf(local)).toContain("<ojad>");
      expect(report.templatesKept).toBe(1);
      expect(report.templatesTaken).toBe(0);
    } finally {
      local.close();
      stale.close();
    }
  });

  it("TAKES the remote body when the remote is newer — the change still travels", () => {
    const local = device().db;
    const remote = device().db;
    try {
      withTemplate(local, "><< 例文 >>", "2026-09-12T09:00:00.000Z");
      withTemplate(remote, "><< 例文 >>\n><ojad></ojad>", "2026-09-13T18:00:00.000Z");

      const report = mergeSync(local, exportSync(remote, NOW));
      expect(bodyOf(local)).toContain("<ojad>");
      expect(report.templatesTaken).toBe(1);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("a peer with NO clock never wins — 'I cannot say when' is not a reason", () => {
    const local = device().db;
    const remote = device().db;
    try {
      withTemplate(local, "><< 例文 >>\n><ojad></ojad>", "2026-09-13T18:00:00.000Z");
      withTemplate(remote, "><< 例文 >>", "2026-09-12T09:00:00.000Z");
      const payload = exportSync(remote, NOW);
      // An older build: it carried bodies but no `updated_at` for them.
      const older = {
        ...payload,
        archive: {
          ...payload.archive,
          templates: (payload.archive.templates ?? []).map(({ id, name, content }) => ({
            id,
            name,
            content,
          })),
        },
      };
      const report = mergeSync(local, older as never);
      expect(bodyOf(local)).toContain("<ojad>");
      expect(report.templatesKept).toBe(1);
    } finally {
      local.close();
      remote.close();
    }
  });
});

// ─── the clock the merge rules stand on (Zach, 2026-09-14) ───────────────────

/**
 * *"if i edit the template on my phone, like changing stroke color to white,
 * would it get synced?"*
 *
 * The answer was NO, and the reason was not in the merge — it was that nothing
 * ever moved the clock the merge reads.
 *
 * `templates.updated_at` and `cards.updated_at` are DEFAULTs on INSERT. There is
 * no `AFTER UPDATE` trigger maintaining either (`schema.sql` has fourteen
 * triggers and every one is FTS or blob refcounts), so a row written at import
 * time keeps its import clock for ever. `app/db.worker.ts` then edited bodies and
 * flags with bare `SET content = ?` / `SET archived = 1`.
 *
 * Both LWW rules below are STRICT — `isNewer` is `a > b` — so two devices whose
 * clocks are both the import timestamp compare EQUAL, and equal means "keep
 * mine". The peer's edit is dropped, silently, and the report counts it as
 * `templatesKept` / `flagsKept` as though a decision had been made.
 *
 * That is decision 33's own failure case arriving from the other direction, and
 * the same shape as the bug Zach reported before it — *"i archived 数字 on my
 * phone twice before realising the desktop had never heard about it"*.
 */
describe("the clock every LWW rule stands on", () => {
  const EQUAL = "2026-09-08T00:00:00.000Z";

  it("LOSES a template edit when both clocks are the import timestamp", () => {
    // The bug, pinned as behaviour so the fix below has something to be the fix
    // OF. Two devices imported together; the phone edited the body and did not
    // touch the clock.
    const laptop = device().db;
    const phone = device().db;
    try {
      const put = (db: Db, content: string): void => {
        db.prepare(
          "INSERT INTO templates (id, name, content, updated_at) VALUES ('t', '漢字', ?, ?)",
        ).run(content, EQUAL);
      };
      put(laptop, '<draw height="400px"/>');
      // What a bare `UPDATE templates SET content = ?` does: body moves, clock
      // does not.
      put(phone, '<draw height="400px" brushColor="#ffffff"/>');

      const report = mergeSync(laptop, exportSync(phone, NOW));
      expect(report.templatesKept).toBe(1);
      expect(report.templatesTaken).toBe(0);
      expect(
        (laptop.prepare("SELECT content FROM templates WHERE id = 't'").get() as {
          content: string;
        }).content,
      ).not.toContain("brushColor");
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it("CARRIES the same edit once the clock moves with the body", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      laptop
        .prepare("INSERT INTO templates (id, name, content, updated_at) VALUES ('t', '漢字', ?, ?)")
        .run('<draw height="400px"/>', EQUAL);
      phone
        .prepare("INSERT INTO templates (id, name, content, updated_at) VALUES ('t', '漢字', ?, ?)")
        .run('<draw height="400px" brushColor="#ffffff"/>', EQUAL);
      // The fix, in the shape `templateOp` now writes it.
      phone
        .prepare(
          "UPDATE templates SET content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 't'",
        )
        .run('<draw height="400px" brushColor="#ffffff"/>');

      const report = mergeSync(laptop, exportSync(phone, NOW));
      expect(report.templatesTaken).toBe(1);
      expect(
        (laptop.prepare("SELECT content FROM templates WHERE id = 't'").get() as {
          content: string;
        }).content,
      ).toContain("brushColor");
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it("loses and then carries a card ARCHIVE by exactly the same mechanism", () => {
    // Not a second bug — the same one. Worth its own test because this is the
    // one he has already been bitten by, on 数字.
    const stale = device().db;
    const fresh = device().db;
    try {
      for (const db of [stale, fresh]) {
        db.prepare("UPDATE cards SET updated_at = ? WHERE id = 'c0'").run(EQUAL);
      }
      stale.prepare("UPDATE cards SET archived = 1 WHERE id = 'c0'").run();
      expect(mergeSync(device().db, exportSync(stale, NOW)).flagsKept).toBeGreaterThan(0);

      fresh
        .prepare(
          "UPDATE cards SET archived = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'c0'",
        )
        .run();
      const laptop = device().db;
      laptop.prepare("UPDATE cards SET updated_at = ? WHERE id = 'c0'").run(EQUAL);
      mergeSync(laptop, exportSync(fresh, NOW));
      expect(flagsOf(laptop, "c0").archived).toBe(1);
      laptop.close();
    } finally {
      stale.close();
      fresh.close();
    }
  });
});

/**
 * THE GUARD, and it reads the SOURCE rather than the behaviour.
 *
 * `app/db.worker.ts` cannot be imported here — the root `tsconfig.json` excludes
 * `app/` on purpose — and the bug was not in any rule, it was in a statement
 * somebody wrote without a clock. So this walks the statements.
 *
 * It has teeth in the direction that matters: a NEW mutation added later, to a
 * table whose rows are merged by clock, fails here until it carries one. Both
 * previous instances of this defect (数字's archive, the `<ojad>` templates) were
 * written exactly that way — by adding a statement, not by changing a rule.
 */
describe("every synced mutation moves its row's clock", () => {
  it("no UPDATE of cards or templates in the worker omits updated_at", () => {
    const source = readFileSync(
      new URL("../app/db.worker.ts", import.meta.url),
      "utf8",
    );
    const offenders: string[] = [];
    // Statement text up to the closing quote. Both tables are merged by clock:
    // `cards.updated_at` carries archived/pinned, `templates.updated_at` carries
    // the body and the name.
    for (const match of source.matchAll(/"UPDATE (cards|templates) SET [^"]*"/g)) {
      if (!match[0].includes("updated_at")) offenders.push(match[0]);
    }
    expect(
      offenders,
      "these rows are merged LAST-WRITE-WINS on updated_at, and `isNewer` is " +
        "strict — a mutation that leaves the clock alone is an edit the peer " +
        "silently discards. Add `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.",
    ).toEqual([]);
    // The scan must actually be finding statements, or an empty list means
    // nothing. Both tables are mutated by the card and template editors.
    expect(source.match(/"UPDATE (cards|templates) SET [^"]*"/g)?.length ?? 0).toBeGreaterThan(5);
  });
});

// ─── a field's settings merge by clock too (2026-09-25) ──────────────────────

/**
 * Stage C of fields-as-modules made a field's options editable. Before it,
 * `UPSERT_FIELD` overwrote every field row wholesale and stamped `now`, so the
 * last peer merged won — harmless while nothing could change a setting, and the
 * body bug of 2026-09-13 in a new place the moment something could. These pin the
 * same three properties the bodies have: newer wins, older loses, no clock never
 * wins.
 */
describe("a field row merges by clock, not by peer order", () => {
  function withField(db: Db, options: string, updatedAt: string): void {
    db.prepare(
      "INSERT INTO templates (id, name, content, updated_at) VALUES ('t', 'New Vocab', '<<Example>>', ?) " +
        "ON CONFLICT (id) DO NOTHING",
    ).run(EPOCH);
    db.prepare(
      `INSERT INTO template_fields (template_id, id, name, type, options, pos, updated_at)
       VALUES ('t', 'f', 'Example', 'speech', ?, 'a', ?)
       ON CONFLICT (template_id, id) DO UPDATE SET options = excluded.options,
                                                   updated_at = excluded.updated_at`,
    ).run(options, updatedAt);
  }
  const optionsOf = (db: Db): string =>
    (db.prepare("SELECT options FROM template_fields WHERE template_id = 't' AND id = 'f'").get() as {
      options: string;
    }).options;
  const clockOf = (db: Db): string =>
    (db.prepare("SELECT updated_at FROM template_fields WHERE template_id = 't' AND id = 'f'").get() as {
      updated_at: string;
    }).updated_at;

  const OLD = '{"voice":"en-US-AIGenerate1Neural"}';
  const SET = '{"voice":"en-US-Neural2-D"}';

  it("KEEPS a voice set here when a peer carries the older row", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      withField(phone, OLD, "2026-09-24T09:00:00.000Z");
      withField(laptop, SET, "2026-09-25T10:00:00.000Z");
      const report = mergeSync(laptop, exportSync(phone, NOW));
      expect(optionsOf(laptop)).toBe(SET);
      expect(clockOf(laptop)).toBe("2026-09-25T10:00:00.000Z");
      expect(report.fieldsKept).toBe(1);
      expect(report.fieldsTaken).toBe(0);
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it("TAKES the newer peer row, WITH the peer's clock", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      withField(phone, OLD, "2026-09-24T09:00:00.000Z");
      withField(laptop, SET, "2026-09-25T10:00:00.000Z");
      const report = mergeSync(phone, exportSync(laptop, NOW));
      expect(optionsOf(phone)).toBe(SET);
      // Not `now`: a merge that re-stamps makes this device claim authorship and
      // win the next sync against an edit made after this one.
      expect(clockOf(phone)).toBe("2026-09-25T10:00:00.000Z");
      expect(report.fieldsTaken).toBe(1);
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it("a peer row with NO clock never wins", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      withField(phone, OLD, "2026-09-26T09:00:00.000Z");
      withField(laptop, SET, "2026-09-25T10:00:00.000Z");
      const payload = exportSync(phone, NOW);
      const older = {
        ...payload,
        archive: {
          ...payload.archive,
          localFields: payload.archive.localFields.map(({ updatedAt: _dropped, ...rest }) => rest),
        },
      };
      const report = mergeSync(laptop, older as never);
      expect(optionsOf(laptop)).toBe(SET);
      expect(report.fieldsKept).toBe(1);
    } finally {
      laptop.close();
      phone.close();
    }
  });
});

describe("a voice override travels with the card's clock (stage E)", () => {
  const voiceOf = (db: Db, id: string): string | null =>
    (db.prepare("SELECT voice FROM cards WHERE id = ?").get(id) as { voice: string | null }).voice;

  it("a voice set on the laptop reaches the phone", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      laptop
        .prepare("UPDATE cards SET voice = 'ja-JP-Neural2-B', updated_at = ? WHERE id = 'c0'")
        .run(NOW);
      const report = mergeSync(phone, exportSync(laptop, NOW));
      expect(voiceOf(phone, "c0")).toBe("ja-JP-Neural2-B");
      expect(report.flagsTaken).toBeGreaterThanOrEqual(1);
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it("a CLEARED voice travels too — absence means null when the payload says voices are carried", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      phone.prepare("UPDATE cards SET voice = 'ja-JP-Neural2-B' WHERE id = 'c0'").run();
      laptop.prepare("UPDATE cards SET voice = NULL, updated_at = ? WHERE id = 'c0'").run(NOW);
      mergeSync(phone, exportSync(laptop, NOW));
      expect(voiceOf(phone, "c0")).toBeNull();
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it("an OLDER peer that carries no voices never clears one", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      phone.prepare("UPDATE cards SET voice = 'ja-JP-Neural2-B' WHERE id = 'c0'").run();
      laptop.prepare("UPDATE cards SET archived = 1, updated_at = ? WHERE id = 'c0'").run(NOW);
      const { voicesCarried: _dropped, ...older } = exportSync(laptop, NOW);
      mergeSync(phone, older as never);
      expect(voiceOf(phone, "c0")).toBe("ja-JP-Neural2-B");
      // …while the flag it DID carry still lands.
      expect((phone.prepare("SELECT archived FROM cards WHERE id = 'c0'").get() as { archived: number }).archived).toBe(1);
    } finally {
      laptop.close();
      phone.close();
    }
  });
});
