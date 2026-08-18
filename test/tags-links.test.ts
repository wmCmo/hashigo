import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MEMORY, checkIntegrity, openDatabase, type Db } from "../src/db/index.js";
import {
  cardLinks,
  importLinks,
  mapCardLinks,
  reconcileReferences,
  wikiLinks,
  type MochiLinkedCard,
} from "../src/import/links.js";
import {
  importTags,
  mapCardTags,
  normaliseTagPath,
  orderTags,
  tagPrefixes,
  tagRow,
  type MochiTaggedCard,
} from "../src/import/tags.js";
import { loadExport, walkCards } from "../src/import/transit.js";

/**
 * Stage 1 acceptance for tags and card links.
 *
 * The oracle is the real corpus: 23 raw tag strings normalise to 19, and 8,690
 * wiki-links come out of 4,323 cards with the unresolved ones counted, not
 * dropped. The synthetic blocks pin the rules the corpus exercises only once —
 * the invisible U+200B duplicates, an ancestor path that must be synthesised so
 * Dialect/Kansai can exist, a link whose target was never exported.
 */

const EXPORT_DIRS = ["exports/日本語", "exports/English", "exports/基本情報"] as const;
const haveCorpus = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

/** U+200B ZERO WIDTH SPACE — the character that corrupted the real tag list. */
const ZWSP = "​";

let db: Db;

beforeEach(() => {
  db = openDatabase(MEMORY);
});

afterEach(() => {
  db.close();
});

function seedCards(...ids: string[]): void {
  db.prepare("INSERT INTO decks (id, name) VALUES ('d', 'テスト') ON CONFLICT DO NOTHING").run();
  const insert = db.prepare("INSERT INTO cards (id, deck_id, name) VALUES (?, 'd', ?)");
  for (const id of ids) insert.run(id, id);
}

// ─── tag normalisation ───────────────────────────────────────────────────────

describe("normaliseTagPath", () => {
  it("strips a leading zero-width space, merging the invisible duplicate", () => {
    expect(normaliseTagPath(`${ZWSP}Mathematics`)).toBe("Mathematics");
    expect(normaliseTagPath(`${ZWSP}Mathematics`)).toBe(normaliseTagPath("Mathematics"));
  });

  it("strips every format character, not just the one in the corpus", () => {
    // ZWNJ, ZWJ, BOM, soft hyphen: all \p{Cf}, all invisible in a sidebar.
    expect(normaliseTagPath("Comp‌ut‍ing﻿")).toBe("Computing");
    expect(normaliseTagPath("Fin­ance")).toBe("Finance");
  });

  it("applies NFKC, so a full-width spelling is the same tag", () => {
    expect(normaliseTagPath("Ｌｏｇｉｃ")).toBe("Logic");
    expect(normaliseTagPath("ﬁnance")).toBe("finance");
  });

  it("trims each segment and drops empty ones", () => {
    expect(normaliseTagPath(" Dialect / Kansai ")).toBe("Dialect/Kansai");
    expect(normaliseTagPath("Dialect//Kansai")).toBe("Dialect/Kansai");
    expect(normaliseTagPath("/Dialect/")).toBe("Dialect");
    // Ideographic space is whitespace too.
    expect(normaliseTagPath("　敬語　")).toBe("敬語");
  });

  it("returns empty for a tag made only of invisible characters", () => {
    expect(normaliseTagPath(ZWSP)).toBe("");
    expect(normaliseTagPath("  /  ")).toBe("");
  });

  it("leaves Japanese tag names exactly as written", () => {
    expect(normaliseTagPath("四字熟語")).toBe("四字熟語");
    expect(normaliseTagPath("駅について")).toBe("駅について");
  });
});

describe("tag paths", () => {
  it("enumerates every prefix, shortest first", () => {
    expect(tagPrefixes("a/b/c")).toEqual(["a", "a/b", "a/b/c"]);
    expect(tagPrefixes("")).toEqual([]);
  });

  it("splits a path into parent plus last segment", () => {
    expect(tagRow("Dialect/Kansai")).toEqual({
      path: "Dialect/Kansai",
      parent_path: "Dialect",
      name: "Kansai",
    });
    expect(tagRow("Law").parent_path).toBeNull();
  });

  it("orders parents before children", () => {
    const ordered = orderTags([tagRow("a/b/c"), tagRow("a/b"), tagRow("z"), tagRow("a")]);
    expect(ordered.map((row) => row.path)).toEqual(["a", "z", "a/b", "a/b/c"]);
  });
});

describe("mapCardTags", () => {
  const cards: MochiTaggedCard[] = [
    { id: "c1", tags: ["Mathematics", `${ZWSP}Mathematics`] },
    { id: "c2", tags: [`${ZWSP}Buddhism`], "manual-tags": [`${ZWSP}Buddhism`] },
    { id: "c3", tags: ["Dialect/Kansai", ZWSP, 42] },
  ];
  const mapped = mapCardTags(cards);

  it("merges the two spellings into one card_tags row", () => {
    const c1 = mapped.cardTags.filter((row) => row.card_id === "c1");
    expect(c1).toEqual([{ card_id: "c1", tag_path: "Mathematics", manual: 0 }]);
    expect(mapped.notes.duplicatePairsMerged).toBe(2); // c1's pair and c2's pair
    // Only paths whose raw spellings actually differed are reported as merges.
    expect(mapped.notes.merged).toEqual([
      { path: "Mathematics", variants: ["Mathematics", `${ZWSP}Mathematics`] },
    ]);
  });

  it("ORs the manual flag rather than emitting a second row", () => {
    expect(mapped.cardTags.filter((row) => row.card_id === "c2")).toEqual([
      { card_id: "c2", tag_path: "Buddhism", manual: 1 },
    ]);
  });

  it("synthesises the ancestor path a child tag needs", () => {
    expect(mapped.notes.ancestorsSynthesised).toEqual(["Dialect"]);
    expect(mapped.tags.map((row) => row.path)).toContain("Dialect");
    expect(mapped.notes.normalisedTags).toBe(3); // paths that carry cards
    expect(mapped.tags.length).toBe(4); // plus the synthesised ancestor
  });

  it("drops an all-invisible tag and reports it, and ignores non-strings", () => {
    expect(mapped.notes.dropped).toEqual([ZWSP]);
    expect(mapped.cardTags.filter((row) => row.card_id === "c3").length).toBe(1);
  });
});

describe("importTags", () => {
  it("writes the tree, satisfies the parent foreign key, and is idempotent", () => {
    seedCards("c1", "c2");
    const first = importTags(db, [
      { id: "c1", tags: ["Dialect/Kansai", `${ZWSP}Buddhism`] },
      { id: "c2", tags: ["Buddhism"], "manual-tags": ["Buddhism"] },
    ]);
    expect(first.tags).toBe(3); // Dialect, Dialect/Kansai, Buddhism
    expect(first.cardTags).toBe(3);

    const usage = db
      .prepare("SELECT path, cards_direct, cards_subtree FROM tag_usage ORDER BY path")
      .all();
    console.log("tag_usage            ", usage);
    expect(usage).toEqual([
      { path: "Buddhism", cards_direct: 2, cards_subtree: 2 },
      { path: "Dialect", cards_direct: 0, cards_subtree: 1 },
      { path: "Dialect/Kansai", cards_direct: 1, cards_subtree: 1 },
    ]);

    importTags(db, [{ id: "c1", tags: ["Dialect/Kansai", `${ZWSP}Buddhism`] }]);
    expect(db.prepare("SELECT count(*) FROM card_tags").pluck().get()).toBe(3);
    expect(db.prepare("SELECT count(*) FROM tags").pluck().get()).toBe(3);
    expect(checkIntegrity(db)).toEqual([]);
  });

  it("makes a card findable in card_fts by its normalised tag path", () => {
    seedCards("c1");
    importTags(db, [{ id: "c1", tags: [`${ZWSP}Buddhism`] }]);
    const hits = db
      .prepare("SELECT card_id FROM card_fts WHERE card_fts MATCH ?")
      .all('"Buddhism"');
    console.log("fts by tag path      ", hits);
    expect(hits).toEqual([{ card_id: "c1" }]);
  });
});

// ─── links ───────────────────────────────────────────────────────────────────

describe("wikiLinks", () => {
  it("parses display text and target out of every occurrence", () => {
    expect(wikiLinks("～に引き換え means [[引く|aaa]] plus [[換える|bbb]].")).toEqual([
      { display: "引く", target: "aaa" },
      { display: "換える", target: "bbb" },
    ]);
  });

  it("does not match a bracket pair without a target", () => {
    expect(wikiLinks("[[引く]] [[|x]] [[a|]]")).toEqual([]);
  });

  it("is not confused by repeated calls (the global-regex lastIndex trap)", () => {
    const text = "[[a|1]][[b|2]]";
    expect(wikiLinks(text)).toHaveLength(2);
    expect(wikiLinks(text)).toHaveLength(2);
  });
});

describe("cardLinks", () => {
  const card: MochiLinkedCard = {
    id: "c1",
    content: "[[越す|t1]]",
    fields: {
      "f-1": { value: "[[引く|t2]] and [[換える|t3]]" },
      "f-2": { value: true }, // a checkbox field: not text, no links
      "f-3": { value: "[[越す|t1]]" }, // the same target twice on one card
    },
  };

  it("reads content AND field values, numbering ordinals per scope", () => {
    expect(cardLinks(card)).toEqual([
      { from_card_id: "c1", to_card_id: "t1", display_text: "越す", field_id: null, ordinal: 0 },
      { from_card_id: "c1", to_card_id: "t2", display_text: "引く", field_id: "f-1", ordinal: 0 },
      { from_card_id: "c1", to_card_id: "t3", display_text: "換える", field_id: "f-1", ordinal: 1 },
      { from_card_id: "c1", to_card_id: "t1", display_text: "越す", field_id: "f-3", ordinal: 0 },
    ]);
  });

  it("counts an unresolved target without dropping its row", () => {
    const mapped = mapCardLinks([card], { knownCardIds: new Set(["c1", "t1", "t2"]) });
    expect(mapped.links.length).toBe(4);
    expect(mapped.notes.unresolvedRows).toBe(1);
    expect(mapped.notes.unresolvedTargets).toEqual(["t3"]);
    expect(mapped.notes.linksInContent).toBe(1);
    expect(mapped.notes.linksInFields).toBe(3);
  });
});

describe("importLinks", () => {
  it("stores an unresolved link and marks it resolved = 0", () => {
    seedCards("c1", "t1");
    const result = importLinks(db, [
      { id: "c1", content: "[[越す|t1]] [[nowhere|gone]]" },
    ]);
    expect(result.links).toBe(2);
    expect(result.unresolvedTargets).toEqual(["gone"]);

    const rows = db
      .prepare(
        `SELECT to_card_id, display_text, resolved, to_card_name
           FROM card_links_resolved ORDER BY ordinal`,
      )
      .all();
    console.log("card_links_resolved  ", rows);
    expect(rows).toEqual([
      { to_card_id: "t1", display_text: "越す", resolved: 1, to_card_name: "t1" },
      { to_card_id: "gone", display_text: "nowhere", resolved: 0, to_card_name: null },
    ]);
    expect(checkIntegrity(db)).toEqual([]);
  });

  it("replaces a card's links on re-import instead of leaving ghosts", () => {
    seedCards("c1", "t1", "t2");
    importLinks(db, [{ id: "c1", content: "[[a|t1]] [[b|t2]]" }]);
    const again = importLinks(db, [{ id: "c1", content: "[[a|t1]]" }]);
    expect(again.replaced).toBe(2);
    expect(db.prepare("SELECT to_card_id FROM card_links").all()).toEqual([{ to_card_id: "t1" }]);
  });

  it("cascades away with the card that owns the links", () => {
    seedCards("c1", "t1");
    importLinks(db, [{ id: "c1", content: "[[a|t1]]" }]);
    db.prepare("DELETE FROM cards WHERE id = 'c1'").run();
    expect(db.prepare("SELECT count(*) FROM card_links").pluck().get()).toBe(0);
  });
});

// ─── the corpus ──────────────────────────────────────────────────────────────

describe.runIf(haveCorpus)("the real corpus", () => {
  const cards = EXPORT_DIRS.flatMap((dir) => walkCards(loadExport(dir)).map(({ card }) => card));
  const tagged = cards as unknown as MochiTaggedCard[];
  const linked = cards as unknown as MochiLinkedCard[];

  // ── PASS CONDITION 1: 23 raw tags normalise to exactly 19 ──────────────────
  it("normalises 23 raw tags to 19", () => {
    const mapped = mapCardTags(tagged);
    console.log(
      "raw tags", mapped.notes.rawTags,
      "-> normalised", mapped.notes.normalisedTags,
      "| tag rows", mapped.tags.length,
      "| card_tags", mapped.cardTags.length,
      "| pairs merged", mapped.notes.duplicatePairsMerged,
    );
    console.log("merged invisible dups", mapped.notes.merged);
    console.log("synthesised ancestors", mapped.notes.ancestorsSynthesised);

    expect(mapped.notes.rawTags).toBe(23);
    expect(mapped.notes.normalisedTags).toBe(19);
    // The four pairs SPEC names, each a clean tag plus its U+200B twin.
    expect(mapped.notes.merged.map((entry) => entry.path).sort()).toEqual([
      "Computing",
      "Finance",
      "Logic",
      "Mathematics",
    ]);
    for (const entry of mapped.notes.merged) {
      expect(entry.variants).toContain(entry.path);
      expect(entry.variants).toContain(`${ZWSP}${entry.path}`);
    }
    // ␣Buddhism has no clean counterpart, so it is not a merge — it is a repair.
    expect(mapped.tags.map((row) => row.path)).toContain("Buddhism");
    expect(mapped.notes.dropped).toEqual([]);
    // 20 rows for 19 used tags: Dialect exists so Dialect/Kansai can.
    expect(mapped.tags.length).toBe(20);
    expect(mapped.notes.ancestorsSynthesised).toEqual(["Dialect"]);
    expect(mapped.cardTags.length).toBe(66);
    expect(new Set(mapped.cardTags.map((row) => row.card_id)).size).toBe(62);
    // 69 raw occurrences: 3 cards carry ␣Buddhism in both tags and manual-tags.
    expect(mapped.notes.duplicatePairsMerged).toBe(3);
    expect(mapped.cardTags.filter((row) => row.manual === 1).length).toBe(3);
  });

  // ── PASS CONDITION 2: 8,690 links, unresolved counted separately ───────────
  it("extracts 8,690 links from 4,323 cards, 18 rows unresolved", () => {
    const mapped = mapCardLinks(linked);
    console.log(
      "links", mapped.links.length,
      "| cards with links", mapped.notes.cardsWithLinks,
      "| in content", mapped.notes.linksInContent,
      "| in field values", mapped.notes.linksInFields,
    );
    console.log(
      "distinct targets", mapped.notes.distinctTargets,
      "| unresolved rows", mapped.notes.unresolvedRows,
      "| unresolved targets", mapped.notes.unresolvedTargets.length,
      mapped.notes.unresolvedTargets,
    );

    expect(mapped.links.length).toBe(8690);
    expect(mapped.notes.cardsWithLinks).toBe(4323);
    // Both surfaces. Reading only `content` would find 12% of the links.
    expect(mapped.notes.linksInContent).toBe(1011);
    expect(mapped.notes.linksInFields).toBe(7679);
    expect(mapped.notes.distinctTargets).toBe(2881);
    expect(mapped.notes.unresolvedRows).toBe(18);
    expect(mapped.notes.unresolvedTargets.length).toBe(15);
  });

  it("reconciles the parse against Mochi's references array (SPEC's 8 of 7,771)", () => {
    const refs = reconcileReferences(linked);
    console.log("references           ", refs);
    // SPEC quotes "7,763 of 7,771 resolve ... the remaining 8", which is this
    // array, not the parsed rows. The two sets genuinely differ.
    expect(refs.declared).toBe(7771);
    expect(refs.declaredUnresolved).toBe(8);
    expect(refs.declaredOnly).toBe(41);
    expect(refs.parsedOnly).toBe(92);
  });

  it("loads both into the database and reads them back through the views", () => {
    // One synthetic deck holding every card: this test owns tags and links, and
    // the deck/template mapping is exercised by test/transit.test.ts.
    db.prepare("INSERT INTO decks (id, name) VALUES ('all', '日本語')").run();
    const insertCard = db.prepare("INSERT INTO cards (id, deck_id, name) VALUES (?, 'all', ?)");
    db.transaction(() => {
      for (const card of cards) {
        insertCard.run(card["id"] as string, (card["name"] as string) ?? "");
      }
    })();

    const tags = importTags(db, tagged);
    const links = importLinks(db, linked);
    console.log("written              ", { tags: tags.tags, cardTags: tags.cardTags, links: links.links });

    expect(db.prepare("SELECT count(*) FROM tags").pluck().get()).toBe(20);
    expect(db.prepare("SELECT count(*) FROM card_tags").pluck().get()).toBe(66);
    expect(db.prepare("SELECT count(*) FROM card_links").pluck().get()).toBe(8690);

    const byResolution = db
      .prepare("SELECT resolved, count(*) AS rows FROM card_links_resolved GROUP BY resolved")
      .all();
    const usedTags = db
      .prepare("SELECT count(*) FROM tag_usage WHERE cards_direct > 0")
      .pluck()
      .get();
    console.log("card_links_resolved  ", byResolution, "| tags with cards", usedTags);
    expect(byResolution).toEqual([
      { resolved: 0, rows: 18 },
      { resolved: 1, rows: 8672 },
    ]);
    expect(usedTags).toBe(19);

    // The tag every UI showed twice, now one tag with all 8 of its cards.
    const buddhism = db.prepare("SELECT * FROM tag_usage WHERE path = 'Buddhism'").get();
    console.log("Buddhism             ", buddhism);
    expect(buddhism).toMatchObject({ cards_direct: 8, depth: 0 });

    expect(checkIntegrity(db)).toEqual([]);
  });
});
