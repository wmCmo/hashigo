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
import { okuriganaStem } from "../src/search/query.js";
import { refreshSearchText } from "../src/generate/index.js";
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

const BS = String.fromCharCode(92);
const LRM = "‎";

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
    expect(charCount("🍣🍜🍙")).toBe(3);
    expect("🍣🍜🍙".length).toBe(6);
    expect(parseSearchQuery("🍣🍜🍙")?.mode).toBe("fts");
    expect(parseSearchQuery("🍣🍜")?.mode).toBe("like");
  });

  it("returns null for an empty or whitespace-only query, not 'everything'", () => {
    expect(parseSearchQuery("")).toBeNull();
    expect(parseSearchQuery("   ")).toBeNull();
    expect(parseSearchQuery("\t\n")).toBeNull();
    expect(parseSearchQuery(LRM + "​")).toBeNull();
  });

  it("normalises the query exactly as the index was normalised, and no further", () => {
    expect(normaliseQuery(`引き${LRM}換え`)).toBe("引き換え");
    expect(normaliseQuery("  勉強   する  ")).toBe("勉強 する");
    expect(normaliseQuery("羽")).toBe("羽");
    expect(normaliseQuery("～に")).toBe("～に");
    expect(normaliseQuery("～に")).not.toBe("~に");
  });

  it("splits on whitespace and routes on the SHORTEST term", () => {
    const mixed = parseSearchQuery("気持ち 意味");
    expect(mixed?.terms).toEqual(["気持ち", "意味"]);
    expect(mixed?.shortestTermChars).toBe(2);
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
    expect(() => ftsMatchExpression(["意味"])).toThrow(/cannot serve fewer than 3/);
    expect(() => ftsMatchExpression(["気持ち", "意味"])).toThrow(/意味/);
    expect(() => ftsMatchExpression([])).toThrow(/no terms/);
    expect(ftsMatchExpression(["気持ち", "言えない"])).toBe('"気持ち" AND "言えない"');
  });

  it("writes AND out, because FTS5 juxtaposition is phrase concatenation", () => {
    expect(ftsMatchExpression(["abc", "def"])).toContain(" AND ");
  });
});

describe("escaping", () => {
  it("escapes the three LIKE metacharacters and nothing else", () => {
    expect(escapeLike("100%")).toBe(`100${BS}%`);
    expect(escapeLike("a_b")).toBe(`a${BS}_b`);
    expect(escapeLike(BS)).toBe(BS + BS);
    expect(escapeLike(`${BS}*`)).toBe(`${BS}${BS}*`);
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
    expect(asciiLower("ÄÖÜ")).toBe("ÄÖÜ");
    expect(asciiLower("ＫＡＮＪＩ")).toBe("ＫＡＮＪＩ");
    expect(asciiLower("AÄ🍣").length).toBe("AÄ🍣".length);
  });
});

describe("agreement with the modules src/search cannot import", () => {
  it("uses the same trigram floor as src/schema/index.ts", () => {
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
    expect(fromSearch.replace(new RegExp(INVISIBLE_MARKS.source, "g"), "")).toBe("");
    for (let code = 0x200a; code <= 0x2010; code += 1) {
      const character = String.fromCodePoint(code);
      const strippedByText = character.replace(new RegExp(INVISIBLE_MARKS.source, "g"), "") === "";
      const inSqlList = (INVISIBLE_CODE_POINTS as readonly number[]).includes(code);
      expect(inSqlList).toBe(strippedByText);
    }
    expect((INVISIBLE_CODE_POINTS as readonly number[]).includes(0xfeff)).toBe(true);
  });
});

describe("the generated SQL", () => {
  const query = parseSearchQuery("気持ち");
  if (query === null) throw new Error("unreachable");

  it("gives bm25 exactly one weight per column, INCLUDING the UNINDEXED one", () => {
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
    const maxFrequency = SCAN_WEIGHTS.bodyOccurrence * SCAN_WEIGHTS.bodyOccurrenceCap;
    expect(maxFrequency).toBeLessThan(SCAN_WEIGHTS.tags - SCAN_WEIGHTS.body);
  });
});

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
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(snippet?.text ?? "")).toBe(false);
    expect(body.indexOf("match")).toBe(46);
    expect(loneSurrogate.test(body.slice(21))).toBe(true);
    expect(snippet?.text.startsWith("…🍣")).toBe(true);
  });

  it("rejects a negative radius rather than producing a strange window", () => {
    expect(() => makeSnippet(source, ["false"], -1)).toThrow(/non-negative/);
  });
});

interface Seed {
  readonly id: string;
  readonly name: string;
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
      {
        id: "split001",
        name: `～に引き${LRM}換え`,
        fields: [["ref", `～に[[引き|10PQotxm]]${LRM}[[換え|C1p9g1mL]]`]],
      },
      { id: "exact001", name: "意味", fields: [["m", "meaning; significance"]] },
      { id: "prefix01", name: "意味合い", fields: [["m", "implication; nuance"]] },
      {
        id: "bodyonly1",
        name: "コンパイラの処理手順",
        fields: [["m", "字句解析 → 構文解析 → 意味解析 → 最適化 → コード生成"]],
      },
      { id: "freq0001", name: "反復", fields: [["m", "意味 ".repeat(9)]] },
      { id: "freq0002", name: "一度", fields: [["m", "意味 once"]] },
      { id: "pct00001", name: "率", fields: [["m", "ratio, rate, proportion, %, factor"]] },
      { id: "under001", name: "対数", fields: [["m", `O($log${BS}_2n$)`]] },
      { id: "latex001", name: "変動費率", fields: [["m", "変動費率＝{{変動費}}$" + BS + "div$" + "{{売上}}"]] },
      { id: "tilde001", name: "以下", fields: [["m", `not more than${BS}~; ${BS}~and under`]] },
      { id: "tagged01", name: "大阪弁", tags: ["Dialect/Kansai"], fields: [["m", "Osaka speech"]] },
      { id: "archive1", name: "意味論", archived: true, fields: [["m", "semantics"]] },
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
    expect(`${raw.content}${raw.v}`).toContain(`[[引き|10PQotxm]]${LRM}[[換え|C1p9g1mL]]`);
    expect(`${raw.content}${raw.v}`).not.toContain("引き換え");

    const result = searchCards(db, "引き換え");
    expect(result.mode).toBe("fts");
    expect(result.total).toBe(1);
    expect(result.hits[0]?.cardId).toBe("split001");
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
    expect(many.score - once.score).toBeCloseTo(
      SCAN_WEIGHTS.bodyOccurrence * (SCAN_WEIGHTS.bodyOccurrenceCap - 1),
      6,
    );
  });

  it("counts literal metacharacters, which is the assertion an escape bug fails", () => {
    const percent = searchCards(db, "%");
    expect(percent.mode).toBe("like");
    expect(percent.total).toBe(1);
    expect(percent.hits[0]?.cardId).toBe("pct00001");

    const underscore = searchCards(db, "_");
    expect(underscore.total).toBe(1);
    expect(underscore.hits[0]?.cardId).toBe("under001");

    expect(searchCards(db, `${BS}div`).hits.map((h) => h.cardId)).toEqual(["latex001"]);
    const tilde = searchCards(db, `${BS}~`);
    expect(tilde.mode).toBe("like");
    expect(tilde.hits.map((h) => h.cardId)).toEqual(["tilde001"]);
  });

  it("treats every FTS5 operator as literal text", () => {
    for (const probe of ["AND", "OR", "NOT", "NEAR", "col:", "-abc", "{a}", "abc*", "**", '"', "^x"]) {
      expect(() => searchCards(db, probe)).not.toThrow();
      const result = searchCards(db, probe);
      expect(result.total).toBeLessThanOrEqual(13);
    }
    const not = searchCards(db, "NOT");
    expect(not.mode).toBe("fts");
    expect(not.total).toBe(1);
    expect(not.hits[0]?.cardId).toBe("tilde001");
    expect(searchCards(db, "AND").hits.map((hit) => hit.cardId)).toEqual(["tilde001"]);
    expect(searchCards(db, "NEAR").total).toBe(0);
  });

  it("ANDs multi-term queries on both paths", () => {
    expect(searchCards(db, "意味 解析").total).toBe(1);
    expect(searchCards(db, "意味 解析").hits[0]?.cardId).toBe("bodyonly1");
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

describe.skipIf(!HAVE_EXPORTS)("the real corpus", () => {
  let db: Db;

  beforeAll(() => {
    db = openDatabase(MEMORY);
    const sources: ImportSource[] = EXPORT_DIRS.map(readSource);
    importExports(db, sources, { blobs: false });
  }, 600_000);

  afterAll(() => {
    db?.close();
  });

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
      expect(likeGroundTruth(term)).toBe(count);
      const result = searchCards(db, term, { limit: 500 });
      expect(result.mode).toBe("like");
      expect(result.total).toBe(count);
      expect(result.hits).toHaveLength(Math.min(count, 500));
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
    const stored = db
      .prepare("SELECT value FROM card_field_values WHERE card_id = '29thh3wW' AND field_id = 'yPvQCIRC'")
      .get() as { value: string };
    expect(stored.value).toBe(`～に[[引き|10PQotxm]]${LRM}[[換え|C1p9g1mL]]`);
  });

  it("finds compounds whose plain form is nowhere in the card's raw text", () => {
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
    const targets = db.prepare("SELECT DISTINCT to_card_id AS id FROM card_links").all() as {
      id: string;
    }[];
    expect(targets.length).toBe(2_893);
    let hits = 0;
    for (const { id } of targets) hits += searchCards(db, id, { limit: 1 }).total;
    expect(hits).toBe(0);
  });

  it("finds the invisible-marked names that only the stripped column can match", () => {
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

    expect(ranked.hits[0]?.name).toBe("する");
    expect(ranked.hits[1]?.name).toBe("する");

    for (let i = 1; i < ranked.hits.length; i += 1) {
      expect(ranked.hits[i]!.score).toBeLessThanOrEqual(ranked.hits[i - 1]!.score);
    }

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
    const rankedIds = new Set(ranked.hits.map((hit) => hit.cardId));
    expect(byId.some((row) => !rankedIds.has(row.card_id))).toBe(true);
  });

  it("ranks the FTS path by bm25, best first", () => {
    const result = searchCards(db, "ている", { limit: 10 });
    expect(result.mode).toBe("fts");
    expect(result.total).toBe(28);
    for (const hit of result.hits) expect(hit.score).toBeGreaterThan(0);
    for (let i = 1; i < result.hits.length; i += 1) {
      expect(result.hits[i]!.score).toBeLessThanOrEqual(result.hits[i - 1]!.score);
    }
    expect(result.hits[0]?.name).toBe("知っている");
  });

  it("escapes against text that really is in his cards", () => {
    expect(searchCards(db, "%").total).toBe(2);
    expect(searchCards(db, "_").total).toBe(47);
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
      expect(median).toBeLessThan(1_000);
    }
    expect(medians.get("勉強")! / medians.get("気持ち")!).toBeGreaterThan(10);
    console.log("search timings, 15 runs each, in-memory import:");
    for (const line of lines) console.log(line);
  }, 120_000);
});

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
      for (let i = 0; i < 50; i += 1) insert.run(`big${i}`, "big", `word ${i}`, "しるし body");
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
    expect(searchCards(db, "しるし", { deckIds: [] }).total).toBe(0);
    expect(searchCards(db, "しるし", { deckIds: [] }).hits).toHaveLength(0);
    expect(searchCards(db, "しるし").total).toBe(53);
  });

  it("scopes the same way on both query paths", () => {
    for (const query of ["しる", "しるし body"]) {
      const scoped = searchCards(db, query, { deckIds: ["small"] });
      expect(scoped.hits.every((hit) => hit.deckId === "small"), `${query} leaked`).toBe(true);
    }
  });
});

describe("the okurigana stem", () => {
  it("strips a short kana tail after a kanji, and nothing else", () => {
    expect(okuriganaStem("貫く")).toBe("貫");
    expect(okuriganaStem("食べる")).toBe("食");
    expect(okuriganaStem("考える")).toBe("考");
    expect(okuriganaStem("書く")).toBe("書");
  });

  it("leaves PHRASES alone, which is what the two-kana bound is for", () => {
    expect(okuriganaStem("口にする")).toBeNull();
    expect(okuriganaStem("身につける")).toBeNull();
    expect(okuriganaStem("極まりない")).toBeNull();
  });

  it("leaves a word with no okurigana alone", () => {
    expect(okuriganaStem("厳格")).toBeNull();
    expect(okuriganaStem("意味")).toBeNull();
    expect(okuriganaStem("つらぬく")).toBeNull();
    expect(okuriganaStem("")).toBeNull();
  });

  it("refuses a multi-term query", () => {
    expect(okuriganaStem("貫く 厳格")).toBeNull();
  });
});

describe("searching falls back to the stem, but only on zero hits", () => {
  let db: Db;

  beforeAll(() => {
    db = openDatabase(MEMORY);
    seed(db, [
      { id: "genkaku1", name: "厳格", fields: [["m", "彼は仕事において非常に厳格な態度を貫いている。"]] },
      { id: "ikkan001", name: "一貫性", fields: [["m", "データの一貫性を保つ"]] },
      { id: "taberu01", name: "食べる", fields: [["m", "to eat"]] },
    ]);
  });

  afterAll(() => db.close());

  it("finds 厳格 from 貫く, which is the report", () => {
    const result = searchCards(db, "貫く");
    expect(result.hits.map((h) => h.name)).toContain("厳格");
    expect(result.stemmedFrom).toBe("貫く");
    expect(result.normalised).toBe("貫");
  });

  it("does NOT broaden a query that already found something", () => {
    const result = searchCards(db, "食べる");
    expect(result.hits.map((h) => h.name)).toEqual(["食べる"]);
    expect(result.stemmedFrom).toBeNull();
  });

  it("reports the ORIGINAL query when even the stem finds nothing", () => {
    const result = searchCards(db, "猫かる");
    expect(result.hits).toEqual([]);
    expect(result.stemmedFrom).toBeNull();
    expect(result.query).toBe("猫かる");
  });
});

describe("the index follows an edit", () => {
  let db: Db;

  function card(id: string, meaning: string): void {
    db.prepare(`INSERT INTO cards (id, deck_id, template_id, name, content) VALUES (?, 'd', 't', ?, '')`).run(id, id);
    db.prepare(`INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, 'm', ?)`).run(id, meaning);
    refreshSearchText(db, [id]);
  }

  beforeAll(() => {
    db = openDatabase(MEMORY);
    db.prepare(`INSERT INTO decks (id, name) VALUES ('d', 'D')`).run();
    db.prepare(`INSERT INTO templates (id, name, content) VALUES ('t', 'T', '<< 意味 >>')`).run();
    db.prepare(
      `INSERT INTO template_fields (template_id, id, name, type, local) VALUES ('t', 'm', '意味', 'plain', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO template_fields (template_id, id, name, type, local) VALUES ('t', 'k', '型', 'plain', 1)`,
    ).run();
    card("genkaku", "strict; rigorous");
  });

  afterAll(() => db.close());

  const names = (q: string) => searchCards(db, q).hits.map((h) => h.cardId);

  it("reproduces the defect when the refresh is skipped", () => {
    db.prepare(`UPDATE card_field_values SET value = 'edited qqplmk' WHERE card_id = 'genkaku'`).run();
    expect(names("qqplmk")).toEqual([]);
    expect(names("rigorous")).toEqual(["genkaku"]);
  });

  it("finds the new text and forgets the old one once refreshed", () => {
    refreshSearchText(db, ["genkaku"]);
    expect(names("qqplmk")).toEqual(["genkaku"]);
    expect(names("rigorous")).toEqual([]);
  });

  it("keeps a LOCAL field out of the index", () => {
    db.prepare(`INSERT INTO card_field_values (card_id, field_id, value) VALUES ('genkaku', 'k', '平板')`).run();
    refreshSearchText(db, ["genkaku"]);
    expect(names("平板")).toEqual([]);
  });

  it("writes nothing when nothing changed", () => {
    expect(refreshSearchText(db, ["genkaku"])).toBe(0);
  });

  it("indexes a brand-new card", () => {
    card("newcard", "a freshly typed meaning zxqv");
    expect(names("zxqv")).toEqual(["newcard"]);
  });
});
