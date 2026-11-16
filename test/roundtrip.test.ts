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
import { renderPlainTextParts } from "../src/text/index.js";

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const EXPORT_DIRS = EXPORT_NAMES.map((name) =>
  resolve(import.meta.dirname, "..", "exports", name),
);
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

const OFFSET_MINUTES = 540;

interface SourceCard {
  readonly exportName: string;
  readonly templateId: string;
  readonly card: MochiRecord;
}

const ARRAYS = [
  { key: "reviews", kind: "forward" },
  { key: "reverse-reviews", kind: "reverse" },
  { key: "cloze/reviews", kind: "cloze:0" },
] as const;

function expectedFieldValue(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "boolean") return raw ? "true" : "false";
  if (typeof raw === "number") return String(raw);
  return "";
}

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

function fieldTexts(card: MochiRecord): (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  for (const [fieldId, field] of Object.entries(asRecord(card["fields"]))) {
    const raw = isRecord(field) ? field["value"] : field;
    if (typeof raw === "string") out.push([fieldId, raw]);
  }
  return out;
}

const WIKI = /\[\[([^[\]]*)\]\]/g;

function splitWikiLink(inner: string): readonly [string, string] | null {
  const bar = inner.indexOf("|");
  const display = bar === -1 ? "" : inner.slice(0, bar);
  const target = bar === -1 ? inner : inner.slice(bar + 1);
  return target === "" ? null : [display, target];
}

interface ExpectedLink {
  readonly to_card_id: string;
  readonly display_text: string;
  readonly field_id: string | null;
  readonly ordinal: number;
}

function expectedLinks(
  card: MochiRecord,
  resolveTargetName: (targetId: string) => string = () => "",
): ExpectedLink[] {
  const out: ExpectedLink[] = [];
  const scopes: (readonly [string | null, string])[] = [
    [null, asText(card["content"])],
    ...fieldTexts(card),
  ];
  for (const [fieldId, text] of scopes) {
    let ordinal = 0;
    for (const match of text.matchAll(WIKI)) {
      const split = splitWikiLink(match[1] as string);
      if (split === null) continue;
      const [display, target] = split;
      out.push({
        to_card_id: target,
        display_text: display === "" ? resolveTargetName(target) : display,
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
  readonly elapsed_days: number | null;
  readonly scheduled_days: number | null;
  readonly next_scheduled_days: number | null;
  readonly due_at: string | null;
  readonly duration_ms: number | null;
  readonly rereview: number;
  readonly source: string;
}

function expectedReviews(card: MochiRecord): ExpectedReview[] {
  const cardId = asText(card["id"]);
  const out: ExpectedReview[] = [];
  for (const array of ARRAYS) {
    const records = asRecords(card[array.key]);
    let previousInterval: number | null = null;
    let previousDate: number | null = null;
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
        elapsed_days:
          previousDate === null ? null : ((date as number) - previousDate) / 86_400_000,
        scheduled_days: previousInterval,
        next_scheduled_days: nextInterval,
        due_at: due === null ? null : atOffset(due, OFFSET_MINUTES),
        duration_ms: durationSeconds === null ? null : Math.round(durationSeconds * 1000),
        rereview: record["rereview?"] === true ? 1 : 0,
        source: "mochi",
      });
      previousInterval = nextInterval;
      previousDate = date as number;
    });
  }
  return out;
}

let db: Db;
let sources: ImportSource[];
let report: ImportReport;
const byId = new Map<string, SourceCard>();

function targetName(targetId: string): string {
  return asText(byId.get(targetId)?.card["name"]);
}

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
    report = importExports(db, sources, {});
  }, 600_000);

  afterAll(() => {
    db?.close();
  });

  it("lands every oracle number", () => {
    expect(count("SELECT count(*) FROM cards")).toBe(7_716);
    expect(count("SELECT count(*) FROM decks")).toBe(39);
    expect(count("SELECT count(*) FROM card_field_values")).toBe(22_325);
    expect(count("SELECT count(*) FROM template_fields")).toBe(41);

    const templateRows = sources.flatMap((source) => asRecords(source.root["templates"]));
    expect(templateRows).toHaveLength(11);
    const templateIds = templateRows.map((template) => asText(template["id"]));
    expect(new Set(templateIds).size).toBe(10);
    expect(templateIds.filter((id) => id === "oiaISYb2")).toHaveLength(2);
    expect(count("SELECT count(*) FROM templates")).toBe(10);
    expect(report.notes.templateIdCollisions).toEqual(["oiaISYb2"]);
    expect(report.notes.templateIdConflicts).toEqual([]);
    for (const id of new Set(templateIds)) {
      expect(count("SELECT count(*) FROM templates WHERE id = ?", id)).toBe(1);
    }

    expect(count("SELECT count(*) FROM reviews")).toBe(103_110);
    expect(count("SELECT count(*) FROM review_log WHERE track_kind = 'forward'")).toBe(59_514);
    expect(count("SELECT count(*) FROM review_log WHERE track_kind = 'reverse'")).toBe(43_596);
    expect(count("SELECT count(*) FROM card_tracks")).toBe(13_393);
    const totals = db
      .prepare(
        `SELECT reviews, passed, lapses, round(retention * 100, 2) AS retention_pct,
                round(hours, 1) AS hours, study_days, first_review_date, last_review_date,
                reviews_time_unknown
           FROM study_totals`,
      )
      .get() as Record<string, unknown>;
    expect(totals).toEqual({
      reviews: 103_110,
      passed: 99_228,
      lapses: 3_882,
      retention_pct: 96.24,
      hours: 641.2,
      study_days: 1_333,
      first_review_date: "2022-06-28",
      last_review_date: "2026-09-06",
      reviews_time_unknown: 103_110,
    });
    expect(count("SELECT count(*) FROM retention_by_hour")).toBe(0);

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
    expect(
      (db.prepare("SELECT path FROM tags").pluck().all() as string[]).filter((path) =>
        /\p{Cf}/u.test(path),
      ),
    ).toEqual([]);

    expect(count("SELECT count(*) FROM card_links")).toBe(8_744);
    expect(count("SELECT count(*) FROM card_links_resolved WHERE resolved = 0")).toBe(18);

    expect(count("SELECT count(*) FROM card_links_resolved WHERE text_present = 0")).toBe(889);
    expect(report.links.inDiscardedContent).toBe(889);
    const ghostCards = db
      .prepare("SELECT DISTINCT from_card_id FROM card_links_resolved WHERE text_present = 0")
      .pluck()
      .all() as string[];
    expect(ghostCards.length).toBe(510);
    const discarded = new Set(report.notes.staleContentCardIds);
    expect(ghostCards.filter((id) => !discarded.has(id))).toEqual([]);
    expect(
      count(
        `SELECT count(*) FROM card_links_resolved r
          WHERE r.text_present = 1
            AND NOT EXISTS (
              SELECT 1 FROM cards c WHERE c.id = r.from_card_id
                AND (r.field_id IS NULL AND instr(c.content, r.to_card_id) > 0))
            AND NOT EXISTS (
              SELECT 1 FROM card_field_values v
               WHERE v.card_id = r.from_card_id AND v.field_id = r.field_id
                 AND instr(v.value, r.to_card_id) > 0)`,
      ),
    ).toBe(0);
    expect(count("SELECT count(DISTINCT from_card_id) FROM card_links")).toBe(4_335);
    const sourceLinking = new Set(
      [...byId.values()]
        .filter(({ card }) => expectedLinks(card).length > 0)
        .map(({ card }) => asText(card["id"])),
    );
    expect(sourceLinking.size).toBe(4_335);
    const PIPED_ONLY = /\[\[[^\]|]+\|[^\]]+\]\]/;
    const pipedOnly = [...byId.values()].filter(({ card }) =>
      [asText(card["content"]), ...fieldTexts(card).map(([, text]) => text)].some((text) =>
        PIPED_ONLY.test(text),
      ),
    ).length;
    expect(pipedOnly).toBe(4_323);
    expect(sourceLinking.size - pipedOnly).toBe(12);

    expect(report.blobs?.liveAttachments).toBe(10_890);
    expect(report.blobs?.mediaRefs).toBe(10_890);
    expect(report.blobs?.tombstonesSkipped).toBe(8_983);
    expect(report.blobs?.filesMissing).toBe(0);
    expect(count("SELECT count(*) FROM blob_refs")).toBe(42_596);
    expect(report.blobs?.distinctFiles).toBe(10_890);
    expect(report.blobs?.dedupedFiles).toBe(64);
    expect(report.blobs?.mediaBlobs).toBe(10_826);

    const tombstoned = new Set<string>();
    const liveNames = new Set<string>();
    for (const { card } of byId.values()) {
      for (const [fileName, record] of Object.entries(asRecord(card["attachments"]))) {
        if (isRecord(record) && record["deleted?"] === true) tombstoned.add(fileName);
        else liveNames.add(fileName);
      }
    }
    expect(tombstoned.size).toBe(8_983);
    const refKeys = db.prepare("SELECT ref_key FROM blob_refs").pluck().all() as string[];
    expect(refKeys.filter((key) => liveNames.has(key))).toHaveLength(10_890);
    const leaked = [...tombstoned].filter(
      (name) => !liveNames.has(name) && refKeys.includes(name),
    );
    expect(leaked).toEqual([]);

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

  it("does NOT revert a locally-graded track on re-import, and says so", () => {
    const track = db
      .prepare(
        `SELECT id, card_id, kind FROM card_tracks
          WHERE due_at IS NOT NULL AND reps > 0 ORDER BY id LIMIT 1`,
      )
      .get() as { id: number; card_id: string; kind: string };
    expect(track).toBeDefined();

    db.prepare(
      `INSERT INTO reviews
         (track_id, reviewed_at, tz_offset_minutes, time_unknown, remembered,
          elapsed_days, scheduled_days, next_scheduled_days, due_at, duration_ms,
          rereview, source, import_key)
       VALUES (?, '2026-08-22T09:00:00Z', 540, 0, 1, 3, 3, 40, '2026-10-01T15:00:00Z',
               4200, 0, 'local', NULL)`,
    ).run(track.id);
    db.prepare(
      `UPDATE card_tracks
          SET due_at = '2099-01-01T15:00:00Z', scheduled_days = 4242,
              reps = 999, lapses = 42, scheduler = 'fsrs6'
        WHERE id = ?`,
    ).run(track.id);

    const again = importExports(db, sources, {});

    expect(again.reviews.tracksPreserved).toBe(1);

    const after = db
      .prepare(
        `SELECT due_at, scheduled_days, reps, lapses, scheduler FROM card_tracks WHERE id = ?`,
      )
      .get(track.id) as Record<string, unknown>;
    expect(after).toEqual({
      due_at: "2099-01-01T15:00:00Z",
      scheduled_days: 4242,
      reps: 999,
      lapses: 42,
      scheduler: "fsrs6",
    });

    const others = db
      .prepare("SELECT count(*) AS n FROM card_tracks WHERE scheduler = 'mochi'")
      .get() as { n: number };
    expect(others.n).toBeGreaterThan(9_000);

    db.prepare("DELETE FROM reviews WHERE source = 'local'").run();
    db.prepare(
      `UPDATE card_tracks SET due_at = NULL, scheduled_days = NULL, reps = 0,
              lapses = 0, scheduler = 'mochi' WHERE id = ?`,
    ).run(track.id);
    importExports(db, sources, {});
  });

  it("re-imports with no duplication and no drift", () => {
    const before = tableCounts();
    const refcounts = count("SELECT COALESCE(sum(refcount), 0) FROM blobs");
    const cardStamps = db
      .prepare("SELECT id, updated_at FROM cards ORDER BY id LIMIT 20")
      .all();

    const again = importExports(db, sources, {});

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
    expect(again.structure.searchTextWritten).toBe(0);
    expect(again.reviews.reviews).toBe(0);
    expect(again.reviews.tracks).toBe(13_393);
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

  describe("field values, reviews and links match the source JSON", () => {
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

      const first = (predicate: (entry: SourceCard) => boolean, n: number): string[] =>
        [...byId.entries()]
          .filter(([, entry]) => predicate(entry))
          .map(([id]) => id)
          .sort()
          .slice(0, n);

      const hard = [
        "J3R240Q0",
        "rhX2sKTs",
        "6bOaHfsA",
        "oYjmEPwB",
        "9IsiWF95",
        "izVJ06yd",
        "913qMiTa",
        ...first((e) => fieldTexts(e.card).some(([, text]) => text.startsWith("~")), 4),
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
        ...first((e) => e.card["cloze/reviews"] !== undefined, 3),
        ...first((e) => asText(e.card["content"]) !== "" && fieldTexts(e.card).length === 0, 3),
        ...first((e) => asText(e.card["content"]) === "" && fieldTexts(e.card).length > 2, 3),
        ...first((e) => e.card["archived?"] === true, 3),
        ...first((e) => e.card["reverse/needs-rereview?"] === true, 2),
        ...widest((entry) => expectedLinks(entry.card).length, 3),
        ...widest((entry) => expectedReviews(entry.card).length, 3),
        ...(db
          .prepare("SELECT from_card_id FROM card_links_resolved WHERE resolved = 0")
          .pluck()
          .all() as string[]),
      ];
      for (const id of hard) if (byId.has(id)) picked.add(id);
      return [...picked].sort();
    }

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

        const templateId = asText(card["template-id"]) || null;
        const rawContent = asText(card["content"]);
        const row = db
          .prepare("SELECT name, content, archived, pinned, pos, template_id FROM cards WHERE id = ?")
          .get(id) as Record<string, unknown>;
        expect({ id, ...row }).toEqual({
          id,
          name: asText(card["name"]),
          content: templateId !== null ? "" : rawContent,
          archived: card["archived?"] === true ? 1 : 0,
          pinned: card["pinned?"] === true ? 1 : 0,
          pos: asText(card["pos"]),
          template_id: templateId,
        });
      }

      expect(wrong).toEqual([]);
      expect(compared).toBeGreaterThan(200);

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
        strings: 20_713,
        booleans: 1_600,
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
                r.remembered, r.elapsed_days, r.scheduled_days, r.next_scheduled_days,
                r.due_at, r.duration_ms, r.rereview, r.source
           FROM reviews r JOIN card_tracks t ON t.id = r.track_id
          WHERE t.card_id = ?`,
      );
      let compared = 0;
      const wrong: unknown[] = [];
      const unsorted: string[] = [];

      for (const id of sample()) {
        const { card } = byId.get(id) as SourceCard;

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
        const expected = new Map(
          expectedLinks(card, targetName).map((link) => [key(link), link]),
        );
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

      let occurrences = 0;
      for (const { card } of byId.values()) occurrences += expectedLinks(card).length;
      expect(occurrences).toBe(8_744);
      expect(count("SELECT count(*) FROM card_links")).toBe(occurrences);
      // eslint-disable-next-line no-console
      console.log("links compared", compared, "| corpus occurrences", occurrences);
    }, 120_000);
  });

  it("renders search_text for every card without touching a stored byte", () => {
    expect(count("SELECT count(*) FROM cards WHERE search_text IS NULL")).toBe(0);
    expect(count("SELECT count(*) FROM cards")).toBe(7_716);
    expect(count("SELECT count(*) FROM cards WHERE search_text = ''")).toBe(18);
    expect(
      count(
        `SELECT count(*) FROM cards c WHERE c.search_text = ''
           AND NOT EXISTS (SELECT 1 FROM card_field_values v WHERE v.card_id = c.id)`,
      ),
    ).toBe(16);
    const empties = db
      .prepare("SELECT id FROM cards WHERE search_text = '' ORDER BY id")
      .pluck()
      .all() as string[];
    const emptiedByDiscard: string[] = [];
    for (const id of empties) {
      const { card } = byId.get(id) as SourceCard;
      for (const [, text] of fieldTexts(card)) expect(text).toBe("");
      if (asText(card["content"]) !== "") emptiedByDiscard.push(id);
    }
    expect(emptiedByDiscard).toEqual(["BvgOrDsX", "fFsjcZla"]);
    for (const id of emptiedByDiscard) {
      expect(report.notes.staleContentCardIds).toContain(id);
    }

    const rows = db
      .prepare(
        `SELECT c.id, c.content, c.search_text,
                (SELECT group_concat(v.value, char(10))
                   FROM card_field_values v WHERE v.card_id = c.id) AS values_joined
           FROM cards c ORDER BY c.id`,
      )
      .all() as { id: string; content: string; search_text: string }[];
    const readValues = db.prepare(
      "SELECT value FROM card_field_values WHERE card_id = ? ORDER BY rowid",
    );
    let checked = 0;
    const wrong: unknown[] = [];
    for (const row of rows) {
      const values = (readValues.all(row.id) as { value: string }[]).map((v) => v.value);
      const expected = renderPlainTextParts([row.content, ...values]);
      checked += 1;
      if (row.search_text !== expected) {
        wrong.push({ id: row.id, expected, actual: row.search_text });
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBe(7_716);

    expect(count("SELECT count(*) FROM cards WHERE search_text GLOB '*[[]][[]]*'")).toBe(0);
    for (const mark of ["​", "‌", "‍", "‎", "﻿"]) {
      expect(
        count("SELECT count(*) FROM cards WHERE instr(search_text, ?) > 0", mark),
      ).toBe(0);
    }
    expect(
      count("SELECT count(*) FROM card_field_values WHERE instr(value, ?) > 0", "‎"),
    ).toBeGreaterThan(0);

    const compound = db
      .prepare("SELECT search_text FROM cards WHERE id = '2ntjaTPJ'")
      .pluck()
      .get() as string | undefined;
    if (compound !== undefined) expect(compound.includes("[[")).toBe(false);
  }, 120_000);

  it("discards stale pre-template content, and says exactly what it discarded", () => {
    expect(report.notes.staleContentCardIds.length).toBe(3_160);
    expect(report.notes.staleContentChars).toBe(79_306);
    expect(report.notes.staleContentSample.length).toBe(20);

    expect(
      count("SELECT count(*) FROM cards WHERE template_id IS NOT NULL AND content <> ''"),
    ).toBe(0);
    expect(
      count("SELECT count(*) FROM cards WHERE template_id IS NULL AND content <> ''"),
    ).toBe(363);

    const ids = new Set(report.notes.staleContentCardIds);
    expect(ids.size).toBe(3_160);
    const stored = db.prepare("SELECT content, template_id FROM cards WHERE id = ?");
    let verified = 0;
    for (const id of ids) {
      const source = byId.get(id);
      expect(source).toBeDefined();
      expect(asText((source as SourceCard).card["content"])).not.toBe("");
      const row = stored.get(id) as { content: string; template_id: string | null };
      expect(row.content).toBe("");
      expect(row.template_id).not.toBeNull();
      verified += 1;
    }
    expect(verified).toBe(3_160);

    for (const entry of report.notes.staleContentSample) {
      expect(ids.has(entry.cardId)).toBe(true);
      expect(entry.content).toBe(asText((byId.get(entry.cardId) as SourceCard).card["content"]));
    }

    const withLinksInContent = [...ids].filter((id) =>
      asText((byId.get(id) as SourceCard).card["content"]).includes("[["),
    );
    expect(withLinksInContent.length).toBe(510);

    const contentScopedFromStale = count(
      `SELECT count(*) FROM card_links l
        WHERE l.field_id IS NULL
          AND EXISTS (SELECT 1 FROM cards c
                       WHERE c.id = l.from_card_id
                         AND c.template_id IS NOT NULL AND c.content = '')`,
    );
    expect(contentScopedFromStale).toBe(889);
    expect(count("SELECT count(*) FROM card_links WHERE field_id IS NULL")).toBe(1_019);
    // eslint-disable-next-line no-console
    console.log(
      "stale content discarded", ids.size,
      "cards |", report.notes.staleContentChars, "code points |",
      "of which carried links in content:", withLinksInContent.length,
    );
  }, 120_000);

  it("drops exactly SPEC's six empty leaf decks by default, and keeps all 45 on request", () => {
    expect(count("SELECT count(*) FROM decks")).toBe(39);
    expect(report.structure.emptyLeafDecksDropped.length).toBe(6);
    const names = (
      report.structure.emptyLeafDecksDropped.map((id) => {
        const source = sources
          .flatMap((entry) => walkDecks(entry.root))
          .find((walked) => asText(walked.deck["id"]) === id);
        return asText(source?.deck["name"]);
      }) as string[]
    ).sort();
    expect(names).toEqual(["一段動詞", "五段動詞", "副詞", "名詞", "形容動詞", "形容詞"].sort());
    expect(count("SELECT count(*) FROM cards")).toBe(7_716);
    expect(count("SELECT count(*) FROM reviews")).toBe(103_110);

    const kept = openDatabase(MEMORY);
    try {
      const unfiltered = importExports(kept, sources, {
        dropEmptyLeafDecks: false,
        blobs: false,
      });
      const rows = (sql: string): number => kept.prepare(sql).pluck().get() as number;
      expect(rows("SELECT count(*) FROM decks")).toBe(45);
      expect(unfiltered.structure.emptyLeafDecksDropped).toEqual([]);
      expect(rows("SELECT count(*) FROM cards")).toBe(7_716);
      expect(rows("SELECT count(*) FROM reviews")).toBe(103_110);
      expect(checkIntegrity(kept)).toEqual([]);
    } finally {
      kept.close();
    }
  }, 300_000);

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
      expect(counts("SELECT count(*) FROM templates")).toBe(combined.templates);
      expect(counts("SELECT count(*) FROM template_fields")).toBe(combined.template_fields);
      expect(counts("SELECT count(*) FROM card_field_values")).toBe(combined.card_field_values);
      expect(counts("SELECT count(*) FROM reviews")).toBe(combined.reviews);
      expect(counts("SELECT count(*) FROM card_tracks")).toBe(combined.card_tracks);
      expect(counts("SELECT count(*) FROM card_links")).toBe(combined.card_links);
      expect(counts("SELECT count(*) FROM tags")).toBe(combined.tags);
      expect(counts("SELECT count(*) FROM card_tags")).toBe(combined.card_tags);
      expect(counts("SELECT count(*) FROM card_links_resolved WHERE resolved = 0")).toBe(18);
      expect(checkIntegrity(separate)).toEqual([]);
    } finally {
      separate.close();
    }
  }, 300_000);
});

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

function canonical(row: object): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

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

describe("local data survives a re-import", () => {
  it("keeps a locally-defined field's values, and still prunes a deleted one", () => {
    const db = openDatabase(MEMORY);
    try {
      db.prepare("INSERT INTO decks (id, name) VALUES ('d', 'd')").run();
      db.prepare("INSERT INTO templates (id, name, content) VALUES ('t', 't', 'x')").run();
      db.prepare(
        `INSERT INTO template_fields (template_id, id, name, type, local)
         VALUES ('t', 'mine', '型', 'accent', 1), ('t', 'theirs', 'Gone', 'plain', 0)`,
      ).run();
      db.prepare("INSERT INTO cards (id, deck_id, template_id) VALUES ('c', 'd', 't')").run();
      db.prepare(
        `INSERT INTO card_field_values (card_id, field_id, value)
         VALUES ('c', 'mine', '平板'), ('c', 'theirs', 'stale')`,
      ).run();

      const removed = db
        .prepare(
          `DELETE FROM card_field_values
            WHERE card_id = 'c'
              AND NOT EXISTS (SELECT 1 FROM template_fields f
                               WHERE f.id = card_field_values.field_id AND f.local = 1)`,
        )
        .run().changes;

      expect(removed).toBe(1);
      expect(
        db.prepare("SELECT value FROM card_field_values WHERE field_id='mine'").pluck().get(),
      ).toBe("平板");
      expect(
        db.prepare("SELECT COUNT(*) FROM card_field_values WHERE field_id='theirs'").pluck().get(),
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});
