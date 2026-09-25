/**
 * Step 3 — the accent key, the `accents` table, and `<<型>>`.
 *
 * A WRONG ACCENT IS WORSE THAN NO ACCENT, so the assertions here are mostly
 * about REFUSING. The derivation itself lives in Python (OpenJTalk) and is
 * validated in notes/pitch-accent-pipeline.md against 箸/橋/端/花/鼻; what this
 * file pins is everything that could turn a refusal into a confident wrong
 * answer on its way into the database.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import {
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
    // Measured: fed raw, `[[参考|UQB66cP2]]にする` came back read as
    // ユーキュービーロクジューロクシーピーニ.
    expect(accentKey("[[参考|UQB66cP2]]にする")).toBe("参考にする");
  });

  it("strips U+200E, which was mis-reading his own compounds", () => {
    // These are WRONG READINGS, not mora wobbles: 準備 came back as
    // ジュン + ソナエ and 面倒 as メン + タオセ, because the invisible mark split
    // the compound and the analyser read each half as its own word. 3,016 of
    // these marks sit on 2,504 cards.
    expect(accentKey("準‎備")).toBe("準備");
    expect(accentKey("面‎倒")).toBe("面倒");
    expect(accentKey("田‎‎植え")).toBe("田植え");
  });

  it("normalises all five placeholder spellings to one, and does NOT drop them", () => {
    // Three tilde codepoints and two ellipsis spellings are in use — measured by
    // codepoint census, because a regex for `～〜...` missed the ASCII tilde in
    // `~に越したことはない` and counted 20 instead of 21.
    expect(accentKey("～なり")).toBe("~なり");
    expect(accentKey("〜なり")).toBe("~なり");
    expect(accentKey("~なり")).toBe("~なり");
    expect(accentKey("...は...に限る")).toBe("~は~に限る");
    expect(accentKey("…は…に限る")).toBe("~は~に限る");
    // Kept, not removed: a placeholder is a better accent-phrase boundary than
    // the analyser's own guess, and stripping it here would throw that away.
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
    // The case a kanji blocklist passes, and the reason this is an allowlist:
    // full-width Latin came straight back through the analyser.
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

  /**
   * AN ANALYSER UPGRADE MUST WIN, AND UNDER `version DESC` IT DID NOT.
   *
   * `accents` keys on (text, analyser, version, probe), so a new analyser build
   * genuinely ADDS a row -- `loadAccents`' docstring promises "re-deriving with a
   * NEW version adds a row the view will prefer". `accent_resolved` ordered by
   * `version DESC`, and `version` is the free-text provenance string the deriver
   * writes. Measured in SQLite:
   *
   *     SELECT 'pyopenjtalk-plus/0.4.10' > 'pyopenjtalk-plus/0.4.9';   ->  0
   *
   * So 0.4.10 LOSES to 0.4.9 and `created_at` is never consulted, because
   * `version` already decided. Latent on the corpus (one openjtalk version), and
   * it matters because decision 8's premise is that a wrong accent drilled
   * through spaced repetition is worse than none -- this view is the only place
   * "which derivation wins" is answered.
   *
   * Fixed in schema v8 by dropping the version compare entirely: newest ROW wins.
   * These two version strings are chosen so the test fails under the old rule.
   */
  it("prefers the NEWEST row when an analyser is upgraded, not the highest string", () => {
    const db = scratch();
    try {
      loadAccents(db, [
        row({ version: "pyopenjtalk-plus/0.4.9", type: "頭高", accentType: 1 }),
      ]);
      expect(accentFor(db, "橋")?.type).toBe("頭高");

      // The upgrade. 0.4.10 sorts BELOW 0.4.9 as a string, which is the trap.
      db.prepare("UPDATE accents SET created_at = '2020-01-01T00:00:00.000Z'").run();
      loadAccents(db, [
        row({ version: "pyopenjtalk-plus/0.4.10", type: "尾高", accentType: 2 }),
      ]);

      // Two rows kept, so the old answer stays auditable rather than destroyed.
      const rows = db
        .prepare("SELECT count(*) AS n FROM accents WHERE text = '橋'")
        .get() as { n: number };
      expect(rows.n).toBe(2);

      // And the NEWER one resolves. Under `version DESC` this was 頭高.
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
      // Manual is first in the ORDER BY and must stay there: the newest-row rule
      // must not let a re-derivation silently overturn an OJAD adjudication.
      expect(accentFor(db, "橋")?.type).toBe("平板");

      // Even when a derivation is inserted AFTER it.
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
      // Same word, three authored spellings — the invisible mark and the link
      // form both resolve to the one row.
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
      // Guarded: a row exists, and it says so. This is the whole point — the
      // rule refused, and collapsing that into "no data" is the same
      // miss-as-silence defect the audio binding was built to fix.
      const guarded = accentFor(db, "光");
      expect(guarded).not.toBeNull();
      expect(guarded?.type).toBeNull();
      expect(guarded?.basis).toBe("guarded");
      expect(guarded?.note).toContain("probe changed the reading");
      // Absent: nobody has looked.
      expect(accentFor(db, "見物")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("normalises a contradictory row instead of crashing the whole load", () => {
    const db = scratch();
    try {
      // The schema CHECKs forbid a guarded row carrying a type. A bad input line
      // must not take down a load of 3,850 with it.
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
      // And the analyser's answer is still there to audit, not destroyed.
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
      // Newest version wins, older stays auditable.
      expect(accentFor(db, "橋")?.type).toBe("中高");
    } finally {
      db.close();
    }
  });
});

describe("the <<型>> label", () => {
  it("shows the number only for 中高, where it is the whole question", () => {
    // Zach's call, and right for a reason: everywhere else the number restates
    // the label. 平板 is 0 by definition, 頭高 is always 1, and 尾高 is always the
    // last mora — so the digit only says how long the word is.
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
  /** A 単語-shaped template with an accent field pointed at the head word. */
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
      expect(report.guarded).toBe(1);   // 光 — nothing written, on purpose
      expect(report.underived).toBe(1); // 見物 — nobody has looked
      expect(report.byType).toEqual({ 尾高: 1 });

      const value = db
        .prepare("SELECT value FROM card_field_values WHERE card_id = 'c1' AND field_id = 'kata'")
        .pluck()
        .get();
      // 尾高 carries no number — see `accentLabel`.
      expect(value).toBe("尾高");
      // A guarded word writes NOTHING. Writing 不明 or '' would be
      // indistinguishable on screen from "not derived yet", and the entire value
      // of <<型>> is that it is VISIBLY wrong when the pipeline is wrong.
      expect(
        db.prepare("SELECT COUNT(*) FROM card_field_values WHERE card_id = 'c2' AND field_id = 'kata'").pluck().get(),
      ).toBe(0);
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

      // The override lives in `accents`, never in card_field_values, so
      // re-materialising cannot destroy it — which is why the schema keeps the
      // two apart at all.
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

/**
 * GREEN MUST NOT MEAN "THE TABLE WAS EMPTY".
 *
 * Loading accents is a manual step -- it needs the Python analyser -- so an
 * un-loaded database is a legitimate state. Two tests below handled that by
 * PASSING anyway, which is the wrong answer: one asserted `expect(0).toBe(0)`
 * and returned, and the other asserted `COUNT(*) = 0` over constraint violations,
 * which is trivially true of an empty table. Both reported green while checking
 * nothing, and both are corpus assertions someone would rely on.
 *
 * `requireAccents` makes the empty case report as SKIPPED instead. A skip is
 * visible in the summary; a vacuous pass is indistinguishable from a real one.
 */
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

      // Measured: 3,850 distinct keys, 3,816 labelled, 34 guarded. Bounded
      // rather than pinned — a newer analyser version legitimately moves these.
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

      // THE TWO CLAIMS THAT DRIVE DECISIONS, both from
      // notes/pitch-accent-pipeline.md and both basis-stated as "distinct
      // normalised head-word keys on 単語 + 言葉".
      //
      // 1. 平板 is the majority pattern, so the notation's most important job is
      //    to NOT add a downstep. Test that first, in any TTS work.
      expect((byType["平板"] ?? 0) / labelled).toBeGreaterThan(0.5);
      // 2. 尾高 is ~1.4% — 55 words. This is the number Zach's "no particle in
      //    the audio" decision rests on: the 平板/尾高 distinction affects 55
      //    cards, not thousands, and <<型>> carries them. If this ratio ever
      //    moved by an order of magnitude that decision would deserve revisiting.
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
      // The CHECK constraints say this, and asserting it over the real load is
      // what proves the loader honours them rather than working around them --
      // which an empty table cannot prove, hence the skip.
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
      // Vacuous on an empty table: every "no row matches" assertion below is
      // trivially satisfied by having no rows. Found by emptying `accents` and
      // watching this stay green.
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
      // The defect this whole key exists to prevent, asserted against the real
      // load rather than a fixture.
      expect(bad.map((r) => r.text)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("the OJAD adjudications", () => {
  it("never gives an ambiguous word a single label", () => {
    // まく has THREE different accents across 巻く / 蒔く・撒く / 膜・幕. Picking
    // one would drill a wrong contour on two thirds of its senses, so the
    // ambiguous list and the adjudication list must not overlap.
    const settled = new Set(OJAD_ADJUDICATIONS.map((a) => a.word));
    for (const { word } of OJAD_AMBIGUOUS) {
      expect(settled.has(word), `${word} is ambiguous and must not be adjudicated`).toBe(false);
    }
  });

  it("keeps type and accent position consistent with each other", () => {
    for (const row of OJAD_ADJUDICATIONS) {
      if (row.type === "平板") expect(row.accent, row.word).toBe(0);
      else expect(row.accent, row.word).toBeGreaterThan(0);
      if (row.type === "頭高") expect(row.accent, row.word).toBe(1);
    }
  });

  it("carries the な-adjective correction, which changes a label", () => {
    // OJAD shows 地味 as じみな — accent 2 of 3 morae, which reads as 中高. The
    // bare noun じみ is 2 morae with accent 2, which is 尾高. The nucleus did not
    // move; the mora count did. Getting this wrong is a wrong label, silently.
    const jimi = OJAD_ADJUDICATIONS.find((a) => a.word === "地味");
    expect(jimi).toMatchObject({ reading: "じみ", accent: 2, type: "尾高" });
  });

  it("records the word both analysers got wrong", () => {
    // 正義: the probe rule refused it, UniDic read it as the personal name
    // マサヨシ, OJAD says せいぎ 頭高. This is the case that justifies not letting
    // a cross-check resolve on its own.
    const seigi = OJAD_ADJUDICATIONS.find((a) => a.word === "正義");
    expect(seigi).toMatchObject({ reading: "せいぎ", accent: 1, type: "頭高", backed: "neither" });
  });
});

describe.runIf(haveCorpus)("adjudication against the real database", () => {
  it("resolves every adjudicated word as manual, and empties them from the queue", (ctx) => {
    const db = openDatabase(DB, { readOnly: true });
    try {
      // Same reason: an empty `accents` means an empty queue, which satisfies
      // "the queue no longer contains them" for free.
      requireAccents(db, ctx);
      const queued = new Set(
        (db.prepare("SELECT text FROM accent_disagreements").all() as { text: string }[]).map(
          (r) => r.text,
        ),
      );
      // The dictionary-cited rows obey exactly the same contract as OJAD's.
      for (const row of [...OJAD_ADJUDICATIONS, ...DICTIONARY_ADJUDICATIONS]) {
        const resolved = accentFor(db, row.word);
        // Skipped rather than failed when the accent data has not been loaded —
        // that is a manual step needing the Python analyser.
        if (resolved === null) continue;
        expect(resolved.analyser, row.word).toBe("manual");
        expect(resolved.type, row.word).toBe(row.type);
        expect(resolved.accentType, row.word).toBe(row.accent);
        // AN ADJUDICATED WORD IS SETTLED, NOT OPEN. Without this the queue never
        // empties: OJAD backed our derivation on 11 words, the cross-check still
        // disagrees with all 11, and they came back as work forever.
        expect(queued.has(row.word), `${row.word} is adjudicated but still queued`).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});
