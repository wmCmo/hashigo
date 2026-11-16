import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { gradeTrack } from "../src/scheduler/index.js";
import { exportSync, mergeSync, SYNC_VERSION } from "../src/sync/index.js";

function device(cards = 3): { db: Db; trackIds: number[] } {
  const db = openDatabase(MEMORY);
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

const EPOCH = "2020-01-01T00:00:00.000Z";
const NOW = "2026-09-12T12:00:00.000Z";

describe("a grade can never be lost by a merge", () => {
  it("unions grades made on BOTH devices while they were apart", () => {
    const laptop = device();
    const phone = device();

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
    const laptop = device();
    const phone = device();
    for (const db of [laptop.db, phone.db]) {
      db.prepare("UPDATE cards SET archived = 1, updated_at = ? WHERE id = 'c1'").run(
        "2026-09-12T09:00:00.000Z",
      );
    }
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

  it("a NEWER local unarchive survives a stale peer that still has it archived", () => {
    const laptop = device();
    const phone = device();
    laptop.db.prepare("UPDATE cards SET archived = 0, updated_at = ? WHERE id = 'c1'").run("2026-10-22T08:00:00.000Z");
    phone.db.prepare("UPDATE cards SET archived = 1, updated_at = ? WHERE id = 'c1'").run("2026-10-21T08:00:00.000Z");
    const report = mergeSync(laptop.db, exportSync(phone.db, NOW));
    expect(flagsOf(laptop.db, "c1").archived).toBe(0);
    expect(report.flagsKept).toBeGreaterThan(0);
    laptop.db.close();
    phone.db.close();
  });

  it("a merge does not move the clock of a card it kept — pins measured at the merge instant", () => {
    const laptop = device();
    const phone = device();
    const clock = "2026-10-16T10:37:06.552Z";
    for (const db of [laptop.db, phone.db]) {
      db.prepare("UPDATE cards SET pinned = 1, updated_at = ? WHERE id = 'c2'").run(clock);
    }
    mergeSync(laptop.db, exportSync(phone.db, NOW));
    const after = laptop.db.prepare("SELECT updated_at FROM cards WHERE id = 'c2'").get() as { updated_at: string };
    expect(after.updated_at).toBe(clock);
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

describe("a deck archive crosses too, not just its cards", () => {
  const deckArchivedOn = (db: Db, id: string): number =>
    (db.prepare("SELECT archived FROM decks WHERE id = ?").get(id) as { archived: number })
      .archived;

  it("carries decks.archived, which decision 17's backup does not", () => {
    const laptop = device();
    const phone = device();
    phone.db
      .prepare("UPDATE decks SET archived = 1, updated_at = ? WHERE id = 'd'")
      .run("2026-09-12T10:00:00.000Z");
    phone.db
      .prepare("UPDATE cards SET archived = 1, updated_at = ? WHERE deck_id = 'd'")
      .run("2026-09-12T10:00:00.000Z");

    const report = mergeSync(laptop.db, exportSync(phone.db, NOW));

    expect(report.deckFlagsTaken).toBe(1);
    expect(deckArchivedOn(laptop.db, "d")).toBe(1);
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
    const laptop = device();
    const phone = device();
    const payload = exportSync(phone.db, NOW);
    const { deckFlags: _dropped, ...older } = payload;
    expect(() => mergeSync(laptop.db, older as typeof payload)).not.toThrow();
    laptop.db.close();
    phone.db.close();
  });
});

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

describe("the clock every LWW rule stands on", () => {
  const EQUAL = "2026-09-08T00:00:00.000Z";

  it("LOSES a template edit when both clocks are the import timestamp", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      const put = (db: Db, content: string): void => {
        db.prepare(
          "INSERT INTO templates (id, name, content, updated_at) VALUES ('t', '漢字', ?, ?)",
        ).run(content, EQUAL);
      };
      put(laptop, '<draw height="400px"/>');
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

describe("every synced mutation moves its row's clock", () => {
  it("no UPDATE of cards or templates in the worker omits updated_at", () => {
    const source = readFileSync(
      new URL("../app/db.worker.ts", import.meta.url),
      "utf8",
    );
    const offenders: string[] = [];
    for (const match of source.matchAll(/"UPDATE (cards|templates) SET [^"]*"/g)) {
      if (!match[0].includes("updated_at")) offenders.push(match[0]);
    }
    expect(
      offenders,
      "these rows are merged LAST-WRITE-WINS on updated_at, and `isNewer` is " +
        "strict — a mutation that leaves the clock alone is an edit the peer " +
        "silently discards. Add `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.",
    ).toEqual([]);
    expect(source.match(/"UPDATE (cards|templates) SET [^"]*"/g)?.length ?? 0).toBeGreaterThan(5);
  });
});

describe("a field value merges by its card's clock, not by peer order", () => {
  function withValue(db: Db, value: string, cardClock: string): void {
    db.prepare(
      "INSERT INTO templates (id, name, content, updated_at) VALUES ('t', '単語', '<<Reference>>', ?) " +
        "ON CONFLICT (id) DO NOTHING",
    ).run(EPOCH);
    db.prepare(
      `INSERT INTO template_fields (template_id, id, name, type, pos, updated_at)
       VALUES ('t', 'ref', 'Reference', 'plain', 'a', ?) ON CONFLICT (template_id, id) DO NOTHING`,
    ).run(EPOCH);
    db.prepare("UPDATE cards SET template_id = 't', local = 1, updated_at = ? WHERE id = 'c0'").run(cardClock);
    db.prepare(
      `INSERT INTO card_field_values (card_id, field_id, value) VALUES ('c0', 'ref', ?)
       ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value`,
    ).run(value);
  }
  const valueOf = (db: Db): string =>
    (db.prepare("SELECT value FROM card_field_values WHERE card_id = 'c0' AND field_id = 'ref'").get() as {
      value: string;
    }).value;

  const STALE = "殉‎[[職|D2oxO4Hv]]";
  const LINKED = "[[殉|t3jlKArb]]‎[[職|D2oxO4Hv]]";

  it("KEEPS the linked value here when a stale peer carries the old one", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      withValue(phone, STALE, "2026-10-21T13:00:00.000Z");
      withValue(laptop, LINKED, "2026-10-22T05:10:00.000Z");
      const report = mergeSync(laptop, exportSync(phone, NOW));
      expect(valueOf(laptop)).toBe(LINKED);
      expect(report.valuesKept).toBe(1);
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it("TAKES the newer edit on the device that still has the stale value", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      withValue(phone, STALE, "2026-10-21T13:00:00.000Z");
      withValue(laptop, LINKED, "2026-10-22T05:10:00.000Z");
      const report = mergeSync(phone, exportSync(laptop, NOW));
      expect(valueOf(phone)).toBe(LINKED);
      expect(report.valuesKept).toBe(0);
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it("converges whichever order the two payloads merge in", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      withValue(phone, STALE, "2026-10-21T13:00:00.000Z");
      withValue(laptop, LINKED, "2026-10-22T05:10:00.000Z");
      const fromLaptop = exportSync(laptop, NOW);
      const fromPhone = exportSync(phone, NOW);
      mergeSync(phone, fromLaptop);
      mergeSync(phone, fromPhone);
      mergeSync(laptop, fromPhone);
      expect(valueOf(phone)).toBe(LINKED);
      expect(valueOf(laptop)).toBe(LINKED);
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it("an edit to a MOCHI field on an IMPORTED card reaches the other device", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      for (const db of [laptop, phone]) {
        db.prepare("INSERT INTO templates (id, name, content, updated_at) VALUES ('t', '単語', '<<Reading>>', ?)").run(EPOCH);
        db.prepare(
          "INSERT INTO template_fields (template_id, id, name, type, pos, local, updated_at) VALUES ('t', 'rd', 'Reading', 'boolean', 'a', 0, ?)",
        ).run(EPOCH);
        db.prepare("UPDATE cards SET template_id = 't', local = 0 WHERE id = 'c1'").run();
        db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES ('c1', 'rd', 'false')").run();
      }
      phone.prepare("UPDATE card_field_values SET value = 'true' WHERE card_id = 'c1' AND field_id = 'rd'").run();
      phone.prepare("UPDATE cards SET updated_at = ? WHERE id = 'c1'").run("2026-10-24T09:00:00.000Z");
      mergeSync(laptop, exportSync(phone, NOW));
      const got = laptop.prepare("SELECT value FROM card_field_values WHERE card_id = 'c1' AND field_id = 'rd'").get() as {
        value: string;
      };
      expect(got.value).toBe("true");
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it("an EQUAL clock keeps the local value — 'same time' is not a reason to move", () => {
    const laptop = device().db;
    const phone = device().db;
    try {
      withValue(phone, STALE, EPOCH);
      withValue(laptop, LINKED, EPOCH);
      mergeSync(laptop, exportSync(phone, NOW));
      expect(valueOf(laptop)).toBe(LINKED);
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it("the worker stamps the card clock on every field write", () => {
    const source = readFileSync(new URL("../app/db.worker.ts", import.meta.url), "utf8");
    for (const name of ["setField", "setReading"]) {
      const body = source.slice(source.indexOf(`function ${name}(`));
      const end = body.indexOf("\n}\n");
      expect(body.slice(0, end), `${name} must call touchCard`).toContain("touchCard(db, request.cardId)");
    }
  });
});

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
      expect((phone.prepare("SELECT archived FROM cards WHERE id = 'c0'").get() as { archived: number }).archived).toBe(1);
    } finally {
      laptop.close();
      phone.close();
    }
  });
});

describe("a retired clip stays retired across a sync, in both directions (redo a clip)", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);

  it("merges the two devices' lists as a UNION — neither side's redo is lost", async () => {
    const { retiredHashes, retireBlob } = await import("../src/blobs/retire.js");
    const laptop = device().db;
    const phone = device().db;
    try {
      retireBlob(laptop, A);
      retireBlob(phone, B);
      const report = mergeSync(phone, exportSync(laptop, NOW));
      expect(retiredHashes(phone)).toEqual([A, B]);
      expect(report.clipsRetired).toBe(1);
    } finally {
      laptop.close();
      phone.close();
    }
  });

  it("a peer that has retired nothing does not un-retire anything here", async () => {
    const { retiredHashes, retireBlob } = await import("../src/blobs/retire.js");
    const laptop = device().db;
    const phone = device().db;
    try {
      retireBlob(phone, A);
      mergeSync(phone, exportSync(laptop, NOW));
      expect(retiredHashes(phone)).toEqual([A]);
    } finally {
      laptop.close();
      phone.close();
    }
  });
});
