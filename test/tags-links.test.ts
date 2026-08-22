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
import { buildSearchText } from "../src/schema/index.js";
import { renderPlainText, renderPlainTextParts } from "../src/text/index.js";

/**
 * Stage 1 acceptance for tags and card links.
 *
 * The oracle is the real corpus: 23 raw tag strings normalise to 19, and 8,744
 * wiki-links come out of 4,335 cards with the unresolved ones counted, not
 * dropped. The synthetic blocks pin the rules the corpus exercises only once —
 * the invisible U+200B duplicates, an ancestor path that must be synthesised so
 * Dialect/Kansai can exist, a link whose target was never exported.
 *
 * 8,744 and not 8,690: the parser used to require the pipe, which silently
 * dropped 46 `[[card-id]]` and 8 `[[|card-id]]` links. All 54 resolve.
 */

const EXPORT_DIRS = ["exports/日本語", "exports/English", "exports/基本情報"] as const;
const haveCorpus = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

/** U+200B ZERO WIDTH SPACE — the character that corrupted the real tag list. */
const ZWSP = "​";

/**
 * U+200E LEFT-TO-RIGHT MARK — the character Zach types between two links so
 * that Mochi can tell them apart. 3,016 of them, 2,911 sitting exactly between
 * `]]` and `[[`, on 2,478 cards.
 */
const LRM = "‎";

/** A real compound from the corpus, verbatim: 引き + 換え, joined by the mark. */
const REAL_COMPOUND = `[[引き|10PQotxm]]${LRM}[[換え|C1p9g1mL]]`;

/** Make the invisible characters visible, so test output can be read. */
function visible(text: string): string {
  return text.replace(
    /[\u200B-\u200F\uFEFF]/g,
    (character) => `<U+${character.codePointAt(0)?.toString(16).toUpperCase()}>`,
  );
}

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

/** Seed cards that carry a real name, for the display-text fallback. */
function seedNamed(named: Readonly<Record<string, string>>): void {
  db.prepare("INSERT INTO decks (id, name) VALUES ('d', 'テスト') ON CONFLICT DO NOTHING").run();
  const insert = db.prepare("INSERT INTO cards (id, deck_id, name) VALUES (?, 'd', ?)");
  for (const [id, name] of Object.entries(named)) insert.run(id, name);
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
  /**
   * A TAG REMOVED IN MOCHI WAS PERMANENT HERE until 2026-08-22. `src/import/tags.ts`
   * had no DELETE at any line, while both siblings prune — so every fresh export
   * was strictly additive, and Zach tags in Mochi daily.
   *
   * Three shapes, because only the first is obvious:
   *   1. one of two tags removed
   *   2. the LAST tag removed, so the card carries no `tags` array at all and is
   *      absent from `mapped.cardTags` — the prune cannot be keyed on that list
   *   3. `manual` demoted, which `max(manual, excluded.manual)` made monotonic
   *      and therefore one-way
   * And one negative: a card from an export NOT being re-read keeps its tags,
   * or importing one of three exports would strip the other two.
   */
  it("removes a tag that Mochi no longer carries, including the last one", () => {
    seedCards("c1", "c2", "c3");
    importTags(db, [
      { id: "c1", tags: ["Dialect/Kansai", "Buddhism"] },
      { id: "c2", tags: ["Buddhism"], "manual-tags": ["Buddhism"] },
      { id: "c3", tags: ["Buddhism"] },
    ]);
    const pathsFor = (card: string) =>
      db
        .prepare("SELECT tag_path, manual FROM card_tags WHERE card_id = ? ORDER BY tag_path")
        .all(card);
    expect(pathsFor("c1")).toEqual([
      { tag_path: "Buddhism", manual: 0 },
      { tag_path: "Dialect/Kansai", manual: 0 },
    ]);
    expect(pathsFor("c2")).toEqual([{ tag_path: "Buddhism", manual: 1 }]);

    // Re-import: c1 loses one tag, c2 is demoted to non-manual, c3 loses its
    // only tag and so carries no array at all. c3 is the case that fails if the
    // prune is scoped to the cards that still have tags.
    const again = importTags(db, [
      { id: "c1", tags: ["Buddhism"] },
      { id: "c2", tags: ["Buddhism"] },
      { id: "c3" },
    ]);

    expect(pathsFor("c1")).toEqual([{ tag_path: "Buddhism", manual: 0 }]);
    expect(pathsFor("c2")).toEqual([{ tag_path: "Buddhism", manual: 0 }]);
    expect(pathsFor("c3")).toEqual([]);

    // Reported, not inferred: 4 rows removed, 2 written back.
    expect(again.cardTagsReplaced).toBe(4);
    expect(again.cardTags).toBe(2);

    // The `tags` rows survive losing their last card — `parent_path` is a
    // foreign key and the synthesised ancestor has no cards of its own.
    const kept = db.prepare("SELECT count(*) AS n FROM tags").get() as { n: number };
    expect(kept.n).toBe(3);
    expect(
      db.prepare("SELECT count(*) AS n FROM tag_usage WHERE cards_direct > 0").get(),
    ).toEqual({ n: 1 });
  });

  it("leaves a card alone when its export is not the one being re-read", () => {
    seedCards("c1", "c2");
    importTags(db, [
      { id: "c1", tags: ["Buddhism"] },
      { id: "c2", tags: ["Dialect/Kansai"] },
    ]);
    // Only c1's export is re-read. c2 is untouched, tags intact.
    const again = importTags(db, [{ id: "c1", tags: ["Buddhism"] }]);
    expect(again.cardTagsReplaced).toBe(1);
    expect(
      db.prepare("SELECT tag_path FROM card_tags WHERE card_id = 'c2'").all(),
    ).toEqual([{ tag_path: "Dialect/Kansai" }]);
    db.prepare("DELETE FROM card_tags").run();
  });

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

// ─── the link grammar ────────────────────────────────────────────────────────

describe("wikiLinks", () => {
  it("parses display text and target out of every occurrence", () => {
    const parsed = wikiLinks("～に引き換え means [[引く|aaa]] plus [[換える|bbb]].");
    expect(parsed.map(({ display, target, form, raw }) => ({ display, target, form, raw }))).toEqual([
      { display: "引く", target: "aaa", form: "piped", raw: "[[引く|aaa]]" },
      { display: "換える", target: "bbb", form: "piped", raw: "[[換える|bbb]]" },
    ]);
    // `index` is the offset of `raw`, which is what lets the renderer splice.
    expect(parsed.map((link) => link.index)).toEqual(
      parsed.map((link) => "～に引き換え means [[引く|aaa]] plus [[換える|bbb]].".indexOf(link.raw)),
    );
  });

  // ── PASS CONDITION: all three forms parse ─────────────────────────────────
  it("accepts all three authored forms, which is the 54 dropped links", () => {
    const parsed = wikiLinks("[[越す|t1]] [[pvtj9W17]] [[|YGaSlUTe]]");
    console.log("three forms          ", parsed);
    expect(parsed.map((link) => [link.form, link.display, link.target])).toEqual([
      ["piped", "越す", "t1"],
      ["bare", "", "pvtj9W17"],
      ["empty-display", "", "YGaSlUTe"],
    ]);
  });

  it("refuses a bracket pair with no target, which Mochi also refuses", () => {
    // `[[a|]]` and `[[]]` render as the literal text the author typed. 0 in the
    // corpus; tools/mochi.py agrees, its target class is one-or-more.
    expect(wikiLinks("[[a|]] [[]] [[|]]")).toEqual([]);
  });

  // ── PASS CONDITION: adjacency, with and without the mark ───────────────────
  it("parses two adjacent links with the U+200E mark AND without it", () => {
    const marked = wikiLinks(`[[a|1]]${LRM}[[b|2]]`);
    const bare = wikiLinks("[[a|1]][[b|2]]");
    console.log("with U+200E          ", marked.map((l) => `${l.display}->${l.target}`));
    console.log("no mark at all       ", bare.map((l) => `${l.display}->${l.target}`));
    expect(marked).toHaveLength(2);
    expect(bare).toHaveLength(2);
    expect(marked.map((l) => l.target)).toEqual(["1", "2"]);
    expect(bare.map((l) => l.target)).toEqual(["1", "2"]);
    // The mark is why he could type it at all; the parser no longer needs it.
    expect(marked.map((l) => l.display)).toEqual(bare.map((l) => l.display));
  });

  it("is not confused by repeated calls (the global-regex lastIndex trap)", () => {
    const text = "[[a|1]][[b|2]]";
    expect(wikiLinks(text)).toHaveLength(2);
    expect(wikiLinks(text)).toHaveLength(2);
  });
});

// ─── the shared renderer ─────────────────────────────────────────────────────

describe("renderPlainText", () => {
  it("joins a compound that was authored as two links plus an invisible mark", () => {
    expect(renderPlainText(REAL_COMPOUND)).toBe("引き換え");
    expect(renderPlainText(REAL_COMPOUND)).not.toContain(LRM);
  });

  it("renders the same whether or not the mark is there", () => {
    expect(renderPlainText("[[引き|10PQotxm]][[換え|C1p9g1mL]]")).toBe("引き換え");
  });

  it("keeps the text around a link, and leaves markdown readable", () => {
    expect(renderPlainText("[[越す|abc12345]]に越したことはない")).toBe("越すに越したことはない");
    expect(renderPlainText("[[**enactment**|zeeUDLTL]]")).toBe("**enactment**");
  });

  it("drops every invisible mark, not just the one Zach uses", () => {
    expect(renderPlainText("あ​い‌う‍え‎お﻿か")).toBe("あいうえおか");
  });

  it("shows the target card's name for the two display-less forms", () => {
    const names: Record<string, string> = { pvtj9W17: "何", YGaSlUTe: "covetousness" };
    const resolveName = (id: string): string | undefined => names[id];
    expect(renderPlainText("[[pvtj9W17]]", { resolveName })).toBe("何");
    expect(renderPlainText("[[|YGaSlUTe]]", { resolveName })).toBe("covetousness");
  });

  it("renders a display-less link as nothing rather than leaking the id", () => {
    // No resolver, or a target that does not exist: an 8-character handle is
    // not text, and putting it in the search index matches unrelated queries.
    expect(renderPlainText("[[pvtj9W17]]")).toBe("");
    expect(renderPlainText("[[|YGaSlUTe]]")).toBe("");
  });

  it("leaves a targetless bracket pair alone", () => {
    expect(renderPlainText("[[a|]]")).toBe("[[a|]]");
  });

  it("joins the parts of a card with newlines, skipping the empty ones", () => {
    expect(renderPlainTextParts(["単語", null, undefined, "", "意味"])).toBe("単語\n意味");
    expect(renderPlainTextParts([])).toBe("");
  });
});

// ─── links on a card ─────────────────────────────────────────────────────────

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
    const rows = cardLinks(card).map(
      ({ from_card_id, to_card_id, display_text, field_id, ordinal }) => ({
        from_card_id, to_card_id, display_text, field_id, ordinal,
      }),
    );
    expect(rows).toEqual([
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

  it("takes display text from the target card's name when none was authored", () => {
    const mapped = mapCardLinks([
      { id: "c1", name: "compound", content: "[[t1]] [[|t2]]" },
      { id: "t1", name: "何" },
      { id: "t2", name: "covetousness" },
    ]);
    console.log("fallback display     ", mapped.links.map((row) => row.display_text));
    expect(mapped.links.map((row) => row.display_text)).toEqual(["何", "covetousness"]);
    expect(mapped.notes.byForm).toEqual({ piped: 0, bare: 1, emptyDisplay: 1 });
    expect(mapped.notes.displayFromTargetName).toBe(2);
    expect(mapped.notes.displayMissing).toBe(0);
  });

  it("still writes the row when the name cannot be found", () => {
    const mapped = mapCardLinks([{ id: "c1", content: "[[gone]]" }]);
    expect(mapped.links.map((row) => [row.to_card_id, row.display_text])).toEqual([["gone", ""]]);
    expect(mapped.notes.displayMissing).toBe(1);
    expect(mapped.notes.unresolvedTargets).toEqual(["gone"]);
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

  it("writes the bare and empty-display forms, naming them from the database", () => {
    seedNamed({ c1: "～に引き換え", pvtj9W17: "何", YGaSlUTe: "covetousness" });
    const result = importLinks(db, [
      { id: "c1", content: "[[pvtj9W17]] and [[|YGaSlUTe]]" },
    ]);
    console.log("recovered forms      ", result.byForm, "from name", result.displayFromTargetName);
    expect(result.links).toBe(2);
    expect(result.byForm).toEqual({ piped: 0, bare: 1, emptyDisplay: 1 });
    expect(result.displayFromTargetName).toBe(2);
    expect(result.unresolvedRows).toBe(0);

    const rows = db
      .prepare("SELECT to_card_id, display_text, resolved FROM card_links_resolved ORDER BY ordinal")
      .all();
    console.log("card_links_resolved  ", rows);
    expect(rows).toEqual([
      { to_card_id: "pvtj9W17", display_text: "何", resolved: 1 },
      { to_card_id: "YGaSlUTe", display_text: "covetousness", resolved: 1 },
    ]);
  });

  // ── PASS CONDITION: the mark survives storage, and not the rendering ───────
  it("keeps U+200E in the stored value and not in the rendered text", () => {
    seedNamed({ "10PQotxm": "引き", C1p9g1mL: "換え" });
    db.prepare("INSERT INTO cards (id, deck_id, name, content) VALUES ('c1', 'd', '引き換え', ?)")
      .run(REAL_COMPOUND);
    const links = importLinks(db, [{ id: "c1", content: REAL_COMPOUND }]);
    expect(links.links).toBe(2);

    const stored = db.prepare("SELECT content FROM cards WHERE id = 'c1'").pluck().get() as string;
    const rendered = renderPlainText(stored);
    db.prepare("UPDATE cards SET search_text = ? WHERE id = 'c1'").run(rendered);
    const indexed = db
      .prepare("SELECT body FROM card_search_index WHERE card_id = 'c1'")
      .pluck()
      .get() as string;

    console.log("authored ", visible(REAL_COMPOUND));
    console.log("stored   ", visible(stored));
    console.log("rendered ", visible(rendered));
    console.log("indexed  ", visible(indexed));

    // Byte-identical to what was authored: the mark, both links, everything.
    expect(stored).toBe(REAL_COMPOUND);
    expect(stored).toContain(LRM);
    expect(stored.split(LRM).length - 1).toBe(1);
    // And the projection has neither the mark nor the syntax.
    expect(rendered).toBe("引き換え");
    expect(rendered).not.toContain(LRM);
    expect(indexed).toContain("引き換え");
    // The compound is findable as one word, which is the point of rendering.
    const hit = db
      .prepare("SELECT card_id FROM card_fts WHERE card_fts MATCH ?")
      .all('"引き換え"');
    expect(hit).toEqual([{ card_id: "c1" }]);
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

  /** `content` plus every string field value, in the export's own order. */
  function textParts(card: Record<string, unknown>): (string | null | undefined)[] {
    const parts: (string | null | undefined)[] = [card["content"] as string | undefined];
    for (const field of Object.values((card["fields"] ?? {}) as Record<string, unknown>)) {
      const value =
        typeof field === "object" && field !== null
          ? (field as Record<string, unknown>)["value"]
          : field;
      if (typeof value === "string") parts.push(value);
    }
    return parts;
  }

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

  // ── PASS CONDITION 2: 8,744 links, none of the three forms dropped ─────────
  it("extracts 8,744 links from 4,335 cards, 18 rows unresolved", () => {
    const mapped = mapCardLinks(linked);
    console.log(
      "links", mapped.links.length,
      "| cards with links", mapped.notes.cardsWithLinks,
      "| in content", mapped.notes.linksInContent,
      "| in field values", mapped.notes.linksInFields,
    );
    console.log("by authored form     ", mapped.notes.byForm);
    console.log(
      "display from target name", mapped.notes.displayFromTargetName,
      "| display missing", mapped.notes.displayMissing,
    );
    console.log(
      "distinct targets", mapped.notes.distinctTargets,
      "| unresolved rows", mapped.notes.unresolvedRows,
      "| unresolved targets", mapped.notes.unresolvedTargets.length,
      mapped.notes.unresolvedTargets,
    );

    expect(mapped.links.length).toBe(8744);
    // 8,690 was the old total: the pipe-only parser saw only the first of these.
    expect(mapped.notes.byForm).toEqual({ piped: 8690, bare: 46, emptyDisplay: 8 });
    expect(mapped.notes.cardsWithLinks).toBe(4335);
    // Both surfaces. Reading only `content` would find 12% of the links.
    expect(mapped.notes.linksInContent).toBe(1019);
    expect(mapped.notes.linksInFields).toBe(7725);
    expect(mapped.notes.distinctTargets).toBe(2895);
    // Unchanged by the fix: every one of the 54 recovered links resolves.
    expect(mapped.notes.unresolvedRows).toBe(18);
    expect(mapped.notes.unresolvedTargets.length).toBe(15);
    // All 54 display-less links found their target's name.
    expect(mapped.notes.displayFromTargetName).toBe(54);
    expect(mapped.notes.displayMissing).toBe(0);
  });

  it("resolves every one of the 54 links the old parser dropped", () => {
    const known = new Set(linked.map((card) => card.id));
    const recovered = mapCardLinks(linked).links.filter((row) => row.form !== "piped");
    const unresolved = recovered.filter((row) => !known.has(row.to_card_id));
    console.log("recovered            ", recovered.length, "| unresolved", unresolved.length);
    console.log("sample               ", recovered.slice(0, 4).map((row) =>
      `${row.form} -> ${row.to_card_id} "${row.display_text}"`));
    expect(recovered.length).toBe(54);
    expect(unresolved).toEqual([]);
    expect(recovered.every((row) => row.display_text !== "")).toBe(true);
  });

  it("reconciles the parse against Mochi's references array (SPEC's 8 of 7,771)", () => {
    const refs = reconcileReferences(linked);
    console.log("references           ", refs);
    // SPEC quotes "7,763 of 7,771 resolve ... the remaining 8", which is this
    // array, not the parsed rows. The two sets genuinely differ.
    expect(refs.declared).toBe(7771);
    expect(refs.declaredUnresolved).toBe(8);
    // Was 41 before the fix. Mochi's own derived array already knew about 40 of
    // the links the pipe-only parser could not see — independent corroboration
    // that the recovered 54 are real edges and not a looser regex inventing them.
    expect(refs.declaredOnly).toBe(1);
    expect(refs.parsedOnly).toBe(97);
  });

  it("finds the U+200E compounds, and renders them without the mark", () => {
    const withMark = linked.filter((card) =>
      textParts(card as unknown as Record<string, unknown>).some(
        (part) => typeof part === "string" && part.includes(`]]${LRM}[[`),
      ),
    );
    const sample = withMark[0] as unknown as Record<string, unknown>;
    const raw = textParts(sample).find(
      (part) => typeof part === "string" && part.includes(`]]${LRM}[[`),
    ) as string;
    const names = new Map(linked.map((card) => [card.id, card.name ?? ""] as const));
    const rendered = renderPlainText(raw, { resolveName: (id) => names.get(id) });
    console.log("cards with ]]U+200E[[", withMark.length);
    console.log("raw                  ", visible(raw));
    console.log("rendered             ", visible(rendered));

    expect(withMark.length).toBe(2478);
    expect(raw).toContain(LRM);
    expect(rendered).not.toContain(LRM);
    expect(rendered).not.toContain("[[");
  });

  /**
   * `buildSearchText` in `src/schema/index.ts` is a thin alias for
   * `renderPlainTextParts`. It used to be a SECOND IMPLEMENTATION, and the two
   * had already drifted before anyone noticed — this corpus sweep was green the
   * whole time, because no card in the corpus takes any of the shapes they
   * disagreed on. Corpus agreement is therefore necessary and not sufficient,
   * so the shapes are probed directly below it.
   */
  it("renders identically to the schema module's alias, on every card", () => {
    let differ = 0;
    const examples: string[] = [];
    for (const card of cards as unknown as Record<string, unknown>[]) {
      const parts = textParts(card);
      const mine = renderPlainTextParts(parts);
      const theirs = buildSearchText(...parts);
      if (mine !== theirs) {
        differ += 1;
        if (examples.length < 3) examples.push(String(card["id"]));
      }
    }
    console.log("cards rendered       ", cards.length, "| disagreements", differ, examples);
    expect(differ).toBe(0);
  });

  /**
   * The four inputs the two copies used to disagree on, and four they agreed on
   * even while drifting. Every one of these is OUTSIDE the corpus, which is the
   * point: this is the test the corpus sweep cannot be.
   */
  it("agrees with the schema alias on the shapes that used to drift", () => {
    const probes = [
      // Was: buildSearchText 'a'. A targetless [[a|]] is not a link.
      ["[[a|]]", "[[a|]]"],
      // Was: buildSearchText ''.
      ["[[]]", "[[]]"],
      ["[[|]]", "[[|]]"],
      // Was: buildSearchText 'displaytail'.
      ["[[display|]]tail", "[[display|]]tail"],
      // These four agreed even before the merge; they stay pinned so a future
      // rewrite of the grammar cannot quietly change the corpus behaviour.
      ["[[越す|abc12345]]に越したことはない", "越すに越したことはない"],
      ["[[10PQotxm]]", ""],
      ["[[|C1p9g1mL]]", ""],
      ["[[a|b|c]]", "a"],
    ] as const;
    const drifted: string[] = [];
    for (const [input, expected] of probes) {
      const mine = renderPlainText(input);
      const theirs = buildSearchText(input);
      expect(mine).toBe(expected);
      if (mine !== theirs) drifted.push(`${input}: src/text=${mine} schema=${theirs}`);
    }
    console.log("drift probes", probes.length, "| divergent", drifted.length, drifted);
    expect(drifted).toEqual([]);
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
    expect(db.prepare("SELECT count(*) FROM card_links").pluck().get()).toBe(8744);
    // Nothing was written with an empty display: the names came from the rows
    // already in `cards`, which is where importLinks reads them from.
    expect(
      db.prepare("SELECT count(*) FROM card_links WHERE display_text = ''").pluck().get(),
    ).toBe(0);

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
      { resolved: 1, rows: 8726 },
    ]);
    expect(usedTags).toBe(19);

    // The tag every UI showed twice, now one tag with all 8 of its cards.
    const buddhism = db.prepare("SELECT * FROM tag_usage WHERE path = 'Buddhism'").get();
    console.log("Buddhism             ", buddhism);
    expect(buddhism).toMatchObject({ cards_direct: 8, depth: 0 });

    expect(checkIntegrity(db)).toEqual([]);
  });
});
