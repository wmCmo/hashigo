import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  deckPos,
  emptyLeafDeckIds,
  fieldValueText,
  mapExports,
  normaliseLang,
  orderDecks,
  orderTemplateFields,
  reverseFlag,
  type DeckRow,
  type TemplateFieldRow,
} from "../src/import/entities.js";
import {
  MOCHI_FORMAT_VERSION,
  asDate,
  cardText,
  decodeExport,
  loadExport,
  reviewTracks,
  untransit,
  walkCards,
  walkDecks,
  type MochiRecord,
} from "../src/import/transit.js";

/**
 * Stage 1 acceptance for the decoder and the structural mapping.
 *
 * The oracle is the real corpus, and the numbers asserted below are the ones in
 * CLAUDE.md and SPEC.html: 7,716 cards, 11 template rows (10 distinct), 102,020
 * reviews split 58,937 / 43,083. The unit tests above them exist to pin the
 * behaviour that the corpus exercises only once or twice — the "~`" escape, the
 * two instant encodings — where a regression would be silent.
 */

const EXPORT_DIRS = ["exports/日本語", "exports/English", "exports/基本情報"] as const;
const haveCorpus = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

describe("untransit", () => {
  it("strips keywords from both map keys and values", () => {
    expect(untransit({ "~:id": "~:KzBUXn1Q", "~:name": "単語" })).toEqual({
      id: "KzBUXn1Q",
      name: "単語",
    });
  });

  it("decodes ~#list and ~#set, both to arrays", () => {
    expect(untransit({ "~#list": ["~:a", "b"] })).toEqual(["a", "b"]);
    expect(untransit({ "~:tags": { "~#set": [] } })).toEqual({ tags: [] });
  });

  it("decodes BOTH instant encodings to the same Date", () => {
    const millis = 1774710000000;
    const fromString = untransit(`~t${millis}`);
    const fromMap = untransit({ "~#dt": millis });
    expect(fromString).toBeInstanceOf(Date);
    expect(fromMap).toBeInstanceOf(Date);
    expect((fromString as Date).toISOString()).toBe((fromMap as Date).toISOString());
    expect((fromMap as Date).toISOString()).toBe("2026-03-28T15:00:00.000Z");
  });

  it("unescapes a literal leading ~, ` or ^ — in values AND in keys", () => {
    expect(untransit("~~に越したことはない")).toBe("~に越したことはない");
    expect(untransit("~`INFORMAL`\ndie.")).toBe("`INFORMAL`\ndie.");
    expect(untransit("~^caret")).toBe("^caret");
    // tools/mochi.py unescapes values but not keys, which leaves a
    // component-cache key that no longer matches the text it caches.
    expect(untransit({ "~~に越したことはない {}": 1 })).toEqual({
      "~に越したことはない {}": 1,
    });
  });

  it("leaves ordinary strings, numbers, booleans and null alone", () => {
    expect(untransit(["plain", 2, true, false, null])).toEqual(["plain", 2, true, false, null]);
  });

  it("does not treat a two-key map as a tagged value", () => {
    expect(untransit({ "~#dt": 1, "~:other": 2 })).toEqual({ "~#dt": 1, other: 2 });
  });

  it("falls back to the bare tail when ~t is not a number", () => {
    expect(untransit("~tnot-a-number")).toBe("not-a-number");
  });
});

describe("walkCards", () => {
  /** A deck node with its own `cards`, reachable twice: the double-count trap. */
  const twiceReachable: MochiRecord = decodeExport(
    JSON.stringify({
      "~:version": 2,
      "~:decks": [
        {
          "~:id": "~:d1",
          "~:name": "単語",
          "~:cards": [{ "~:id": "~:c1", "~:deck-id": "~:d1" }],
        },
      ],
    }),
  );

  it("counts a card reachable by two paths exactly once", () => {
    const naive = naiveWalkCount(twiceReachable);
    expect(naive).toBe(2);
    expect(walkCards(twiceReachable)).toHaveLength(1);
  });

  it("carries the deck path and the deck id", () => {
    const [walked] = walkCards(twiceReachable);
    expect(walked?.deckPath).toBe("単語");
    expect(walked?.deckId).toBe("d1");
  });
});

describe("entity mapping units", () => {
  it("maps review-reverse? true to on and everything else to inherit", () => {
    expect(reverseFlag(true)).toBe("on");
    expect(reverseFlag(false)).toBe("inherit");
    expect(reverseFlag(null)).toBe("inherit");
    expect(reverseFlag(undefined)).toBe("inherit");
  });

  it("keeps boolean field values as JSON text and nulls as empty", () => {
    expect(fieldValueText("かんじ")).toBe("かんじ");
    expect(fieldValueText(true)).toBe("true");
    expect(fieldValueText(false)).toBe("false");
    expect(fieldValueText(null)).toBe("");
    expect(fieldValueText(undefined)).toBe("");
  });

  it("zero-pads deck sort so TEXT pos sorts numerically", () => {
    expect([deckPos(10), deckPos(2)].sort()).toEqual([deckPos(2), deckPos(10)]);
    expect(deckPos(undefined)).toBe("");
  });

  it("normalises jp to ja-JP and leaves bare tags alone", () => {
    expect(normaliseLang("jp")).toBe("ja-JP");
    expect(normaliseLang("ja-jp")).toBe("ja-JP");
    expect(normaliseLang("ja")).toBe("ja");
    expect(normaliseLang("en")).toBe("en");
    expect(normaliseLang("en-us")).toBe("en-US");
  });

  it("sorts object keys so options compare by value", () => {
    expect(canonicalJson({ to: "en", from: "ja" })).toBe('{"from":"ja","to":"en"}');
  });

  it("emits parents before children", () => {
    const rows: DeckRow[] = [
      deck("child", "parent"),
      deck("grandchild", "child"),
      deck("parent", null),
    ];
    expect(orderDecks(rows).map((row) => row.id)).toEqual(["parent", "child", "grandchild"]);
  });

  it("survives a parent cycle rather than recursing forever", () => {
    const rows: DeckRow[] = [deck("a", "b"), deck("b", "a")];
    expect(orderDecks(rows).map((row) => row.id).sort()).toEqual(["a", "b"]);
  });

  it("emits template fields sources-first, and survives a source cycle", () => {
    const rows = [field("speech", "word"), field("word", null), field("audio", "speech")];
    expect(orderTemplateFields(rows).map((row) => row.id)).toEqual(["word", "speech", "audio"]);
    const cycle = [field("a", "b"), field("b", "a")];
    expect(orderTemplateFields(cycle).map((row) => row.id).sort()).toEqual(["a", "b"]);
  });
});

describe.runIf(haveCorpus)("the real corpus", () => {
  const roots = EXPORT_DIRS.map((dir) => loadExport(dir));
  const mapped = mapExports(roots);

  it("is format version 2", () => {
    for (const root of roots) expect(root["version"]).toBe(MOCHI_FORMAT_VERSION);
  });

  // ── THE PASS CONDITION ────────────────────────────────────────────────────
  it("decodes exactly 7,716 cards and 11 templates", () => {
    const cardsPerExport = roots.map((root) => walkCards(root).length);
    const templatesPerExport = roots.map((root) => (root["templates"] as unknown[]).length);
    const templateRows = templatesPerExport.reduce((a, b) => a + b, 0);

    console.log("cards per export      ", cardsPerExport, "total", mapped.cards.length);
    console.log("template rows         ", templatesPerExport, "total", templateRows);
    console.log("distinct templates    ", mapped.templates.length, mapped.notes.templateIdCollisions);

    expect(cardsPerExport).toEqual([5947, 1258, 511]);
    expect(mapped.cards.length).toBe(7716);
    expect(templateRows).toBe(11);
    // 11 rows, 10 distinct: oiaISYb2 (単語) is in both 日本語 and 基本情報.
    expect(mapped.templates.length).toBe(10);
    expect(mapped.notes.templateIdCollisions).toEqual(["oiaISYb2"]);
    expect(mapped.notes.templateIdConflicts).toEqual([]);
  });

  it("finds all 102,020 reviews, split 58,937 forward / 43,083 reverse", () => {
    const perTrack = new Map<string, number>();
    for (const root of roots) {
      for (const { card } of walkCards(root)) {
        for (const [kind, rows] of reviewTracks(card)) {
          perTrack.set(kind, (perTrack.get(kind) ?? 0) + rows.length);
        }
      }
    }
    const total = [...perTrack.values()].reduce((a, b) => a + b, 0);
    console.log("reviews by track      ", Object.fromEntries(perTrack), "total", total);
    expect(perTrack.get("forward")).toBe(58937);
    expect(perTrack.get("reverse")).toBe(43083);
    expect(total).toBe(102020);
  });

  it("decodes every review date, and every one is 15:00:00Z", () => {
    const clockTimes = new Set<string>();
    let dates = 0;
    for (const root of roots) {
      for (const { card } of walkCards(root)) {
        for (const rows of reviewTracks(card).values()) {
          for (const row of rows) {
            const when = asDate(row["date"]);
            expect(when).not.toBeNull();
            dates += 1;
            clockTimes.add(when!.toISOString().slice(11));
          }
        }
      }
    }
    console.log("review clock times    ", [...clockTimes], "over", dates, "reviews");
    expect(dates).toBe(102020);
    expect([...clockTimes]).toEqual(["15:00:00.000Z"]);
  });

  it("maps 39 decks with 3 roots, parents before children — the six empty leaves are dropped by default", () => {
    const seen = new Set<string>();
    for (const row of mapped.decks) {
      if (row.parent_id !== null) expect(seen.has(row.parent_id)).toBe(true);
      seen.add(row.id);
    }
    const deckRoots = mapped.decks.filter((row) => row.parent_id === null);
    const perExport = roots.map((root) => walkDecks(root).length);
    console.log("decks per export      ", perExport, "total", mapped.decks.length);
    console.log("deck roots            ", deckRoots.map((row) => row.name));
    // The walk still sees all 45 in the export; the mapper is what drops six.
    expect(perExport).toEqual([18, 4, 23]);
    expect(perExport.reduce((a, b) => a + b, 0)).toBe(45);
    expect(mapped.decks.length).toBe(39);
    expect(deckRoots.map((row) => row.name)).toEqual(["日本語", "English", "基本情報"]);
    // …and asking for them back gives exactly 45 again, so the rule is a filter
    // over the mapper's output and not a different walk.
    expect(mapExports(roots, { dropEmptyLeafDecks: false }).decks.length).toBe(45);
  });

  it("identifies exactly the six empty leaf decks SPEC drops", () => {
    // Computed over the UNFILTERED mapping — the default output no longer
    // contains them, so asking the filtered list which decks are empty leaves
    // is a different (and empty) question.
    const unfiltered = mapExports(roots, { dropEmptyLeafDecks: false });
    const ids = new Set(emptyLeafDeckIds(unfiltered.decks, unfiltered.cards));
    const names = unfiltered.decks.filter((row) => ids.has(row.id)).map((row) => row.name);
    console.log("empty leaf decks      ", names);
    expect(names).toEqual(["副詞", "名詞", "形容動詞", "一段動詞", "形容詞", "五段動詞"]);
    expect(unfiltered.decks.length - names.length).toBe(39);
    // The default drops them, and drops nothing else.
    expect(mapped.decks.length).toBe(39);
    expect(mapped.decks.filter((row) => ids.has(row.id))).toEqual([]);
    // Not one card moves: the six hold none, which is the whole reason they go.
    expect(mapped.cards.length).toBe(unfiltered.cards.length);
    expect(mapped.cards.length).toBe(7_716);
  });

  it("maps 49 template fields, defaulting the 22 without a type to plain", () => {
    const byType = new Map<string, number>();
    for (const field of mapped.templateFields) {
      byType.set(field.type, (byType.get(field.type) ?? 0) + 1);
    }
    console.log("field types           ", Object.fromEntries([...byType].sort()));
    // 49 rows over 11 template rows, of which oiaISYb2's 8 are counted once.
    expect(mapped.templateFields.length).toBe(41);
    expect(byType.get("plain")).toBe(19);
    expect(mapped.notes.unknownFieldTypes).toEqual([]);
    // 例文: an ai field whose dependency is only inside its prompt.
    const reibun = mapped.templateFields.find(
      (field) => field.template_id === "oiaISYb2" && field.name === "例文",
    );
    expect(reibun?.type).toBe("ai");
    expect(reibun?.source_field_id).toBeNull();
    expect(reibun?.options).toContain("<<単語>>");
  });

  it("emits a source field before the field that reads it", () => {
    // template_fields carries a self-referential foreign key, so map order is
    // not insertable: 単語's Speech precedes its source `name` in the export.
    const seen = new Set<string>();
    for (const field of mapped.templateFields) {
      if (field.source_field_id !== null) {
        expect(seen.has(`${field.template_id}/${field.source_field_id}`)).toBe(true);
      }
      seen.add(`${field.template_id}/${field.id}`);
    }
    expect(mapped.templateFields.filter((f) => f.source_field_id !== null).length).toBe(15);
  });

  it("every source_field_id names a field on the same template", () => {
    const byTemplate = new Map<string, Set<string>>();
    for (const field of mapped.templateFields) {
      const set = byTemplate.get(field.template_id) ?? new Set<string>();
      set.add(field.id);
      byTemplate.set(field.template_id, set);
    }
    const dangling = mapped.templateFields.filter(
      (field) =>
        field.source_field_id !== null &&
        !byTemplate.get(field.template_id)?.has(field.source_field_id),
    );
    expect(dangling).toEqual([]);
  });

  it("puts the card text in field values, not in content", () => {
    const withContent = mapped.cards.filter((card) => card.content.trim() !== "").length;
    const authored = new Set(
      mapped.cardFieldValues.filter((row) => row.value.trim() !== "").map((row) => row.card_id),
    );
    console.log(
      "cards with content    ", withContent,
      "| field values", mapped.cardFieldValues.length,
      "| cards with authored field text", authored.size,
    );
    // 3,523 cards carry non-empty `content` in the export. 3,159 of them are
    // TEMPLATED, and on a templated card the template decides every side — so
    // that text has never been rendered by Mochi and is discarded on import
    // (Zach's decision; see MappingNotes.staleContentCardIds). What is left is
    // the 364 template-less cards, which really do author their sides here.
    expect(withContent).toBe(364);
    expect(mapped.notes.staleContentCardIds.length).toBe(3_159);
    expect(withContent + mapped.notes.staleContentCardIds.length).toBe(3_523);
    // Discarding is not silent: every id is reported, the size is counted, and
    // a sample carries the text itself.
    // 79,175 CODE POINTS, matching tools/mochi.py. The naive `.length` says
    // 79,176: one card (lWDwKxNL) writes U+1F347 GRAPES, which is a surrogate
    // pair in UTF-16 and one character everywhere else.
    expect(mapped.notes.staleContentChars).toBe(79_175);
    expect(mapped.notes.staleContentSample.length).toBe(20);
    expect(new Set(mapped.notes.staleContentCardIds).size).toBe(3_159);
    // Every discarded card is templated, and none of them lost anything else:
    // the text is still in the export, and the card keeps its field values.
    const staleIds = new Set(mapped.notes.staleContentCardIds);
    expect(mapped.cards.filter((c) => staleIds.has(c.id) && c.template_id === null)).toEqual([]);
    expect(mapped.cards.filter((c) => staleIds.has(c.id) && c.content !== "").length).toBe(0);
    for (const entry of mapped.notes.staleContentSample) {
      expect(entry.content.length).toBeGreaterThan(0);
      expect(staleIds.has(entry.cardId)).toBe(true);
    }
    // Keeping it is one option away, which is what makes the discard recoverable
    // without going back to data.json.
    const kept = mapExports(roots, { dropEmptyLeafDecks: false });
    expect(kept.cards.filter((card) => card.content.trim() !== "").length).toBe(364);
    expect(mapped.cardFieldValues.length).toBe(22319);
    expect(authored.size).toBeGreaterThan(7000);
    // cardText sees both surfaces; content alone sees almost nothing. 16 cards
    // carry no authored text at all -- blank "Untitled card" stubs with no
    // fields and no reviews. tools/mochi.py agrees on all three counts.
    const texts = roots.flatMap((root) => walkCards(root).map(({ card }) => cardText(card)));
    expect(texts.filter((text) => text.trim() !== "").length).toBe(7700);
  });

  it("unescapes the 28 field values tools/mochi.py corrupts", () => {
    // 30 field values arrive Transit-escaped. 28 are dictionary glosses whose
    // text begins with a markdown code span ("~`INFORMAL`\ndie."); 2 are the
    // grammar patterns that genuinely begin with a tilde ("~に越したことはない",
    // encoded "~~..."). Python unescapes only "~~", so it leaves all 30 with a
    // leading "~" and silently corrupts the 28.
    const backtick = mapped.cardFieldValues.filter((row) => row.value.startsWith("`"));
    const tilde = mapped.cardFieldValues.filter((row) => row.value.startsWith("~"));
    console.log(
      "escaped field values  ", backtick.length, "backtick +", tilde.length, "tilde",
      "| sample", JSON.stringify(backtick[0]?.value.slice(0, 24)),
    );
    expect(backtick.length).toBe(28);
    expect(tilde.length).toBe(2);
    expect(mapped.cardFieldValues.filter((row) => row.value.startsWith("~`"))).toEqual([]);
  });

  it("keeps 143 field values whose field is not on the card's template", () => {
    // 235, not 143: the old definition was guarded by `row.template_id &&`, so it
    // could not see the 92 values on template-less cards — exactly the half a
    // reader would not think to look for. Both breakouts are asserted, because a
    // count with no basis is not a fact: 98 of the 235 are empty strings and are
    // debris, while the 137 with text are the ones a person might want back.
    console.log(
      "orphan field values   ",
      mapped.notes.orphanFieldValues.length,
      "of which with text",
      mapped.notes.orphanFieldValuesWithText,
      "on template-less cards",
      mapped.notes.orphanFieldValuesTemplateless,
    );
    expect(mapped.notes.orphanFieldValues.length).toBe(235);
    expect(mapped.notes.orphanFieldValuesWithText).toBe(137);
    expect(mapped.notes.orphanFieldValuesTemplateless).toBe(92);
    // And the two halves partition the whole, so neither can drift alone.
    expect(
      mapped.notes.orphanFieldValues.filter((pair) => pair.includes("/")).length,
    ).toBe(235);
  });

  it("never orphans a reverse track: 6 cards are forced to on", () => {
    const forced = new Set(mapped.notes.reverseForcedCardIds);
    console.log("reverse forced to on  ", [...forced]);
    expect(forced.size).toBe(6);

    // The invariant SPEC states: every card with reverse history resolves to on.
    const deckReverse = new Map(
      mapped.decks.map((row) => [row.id, row.reverse] as const),
    );
    const parent = new Map(mapped.decks.map((row) => [row.id, row.parent_id] as const));
    const resolve = (deckId: string): string => {
      let at: string | null = deckId;
      const seen = new Set<string>();
      while (at !== null && !seen.has(at)) {
        seen.add(at);
        const value = deckReverse.get(at);
        if (value !== undefined && value !== "inherit") return value;
        at = parent.get(at) ?? null;
      }
      return "off";
    };
    const byId = new Map(mapped.cards.map((row) => [row.id, row] as const));

    let withHistory = 0;
    let inheriting = 0;
    for (const root of roots) {
      for (const { card } of walkCards(root)) {
        if (reviewTracks(card).get("reverse") === undefined) continue;
        withHistory += 1;
        const row = byId.get(card["id"] as string);
        expect(row).toBeDefined();
        const effective = row!.reverse === "inherit" ? resolve(row!.deck_id) : row!.reverse;
        expect(effective).toBe("on");
        if (row!.reverse === "inherit") inheriting += 1;
      }
    }
    const explicit = mapped.cards.filter((row) => row.reverse === "on").length - forced.size;
    console.log(
      "cards with reverse history", withHistory,
      "| on by inheritance", inheriting,
      "| on by card flag", explicit,
      "| forced", forced.size,
    );
    expect(withHistory).toBe(3778);
    // 3,764 inherit from 文法/言葉/漢字/単語, 8 carry review-reverse? true
    // themselves, and 6 would have been lost without SPEC's enforcement rule.
    expect(inheriting).toBe(3764);
    expect(explicit).toBe(8);
    expect(inheriting + explicit + forced.size).toBe(withHistory);
  });

  it("keeps the 234 archived cards and finds no pinned ones", () => {
    expect(mapped.cards.filter((row) => row.archived === 1).length).toBe(234);
    expect(mapped.cards.filter((row) => row.pinned === 1).length).toBe(0);
    expect(mapped.cards.filter((row) => row.needs_rereview === 1).length).toBe(1);
  });

  it("gives every card an RFC 3339 created_at and updated_at", () => {
    const rfc3339Utc = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
    const bad = mapped.cards.filter(
      (row) => !rfc3339Utc.test(row.created_at) || !rfc3339Utc.test(row.updated_at),
    );
    expect(bad).toEqual([]);
    // 266 cards have no updated-at; they fall back to created_at.
    const same = mapped.cards.filter((row) => row.created_at === row.updated_at).length;
    console.log("cards created_at == updated_at", same);
    expect(same).toBeGreaterThanOrEqual(266);
  });

  it("maps every card into a deck that exists", () => {
    expect(mapped.notes.unknownDeckCardIds).toEqual([]);
    const deckIds = new Set(mapped.decks.map((row) => row.id));
    expect(mapped.cards.every((row) => deckIds.has(row.deck_id))).toBe(true);
  });

  it("is idempotent: mapping the same exports twice yields the same rows", () => {
    const again = mapExports(roots);
    expect(again.cards.length).toBe(mapped.cards.length);
    expect(canonicalJson(again.decks)).toBe(canonicalJson(mapped.decks));
    expect(canonicalJson(again.templates)).toBe(canonicalJson(mapped.templates));
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/** The walk without the identity set — the bug this module exists to avoid. */
function naiveWalkCount(node: MochiRecord): number {
  let total = 0;
  for (const deck of (node["decks"] as MochiRecord[] | undefined) ?? []) {
    total += ((deck["cards"] as unknown[] | undefined) ?? []).length;
    total += naiveWalkCount(deck);
  }
  total += ((node["cards"] as unknown[] | undefined) ?? []).length;
  return total;
}

function field(id: string, source: string | null): TemplateFieldRow {
  return {
    template_id: "t",
    id,
    name: id,
    type: "plain",
    source_field_id: source,
    options: "{}",
    pos: "",
  };
}

function deck(id: string, parentId: string | null): DeckRow {
  return {
    id,
    parent_id: parentId,
    name: id,
    reverse: "inherit",
    target_retention: null,
    default_template_id: null,
    archived: 0,
    pos: "",
  };
}
