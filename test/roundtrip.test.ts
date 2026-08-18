import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MEMORY, checkIntegrity, openDatabase, type Db } from "../src/db/index.js";
import {
  importExports,
  readSource,
  type ImportReport,
  type ImportSource,
} from "../src/import/index.js";
import { asRecord, asRecords, asText, isRecord, type MochiRecord } from "../src/import/transit.js";
import { walkCards, walkDecks } from "../src/import/transit.js";

/**
 * Stage 1 acceptance. Two jobs, and the second is the one that matters.
 *
 * 1. THE ORACLE. Import all three real exports through the real orchestrator and
 *    assert every known-correct figure: 7,716 cards, 102,020 reviews split
 *    58,937 / 43,083 at 96.24% retention, 11 template rows, 19 tags carrying
 *    cards, 8,690 wiki-links, 10,887 live attachments and 8,958 tombstones that
 *    must NOT be in the database. Then import again and assert nothing changed.
 *
 * 2. THE DIFF. Counting rows proves nothing about whether the right bytes landed
 *    in the right row — a mapper that swapped two fields would pass every total
 *    above. So a deterministic sample of cards spanning all three exports, all
 *    eleven template rows and every awkward case the corpus has (booleans, nulls
 *    Transit-escaped text, forced reverse, archived, unresolved links) is
 *    compared field value by field value, review record by review record and
 *    link by link against the decoded source, re-derived here rather than read
 *    back from the mapper that wrote it.
 *
 * THREE PLACES THE TASK'S ORACLE AND THE DATABASE LEGITIMATELY DIFFER, all
 * asserted in both spellings rather than papered over:
 *
 *   * 11 templates, 10 rows. `oiaISYb2` (単語) is defined in BOTH 日本語 and
 *     基本情報, byte-identically. Eleven template rows across the three files,
 *     ten distinct templates in one database.
 *   * 19 tags, 20 rows. `Dialect` carries no cards of its own; it exists so
 *     `Dialect/Kansai` satisfies `tags.parent_path`. 19 paths carry cards.
 *   * 10,887 blobs, 10,816 addresses. 10,887 live attachment records is the
 *     oracle and is exactly the number of `blob_refs`; 71 of those files are
 *     byte-identical to another, and content-addressing collapses them.
 */

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const EXPORT_DIRS = EXPORT_NAMES.map((name) =>
  resolve(import.meta.dirname, "..", "exports", name),
);
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

/** JST. Every review in the corpus is date-only and lands at this offset. */
const OFFSET_MINUTES = 540;

// ─── the source of truth, read independently of the importer ─────────────────

interface SourceCard {
  readonly exportName: string;
  readonly templateId: string;
  readonly card: MochiRecord;
}

/**
 * Mochi's three review arrays. An EMPTY array is encoded as the empty map, not
 * `[]`, so `asRecords` (which returns [] for a non-array) is the only safe read.
 */
const ARRAYS = [
  { key: "reviews", kind: "forward" },
  { key: "reverse-reviews", kind: "reverse" },
  { key: "cloze/reviews", kind: "cloze:0" },
] as const;

/** The documented coercion: TEXT NOT NULL, so booleans keep their spelling. */
function expectedFieldValue(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "boolean") return raw ? "true" : "false";
  if (typeof raw === "number") return String(raw);
  return "";
}

/** RFC 3339 at a fixed offset, written out here rather than imported. */
function atOffset(millis: number, offsetMinutes: number): string {
  const shifted = new Date(millis + offsetMinutes * 60_000);
  const two = (n: number): string => String(n).padStart(2, "0");
  const date = `${shifted.getUTCFullYear()}-${two(shifted.getUTCMonth() + 1)}-${two(
    shifted.getUTCDate(),
  )}`;
  const clock = `${two(shifted.getUTCHours())}:${two(shifted.getUTCMinutes())}:${two(
    shifted.getUTCSeconds(),
  )}`;
  const millisPart =
    shifted.getUTCMilliseconds() === 0
      ? ""
      : `.${String(shifted.getUTCMilliseconds()).padStart(3, "0")}`;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${date}T${clock}${millisPart}${sign}${two(Math.trunc(abs / 60))}:${two(abs % 60)}`;
}

function instantMillis(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Field values in the export's own order: `content` is a separate scope. */
function fieldTexts(card: MochiRecord): (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  for (const [fieldId, field] of Object.entries(asRecord(card["fields"]))) {
    const raw = isRecord(field) ? field["value"] : field;
    if (typeof raw === "string") out.push([fieldId, raw]);
  }
  return out;
}

const WIKI = /\[\[([^\]|]+)\|([^\]]+)\]\]/g;

interface ExpectedLink {
  readonly to_card_id: string;
  readonly display_text: string;
  readonly field_id: string | null;
  readonly ordinal: number;
}

/** Re-derive a card's links: content first, then each field, ordinal per scope. */
function expectedLinks(card: MochiRecord): ExpectedLink[] {
  const out: ExpectedLink[] = [];
  const scopes: (readonly [string | null, string])[] = [
    [null, asText(card["content"])],
    ...fieldTexts(card),
  ];
  for (const [fieldId, text] of scopes) {
    let ordinal = 0;
    for (const match of text.matchAll(WIKI)) {
      out.push({
        to_card_id: match[2] as string,
        display_text: match[1] as string,
        field_id: fieldId,
        ordinal: ordinal++,
      });
    }
  }
  return out;
}

interface ExpectedReview {
  readonly import_key: string;
  readonly kind: string;
  readonly reviewed_at: string;
  readonly tz_offset_minutes: number;
  readonly time_unknown: number;
  readonly remembered: number;
  readonly grade: null;
  readonly interval_days: number | null;
  readonly next_interval_days: number | null;
  readonly due_at: string | null;
  readonly duration_ms: number | null;
  readonly rereview: number;
  readonly source: string;
}

/**
 * Re-derive every review row for one card.
 *
 * `interval_days` is the interval that PRECEDED the review, which Mochi does not
 * store: it is the previous record's `interval`, NULL on a track's first review
 * and on any review whose predecessor carried none. Computed here in source
 * order, which the caller separately asserts is chronological.
 */
function expectedReviews(card: MochiRecord): ExpectedReview[] {
  const cardId = asText(card["id"]);
  const out: ExpectedReview[] = [];
  for (const array of ARRAYS) {
    const records = asRecords(card[array.key]);
    let previousInterval: number | null = null;
    records.forEach((record, index) => {
      const date = instantMillis(record["date"]);
      const due = instantMillis(record["due"]);
      const nextInterval = numberOrNull(record["interval"]);
      const durationSeconds = numberOrNull(record["duration"]);
      out.push({
        import_key: `mochi:${cardId}:${array.kind}:${index}`,
        kind: array.kind,
        reviewed_at: atOffset(date as number, OFFSET_MINUTES),
        tz_offset_minutes: OFFSET_MINUTES,
        time_unknown: 1,
        remembered: record["remembered?"] === true ? 1 : 0,
        grade: null,
        interval_days: previousInterval,
        next_interval_days: nextInterval,
        due_at: due === null ? null : atOffset(due, OFFSET_MINUTES),
        duration_ms: durationSeconds === null ? null : Math.round(durationSeconds * 1000),
        rereview: record["rereview?"] === true ? 1 : 0,
        source: "mochi",
      });
      previousInterval = nextInterval;
    });
  }
  return out;
}

// ─── the run ─────────────────────────────────────────────────────────────────

let db: Db;
let sources: ImportSource[];
let report: ImportReport;
/** Every card in the corpus, by id, straight off the decoded export. */
const byId = new Map<string, SourceCard>();

function count(sql: string, ...params: readonly unknown[]): number {
  return db.prepare(sql).pluck().get(...params) as number;
}

describe.skipIf(!HAVE_EXPORTS)("stage 1 round-trip over the real corpus", () => {
  beforeAll(() => {
    db = openDatabase(MEMORY);
    sources = EXPORT_DIRS.map(readSource);
    for (let i = 0; i < sources.length; i += 1) {
      for (const { card } of walkCards((sources[i] as ImportSource).root)) {
        byId.set(asText(card["id"]), {
          exportName: EXPORT_NAMES[i] as string,
          templateId: asText(card["template-id"]) || "(none)",
          card,
        });
      }
    }
    // Media stays on disk (657 MB); only its address and size are recorded.
    report = importExports(db, sources, {});
  }, 600_000);

  afterAll(() => {
    db?.close();
  });

  // ── 1. the oracle ──────────────────────────────────────────────────────────

  it("lands every oracle number", () => {
    // ── cards, decks, templates, fields
    expect(count("SELECT count(*) FROM cards")).toBe(7_716);
    expect(count("SELECT count(*) FROM decks")).toBe(45);
    expect(count("SELECT count(*) FROM card_field_values")).toBe(22_319);
    expect(count("SELECT count(*) FROM template_fields")).toBe(41);

    // 11 template ROWS across the three exports; oiaISYb2 is in two of them, so
    // 10 rows in one database. Both halves asserted from the source, not assumed.
    const templateRows = sources.flatMap((source) => asRecords(source.root["templates"]));
    expect(templateRows).toHaveLength(11);
    const templateIds = templateRows.map((template) => asText(template["id"]));
    expect(new Set(templateIds).size).toBe(10);
    expect(templateIds.filter((id) => id === "oiaISYb2")).toHaveLength(2);
    expect(count("SELECT count(*) FROM templates")).toBe(10);
    expect(report.notes.templateIdCollisions).toEqual(["oiaISYb2"]);
    expect(report.notes.templateIdConflicts).toEqual([]);
    // Every template row's id resolved to a row, so no definition was lost.
    for (const id of new Set(templateIds)) {
      expect(count("SELECT count(*) FROM templates WHERE id = ?", id)).toBe(1);
    }

    // ── reviews
    expect(count("SELECT count(*) FROM reviews")).toBe(102_020);
    expect(count("SELECT count(*) FROM review_log WHERE track_kind = 'forward'")).toBe(58_937);
    expect(count("SELECT count(*) FROM review_log WHERE track_kind = 'reverse'")).toBe(43_083);
    expect(count("SELECT count(*) FROM card_tracks")).toBe(13_392);
    const totals = db
      .prepare(
        `SELECT reviews, passed, lapses, round(retention * 100, 2) AS retention_pct,
                round(hours, 1) AS hours, study_days, first_review_date, last_review_date,
                reviews_time_unknown
           FROM study_totals`,
      )
      .get() as Record<string, unknown>;
    expect(totals).toEqual({
      reviews: 102_020,
      passed: 98_188,
      lapses: 3_832,
      retention_pct: 96.24,
      hours: 636.1,
      study_days: 1_317,
      first_review_date: "2022-06-28",
      last_review_date: "2026-08-18",
      // SPEC: imported history is flagged time-unknown, never assigned midnight.
      reviews_time_unknown: 102_020,
    });
    expect(count("SELECT count(*) FROM retention_by_hour")).toBe(0);

    // ── tags: 23 raw -> 19 carrying cards, 20 rows (Dialect is a parent only)
    const rawTags = new Set<string>();
    for (const { card } of byId.values()) {
      for (const key of ["tags", "manual-tags"] as const) {
        const list = card[key];
        if (Array.isArray(list)) for (const tag of list) if (typeof tag === "string") rawTags.add(tag);
      }
    }
    expect(rawTags.size).toBe(23);
    expect(count("SELECT count(*) FROM tag_usage WHERE cards_direct > 0")).toBe(19);
    expect(count("SELECT count(*) FROM tags")).toBe(20);
    expect(
      db.prepare("SELECT path FROM tag_usage WHERE cards_direct = 0").pluck().all(),
    ).toEqual(["Dialect"]);
    expect(count("SELECT count(*) FROM card_tags")).toBe(66);
    // The zero-width-space duplicates are gone: no tag path carries a format char.
    expect(
      (db.prepare("SELECT path FROM tags").pluck().all() as string[]).filter((path) =>
        /\p{Cf}/u.test(path),
      ),
    ).toEqual([]);

    // ── wiki-links
    expect(count("SELECT count(*) FROM card_links")).toBe(8_690);
    expect(count("SELECT count(*) FROM card_links_resolved WHERE resolved = 0")).toBe(18);
    expect(count("SELECT count(DISTINCT from_card_id) FROM card_links")).toBe(4_323);

    // ── blobs: 10,887 live attachments, 8,958 tombstones, and the tombstones
    //    are provably absent rather than merely uncounted.
    expect(report.blobs?.liveAttachments).toBe(10_887);
    expect(report.blobs?.mediaRefs).toBe(10_887);
    expect(report.blobs?.tombstonesSkipped).toBe(8_958);
    expect(report.blobs?.filesMissing).toBe(0);
    expect(count("SELECT count(*) FROM blob_refs")).toBe(42_569);
    // 71 of the 10,887 files are byte-identical to another; addressing collapses
    // them, which is why the blob count is 10,816 and not 10,887.
    expect(report.blobs?.distinctFiles).toBe(10_887);
    expect(report.blobs?.dedupedFiles).toBe(71);
    expect(report.blobs?.mediaBlobs).toBe(10_816);

    // Which filenames the export calls live, and which it tombstones, read
    // straight off the decoded records rather than from the blob importer.
    const tombstoned = new Set<string>();
    const liveNames = new Set<string>();
    for (const { card } of byId.values()) {
      for (const [fileName, record] of Object.entries(asRecord(card["attachments"]))) {
        if (isRecord(record) && record["deleted?"] === true) tombstoned.add(fileName);
        else liveNames.add(fileName);
      }
    }
    expect(tombstoned.size).toBe(8_958);
    const refKeys = db.prepare("SELECT ref_key FROM blob_refs").pluck().all() as string[];
    // Exactly the live attachments are referenced by filename; every other ref
    // is a generation key for cached text, which cannot collide with a filename.
    expect(refKeys.filter((key) => liveNames.has(key))).toHaveLength(10_887);
    // THE TOMBSTONE CHECK: not one of the 8,958 is reachable in the database.
    const leaked = [...tombstoned].filter(
      (name) => !liveNames.has(name) && refKeys.includes(name),
    );
    expect(leaked).toEqual([]);
    // And no blob row carries Mochi's tombstone concept at all: there is no
    // deleted? column in the schema, so the only way a tombstone could survive
    // is as a reference, which the line above rules out.

    // ── the reverse invariant, over the real data
    expect([...report.reviews.reverseForced].sort()).toEqual([
      "6bOaHfsA",
      "9IsiWF95",
      "J3R240Q0",
      "izVJ06yd",
      "oYjmEPwB",
      "rhX2sKTs",
    ]);
    expect(
      count(`SELECT count(*) FROM card_tracks t
               JOIN card_reverse_resolved cr ON cr.card_id = t.card_id
              WHERE t.kind = 'reverse' AND (cr.reverse <> 'on' OR t.dormant = 1)`),
    ).toBe(0);

    // ── 143 values name a field their card's template does not have. They are
    //    kept: card_field_values has no FK to template_fields on purpose.
    expect(
      count(`SELECT count(*) FROM card_field_values v
               JOIN cards c ON c.id = v.card_id
              WHERE c.template_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM template_fields f
                                 WHERE f.template_id = c.template_id AND f.id = v.field_id)`),
    ).toBe(143);

    expect(report.integrity).toEqual([]);
    expect(checkIntegrity(db)).toEqual([]);

    // eslint-disable-next-line no-console
    console.log("import", {
      elapsedSeconds: +(report.elapsedMs / 1000).toFixed(1),
      structure: {
        decks: report.structure.decks,
        templates: report.structure.templates,
        templateFields: report.structure.templateFields,
        cards: report.structure.cards,
        cardFieldValues: report.structure.cardFieldValues,
      },
      reviews: report.reviews.reviews,
      reviewsByKind: report.reviews.reviewsByKind,
      retention: `${((report.reviews.retention ?? 0) * 100).toFixed(2)}%`,
      tags: { paths: report.tags.tags, withCards: 19, cardTags: report.tags.cardTags },
      links: { rows: report.links.links, unresolved: report.links.unresolvedRows },
      blobs: {
        liveAttachments: report.blobs?.liveAttachments,
        refs: report.blobs?.mediaRefs,
        addresses: report.blobs?.mediaBlobs,
        tombstonesSkipped: report.blobs?.tombstonesSkipped,
        textBlobs: report.blobs?.textBlobs,
        textRefs: report.blobs?.textRefs,
      },
    });
    // eslint-disable-next-line no-console
    console.log("study_totals", totals);
  }, 120_000);

  // ── 2. idempotence ─────────────────────────────────────────────────────────

  it("re-imports with no duplication and no drift", () => {
    const before = tableCounts();
    const refcounts = count("SELECT COALESCE(sum(refcount), 0) FROM blobs");
    const cardStamps = db
      .prepare("SELECT id, updated_at FROM cards ORDER BY id LIMIT 20")
      .all();

    const again = importExports(db, sources, {});

    // Not one structural row inserted or updated the second time. This is the
    // strong form: "no duplication" would pass on an UPDATE that rewrote every
    // row and bumped every updated_at.
    for (const [name, counts] of [
      ["decks", again.structure.decks],
      ["templates", again.structure.templates],
      ["templateFields", again.structure.templateFields],
      ["cards", again.structure.cards],
      ["cardFieldValues", again.structure.cardFieldValues],
    ] as const) {
      expect({ name, ...counts }).toEqual({
        name,
        inserted: 0,
        updated: 0,
        unchanged: counts.unchanged,
      });
      expect(counts.unchanged).toBeGreaterThan(0);
    }
    expect(again.structure.fieldValuesRemoved).toBe(0);
    // reviews is append-only and keyed on import_key: zero new rows.
    expect(again.reviews.reviews).toBe(0);
    expect(again.reviews.tracks).toBe(13_392);
    expect(again.blobs?.mediaBlobs).toBe(0);
    expect(again.blobs?.mediaRefs).toBe(0);
    expect(again.blobs?.textBlobs).toBe(0);
    expect(again.blobs?.textRefs).toBe(0);
    expect(again.integrity).toEqual([]);

    expect(tableCounts()).toEqual(before);
    expect(count("SELECT COALESCE(sum(refcount), 0) FROM blobs")).toBe(refcounts);
    expect(db.prepare("SELECT id, updated_at FROM cards ORDER BY id LIMIT 20").all()).toEqual(
      cardStamps,
    );

    // eslint-disable-next-line no-console
    console.log("second import", { ...tableCounts(), reviewsInserted: again.reviews.reviews });
  }, 240_000);

  // ── 3. the diff, card by card against the source JSON ──────────────────────

  describe("field values, reviews and links match the source JSON", () => {
    /**
     * A deterministic sample: eight cards from every (export, template) pair —
     * all eleven of them, plus the template-less cards each export has — and
     * then every card the corpus makes awkward. Even stride over sorted ids, so
     * it is reproducible and spread rather than the first N of anything.
     */
    let cached: string[] | null = null;
    const sample = (): string[] => (cached ??= buildSample());

    function buildSample(): string[] {
      const groups = new Map<string, string[]>();
      for (const [id, entry] of byId) {
        const key = `${entry.exportName}|${entry.templateId}`;
        const list = groups.get(key);
        if (list === undefined) groups.set(key, [id]);
        else list.push(id);
      }

      const picked = new Set<string>();
      for (const ids of groups.values()) {
        const sorted = [...ids].sort();
        const take = Math.min(20, sorted.length);
        for (let i = 0; i < take; i += 1) {
          const at = take === 1 ? 0 : Math.round((i * (sorted.length - 1)) / (take - 1));
          picked.add(sorted[at] as string);
        }
      }

      // The awkward cases, each chosen because something in the corpus made it
      // awkward rather than because it is convenient.
      const first = (predicate: (entry: SourceCard) => boolean, n: number): string[] =>
        [...byId.entries()]
          .filter(([, entry]) => predicate(entry))
          .map(([id]) => id)
          .sort()
          .slice(0, n);

      const hard = [
        // Reverse forced on to keep history their deck would not schedule.
        "J3R240Q0",
        "rhX2sKTs",
        "6bOaHfsA",
        "oYjmEPwB",
        "9IsiWF95",
        "izVJ06yd",
        // SPEC's worked example of the regeneration churn: five cache entries,
        // four tombstones, one surviving file.
        "913qMiTa",
        // Transit's "~`" escape, which tools/mochi.py gets wrong.
        ...first((e) => fieldTexts(e.card).some(([, text]) => text.startsWith("~")), 4),
        // Booleans and nulls, which are not strings and must not become "".
        ...first(
          (e) =>
            Object.values(asRecord(e.card["fields"])).some(
              (f) => isRecord(f) && typeof f["value"] === "boolean",
            ),
          4,
        ),
        ...first(
          (e) =>
            Object.values(asRecord(e.card["fields"])).some(
              (f) => isRecord(f) && f["value"] === null,
            ),
          4,
        ),
        // The empty-map-not-empty-array trap on cloze/reviews.
        ...first((e) => e.card["cloze/reviews"] !== undefined, 3),
        // Cards whose text is in `content` and not in fields, and vice versa.
        ...first((e) => asText(e.card["content"]) !== "" && fieldTexts(e.card).length === 0, 3),
        ...first((e) => asText(e.card["content"]) === "" && fieldTexts(e.card).length > 2, 3),
        ...first((e) => e.card["archived?"] === true, 3),
        // Leech flags, per track and not per card.
        ...first((e) => e.card["reverse/needs-rereview?"] === true, 2),
        // The most-linked and most-reviewed cards: the widest rows there are.
        // Counted in one pass — a comparator that recomputes the parse is
        // O(n log n) parses and dominated the runtime of this whole file.
        ...widest((entry) => expectedLinks(entry.card).length, 3),
        ...widest((entry) => expectedReviews(entry.card).length, 3),
        // Both ends of an unresolved link: the source card must keep the row.
        ...(db
          .prepare("SELECT from_card_id FROM card_links_resolved WHERE resolved = 0")
          .pluck()
          .all() as string[]),
      ];
      for (const id of hard) if (byId.has(id)) picked.add(id);
      return [...picked].sort();
    }

    /** The n cards with the largest `size`, counted once each. */
    function widest(size: (entry: SourceCard) => number, n: number): string[] {
      return [...byId.entries()]
        .map(([id, entry]) => [id, size(entry)] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([id]) => id);
    }

    it("covers at least 50 cards across all three exports and all 11 template rows", () => {
      const ids = sample();
      expect(ids.length).toBeGreaterThanOrEqual(50);

      const pairs = new Set(
        ids.map((id) => {
          const entry = byId.get(id) as SourceCard;
          return `${entry.exportName}|${entry.templateId}`;
        }),
      );
      // 11 template rows + the template-less cards each export also has.
      expect([...pairs].sort()).toEqual([
        "English|(none)",
        "English|8JhEkkMC",
        "English|Q37a0W3E",
        "基本情報|(none)",
        "基本情報|oiaISYb2",
        "基本情報|ycFF12Ld",
        "日本語|(none)",
        "日本語|Dq5TYgr9",
        "日本語|HxKQLDx7",
        "日本語|NvtutXUt",
        "日本語|ibeOPZ1V",
        "日本語|itmYDz2N",
        "日本語|oiaISYb2",
        "日本語|ypBVG0UL",
      ]);
      expect(new Set(ids.map((id) => (byId.get(id) as SourceCard).exportName)).size).toBe(3);

      // eslint-disable-next-line no-console
      console.log("diff sample", {
        cards: ids.length,
        groups: pairs.size,
        fieldValues: ids.reduce(
          (n, id) => n + Object.keys(asRecord((byId.get(id) as SourceCard).card["fields"])).length,
          0,
        ),
        reviews: ids.reduce(
          (n, id) => n + expectedReviews((byId.get(id) as SourceCard).card).length,
          0,
        ),
        links: ids.reduce(
          (n, id) => n + expectedLinks((byId.get(id) as SourceCard).card).length,
          0,
        ),
      });
    }, 60_000);

    it("has every field value byte-identical to the source, in both directions", () => {
      const read = db.prepare(
        "SELECT field_id, value FROM card_field_values WHERE card_id = ? ORDER BY field_id",
      );
      let compared = 0;
      const wrong: unknown[] = [];

      for (const id of sample()) {
        const { card } = byId.get(id) as SourceCard;
        const expected = new Map<string, string>();
        for (const [fieldId, field] of Object.entries(asRecord(card["fields"]))) {
          expected.set(fieldId, expectedFieldValue(isRecord(field) ? field["value"] : field));
        }
        const actual = new Map(
          (read.all(id) as { field_id: string; value: string }[]).map((row) => [
            row.field_id,
            row.value,
          ]),
        );

        for (const [fieldId, value] of expected) {
          compared += 1;
          if (actual.get(fieldId) !== value) {
            wrong.push({ card: id, fieldId, expected: value, actual: actual.get(fieldId) });
          }
        }
        for (const fieldId of actual.keys()) {
          if (!expected.has(fieldId)) wrong.push({ card: id, fieldId, extraneous: true });
        }

        // The card's own columns, while we are here.
        const row = db
          .prepare("SELECT name, content, archived, pinned, pos, template_id FROM cards WHERE id = ?")
          .get(id) as Record<string, unknown>;
        expect({ id, ...row }).toEqual({
          id,
          name: asText(card["name"]),
          content: asText(card["content"]),
          archived: card["archived?"] === true ? 1 : 0,
          pinned: card["pinned?"] === true ? 1 : 0,
          pos: asText(card["pos"]),
          template_id: asText(card["template-id"]) || null,
        });
      }

      expect(wrong).toEqual([]);
      expect(compared).toBeGreaterThan(200);

      // And the coercion is measured over the WHOLE corpus, not just the sample,
      // because "12 nulls" is the kind of number a sample can miss entirely.
      let strings = 0;
      let booleans = 0;
      let nulls = 0;
      for (const { card } of byId.values()) {
        for (const field of Object.values(asRecord(card["fields"]))) {
          const raw = isRecord(field) ? field["value"] : field;
          if (typeof raw === "string") strings += 1;
          else if (typeof raw === "boolean") booleans += 1;
          else nulls += 1;
        }
      }
      expect({ strings, booleans, nulls }).toEqual({
        strings: 20_708,
        booleans: 1_599,
        nulls: 12,
      });
      // eslint-disable-next-line no-console
      console.log("field values compared", compared, "| corpus classes", {
        strings,
        booleans,
        nulls,
      });
    }, 120_000);

    it("has every review record byte-identical to the source, in both directions", () => {
      const read = db.prepare(
        `SELECT t.kind, r.import_key, r.reviewed_at, r.tz_offset_minutes, r.time_unknown,
                r.remembered, r.grade, r.interval_days, r.next_interval_days, r.due_at,
                r.duration_ms, r.rereview, r.source
           FROM reviews r JOIN card_tracks t ON t.id = r.track_id
          WHERE t.card_id = ?`,
      );
      let compared = 0;
      const wrong: unknown[] = [];
      const unsorted: string[] = [];

      for (const id of sample()) {
        const { card } = byId.get(id) as SourceCard;

        // The preceding-interval chain is only meaningful if the export's array
        // order is chronological. Assert it rather than assume it.
        for (const array of ARRAYS) {
          const dates = asRecords(card[array.key]).map((r) => instantMillis(r["date"]) ?? 0);
          for (let i = 1; i < dates.length; i += 1) {
            if ((dates[i] as number) < (dates[i - 1] as number)) unsorted.push(`${id}:${array.key}`);
          }
        }

        const expected = new Map(expectedReviews(card).map((row) => [row.import_key, row]));
        const actual = new Map(
          (read.all(id) as Record<string, unknown>[]).map((row) => [
            row["import_key"] as string,
            row,
          ]),
        );

        for (const [key, row] of expected) {
          compared += 1;
          const got = actual.get(key);
          if (got === undefined) {
            wrong.push({ missing: key });
            continue;
          }
          // Deep-equal the whole row: a field-by-field comparison would silently
          // stop at the first column someone forgets to list. Keys are sorted
          // because SELECT order and object-literal order are not the same.
          if (canonical(got) !== canonical(row)) {
            wrong.push({ key, expected: row, actual: got });
          }
        }
        for (const key of actual.keys()) {
          if (!expected.has(key)) wrong.push({ extraneous: key });
        }
      }

      expect(unsorted).toEqual([]);
      expect(wrong).toEqual([]);
      expect(compared).toBeGreaterThan(500);
      // eslint-disable-next-line no-console
      console.log("review records compared", compared);
    }, 180_000);

    it("has every wiki-link byte-identical to the source, in both directions", () => {
      const read = db.prepare(
        `SELECT to_card_id, display_text, field_id, ordinal FROM card_links
          WHERE from_card_id = ? ORDER BY COALESCE(field_id, ''), ordinal`,
      );
      let compared = 0;
      const wrong: unknown[] = [];

      for (const id of sample()) {
        const { card } = byId.get(id) as SourceCard;
        const key = (link: ExpectedLink): string =>
          `${link.field_id ?? ""}${link.ordinal}`;
        const expected = new Map(expectedLinks(card).map((link) => [key(link), link]));
        const actual = new Map(
          (read.all(id) as ExpectedLink[]).map((link) => [key(link), link]),
        );

        for (const [scope, link] of expected) {
          compared += 1;
          const got = actual.get(scope);
          if (
            got === undefined ||
            got.to_card_id !== link.to_card_id ||
            got.display_text !== link.display_text
          ) {
            wrong.push({ card: id, scope, expected: link, actual: got });
          }
        }
        for (const scope of actual.keys()) {
          if (!expected.has(scope)) wrong.push({ card: id, scope, extraneous: true });
        }
      }

      expect(wrong).toEqual([]);
      expect(compared).toBeGreaterThan(100);

      // Whole-corpus cross-check on the same parse, so the sample cannot flatter
      // the total: the row count equals the number of [[...]] occurrences.
      let occurrences = 0;
      for (const { card } of byId.values()) occurrences += expectedLinks(card).length;
      expect(occurrences).toBe(8_690);
      expect(count("SELECT count(*) FROM card_links")).toBe(occurrences);
      // eslint-disable-next-line no-console
      console.log("links compared", compared, "| corpus occurrences", occurrences);
    }, 120_000);
  });

  // ── 4. the 45-vs-39 decision, tested both ways ─────────────────────────────

  it("keeps all 45 decks by default and drops exactly SPEC's six on request", () => {
    // Lossless is the default: stage 1's contract is round-trip fidelity, and a
    // lossless import can be filtered later while the reverse is not true.
    expect(count("SELECT count(*) FROM decks")).toBe(45);
    expect(report.structure.emptyLeafDecksDropped).toEqual([]);

    const filtered = openDatabase(MEMORY);
    try {
      const dropped = importExports(filtered, sources, {
        dropEmptyLeafDecks: true,
        blobs: false,
      });
      expect(filtered.prepare("SELECT count(*) FROM decks").pluck().get()).toBe(39);
      // SPEC "Settled": 副詞, 名詞, 形容動詞, 一段動詞, 形容詞, 五段動詞.
      const names = (
        dropped.structure.emptyLeafDecksDropped.map((id) => {
          const source = sources
            .flatMap((entry) => walkDecks(entry.root))
            .find((walked) => asText(walked.deck["id"]) === id);
          return asText(source?.deck["name"]);
        }) as string[]
      ).sort();
      expect(names).toEqual(["一段動詞", "五段動詞", "副詞", "名詞", "形容動詞", "形容詞"].sort());
      // Every card still has a deck: the six hold none, which is why they go.
      expect(filtered.prepare("SELECT count(*) FROM cards").pluck().get()).toBe(7_716);
      expect(checkIntegrity(filtered)).toEqual([]);
    } finally {
      filtered.close();
    }
  }, 300_000);

  // ── 5. importing the exports one at a time reaches the same database ────────

  it("is order-independent: three separate imports equal one combined import", () => {
    const combined = tableCounts();
    const separate = openDatabase(MEMORY);
    try {
      for (const source of sources) {
        importExports(separate, [source], { blobs: false });
      }
      const counts = (sql: string): number =>
        separate.prepare(sql).pluck().get() as number;
      expect(counts("SELECT count(*) FROM cards")).toBe(combined.cards);
      expect(counts("SELECT count(*) FROM decks")).toBe(combined.decks);
      // The 単語 template is defined in two exports; importing them separately
      // must still leave one row, upserted rather than rejected.
      expect(counts("SELECT count(*) FROM templates")).toBe(combined.templates);
      expect(counts("SELECT count(*) FROM template_fields")).toBe(combined.template_fields);
      expect(counts("SELECT count(*) FROM card_field_values")).toBe(combined.card_field_values);
      expect(counts("SELECT count(*) FROM reviews")).toBe(combined.reviews);
      expect(counts("SELECT count(*) FROM card_tracks")).toBe(combined.card_tracks);
      expect(counts("SELECT count(*) FROM card_links")).toBe(combined.card_links);
      expect(counts("SELECT count(*) FROM tags")).toBe(combined.tags);
      expect(counts("SELECT count(*) FROM card_tags")).toBe(combined.card_tags);
      // Cross-export links resolve once the last export lands, without anyone
      // re-visiting the first: `card_links_resolved` is computed, not stored.
      expect(counts("SELECT count(*) FROM card_links_resolved WHERE resolved = 0")).toBe(18);
      expect(checkIntegrity(separate)).toEqual([]);
    } finally {
      separate.close();
    }
  }, 300_000);
});

// ─── convergence, on a synthetic export ──────────────────────────────────────

describe("re-importing an edited export converges", () => {
  it("removes a field value the export no longer carries", () => {
    const fresh = openDatabase(MEMORY);
    try {
      const build = (fields: Record<string, unknown>): MochiRecord => ({
        decks: [
          {
            id: "d1",
            name: "D",
            cards: [{ id: "c1", "deck-id": "d1", content: "", fields }],
          },
        ],
      });

      importExports(fresh, [{ dir: "synthetic", root: build({ f1: { id: "f1", value: "keep" }, f2: { id: "f2", value: "drop me" } }) }], { blobs: false });
      expect(fresh.prepare("SELECT count(*) FROM card_field_values").pluck().get()).toBe(2);

      const report = importExports(
        fresh,
        [{ dir: "synthetic", root: build({ f1: { id: "f1", value: "keep" } }) }],
        { blobs: false },
      );
      expect(report.structure.fieldValuesRemoved).toBe(1);
      expect(fresh.prepare("SELECT field_id FROM card_field_values").pluck().all()).toEqual([
        "f1",
      ]);
      // The FTS body no longer matches the removed text, which is the actual
      // reason this matters: a stale value keeps answering searches.
      expect(
        fresh
          .prepare("SELECT count(*) FROM card_fts WHERE card_fts MATCH ?")
          .pluck()
          .get('"drop me"'),
      ).toBe(0);
      expect(checkIntegrity(fresh)).toEqual([]);
    } finally {
      fresh.close();
    }
  });
});

/** Key-order-independent JSON, so two rows compare by value. */
function canonical(row: object): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

/** Row counts for every table the importer writes. */
function tableCounts(): Record<string, number> {
  const tables = [
    "decks",
    "templates",
    "template_fields",
    "cards",
    "card_field_values",
    "card_tracks",
    "reviews",
    "tags",
    "card_tags",
    "card_links",
    "blobs",
    "blob_refs",
    "card_fts",
  ];
  const out: Record<string, number> = {};
  for (const table of tables) out[table] = count(`SELECT count(*) FROM ${table}`);
  return out;
}
