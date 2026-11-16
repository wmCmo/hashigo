import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import {
  CARD_ADJUDICATIONS,
  DICTIONARY_ADJUDICATIONS,
  OJAD_ADJUDICATIONS,
  accentLabel,
  OJAD_AMBIGUOUS,
  accentFor,
  accentKey,
  hasPlaceholder,
  loadAccents,
  materialiseAccents,
  readingLooksUnanalysed,
  setManualAccent,
  type AccentRow,
} from "../src/accent/index.js";

const DB = "build/hashigo.db";
const haveCorpus = existsSync(DB);

describe("the accent key", () => {
  it("reduces wiki-links, so an opaque id is never read aloud", () => {
    expect(accentKey("[[参考|UQB66cP2]]にする")).toBe("参考にする");
  });

  it("strips U+200E, which was mis-reading his own compounds", () => {
    expect(accentKey("準‎備")).toBe("準備");
    expect(accentKey("面‎倒")).toBe("面倒");
    expect(accentKey("田‎‎植え")).toBe("田植え");
  });

  it("normalises all five placeholder spellings to one, and does NOT drop them", () => {
    expect(accentKey("～なり")).toBe("~なり");
    expect(accentKey("〜なり")).toBe("~なり");
    expect(accentKey("~なり")).toBe("~なり");
    expect(accentKey("...は...に限る")).toBe("~は~に限る");
    expect(accentKey("…は…に限る")).toBe("~は~に限る");
    expect(hasPlaceholder(accentKey("～なり"))).toBe(true);
    expect(hasPlaceholder(accentKey("なり"))).toBe(false);
  });

  it("collapses the three spellings onto ONE key, so one word gets one row", () => {
    expect(new Set(["～なり", "〜なり", "~なり"].map(accentKey)).size).toBe(1);
  });

  it("rejects a reading by allowlist, not by looking for kanji", () => {
    expect(readingLooksUnanalysed("ハシ")).toBe(false);
    expect(readingLooksUnanalysed("ジュンビ")).toBe(false);
    expect(readingLooksUnanalysed("")).toBe(true);
    expect(readingLooksUnanalysed("嗤ウ")).toBe(true);
    expect(readingLooksUnanalysed("Ｙシャツ")).toBe(true);
    expect(readingLooksUnanalysed("（オス）ユー")).toBe(true);
  });
});

describe("the accents table", () => {
  const row = (over: Partial<AccentRow> = {}): AccentRow => ({
    text: "橋",
    analyser: "openjtalk",
    version: "pyopenjtalk-plus/0.4.1.post9",
    probe: "が",
    phrases: [[2, 2]],
    type: "尾高",
    accentType: 2,
    reading: "ハシ",
    basis: "probe",
    ...over,
  });

  const scratch = () => openDatabase(MEMORY);

  it("stores and resolves a derivation", () => {
    const db = scratch();
    try {
      loadAccents(db, [row()]);
      const found = accentFor(db, "橋");
      expect(found).toMatchObject({ type: "尾高", accentType: 2, basis: "probe", reading: "ハシ" });
      expect(found?.phrases).toEqual([[2, 2]]);
    } finally {
      db.close();
    }
  });

  it("prefers the NEWEST row when an analyser is upgraded, not the highest string", () => {
    const db = scratch();
    try {
      loadAccents(db, [
        row({ version: "pyopenjtalk-plus/0.4.9", type: "頭高", accentType: 1 }),
      ]);
      expect(accentFor(db, "橋")?.type).toBe("頭高");

      db.prepare("UPDATE accents SET created_at = '2020-01-01T00:00:00.000Z'").run();
      loadAccents(db, [
        row({ version: "pyopenjtalk-plus/0.4.10", type: "尾高", accentType: 2 }),
      ]);

      const rows = db
        .prepare("SELECT count(*) AS n FROM accents WHERE text = '橋'")
        .get() as { n: number };
      expect(rows.n).toBe(2);

      expect(accentFor(db, "橋")?.type).toBe("尾高");
    } finally {
      db.close();
    }
  });

  it("still lets a manual override beat any derivation, however new", () => {
    const db = scratch();
    try {
      loadAccents(db, [row({ type: "尾高", accentType: 2 })]);
      loadAccents(db, [
        { ...row(), analyser: "manual", version: "", type: "平板", accentType: 0 },
      ]);
      expect(accentFor(db, "橋")?.type).toBe("平板");

      loadAccents(db, [
        row({ version: "pyopenjtalk-plus/9.9.9", type: "中高", accentType: 1 }),
      ]);
      expect(accentFor(db, "橋")?.type).toBe("平板");
    } finally {
      db.close();
    }
  });

  it("keys by TEXT, so one word has one accent across every card", () => {
    const db = scratch();
    try {
      loadAccents(db, [row()]);
      expect(accentFor(db, "橋")?.type).toBe("尾高");
      expect(accentFor(db, "[[橋|abcd1234]]")?.type).toBe("尾高");
    } finally {
      db.close();
    }
  });

  it("distinguishes REFUSED from NOT YET LOOKED AT", () => {
    const db = scratch();
    try {
      loadAccents(db, [
        row({ text: "光", basis: "guarded", type: null, accentType: null, phrases: [], note: "probe changed the reading" }),
      ]);
      const guarded = accentFor(db, "光");
      expect(guarded).not.toBeNull();
      expect(guarded?.type).toBeNull();
      expect(guarded?.basis).toBe("guarded");
      expect(guarded?.note).toContain("probe changed the reading");
      expect(accentFor(db, "見物")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("normalises a contradictory row instead of crashing the whole load", () => {
    const db = scratch();
    try {
      const report = loadAccents(db, [row({ basis: "guarded" })]);
      expect(report.guarded).toBe(1);
      expect(accentFor(db, "橋")?.type).toBeNull();
    } finally {
      db.close();
    }
  });

  it("lets a manual override beat the analyser outright", () => {
    const db = scratch();
    try {
      loadAccents(db, [row()]);
      expect(accentFor(db, "橋")?.type).toBe("尾高");
      setManualAccent(db, "橋", { type: "頭高", accentType: 1, note: "OJAD says so" });
      const resolved = accentFor(db, "橋");
      expect(resolved?.type).toBe("頭高");
      expect(resolved?.analyser).toBe("manual");
      expect(
        db.prepare("SELECT COUNT(*) FROM accents WHERE text = '橋'").pluck().get(),
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  it("is idempotent for one analyser version, and additive across versions", () => {
    const db = scratch();
    try {
      loadAccents(db, [row()]);
      loadAccents(db, [row({ type: "平板", accentType: 0 })]);
      expect(db.prepare("SELECT COUNT(*) FROM accents").pluck().get()).toBe(1);
      expect(accentFor(db, "橋")?.type).toBe("平板");

      loadAccents(db, [row({ version: "pyopenjtalk-plus/9.9.9", type: "中高", accentType: 2 })]);
      expect(db.prepare("SELECT COUNT(*) FROM accents").pluck().get()).toBe(2);
      expect(accentFor(db, "橋")?.type).toBe("中高");
    } finally {
      db.close();
    }
  });
});

describe("the <<型>> label", () => {
  it("shows the number only for 中高, where it is the whole question", () => {
    expect(accentLabel("中高", 3)).toBe("中高 (3)");
    expect(accentLabel("平板", 0)).toBe("平板");
    expect(accentLabel("頭高", 1)).toBe("頭高");
    expect(accentLabel("尾高", 2)).toBe("尾高");
  });

  it("falls back to the bare label rather than printing (null)", () => {
    expect(accentLabel("中高", null)).toBe("中高");
  });
});

describe("materialising <<型>>", () => {
  const scratch = () => {
    const db = openDatabase(MEMORY);
    db.prepare("INSERT INTO decks (id, name) VALUES ('d', '日本語')").run();
    db.prepare("INSERT INTO templates (id, name, content) VALUES ('t', '単語', '<<単語>>\n---\n<<型>>')").run();
    db.prepare(
      "INSERT INTO template_fields (template_id, id, name, type) VALUES ('t', 'name', '単語', 'plain')",
    ).run();
    db.prepare(
      `INSERT INTO template_fields (template_id, id, name, type, source_field_id)
       VALUES ('t', 'kata', '型', 'accent', 'name')`,
    ).run();
    for (const [id, word] of [
      ["c1", "橋"],
      ["c2", "光"],
      ["c3", "見物"],
    ] as const) {
      db.prepare("INSERT INTO cards (id, deck_id, template_id) VALUES (?, 'd', 't')").run(id);
      db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, 'name', ?)").run(
        id,
        word,
      );
    }
    return db;
  };

  it("writes the label, and leaves a refusal EMPTY rather than guessing", () => {
    const db = scratch();
    try {
      loadAccents(db, [
        {
          text: "橋", analyser: "openjtalk", version: "v", probe: "が",
          phrases: [[2, 2]], type: "尾高", accentType: 2, reading: "ハシ", basis: "probe",
        },
        {
          text: "光", analyser: "openjtalk", version: "v", probe: "が",
          phrases: [], type: null, accentType: null, reading: "ヒカリ", basis: "guarded",
          note: "probe changed the reading",
        },
      ]);

      const report = materialiseAccents(db);
      expect(report.written).toBe(1);
      expect(report.guarded).toBe(1);
      expect(report.underived).toBe(1);
      expect(report.byType).toEqual({ 尾高: 1 });

      const value = db
        .prepare("SELECT value FROM card_field_values WHERE card_id = 'c1' AND field_id = 'kata'")
        .pluck()
        .get();
      expect(value).toBe("尾高");
      expect(
        db.prepare("SELECT COUNT(*) FROM card_field_values WHERE card_id = 'c2' AND field_id = 'kata'").pluck().get(),
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("takes a CARD's adjudication over the word's, and touches no other card", () => {
    const db = scratch();
    try {
      db.prepare("INSERT INTO cards (id, deck_id, template_id) VALUES ('c4', 'd', 't')").run();
      db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES ('c4', 'name', '橋')").run();
      loadAccents(db, [
        {
          text: "橋", analyser: "openjtalk", version: "v", probe: "が",
          phrases: [[2, 2]], type: "尾高", accentType: 2, reading: "ハシ", basis: "probe",
        },
      ]);
      materialiseAccents(db, { cardOverrides: new Map([["c1", { type: "頭高", accentType: 1 }]]) });
      const kata = db.prepare("SELECT value FROM card_field_values WHERE card_id = ? AND field_id = 'kata'").pluck();
      expect(kata.get("c1")).toBe("頭高");
      expect(kata.get("c4")).toBe("尾高");
    } finally {
      db.close();
    }
  });

  it("is idempotent, and a manual override survives re-running it", () => {
    const db = scratch();
    try {
      loadAccents(db, [
        {
          text: "橋", analyser: "openjtalk", version: "v", probe: "が",
          phrases: [[2, 2]], type: "尾高", accentType: 2, reading: "ハシ", basis: "probe",
        },
      ]);
      expect(materialiseAccents(db).written).toBe(1);
      expect(materialiseAccents(db)).toMatchObject({ written: 0, unchanged: 1 });

      setManualAccent(db, "橋", { type: "頭高", accentType: 1 });
      expect(materialiseAccents(db).written).toBe(1);
      expect(
        db.prepare("SELECT value FROM card_field_values WHERE card_id='c1' AND field_id='kata'").pluck().get(),
      ).toBe("頭高");
      expect(materialiseAccents(db)).toMatchObject({ written: 0, unchanged: 1 });
    } finally {
      db.close();
    }
  });

  it("does nothing at all when dryRun is set", () => {
    const db = scratch();
    try {
      loadAccents(db, [
        {
          text: "橋", analyser: "openjtalk", version: "v", probe: "が",
          phrases: [[2, 2]], type: "尾高", accentType: 2, reading: "ハシ", basis: "probe",
        },
      ]);
      expect(materialiseAccents(db, { dryRun: true }).written).toBe(1);
      expect(db.prepare("SELECT COUNT(*) FROM card_field_values WHERE field_id='kata'").pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });
});

function requireAccents(db: Db, ctx: { skip: (note?: string) => void }): number {
  const total = db.prepare("SELECT COUNT(*) FROM accent_resolved").pluck().get() as number;
  if (total === 0) {
    ctx.skip(
      "accent_resolved is empty — run `accent/cli.ts load` first. Skipped rather " +
        "than passed, because every assertion below is vacuous on an empty table.",
    );
  }
  return total;
}

describe.runIf(haveCorpus)("the real corpus", () => {
  it("has an accent for essentially every head word, and refuses a handful", (ctx) => {
    const db = openDatabase(DB, { readOnly: true });
    try {
      const total = requireAccents(db, ctx);
      const labelled = db
        .prepare("SELECT COUNT(*) FROM accent_resolved WHERE type IS NOT NULL")
        .pluck()
        .get() as number;
      const guarded = total - labelled;

      expect(total).toBeGreaterThan(3800);
      expect(guarded).toBeLessThan(120);

      const byType = Object.fromEntries(
        (
          db
            .prepare("SELECT type, COUNT(*) n FROM accent_resolved WHERE type IS NOT NULL GROUP BY type")
            .all() as { type: string; n: number }[]
        ).map((r) => [r.type, r.n]),
      );
      // eslint-disable-next-line no-console
      console.log(`accents: ${total} keys, ${labelled} labelled, ${guarded} guarded, ${JSON.stringify(byType)}`);

      expect((byType["平板"] ?? 0) / labelled).toBeGreaterThan(0.5);
      const odaka = (byType["尾高"] ?? 0) / labelled;
      expect(odaka).toBeGreaterThan(0.005);
      expect(odaka).toBeLessThan(0.03);
    } finally {
      db.close();
    }
  });

  it("never stores a type without an accent position, or vice versa", (ctx) => {
    const db = openDatabase(DB, { readOnly: true });
    try {
      requireAccents(db, ctx);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) FROM accents WHERE (type IS NULL) <> (accent_type IS NULL)",
          )
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        db.prepare("SELECT COUNT(*) FROM accents WHERE basis = 'guarded' AND type IS NOT NULL").pluck().get(),
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("stored no key carrying a wiki-link, an invisible mark, or a raw tilde", (ctx) => {
    const db = openDatabase(DB, { readOnly: true });
    try {
      requireAccents(db, ctx);
      const bad = db
        .prepare(
          `SELECT text FROM accents
            WHERE text LIKE '%[[%' OR text LIKE '%]]%'
               OR text LIKE '%' || char(8206) || '%'
               OR text LIKE '%' || char(8203) || '%'
               OR text LIKE '%' || char(65374) || '%'
               OR text LIKE '%' || char(12316) || '%'
            LIMIT 5`,
        )
        .all() as { text: string }[];
      expect(bad.map((r) => r.text)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("the OJAD adjudications", () => {
  it("never gives an ambiguous word a single label", () => {
    const settled = new Set([...OJAD_ADJUDICATIONS, ...DICTIONARY_ADJUDICATIONS].map((a) => a.word));
    for (const { word } of OJAD_AMBIGUOUS) {
      expect(settled.has(word), `${word} is ambiguous and must not be adjudicated`).toBe(false);
    }
  });

  it("adjudicates by CARD only the words that cannot be settled by word", () => {
    const ambiguous = new Set(OJAD_AMBIGUOUS.map((a) => a.word));
    for (const row of CARD_ADJUDICATIONS) {
      expect(ambiguous.has(row.word), `${row.word} (${row.cardId})`).toBe(true);
    }
    expect(new Set(CARD_ADJUDICATIONS.map((r) => r.cardId)).size).toBe(CARD_ADJUDICATIONS.length);
  });

  it("names a source on every row that is not the first OJAD batch", () => {
    for (const row of [...DICTIONARY_ADJUDICATIONS, ...CARD_ADJUDICATIONS]) {
      expect(row.source.length, row.word).toBeGreaterThan(0);
      expect(row.looked, row.word).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("keeps type and accent position consistent with each other", () => {
    for (const row of [...OJAD_ADJUDICATIONS, ...DICTIONARY_ADJUDICATIONS, ...CARD_ADJUDICATIONS]) {
      if (row.type === "平板") expect(row.accent, row.word).toBe(0);
      else expect(row.accent, row.word).toBeGreaterThan(0);
      if (row.type === "頭高") expect(row.accent, row.word).toBe(1);
    }
  });

  it("carries the な-adjective correction, which changes a label", () => {
    const jimi = OJAD_ADJUDICATIONS.find((a) => a.word === "地味");
    expect(jimi).toMatchObject({ reading: "じみ", accent: 2, type: "尾高" });
  });

  it("records the word both analysers got wrong", () => {
    const seigi = OJAD_ADJUDICATIONS.find((a) => a.word === "正義");
    expect(seigi).toMatchObject({ reading: "せいぎ", accent: 1, type: "頭高", backed: "neither" });
  });
});

describe.runIf(haveCorpus)("adjudication against the real database", () => {
  it("resolves every adjudicated word as manual, and empties them from the queue", (ctx) => {
    const db = openDatabase(DB, { readOnly: true });
    try {
      requireAccents(db, ctx);
      const queued = new Set(
        (db.prepare("SELECT text FROM accent_disagreements").all() as { text: string }[]).map(
          (r) => r.text,
        ),
      );
      for (const row of [...OJAD_ADJUDICATIONS, ...DICTIONARY_ADJUDICATIONS]) {
        const resolved = accentFor(db, row.word);
        if (resolved === null) continue;
        expect(resolved.analyser, row.word).toBe("manual");
        expect(resolved.type, row.word).toBe(row.type);
        expect(resolved.accentType, row.word).toBe(row.accent);
        expect(queued.has(row.word), `${row.word} is adjudicated but still queued`).toBe(false);
      }
      const kata = db.prepare(
        `SELECT v.value FROM card_field_values v
           JOIN cards c ON c.id = v.card_id
           JOIN template_fields f ON f.template_id = c.template_id AND f.id = v.field_id
          WHERE v.card_id = ? AND f.type = 'accent'`,
      ).pluck();
      for (const row of CARD_ADJUDICATIONS) {
        const held = kata.get(row.cardId) as string | undefined;
        if (held === undefined) continue;
        expect(held.startsWith(row.type), `${row.word} ${row.cardId}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });
});
