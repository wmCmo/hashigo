/**
 * Stage 8 acceptance. SPEC's "Search — Ctrl+K over the stage-1 index", and the
 * defect FIXES.md §3.5 named: the index existed and worked, and nothing routed
 * to it.
 *
 * 1. THE TWO-CHARACTER QUERY IS THE CASE, NOT THE EXCEPTION. FTS5's trigram
 *    tokeniser cannot serve fewer than three characters, and two characters is
 *    the commonest search unit in Japanese — 意味, 勉強, 漢字, 日本. The pass
 *    condition is that `searchCards` returns the same counts as a raw LIKE over
 *    `card_search_index`: 意味 3, する 228, ない 74, 勉強 1. Asserted through
 *    the public API, and separately against the raw SQL in the same test so the
 *    oracle is computed here rather than quoted from a brief.
 *
 * 2. SEARCH SEES THE RENDERED TEXT. `～に[[引き|10PQotxm]]‎[[換え|C1p9g1mL]]`
 *    is findable as 引き換え. Pinned twice: end to end on the real corpus, and
 *    on a hand-built database where the raw text provably does NOT contain the
 *    compound, because on the real card Mochi's own primary field happens to
 *    store the plain form and would have found it either way. The corpus-wide
 *    version of the claim is the opaque-id one: a trigram index over the raw
 *    concatenation matches 2,870 of 2,895 link target ids; `card_fts` matches 0.
 *
 * 3. RANKING, ON BOTH PATHS. `bm25()` for FTS; field weight + capped term
 *    frequency + length normalisation for the scan. Asserted as the actual top
 *    hit (`する` -> the card titled する), as differing from `card_id` order, and
 *    as a strictly decreasing score — a sort in the wrong direction returns the
 *    worst 50 matches in confident order, which "the order differs" would pass.
 *
 * 4. NOTHING YOU CAN TYPE BREAKS OR STEERS EITHER PATH. `%`, `_`, `"`, `*`,
 *    `AND`, `col:`, `-abc` and the LaTeX backslashes that really are in his cards
 *    (`$\div$`, `\~`). Escaping is asserted by COUNT, not by absence of an
 *    exception: an unescaped `%` does not throw, it matches all 7,716 cards.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { importExports, readSource, type ImportSource } from "../src/import/index.js";
import {
  FTS_MIN_QUERY_CHARS as SCHEMA_FTS_MIN_QUERY_CHARS,
  buildSearchText,
  escapeLike as schemaEscapeLike,
  ftsPhrase as schemaFtsPhrase,
  searchPlan,
} from "../src/schema/index.js";
import { INVISIBLE_MARKS } from "../src/text/index.js";
import {
  DEFAULT_SEARCH_LIMIT,
  FTS_BM25_WEIGHTS,
  FTS_COLUMNS,
  FTS_MIN_QUERY_CHARS,
  INVISIBLE_CODE_POINTS,
  LIKE_ESCAPE,
  MAX_SEARCH_LIMIT,
  MAX_TERMS,
  SCAN_WEIGHTS,
  asciiLower,
  bm25Expression,
  buildFtsSearch,
  buildScanSearch,
  charCount,
  escapeLike,
  ftsMatchExpression,
  ftsPhrase,
  likeContains,
  likePrefix,
  makeSnippet,
  normaliseQuery,
  parseSearchQuery,
  searchCards,
  searchIndexStatus,
  strippedNameSql,
} from "../src/search/index.js";

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const EXPORT_DIRS = EXPORT_NAMES.map((name) => resolve(import.meta.dirname, "..", "exports", name));
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

/** One backslash, never written as a literal. See LIKE_ESCAPE in query.ts. */
const BS = String.fromCharCode(92);
/** U+200E LEFT-TO-RIGHT MARK — the one Zach typed between adjacent links. */
const LRM = "‎";

// ---------------------------------------------------------------------------
// 1. Routing. Pure, so it runs everywhere.
// ---------------------------------------------------------------------------

describe("the router", () => {
  it("sends 1-2 character queries to the scan and 3+ to the trigram index", () => {
    expect(parseSearchQuery("意")?.mode).toBe("like");
    expect(parseSearchQuery("意味")?.mode).toBe("like");
    expect(parseSearchQuery("勉強")?.mode).toBe("like");
    expect(parseSearchQuery("気持ち")?.mode).toBe("fts");
    expect(parseSearchQuery("とはない")?.mode).toBe("fts");
    expect(parseSearchQuery("abc")?.mode).toBe("fts");
  });

  it("counts CODE POINTS, so an astral character is one character", () => {
    // Three emoji are three characters, and the trigram index can serve them.
    expect(charCount("🍣🍜🍙")).toBe(3);
    expect("🍣🍜🍙".length).toBe(6);
    expect(parseSearchQuery("🍣🍜🍙")?.mode).toBe("fts");
    // Two are two, and the index cannot.
    expect(parseSearchQuery("🍣🍜")?.mode).toBe("like");
  });

  it("returns null for an empty or whitespace-only query, not 'everything'", () => {
    expect(parseSearchQuery("")).toBeNull();
    expect(parseSearchQuery("   ")).toBeNull();
    expect(parseSearchQuery("\t\n")).toBeNull();
    // Invisible marks are stripped, so a query of nothing but marks is empty.
    expect(parseSearchQuery(LRM + "​")).toBeNull();
  });

  it("normalises the query exactly as the index was normalised, and no further", () => {
    // NFC, marks stripped, whitespace collapsed.
    expect(normaliseQuery(`引き${LRM}換え`)).toBe("引き換え");
    expect(normaliseQuery("  勉強   する  ")).toBe("勉強 する");
    // U+FA1E, a compatibility ideograph, is NFC-folded — the index is NFC too.
    expect(normaliseQuery("羽")).toBe("羽");
    // NFKC is NOT applied: ～ (U+FF5E) stays itself, because 464 cards use it
    // and the index does not fold it either.
    expect(normaliseQuery("～に")).toBe("～に");
    expect(normaliseQuery("～に")).not.toBe("~に");
  });

  it("splits on whitespace and routes on the SHORTEST term", () => {
    const mixed = parseSearchQuery("気持ち 意味");
    expect(mixed?.terms).toEqual(["気持ち", "意味"]);
    expect(mixed?.shortestTermChars).toBe(2);
    // One two-character term is enough to make the whole FTS query wrong, so
    // the whole query scans.
    expect(mixed?.mode).toBe("like");

    const long = parseSearchQuery("気持ち 言えない");
    expect(long?.mode).toBe("fts");
    expect(long?.terms).toEqual(["気持ち", "言えない"]);
  });

  it("drops terms past MAX_TERMS and says so instead of silently truncating", () => {
    const many = Array.from({ length: MAX_TERMS + 4 }, (_, i) => `term${i}`).join(" ");
    const parsed = parseSearchQuery(many);
    expect(parsed?.terms).toHaveLength(MAX_TERMS);
    expect(parsed?.termsDropped).toBe(4);
    expect(parseSearchQuery("one two")?.termsDropped).toBe(0);
  });

  it("refuses to build a MATCH for a term the trigram index cannot serve", () => {
    // Not cosmetic. FTS5 answers a zero-token phrase under AND with zero rows,
    // so a leaked 2-character term reports "no results" for a real query.
    expect(() => ftsMatchExpression(["意味"])).toThrow(/cannot serve fewer than 3/);
    expect(() => ftsMatchExpression(["気持ち", "意味"])).toThrow(/意味/);
    expect(() => ftsMatchExpression([])).toThrow(/no terms/);
    expect(ftsMatchExpression(["気持ち", "言えない"])).toBe('"気持ち" AND "言えない"');
  });

  it("writes AND out, because FTS5 juxtaposition is phrase concatenation", () => {
    expect(ftsMatchExpression(["abc", "def"])).toContain(" AND ");
  });
});

// ---------------------------------------------------------------------------
// 2. Escaping, as pure functions. The database half is asserted by count below.
// ---------------------------------------------------------------------------

describe("escaping", () => {
  it("escapes the three LIKE metacharacters and nothing else", () => {
    expect(escapeLike("100%")).toBe(`100${BS}%`);
    expect(escapeLike("a_b")).toBe(`a${BS}_b`);
    expect(escapeLike(BS)).toBe(BS + BS);
    expect(escapeLike(`${BS}*`)).toBe(`${BS}${BS}*`);
    // Not metacharacters, so untouched.
    expect(escapeLike("*?[]~")).toBe("*?[]~");
    expect(escapeLike("引き換え")).toBe("引き換え");
  });

  it("keeps surrogate pairs whole", () => {
    expect(escapeLike("🍣%🍜")).toBe(`🍣${BS}%🍜`);
    expect([...escapeLike("🍣%🍜")]).toHaveLength(4);
  });

  it("wraps a phrase and doubles the quotes", () => {
    expect(ftsPhrase("abc")).toBe('"abc"');
    expect(ftsPhrase('a"b')).toBe('"a""b"');
    expect(ftsPhrase('"')).toBe('""""');
    // Every FTS5 operator becomes literal text.
    expect(ftsPhrase("AND")).toBe('"AND"');
    expect(ftsPhrase("col:")).toBe('"col:"');
    expect(ftsPhrase("abc*")).toBe('"abc*"');
  });

  it("builds the patterns the scan uses", () => {
    expect(likeContains("意味")).toBe("%意味%");
    expect(likePrefix("意味")).toBe("意味%");
    expect(likeContains("50%")).toBe(`%50${BS}%%`);
  });

  it("folds case ASCII-only, the way SQLite LIKE and lower() do", () => {
    expect(asciiLower("Kanji")).toBe("kanji");
    // Not folded: SQLite would not fold these either, and a snippet that used a
    // wider fold would highlight text the query did not match.
    expect(asciiLower("ÄÖÜ")).toBe("ÄÖÜ");
    expect(asciiLower("ＫＡＮＪＩ")).toBe("ＫＡＮＪＩ");
    // Length-preserving, which is what makes snippet offsets valid.
    expect(asciiLower("AÄ🍣").length).toBe("AÄ🍣".length);
  });
});

// ---------------------------------------------------------------------------
// 3. The two forced duplications, pinned equal to their originals.
// ---------------------------------------------------------------------------

describe("agreement with the modules src/search cannot import", () => {
  it("uses the same trigram floor as src/schema/index.ts", () => {
    // src/search/ cannot import src/schema/index.ts: that module reads its .sql
    // with node:fs at load time, so importing it would make Ctrl+K Node-only.
    // The copy is therefore forced; this is what stops it drifting.
    expect(FTS_MIN_QUERY_CHARS).toBe(SCHEMA_FTS_MIN_QUERY_CHARS);
  });

  it("escapes identically to src/schema/index.ts over a probe set", () => {
    const probes = [
      "意味",
      "100%",
      "a_b",
      BS,
      `${BS}*`,
      "%_",
      '"',
      "*",
      "**",
      "AND",
      "col:",
      "-abc",
      `$${BS}div$`,
      "🍣%🍜",
    ];
    for (const probe of probes) {
      expect(escapeLike(probe)).toBe(schemaEscapeLike(probe));
      expect(ftsPhrase(probe)).toBe(schemaFtsPhrase(probe));
    }
  });

  it("routes identically to searchPlan() over a probe set", () => {
    for (const probe of ["意", "意味", "気持ち", "とはない", "abc", "ab", "a", "🍣🍜", "🍣🍜🍙"]) {
      expect(parseSearchQuery(probe)?.mode).toBe(searchPlan(probe)?.mode);
    }
    expect(parseSearchQuery("  ")).toBeNull();
    expect(searchPlan("  ")).toBeNull();
  });

  it("strips exactly the marks src/text/render.ts strips", () => {
    const fromSearch = INVISIBLE_CODE_POINTS.map((code) => String.fromCodePoint(code)).join("");
    // Every code point this module strips in SQL is one src/text strips in JS.
    expect(fromSearch.replace(new RegExp(INVISIBLE_MARKS.source, "g"), "")).toBe("");
    // And nothing src/text strips is missing from the SQL list.
    for (let code = 0x200a; code <= 0x2010; code += 1) {
      const character = String.fromCodePoint(code);
      const strippedByText = character.replace(new RegExp(INVISIBLE_MARKS.source, "g"), "") === "";
      const inSqlList = (INVISIBLE_CODE_POINTS as readonly number[]).includes(code);
      expect(inSqlList).toBe(strippedByText);
    }
    expect((INVISIBLE_CODE_POINTS as readonly number[]).includes(0xfeff)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. SQL generation. The bm25 weight-count footgun is the point of this block.
// ---------------------------------------------------------------------------

describe("the generated SQL", () => {
  const query = parseSearchQuery("気持ち");
  if (query === null) throw new Error("unreachable");

  it("gives bm25 exactly one weight per column, INCLUDING the UNINDEXED one", () => {
    // SQLite does not check the count. Measured on the real index:
    // bm25(card_fts, 10.0, 1.0, 3.0) on this 4-column table runs happily and
    // silently weights card_id by 10 and body by 3 — a scoring function nobody
    // wrote. So the vector is generated from FTS_COLUMNS, and this asserts it.
    const expression = bm25Expression();
    const weights = expression.slice(expression.indexOf("(") + 1, -1).split(",").slice(1);
    expect(weights).toHaveLength(FTS_COLUMNS.length);
    expect(FTS_COLUMNS[0]).toBe("card_id");
    expect(FTS_BM25_WEIGHTS.card_id).toBe(0);
    expect(expression).toBe("bm25(card_fts, 0.0, 8.0, 1.0, 4.0)");
  });

  it("sorts bm25 ASCENDING, because bm25 is negative-better", () => {
    const { sql } = buildFtsSearch(query, 10, 0, true);
    expect(sql).toContain("ORDER BY score ASC, c.seq ASC");
    expect(sql).not.toContain("ORDER BY score DESC");
  });

  it("never orders either path by card_id", () => {
    const scan = buildScanSearch(parseSearchQuery("意味")!, 10, 0, true);
    expect(scan.sql).not.toMatch(/ORDER BY[^L]*card_id/);
    expect(buildFtsSearch(query, 10, 0, true).sql).not.toMatch(/ORDER BY[^L]*card_id/);
  });

  it("emits one parameter per placeholder", () => {
    for (const built of [
      buildFtsSearch(query, 10, 0, true),
      buildScanSearch(parseSearchQuery("意味")!, 10, 0, true),
      buildScanSearch(parseSearchQuery("意味 勉強")!, 10, 0, false),
    ]) {
      expect(built.sql.split("?").length - 1).toBe(built.params.length);
    }
  });

  it("strips the invisible marks from the name column it filters and ranks on", () => {
    // card_search_index.body is rendered; its name column is cards.name, RAW.
    const scan = buildScanSearch(parseSearchQuery("意味")!, 10, 0, true);
    for (const code of INVISIBLE_CODE_POINTS) expect(scan.sql).toContain(`char(${code})`);
    expect(strippedNameSql("x")).toContain("replace(");
  });

  it("ANDs the terms of a multi-term scan", () => {
    const two = buildScanSearch(parseSearchQuery("意味 勉強")!, 10, 0, true);
    expect(two.sql).toContain(") AND (");
    expect(two.params).toContain("%意味%");
    expect(two.params).toContain("%勉強%");
  });

  it("keeps every ordering constant in one named place", () => {
    expect(SCAN_WEIGHTS.nameExact).toBeGreaterThan(SCAN_WEIGHTS.namePrefix);
    expect(SCAN_WEIGHTS.namePrefix).toBeGreaterThan(SCAN_WEIGHTS.nameContains);
    expect(SCAN_WEIGHTS.nameContains).toBeGreaterThan(SCAN_WEIGHTS.tags);
    expect(SCAN_WEIGHTS.tags).toBeGreaterThan(SCAN_WEIGHTS.body);
    // Term frequency breaks ties INSIDE a field bucket and can never cross one.
    const maxFrequency = SCAN_WEIGHTS.bodyOccurrence * SCAN_WEIGHTS.bodyOccurrenceCap;
    expect(maxFrequency).toBeLessThan(SCAN_WEIGHTS.tags - SCAN_WEIGHTS.body);
  });
});

// ---------------------------------------------------------------------------
// 5. Snippets.
// ---------------------------------------------------------------------------

describe("snippets", () => {
  const source = {
    name: "～に引き換え",
    body: "～に引き換え\nfalse\n～に引き換え\nin contrast to ...; unlike ...; while ...",
    tags: "Grammar/Contrast",
  };

  it("excerpts the body around the match and reports where the match is", () => {
    const snippet = makeSnippet(source, ["引き換え"], 6);
    expect(snippet).not.toBeNull();
    expect(snippet?.field).toBe("body");
    expect(snippet?.text.slice(snippet.matchStart, snippet.matchStart + snippet.matchLength)).toBe(
      "引き換え",
    );
  });

  it("flattens newlines without moving the offsets", () => {
    const snippet = makeSnippet(source, ["false"], 4);
    expect(snippet?.text).not.toContain("\n");
    expect(snippet?.text.slice(snippet.matchStart, snippet.matchStart + snippet.matchLength)).toBe(
      "false",
    );
  });

  it("falls back to name then tags, and returns null when no field matches", () => {
    expect(makeSnippet({ name: "x", body: "", tags: "" }, ["x"])?.field).toBe("name");
    expect(makeSnippet({ name: "", body: "", tags: "Kansai" }, ["kansai"])?.field).toBe("tags");
    expect(makeSnippet(source, ["nothing here"])).toBeNull();
    expect(makeSnippet({ name: "", body: "", tags: "" }, ["x"])).toBeNull();
  });

  it("never cuts a surrogate pair in half", () => {
    const body = `${"a".repeat(20)}🍣🍜🍙${"b".repeat(20)}match${"c".repeat(20)}`;
    const snippet = makeSnippet({ name: "", body, tags: "" }, ["match"], 25);
    expect(snippet).not.toBeNull();
    // A lone surrogate — a high one not followed by a low, or a low one not
    // preceded by a high — is what a naive slice() produces and what this
    // guards against. The window here is chosen to land inside the emoji run.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(snippet?.text ?? "")).toBe(false);
    // And the guard is load-bearing here, not decorative: `match` starts at
    // UTF-16 offset 46, so a radius of 25 wants to start the window at 21 —
    // the low half of 🍣. The unguarded slice at that offset is broken text.
    expect(body.indexOf("match")).toBe(46);
    expect(loneSurrogate.test(body.slice(21))).toBe(true);
    expect(snippet?.text.startsWith("…🍣")).toBe(true);
  });

  it("rejects a negative radius rather than producing a strange window", () => {
    expect(() => makeSnippet(source, ["false"], -1)).toThrow(/non-negative/);
  });
});

// ---------------------------------------------------------------------------
// 6. A hand-built database. Runs on a clean clone with no exports/.
// ---------------------------------------------------------------------------

interface Seed {
  readonly id: string;
  readonly name: string;
  /** Verbatim, as authored. Never touched. */
  readonly content?: string;
  readonly fields?: readonly (readonly [string, string])[];
  readonly tags?: readonly string[];
  readonly archived?: boolean;
}

function seed(db: Db, cards: readonly Seed[]): void {
  db.prepare("INSERT INTO decks (id, name) VALUES ('d1', '単語')").run();
  const insertCard = db.prepare(
    "INSERT INTO cards (id, deck_id, name, content, search_text, archived)" +
      " VALUES (?, 'd1', ?, ?, ?, ?)",
  );
  const insertValue = db.prepare(
    "INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?)",
  );
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (path, parent_path, name) VALUES (?, ?, ?)");
  const insertCardTag = db.prepare("INSERT INTO card_tags (card_id, tag_path) VALUES (?, ?)");

  db.transaction(() => {
    for (const card of cards) {
      const content = card.content ?? "";
      const values = card.fields ?? [];
      // The importer's rule, through the importer's function: search_text is
      // renderPlainTextParts over content plus every field value.
      const searchText = buildSearchText(content, ...values.map(([, value]) => value));
      insertCard.run(card.id, card.name, content, searchText, card.archived === true ? 1 : 0);
      for (const [fieldId, value] of values) insertValue.run(card.id, fieldId, value);
      for (const path of card.tags ?? []) {
        const parts = path.split("/");
        for (let i = 0; i < parts.length; i += 1) {
          const prefix = parts.slice(0, i + 1).join("/");
          insertTag.run(prefix, i === 0 ? null : parts.slice(0, i).join("/"), parts[i]);
        }
        insertCardTag.run(card.id, path);
      }
    }
  })();
}

describe("a hand-built database", () => {
  let db: Db;

  beforeAll(() => {
    db = openDatabase(MEMORY);
    seed(db, [
      // THE CASE THE RENDERED INDEX EXISTS FOR. The raw text holds neither
      // 引き換え nor 引き換 contiguously — only two linked halves joined by a
      // U+200E. On the real card Mochi's own `name` field also stores the plain
      // form, which is why the corpus version of this test proves less than it
      // looks; here there is no such field and the raw text genuinely lacks it.
      {
        id: "split001",
        name: `～に引き${LRM}換え`,
        fields: [["ref", `～に[[引き|10PQotxm]]${LRM}[[換え|C1p9g1mL]]`]],
      },
      // Exact-title hits, for ranking.
      { id: "exact001", name: "意味", fields: [["m", "meaning; significance"]] },
      { id: "prefix01", name: "意味合い", fields: [["m", "implication; nuance"]] },
      {
        id: "bodyonly1",
        name: "コンパイラの処理手順",
        fields: [["m", "字句解析 → 構文解析 → 意味解析 → 最適化 → コード生成"]],
      },
      // Term frequency, inside one field bucket.
      { id: "freq0001", name: "反復", fields: [["m", "意味 ".repeat(9)]] },
      { id: "freq0002", name: "一度", fields: [["m", "意味 once"]] },
      // Escaping fodder, all of it real shapes from his corpus.
      { id: "pct00001", name: "率", fields: [["m", "ratio, rate, proportion, %, factor"]] },
      { id: "under001", name: "対数", fields: [["m", `O($log${BS}_2n$)`]] },
      { id: "latex001", name: "変動費率", fields: [["m", "変動費率＝{{変動費}}$" + BS + "div$" + "{{売上}}"]] },
      { id: "tilde001", name: "以下", fields: [["m", `not more than${BS}~; ${BS}~and under`]] },
      // Tag-only and archived cards.
      { id: "tagged01", name: "大阪弁", tags: ["Dialect/Kansai"], fields: [["m", "Osaka speech"]] },
      { id: "archive1", name: "意味論", archived: true, fields: [["m", "semantics"]] },
      // English, for ASCII case folding.
      { id: "eng00001", name: "Kanji", fields: [["m", "Chinese characters"]] },
    ]);
  });

  afterAll(() => {
    db?.close();
  });

  it("indexes every card and reports the index as maintained", () => {
    const status = searchIndexStatus(db);
    expect(status.cards).toBe(13);
    expect(status.indexed).toBe(status.cards);
    expect(status.unrendered).toBe(0);
  });

  it("finds the split-link compound that the RAW text does not contain", () => {
    const raw = db
      .prepare("SELECT content, (SELECT group_concat(value) FROM card_field_values WHERE card_id = 'split001') AS v FROM cards WHERE id = 'split001'")
      .get() as { content: string; v: string };
    // The premise: nowhere in the stored text does the compound appear.
    expect(`${raw.content}${raw.v}`).toContain(`[[引き|10PQotxm]]${LRM}[[換え|C1p9g1mL]]`);
    expect(`${raw.content}${raw.v}`).not.toContain("引き換え");

    // Four characters, so this is the FTS path over the RENDERED body.
    const result = searchCards(db, "引き換え");
    expect(result.mode).toBe("fts");
    expect(result.total).toBe(1);
    expect(result.hits[0]?.cardId).toBe("split001");
    // And the rendered name is what a UI shows, marks gone.
    expect(result.hits[0]?.name).toBe("～に引き換え");
  });

  it("finds a TWO-character half of that compound through the scan", () => {
    const result = searchCards(db, "換え");
    expect(result.mode).toBe("like");
    expect(result.hits.map((hit) => hit.cardId)).toContain("split001");
  });

  it("ranks an exact title first, then a prefix, then a body mention", () => {
    const result = searchCards(db, "意味");
    expect(result.mode).toBe("like");
    const order = result.hits.map((hit) => hit.cardId);
    expect(order[0]).toBe("exact001");
    expect(order.indexOf("prefix01")).toBeLessThan(order.indexOf("bodyonly1"));
    // Scores strictly decrease, so the sort direction is pinned rather than
    // just "the order is not card_id".
    for (let i = 1; i < result.hits.length; i += 1) {
      expect(result.hits[i]!.score).toBeLessThanOrEqual(result.hits[i - 1]!.score);
    }
  });

  it("breaks ties inside a bucket by term frequency, capped", () => {
    const result = searchCards(db, "意味");
    const order = result.hits.map((hit) => hit.cardId);
    expect(order.indexOf("freq0001")).toBeLessThan(order.indexOf("freq0002"));
    const many = result.hits.find((hit) => hit.cardId === "freq0001")!;
    const once = result.hits.find((hit) => hit.cardId === "freq0002")!;
    // Nine occurrences, capped at eight, at 2 points each.
    expect(many.score - once.score).toBeCloseTo(
      SCAN_WEIGHTS.bodyOccurrence * (SCAN_WEIGHTS.bodyOccurrenceCap - 1),
      6,
    );
  });

  it("counts literal metacharacters, which is the assertion an escape bug fails", () => {
    // An unescaped % does not throw — it matches every card. So the test is a
    // count, not a try/catch.
    const percent = searchCards(db, "%");
    expect(percent.mode).toBe("like");
    expect(percent.total).toBe(1);
    expect(percent.hits[0]?.cardId).toBe("pct00001");

    const underscore = searchCards(db, "_");
    expect(underscore.total).toBe(1);
    expect(underscore.hits[0]?.cardId).toBe("under001");

    // A backslash, in both paths: \div is 4 characters (FTS), \~ is 2 (scan).
    expect(searchCards(db, `${BS}div`).hits.map((h) => h.cardId)).toEqual(["latex001"]);
    const tilde = searchCards(db, `${BS}~`);
    expect(tilde.mode).toBe("like");
    expect(tilde.hits.map((h) => h.cardId)).toEqual(["tilde001"]);
  });

  it("treats every FTS5 operator as literal text", () => {
    for (const probe of ["AND", "OR", "NOT", "NEAR", "col:", "-abc", "{a}", "abc*", "**", '"', "^x"]) {
      // The bar is "does not throw and does not answer a different question".
      expect(() => searchCards(db, probe)).not.toThrow();
      const result = searchCards(db, probe);
      expect(result.total).toBeLessThanOrEqual(13);
    }
    // Quoting is proved by what these queries DO, not by them not throwing.
    // `NOT` unquoted is `fts5: syntax error near "NOT"`; quoted it is the word
    // "not", and this corpus has exactly one card containing it.
    const not = searchCards(db, "NOT");
    expect(not.mode).toBe("fts");
    expect(not.total).toBe(1);
    expect(not.hits[0]?.cardId).toBe("tilde001");
    // Same for `AND`: a syntax error unquoted, the word "and" quoted, and the
    // same card carries both words.
    expect(searchCards(db, "AND").hits.map((hit) => hit.cardId)).toEqual(["tilde001"]);
    // `NEAR` is the control: also a syntax error unquoted, and no card has it.
    expect(searchCards(db, "NEAR").total).toBe(0);
  });

  it("ANDs multi-term queries on both paths", () => {
    expect(searchCards(db, "意味 解析").total).toBe(1);
    expect(searchCards(db, "意味 解析").hits[0]?.cardId).toBe("bodyonly1");
    // Both terms 3+ characters, so this one goes through FTS5.
    const fts = searchCards(db, "構文解析 最適化");
    expect(fts.mode).toBe("fts");
    expect(fts.total).toBe(1);
    expect(searchCards(db, "構文解析 存在しない").total).toBe(0);
  });

  it("matches tags as well as names and bodies", () => {
    const result = searchCards(db, "Kansai");
    expect(result.hits.map((hit) => hit.cardId)).toEqual(["tagged01"]);
    expect(result.hits[0]?.snippet?.field).toBe("tags");
  });

  it("folds ASCII case on both paths", () => {
    expect(searchCards(db, "kanji").hits[0]?.cardId).toBe("eng00001");
    expect(searchCards(db, "KANJI").hits[0]?.cardId).toBe("eng00001");
    // Two characters, so the scan; LIKE folds ASCII case by default.
    expect(searchCards(db, "ka").hits.map((h) => h.cardId)).toContain("eng00001");
  });

  it("includes archived cards by default and can exclude them", () => {
    const all = searchCards(db, "意味");
    expect(all.hits.map((hit) => hit.cardId)).toContain("archive1");
    expect(all.hits.find((hit) => hit.cardId === "archive1")?.archived).toBe(true);
    const live = searchCards(db, "意味", { includeArchived: false });
    expect(live.hits.map((hit) => hit.cardId)).not.toContain("archive1");
    expect(live.total).toBe(all.total - 1);
  });

  it("reports total and truncated separately from the page", () => {
    const page = searchCards(db, "意味", { limit: 2 });
    expect(page.hits).toHaveLength(2);
    expect(page.total).toBeGreaterThan(2);
    expect(page.truncated).toBe(true);
    const rest = searchCards(db, "意味", { limit: 2, offset: 2 });
    expect(rest.hits[0]?.rank).toBe(2);
    // Paging is stable: no card appears on both pages.
    const first = new Set(page.hits.map((hit) => hit.cardId));
    for (const hit of rest.hits) expect(first.has(hit.cardId)).toBe(false);
  });

  it("returns an empty result, and runs no query, for an empty box", () => {
    const empty = searchCards(db, "   ");
    expect(empty.mode).toBeNull();
    expect(empty.hits).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.truncated).toBe(false);
  });

  it("validates limit and offset loudly", () => {
    expect(() => searchCards(db, "意味", { limit: -1 })).toThrow(/non-negative/);
    expect(() => searchCards(db, "意味", { offset: 1.5 })).toThrow(/non-negative/);
    expect(searchCards(db, "意味", { limit: 10_000 }).limit).toBe(MAX_SEARCH_LIMIT);
    expect(searchCards(db, "意味").limit).toBe(DEFAULT_SEARCH_LIMIT);
  });

  it("hands back a snippet positioned on the match", () => {
    const hit = searchCards(db, "意味").hits.find((h) => h.cardId === "bodyonly1");
    const snippet = hit?.snippet;
    expect(snippet).not.toBeNull();
    expect(snippet?.text.slice(snippet.matchStart, snippet.matchStart + snippet.matchLength)).toBe(
      "意味",
    );
    expect(searchCards(db, "意味", { snippets: false }).hits[0]?.snippet).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. The real corpus. The pass condition, and the timings.
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_EXPORTS)("the real corpus", () => {
  let db: Db;

  beforeAll(() => {
    db = openDatabase(MEMORY);
    const sources: ImportSource[] = EXPORT_DIRS.map(readSource);
    // 657 MB of mp3 contributes nothing to a text index.
    importExports(db, sources, { blobs: false });
  }, 600_000);

  afterAll(() => {
    db?.close();
  });

  /** The oracle, computed here rather than quoted: LIKE over the same view. */
  function likeGroundTruth(term: string): number {
    const pattern = likeContains(term);
    const escape = `ESCAPE '${LIKE_ESCAPE}'`;
    const row = db
      .prepare(
        "SELECT count(*) AS n FROM card_search_index" +
          ` WHERE name LIKE ? ${escape} OR body LIKE ? ${escape} OR tags LIKE ? ${escape}`,
      )
      .get(pattern, pattern, pattern) as { n: number };
    return row.n;
  }

  it("has the corpus this stage was measured against", () => {
    const status = searchIndexStatus(db);
    expect(status.cards).toBe(7_716);
    expect(status.indexed).toBe(7_716);
    expect(status.unrendered).toBe(0);
  });

  it("THE PASS CONDITION: two-character queries return the LIKE counts", () => {
    const expected = { 意味: 3, する: 227, ない: 74, 勉強: 1 } as const;
    for (const [term, count] of Object.entries(expected)) {
      // The ground truth, from raw SQL over card_search_index.
      expect(likeGroundTruth(term)).toBe(count);
      // The same number, through the public API.
      const result = searchCards(db, term, { limit: 500 });
      expect(result.mode).toBe("like");
      expect(result.total).toBe(count);
      expect(result.hits).toHaveLength(Math.min(count, 500));
      // And the trigram index really does return nothing for it.
      const match = db
        .prepare("SELECT count(*) AS n FROM card_fts WHERE card_fts MATCH ?")
        .get(ftsPhrase(term)) as { n: number };
      expect(match.n).toBe(0);
    }
  });

  it("finds the split-link card 29thh3wW as 引き換え", () => {
    const result = searchCards(db, "引き換え");
    expect(result.mode).toBe("fts");
    expect(result.total).toBe(1);
    expect(result.hits[0]?.cardId).toBe("29thh3wW");
    // The stored value is untouched and still holds both links and the mark.
    const stored = db
      .prepare("SELECT value FROM card_field_values WHERE card_id = '29thh3wW' AND field_id = 'yPvQCIRC'")
      .get() as { value: string };
    expect(stored.value).toBe(`～に[[引き|10PQotxm]]${LRM}[[換え|C1p9g1mL]]`);
  });

  it("finds compounds whose plain form is nowhere in the card's raw text", () => {
    // These five cards write a compound as one linked card per character. The
    // raw text has only the links; the rendered index has the word.
    for (const [term, cardId] of [
      ["川越市", "85erJv5i"],
      ["小学校", "laZCBKEv"],
      ["警察官", "FaOBz9M8"],
      ["年賀状", "CSMIUBSQ"],
      ["宇宙飛行士", "kGIGxO8m"],
    ] as const) {
      const result = searchCards(db, term);
      expect(result.mode).toBe("fts");
      expect(result.hits.map((hit) => hit.cardId)).toContain(cardId);
      const raw = db
        .prepare(
          "SELECT content || COALESCE((SELECT group_concat(value) FROM card_field_values WHERE card_id = ?), '') AS t FROM cards WHERE id = ?",
        )
        .get(cardId, cardId) as { t: string };
      expect(raw.t).not.toContain(term);
    }
  });

  it("never matches an opaque link id, which the raw text is full of", () => {
    // 2,895 distinct targets; a trigram index over the raw concatenation matches
    // 2,870 of them across 7,801 card hits. This index matches none.
    const targets = db.prepare("SELECT DISTINCT to_card_id AS id FROM card_links").all() as {
      id: string;
    }[];
    expect(targets.length).toBe(2_893);
    let hits = 0;
    for (const { id } of targets) hits += searchCards(db, id, { limit: 1 }).total;
    expect(hits).toBe(0);
  });

  it("finds the invisible-marked names that only the stripped column can match", () => {
    // 48 card names hold an invisible mark. On 40 of them the mark is INTERIOR,
    // so the raw name no longer contains the word at all; for the three below the
    // body has no copy either, which leaves the stripped name column as the only
    // thing in the database that can match. THAT is the claim, so it is asserted
    // rather than asserted about: `3GPP` (sOUDQozS) used to be in this list and
    // proved nothing, because its mark is a LEADING U+200B and both the raw name
    // and the body still hold `3GPP` verbatim — the test passed without the
    // stripping doing any work.
    const BODY_SQL =
      "SELECT name, content || char(10) || COALESCE((SELECT group_concat(value, char(10))" +
      " FROM card_field_values WHERE card_id = c.id), '') AS body FROM cards c WHERE id = ?";
    for (const [term, cardId] of [
      ["素因数分解", "Dcws28og"],
      ["宇宙飛行士", "kGIGxO8m"],
      ["二日酔い", "dHmZ9Kk9"],
    ] as const) {
      const row = db.prepare(BODY_SQL).get(cardId) as { name: string; body: string };
      expect(row.name.includes(term), `${cardId}: raw name holds ${term}`).toBe(false);
      expect(row.body.includes(term), `${cardId}: body holds ${term}`).toBe(false);
      const result = searchCards(db, term, { limit: 5 });
      expect(result.mode).toBe("fts");
      expect(result.hits.map((hit) => hit.cardId)).toContain(cardId);
    }
  });

  it("RANKS `する`, and the ranking is not card_id order", () => {
    const ranked = searchCards(db, "する", { limit: 10 });
    expect(ranked.total).toBe(227);
    expect(ranked.truncated).toBe(true);

    // The cards actually titled する come first.
    expect(ranked.hits[0]?.name).toBe("する");
    expect(ranked.hits[1]?.name).toBe("する");

    // Scores decrease monotonically.
    for (let i = 1; i < ranked.hits.length; i += 1) {
      expect(ranked.hits[i]!.score).toBeLessThanOrEqual(ranked.hits[i - 1]!.score);
    }

    // And it differs from what the old scan returned: ORDER BY card_id.
    const pattern = likeContains("する");
    const escape = `ESCAPE '${LIKE_ESCAPE}'`;
    const byId = db
      .prepare(
        "SELECT card_id FROM card_search_index" +
          ` WHERE name LIKE ? ${escape} OR body LIKE ? ${escape} OR tags LIKE ? ${escape}` +
          " ORDER BY card_id LIMIT 10",
      )
      .all(pattern, pattern, pattern) as { card_id: string }[];
    expect(ranked.hits.map((hit) => hit.cardId)).not.toEqual(byId.map((row) => row.card_id));
    // Not merely a different order — a different SET of cards, which is the
    // whole complaint: 50 arbitrary cards out of 228.
    const rankedIds = new Set(ranked.hits.map((hit) => hit.cardId));
    expect(byId.some((row) => !rankedIds.has(row.card_id))).toBe(true);
  });

  it("ranks the FTS path by bm25, best first", () => {
    const result = searchCards(db, "ている", { limit: 10 });
    expect(result.mode).toBe("fts");
    expect(result.total).toBe(28);
    // Higher is better on both paths, so bm25's negative is flipped.
    for (const hit of result.hits) expect(hit.score).toBeGreaterThan(0);
    for (let i = 1; i < result.hits.length; i += 1) {
      expect(result.hits[i]!.score).toBeLessThanOrEqual(result.hits[i - 1]!.score);
    }
    // The shortest card containing it — bm25's length normalisation, working.
    expect(result.hits[0]?.name).toBe("知っている");
  });

  it("escapes against text that really is in his cards", () => {
    // % and _ appear in bodies; an unescaped pattern would return all 7,716.
    expect(searchCards(db, "%").total).toBe(2);
    expect(searchCards(db, "_").total).toBe(47);
    // LaTeX, which is where the corpus's backslashes actually live.
    expect(searchCards(db, `${BS}div`).total).toBe(11);
    expect(searchCards(db, `${BS}times`).total).toBe(6);
    expect(searchCards(db, `${BS}frac`).total).toBe(1);
    const tilde = searchCards(db, `${BS}~`);
    expect(tilde.mode).toBe("like");
    expect(tilde.total).toBe(1);
    expect(tilde.hits[0]?.cardId).toBe("9Bd9mlMU");
  });

  it("answers every query without throwing, over a hostile probe set", () => {
    const probes = [
      "%",
      "_",
      "%_",
      '"',
      '""',
      "*",
      "**",
      "AND",
      "OR",
      "NOT",
      "NEAR",
      "col:",
      "-abc",
      "{a}",
      "(a b)",
      "^abc",
      `${BS}`,
      `${BS}*`,
      `${BS}${BS}`,
      "'; DROP TABLE cards; --",
      "0x00",
      "意味%",
      "%意味%",
      "🍣",
      "🍣🍜🍙",
      LRM,
    ];
    for (const probe of probes) {
      expect(() => searchCards(db, probe, { limit: 3 })).not.toThrow();
    }
    // The table is still there, which is the point of the injection probe.
    expect(searchIndexStatus(db).cards).toBe(7_716);
  });

  it("is fast enough for a search box, and the numbers are ranges", () => {
    const cases = ["意味", "する", "ない", "勉強", "の", "気持ち", "引き換え", "ている", "a"];
    const lines: string[] = [];
    const medians = new Map<string, number>();
    for (const term of cases) {
      const samples: number[] = [];
      let result = searchCards(db, term, { limit: 50 });
      for (let i = 0; i < 15; i += 1) {
        result = searchCards(db, term, { limit: 50 });
        samples.push(result.elapsedMs);
      }
      samples.sort((a, b) => a - b);
      const min = samples[0]!;
      const max = samples[samples.length - 1]!;
      const median = samples[Math.floor(samples.length / 2)]!;
      lines.push(
        `  ${term.padEnd(6)} mode=${String(result.mode).padEnd(4)} total=${String(result.total).padStart(5)}` +
          ` ${min.toFixed(2)}-${max.toFixed(2)} ms (median ${median.toFixed(2)})`,
      );
      medians.set(term, median);
      // A LOOSE absolute bar, on purpose. This assertion runs inside a suite of
      // 14 files in parallel, so a tight wall-clock bound here is a flaky test
      // rather than a performance gate; what it still catches is the scan going
      // superlinear. The real numbers are the logged ranges, measured five
      // separate times against build/hashigo.db and reported as a union.
      expect(median).toBeLessThan(1_000);
    }
    // The routing claim, as a RATIO, which survives machine load: the trigram
    // index answers a 3+ character query in well under a millisecond, and the
    // scan takes tens. Measured gap is 40-100x; ten is the floor asserted.
    expect(medians.get("勉強")! / medians.get("気持ち")!).toBeGreaterThan(10);
    console.log("search timings, 15 runs each, in-memory import:");
    for (const line of lines) console.log(line);
    // 135 searches, nine of them over 6,359 matching cards. The generous
    // timeout is about the measurement loop, not about one query.
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 8. Deck scoping. The limit is why this has to happen in the query.
// ---------------------------------------------------------------------------

/**
 * SCOPING A SEARCH TO A DECK, AND WHY FILTERING THE PAGE IS NOT THE SAME THING.
 *
 * The app used to ask `src/search` for the top `limit` matches across the whole
 * collection and then drop the ones outside the deck being browsed. With `limit: 300`
 * over 7,716 cards that silently under-reports: a term matching widely elsewhere fills
 * the page before a single in-deck card is reached, so the gallery shows nothing and
 * says "0" — and `total` was the unfiltered count, so the two numbers disagreed as well.
 *
 * These use a deliberately hostile fixture rather than the corpus: many matches in one
 * deck, few in another, and a limit small enough that the page cannot hold both. That
 * is the exact shape the bug needed, and it runs in a millisecond.
 */
describe("deck-scoped search", () => {
  let db: Db;

  beforeAll(() => {
    db = openDatabase(MEMORY);
    db.prepare("INSERT INTO decks (id, name) VALUES ('big', '単語')").run();
    db.prepare("INSERT INTO decks (id, name) VALUES ('small', '数字')").run();
    const insert = db.prepare(
      "INSERT INTO cards (id, deck_id, name, content, search_text, archived)" +
        " VALUES (?, ?, ?, '', ?, 0)",
    );
    db.transaction(() => {
      // 50 matches in the big deck...
      for (let i = 0; i < 50; i += 1) insert.run(`big${i}`, "big", `word ${i}`, "しるし body");
      // ...and 3 in the small one, which a page of 5 could never reach.
      for (let i = 0; i < 3; i += 1) insert.run(`small${i}`, "small", `number ${i}`, "しるし body");
    })();
  });

  afterAll(() => {
    db?.close();
  });

  it("returns only cards inside the scope", () => {
    const scoped = searchCards(db, "しるし", { deckIds: ["small"] });
    expect(scoped.hits.length).toBe(3);
    expect(scoped.hits.every((hit) => hit.deckId === "small")).toBe(true);
  });

  it("FINDS the in-deck matches even when the page could not reach them", () => {
    // The bug, stated exactly. Unscoped, a page of 5 is all `big` cards, so filtering
    // afterwards yields zero — and the deck really does hold three.
    const unscoped = searchCards(db, "しるし", { limit: 5 });
    expect(unscoped.hits.filter((hit) => hit.deckId === "small")).toHaveLength(0);

    const scoped = searchCards(db, "しるし", { limit: 5, deckIds: ["small"] });
    expect(scoped.hits).toHaveLength(3);
  });

  it("counts only what is in scope, so `total` matches what is shown", () => {
    expect(searchCards(db, "しるし", { limit: 5 }).total).toBe(53);
    expect(searchCards(db, "しるし", { limit: 5, deckIds: ["small"] }).total).toBe(3);
    expect(searchCards(db, "しるし", { limit: 5, deckIds: ["big"] }).total).toBe(50);
  });

  it("accepts a multi-deck scope, which is what a subtree resolves to", () => {
    const both = searchCards(db, "しるし", { deckIds: ["big", "small"] });
    expect(both.total).toBe(53);
  });

  it("matches nothing for an EMPTY scope, which is different from omitting it", () => {
    // `IN ()` is a syntax error in SQLite, so this is an explicit `0 = 1`.
    expect(searchCards(db, "しるし", { deckIds: [] }).total).toBe(0);
    expect(searchCards(db, "しるし", { deckIds: [] }).hits).toHaveLength(0);
    expect(searchCards(db, "しるし").total).toBe(53);
  });

  it("scopes the same way on both query paths", () => {
    // Two characters routes to the ranked scan, longer routes to FTS — the split that
    // `src/search` exists to handle. Both must scope, and only one was ever exercised
    // by hand.
    for (const query of ["しる", "しるし body"]) {
      const scoped = searchCards(db, query, { deckIds: ["small"] });
      expect(scoped.hits.every((hit) => hit.deckId === "small"), `${query} leaked`).toBe(true);
    }
  });
});
