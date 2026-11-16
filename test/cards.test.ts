import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  backlinksOf,
  reconcileCardLinks,
  cardAudioResolver,
  cardContext,
  cardInputFor,
  decodeReversePermutation,
  directionForTrackKind,
  linkTargetsOf,
  loadCard,
  loadRenderedCard,
  renderLoadedCard,
  resolveAudioHash,
} from "../src/cards/index.js";
import { BlobMissingError, defaultStoreDatabase, openBlobStoreDatabase, type BlobStore } from "../src/blobs/index.js";
import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { expandGeneratorFields } from "../src/generate/index.js";
import type { AudioResolver } from "../src/render/audio.js";
import { memoryDocument, renderSides, serialise } from "../src/render/index.js";
import { prepareCard } from "../src/review/index.js";
import { orderSides, resolveCard, side, walkSides, type TemplateInput } from "../src/template/index.js";

const DB = "build/hashigo.db";
const haveCorpus = existsSync(DB);

function fixture(): Db {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name, reverse) VALUES ('root', '日本語', 'on')").run();
  db.prepare("INSERT INTO decks (id, parent_id, name) VALUES ('kid', 'root', '単語')").run();
  db.prepare(
    `INSERT INTO templates (id, name, content, reverse_permutation)
     VALUES ('t', '単語', '<<Word>>\n---\n<<Reading>>\n---\n<<Sense>>', '[2,0,1]')`,
  ).run();
  for (const [id, name, type, pos] of [
    ["f3", "Sense", "plain", "b"],
    ["f1", "Word", "plain", "c"],
    ["f2", "Reading", "speech", "a"],
  ] as const) {
    db.prepare(
      `INSERT INTO template_fields (template_id, id, name, type, pos, options)
       VALUES ('t', ?, ?, ?, ?, '{"voice":"ja-JP-Neural2-C"}')`,
    ).run(id, name, type, pos);
  }
  db.prepare("INSERT INTO cards (id, deck_id, template_id, name) VALUES ('c1', 'kid', 't', '橋')").run();
  db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES ('c1', 'f1', '橋')").run();
  db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES ('c1', 'f3', 'bridge')").run();
  db.prepare(
    "INSERT INTO cards (id, deck_id, name, content) VALUES ('c2', 'kid', 'plain', 'front\n---\nback')",
  ).run();
  return db;
}

describe("loading a card", () => {
  it("assembles the card, its template, its fields in pos order, and its values", () => {
    const db = fixture();
    const loaded = loadCard(db, "c1");
    expect(loaded).not.toBeNull();
    const card = loaded as NonNullable<typeof loaded>;

    expect(card.id).toBe("c1");
    expect(card.name).toBe("橋");
    expect(card.deckPath).toBe("日本語/単語");
    expect(card.templateId).toBe("t");
    expect(card.template?.name).toBe("単語");
    expect(card.template?.fields.map((f) => f.name)).toEqual(["Reading", "Sense", "Word"]);
    expect(card.template?.fields[0]?.type).toBe("speech");
    expect(card.template?.fields[0]?.options).toEqual({ voice: "ja-JP-Neural2-C" });
    expect(card.values.get("f1")).toBe("橋");
    expect(card.values.get("f3")).toBe("bridge");
    expect(card.values.has("f2")).toBe(false);
    db.close();
  });

  it("keeps the 4.33 ms/card views OUT of the load, and reachable beside it", () => {
    const db = fixture();
    const loaded = loadCard(db, "c1") as NonNullable<ReturnType<typeof loadCard>>;
    expect(Object.keys(loaded)).not.toContain("reverse");
    expect(Object.keys(loaded)).not.toContain("voice");

    expect(cardContext(db, "c1")?.reverse).toBe("on");
    db.prepare("UPDATE cards SET reverse = 'off' WHERE id = 'c1'").run();
    expect(cardContext(db, "c1")?.reverse).toBe("off");
    db.prepare("UPDATE decks SET reverse = 'off' WHERE id = 'root'").run();
    db.prepare("UPDATE cards SET reverse = 'on' WHERE id = 'c1'").run();
    expect(cardContext(db, "c1")?.reverse).toBe("on");
    expect(cardContext(db, "nope")).toBeNull();
    db.close();
  });

  it("returns null for a card that does not exist, rather than throwing", () => {
    const db = fixture();
    expect(loadCard(db, "nope")).toBeNull();
    expect(loadRenderedCard(db, "nope", "forward")).toBeNull();
    db.close();
  });

  it("renders a template-less card from cards.content", () => {
    const db = fixture();
    const card = loadCard(db, "c2");
    expect(card?.template).toBeNull();
    const rendered = loadRenderedCard(db, "c2", "forward");
    expect(rendered?.sides.length).toBe(2);
    expect(rendered?.source).toBe("content");
    db.close();
  });

  it("decodes the reverse permutation, and treats a malformed one as absent", () => {
    expect(decodeReversePermutation('[2,0,1]')).toEqual([2, 0, 1]);
    expect(decodeReversePermutation(null)).toBeNull();
    expect(decodeReversePermutation("")).toBeNull();
    expect(decodeReversePermutation("not json")).toBeNull();
    expect(decodeReversePermutation('{"a":1}')).toBeNull();
    expect(decodeReversePermutation('[0,"x",1]')).toBeNull();

    const db = fixture();
    expect(loadCard(db, "c1")?.template?.reversePermutation).toEqual([2, 0, 1]);
    const forward = loadRenderedCard(db, "c1", "forward");
    const reverse = loadRenderedCard(db, "c1", "reverse");
    expect(forward?.sides.length).toBe(3);
    expect(reverse?.sides.length).toBe(3);
    const draw = (sides: typeof forward): string =>
      renderSides(sides?.sides ?? [], { document: memoryDocument() })
        .sides.map((side) => serialise(side.element))
        .join("|");
    expect(draw(reverse)).not.toBe(draw(forward));
    db.close();
  });

  it("maps a track kind to a direction, and a cloze track is FORWARD", () => {
    expect(directionForTrackKind("forward")).toBe("forward");
    expect(directionForTrackKind("reverse")).toBe("reverse");
    expect(directionForTrackKind("cloze:0")).toBe("forward");
    expect(directionForTrackKind("cloze:12")).toBe("forward");
  });

  it("REFUSES to let a caller switch pendingGenerators off", () => {
    const db = fixture();
    const card = loadCard(db, "c1") as NonNullable<ReturnType<typeof loadCard>>;
    const forced = renderLoadedCard(card, "forward", {
      pendingGenerators: false,
    } as { pendingGenerators?: boolean });
    const honest = renderLoadedCard(card, "forward");
    const draw = (sides: typeof forced.sides): string =>
      renderSides(sides, { document: memoryDocument() })
        .sides.map((side) => serialise(side.element))
        .join("|");
    expect(draw(forced.sides)).toBe(draw(honest.sides));
    expect(card.values.has("f2")).toBe(false);
    expect(JSON.stringify(forced.sides)).toContain("field");
    db.close();
  });
});

describe.skipIf(!haveCorpus)("the card loader over the real collection", () => {
  it("assembles exactly what the hand-built SQL assembly does, for all 7,716", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const fields = new Map<string, { id: string; name: string; type: string }[]>();
      for (const row of db
        .prepare("SELECT template_id, id, name, type FROM template_fields ORDER BY template_id, pos, id")
        .all() as { template_id: string; id: string; name: string; type: string }[]) {
        const list = fields.get(row.template_id) ?? [];
        list.push({ id: row.id, name: row.name, type: row.type });
        fields.set(row.template_id, list);
      }
      const templates = new Map<string, TemplateInput>();
      for (const t of db
        .prepare("SELECT id, content, reverse_permutation FROM templates")
        .all() as { id: string; content: string; reverse_permutation: string | null }[]) {
        templates.set(t.id, {
          id: t.id,
          content: t.content,
          fields: fields.get(t.id) ?? [],
          reversePermutation:
            t.reverse_permutation === null ? null : (JSON.parse(t.reverse_permutation) as number[]),
        });
      }
      const cards = db.prepare("SELECT id, content, template_id FROM cards ORDER BY id").all() as {
        id: string;
        content: string;
        template_id: string | null;
      }[];
      const valuesOf = db.prepare("SELECT field_id, value FROM card_field_values WHERE card_id = ?");

      let compared = 0;
      const mismatches: string[] = [];
      for (const card of cards) {
        const loaded = loadCard(db, card.id);
        if (loaded === null) {
          mismatches.push(`${card.id}: loader returned null`);
          continue;
        }
        const expectedValues: Record<string, string> = {};
        for (const row of valuesOf.all(card.id) as { field_id: string; value: string }[]) {
          expectedValues[row.field_id] = row.value;
        }
        const expectedTemplate = card.template_id === null ? null : templates.get(card.template_id);

        if (loaded.content !== card.content) mismatches.push(`${card.id}: content`);
        if (Object.fromEntries(loaded.values) !== undefined) {
          const a = JSON.stringify(Object.fromEntries([...loaded.values].sort()));
          const b = JSON.stringify(
            Object.fromEntries(Object.entries(expectedValues).sort(([x], [y]) => (x < y ? -1 : 1))),
          );
          if (a !== b) mismatches.push(`${card.id}: values`);
        }
        if ((expectedTemplate ?? null) === null) {
          if (loaded.template !== null) mismatches.push(`${card.id}: unexpected template`);
        } else {
          const t = expectedTemplate as TemplateInput;
          if (loaded.template === null) {
            mismatches.push(`${card.id}: missing template`);
          } else {
            if (loaded.template.content !== t.content) mismatches.push(`${card.id}: template content`);
            const mine = loaded.template.fields.map((f) => `${f.id}:${f.name}:${f.type ?? ""}`);
            const theirs = (t.fields ?? []).map((f) => `${f.id}:${f.name}:${f.type ?? ""}`);
            if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
              mismatches.push(`${card.id}: fields ${JSON.stringify(mine)} vs ${JSON.stringify(theirs)}`);
            }
            if (
              JSON.stringify(loaded.template.reversePermutation) !==
              JSON.stringify(t.reversePermutation ?? null)
            ) {
              mismatches.push(`${card.id}: permutation`);
            }
          }
        }
        compared += 1;
      }
      expect(mismatches.slice(0, 5)).toEqual([]);
      expect(compared).toBe(7_716);
    } finally {
      db.close();
    }
  }, 120_000);

  it("REGENERATES the corpus speech-mount count, driven entirely through the loader", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const cards = db
        .prepare("SELECT id FROM cards WHERE template_id IS NOT NULL ORDER BY id")
        .all() as { id: string }[];

      let mounts = 0;
      let expanded = 0;
      let divergent = 0;
      const withMounts = new Set<string>();
      for (const { id } of cards) {
        const loaded = loadCard(db, id);
        if (loaded === null) continue;
        const rendered = renderLoadedCard(loaded, "forward");
        const bound = expandGeneratorFields(rendered.sides, {
          fields: loaded.template?.fields ?? [],
          values: loaded.values,
        });
        expanded += bound.expanded.length;
        divergent += bound.divergent.length;
        const out = renderSides(bound.sides, { document: memoryDocument() });
        const speech = out.generations.filter((g) => g.name === "speech").length;
        mounts += speech;
        if (speech > 0) withMounts.add(id);
      }

      // eslint-disable-next-line no-console
      console.log(
        `loader pipeline: ${mounts} speech mounts over ${withMounts.size} cards (expanded ${expanded})`,
      );
      expect({ mounts, cards: withMounts.size, expanded, divergent }).toEqual({
        mounts: 6_829,
        cards: 5_665,
        expanded: 10_697,
        divergent: 0,
      });
    } finally {
      db.close();
    }
  }, 180_000);

  it("RESOLVES the corpus audio end to end: mount → address → hash → bytes", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    const opened = openBlobStoreDatabase(defaultStoreDatabase(DB), { mustExist: true });
    try {
      const cards = db
        .prepare("SELECT id FROM cards WHERE template_id IS NOT NULL ORDER BY id LIMIT 400")
        .all() as { id: string }[];

      let mounts = 0;
      let resolvedHash = 0;
      let readBytes = 0;
      let totalBytes = 0;
      const mimes = new Map<string, number>();
      for (const { id } of cards) {
        const loaded = loadCard(db, id);
        if (loaded === null) continue;
        const rendered = renderLoadedCard(loaded, "forward");
        const bound = expandGeneratorFields(rendered.sides, {
          fields: loaded.template?.fields ?? [],
          values: loaded.values,
        });
        const out = renderSides(bound.sides, { document: memoryDocument() });
        const resolve = cardAudioResolver(db, id, { store: opened.store });
        for (const generation of out.generations) {
          if (generation.name !== "speech" || generation.request === null) continue;
          mounts += 1;
          const address = { origin: "generator", request: generation.request } as const;
          if (resolveAudioHash(db, id, address) !== null) resolvedHash += 1;
          const payload = resolve(address);
          if (payload !== null) {
            readBytes += 1;
            totalBytes += payload.bytes.length;
            mimes.set(payload.mime, (mimes.get(payload.mime) ?? 0) + 1);
          }
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `audio resolve over ${cards.length} cards: ${mounts} speech mounts · ` +
          `${resolvedHash} addressed · ${readBytes} payloads read · ` +
          `${(totalBytes / 1048576).toFixed(1)} MiB · mimes ${JSON.stringify([...mimes])}`,
      );

      expect(mounts).toBeGreaterThan(200);
      expect(resolvedHash / mounts).toBeGreaterThan(0.95);
      expect(readBytes).toBe(resolvedHash);
      expect(totalBytes).toBeGreaterThan(1_000_000);
      for (const [mime] of mimes) expect(mime.startsWith("audio/")).toBe(true);
    } finally {
      opened.close();
      db.close();
    }
  }, 240_000);

  it("returns null for a MISSING payload and RETHROWS anything else", () => {
    const db = openDatabase(MEMORY);
    db.prepare("INSERT INTO decks (id, name) VALUES ('d', 'd')").run();
    db.prepare("INSERT INTO cards (id, deck_id) VALUES ('c', 'd')").run();
    const hash = "a".repeat(64);
    db.prepare(
      "INSERT INTO blobs (hash, kind, mime, byte_size, bytes) VALUES (?, 'file', 'audio/mpeg', 3, NULL)",
    ).run(hash);
    db.prepare(
      "INSERT INTO blob_refs (blob_hash, card_id, ref_key) VALUES (?, 'c', 'x.mp3')",
    ).run(hash);
    const address = { origin: "attachment", key: "x.mp3" } as const;

    expect(cardAudioResolver(db, "c")(address)).toBeNull();

    const store = (read: () => Uint8Array): BlobStore =>
      ({
        describe: "test",
        has: () => true,
        size: () => 3,
        read,
        write: () => {
          throw new Error("not used");
        },
        remove: () => false,
        list: () => [][Symbol.iterator](),
        verify: () => true,
      }) as unknown as BlobStore;

    expect(
      cardAudioResolver(db, "c", {
        store: store(() => {
          throw new BlobMissingError(hash, "test store");
        }),
      })(address),
    ).toBeNull();

    expect(() =>
      cardAudioResolver(db, "c", {
        store: store(() => {
          throw new TypeError("the store is broken");
        }),
      })(address),
    ).toThrow(TypeError);

    const payload = cardAudioResolver(db, "c", {
      store: store(() => new Uint8Array([1, 2, 3])),
    })(address);
    expect(payload?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(payload?.mime).toBe("audio/mpeg");
    expect(payload?.hash).toBe(hash);
    db.close();
  });

  it("is assignable to the AudioResolver the renderer takes", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const resolver: AudioResolver = cardAudioResolver(db, "any-card");
      expect(typeof resolver).toBe("function");
      expect(resolver({ origin: "attachment", key: "nothing.mp3" })).toBeNull();
    } finally {
      db.close();
    }
  });

  it("addresses an attachment by CARD as well as key, and a miss is null", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const ref = db
        .prepare(
          `SELECT r.card_id AS cardId, r.ref_key AS refKey, r.blob_hash AS hash
             FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash
            WHERE b.kind = 'file' AND r.ref_key IS NOT NULL LIMIT 1`,
        )
        .get() as { cardId: string; refKey: string; hash: string } | undefined;
      expect(ref).toBeDefined();
      const found = ref as { cardId: string; refKey: string; hash: string };

      const address = { origin: "attachment", key: found.refKey } as const;
      expect(resolveAudioHash(db, found.cardId, address)).toBe(found.hash);
      const other = db
        .prepare("SELECT id FROM cards WHERE id <> ? LIMIT 1")
        .get(found.cardId) as { id: string };
      expect(resolveAudioHash(db, other.id, address)).toBeNull();
      expect(
        resolveAudioHash(db, found.cardId, { origin: "attachment", key: "nope.mp3" }),
      ).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  it("renders every card in both directions without throwing", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const cards = db.prepare("SELECT id FROM cards ORDER BY id").all() as { id: string }[];
      let rendered = 0;
      let emptyForward = 0;
      for (const { id } of cards) {
        for (const direction of ["forward", "reverse"] as const) {
          const card = loadRenderedCard(db, id, direction);
          expect(card).not.toBeNull();
          rendered += 1;
        }
        const forward = loadRenderedCard(db, id, "forward");
        if ((forward?.sides.length ?? 0) === 0) emptyForward += 1;
      }
      expect(rendered).toBe(7_716 * 2);
      // eslint-disable-next-line no-console
      console.log(`loader: ${rendered} renders, ${emptyForward} cards with no forward side at all`);
      expect(emptyForward).toBe(0);
    } finally {
      db.close();
    }
  }, 180_000);
});

describe("the card input seam", () => {
  it("carries id, content and values, and nothing else", () => {
    const db = fixture();
    const loaded = loadCard(db, "c1") as NonNullable<ReturnType<typeof loadCard>>;
    const input = cardInputFor(loaded);
    expect(Object.keys(input).sort()).toEqual(["content", "id", "values"]);
    expect(input.id).toBe("c1");
    expect(resolveCard(input, loaded.template, { pendingGenerators: true }).sides.length).toBe(3);
    expect(orderSides([], "forward", null)).toEqual([]);
    db.close();
  });
});

function linkFixture(): Db {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name) VALUES ('root', '日本語')").run();
  db.prepare("INSERT INTO decks (id, parent_id, name) VALUES ('kid', 'root', '単語')").run();
  db.prepare("INSERT INTO templates (id, name, content) VALUES ('t', '単語', '<<W>>')").run();
  const card = db.prepare(
    "INSERT INTO cards (id, deck_id, template_id, name, archived) VALUES (?, 'kid', 't', ?, ?)",
  );
  card.run("target", "人", 0);
  card.run("src-a", "一人前", 1);
  card.run("src-b", "けが人", 0);
  card.run("src-c", "主人", 0);
  const link = db.prepare(
    "INSERT INTO card_links (from_card_id, to_card_id, display_text, field_id, ordinal) VALUES (?, ?, ?, ?, ?)",
  );
  link.run("src-a", "target", "人", "f1", 0);
  link.run("src-b", "target", "人", "f1", 0);
  link.run("src-b", "target", "人", "f2", 0);
  link.run("src-c", "target", "人", null, 0);
  link.run("target", "target", "人", null, 0);
  return db;
}

describe("what links here", () => {
  it("returns one row per SOURCE CARD, however many links that card holds", () => {
    const db = linkFixture();
    const rows = backlinksOf(db, "target");
    expect(rows.map((row) => row.cardId)).toEqual(["src-b", "src-a", "src-c"]);
    db.close();
  });

  it("drops a self-link, and CANNOT be handed a dangling source", () => {
    const db = linkFixture();
    expect(backlinksOf(db, "target").map((row) => row.cardId)).not.toContain("target");
    expect(() =>
      db
        .prepare(
          "INSERT INTO card_links (from_card_id, to_card_id, display_text, ordinal) VALUES ('ghost', 'target', '人', 9)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("SHOWS an archived source and marks it, rather than hiding it", () => {
    const db = linkFixture();
    const rows = backlinksOf(db, "target");
    expect(rows.find((row) => row.cardId === "src-a")?.archived).toBe(true);
    expect(rows.find((row) => row.cardId === "src-c")?.archived).toBe(false);
    db.close();
  });

  it("carries the SOURCE card's name and deck path, not the link's display text", () => {
    const db = linkFixture();
    const row = backlinksOf(db, "target").find((r) => r.cardId === "src-c");
    expect(row?.name).toBe("主人");
    expect(row?.deckPath).toBe("日本語/単語");
    db.close();
  });

  it("answers a card nothing points at with an empty list, not a null", () => {
    const db = linkFixture();
    expect(backlinksOf(db, "src-a")).toEqual([]);
    expect(backlinksOf(db, "no-such-card")).toEqual([]);
    db.close();
  });

  it("indexes links written after the import — 濃紺 → 紺, 2026-10-26", () => {
    const db = linkFixture();
    const value = db.prepare(
      "INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?) ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value",
    );
    value.run("src-a", "f1", "一[[人|target]]前");
    value.run("src-b", "f1", "けが[[人|target]]");
    value.run("src-b", "f2", "[[人|target]]");
    value.run("target", "f1", "no links here");
    expect(reconcileCardLinks(db)).toEqual({ cards: 0, rows: 0 });

    db.prepare("INSERT INTO cards (id, deck_id, template_id, name, archived) VALUES ('app', 'kid', 't', '人間', 0)").run();
    value.run("app", "f1", "[[人|target]]間");
    expect(backlinksOf(db, "target").map((r) => r.cardId)).not.toContain("app");
    expect(reconcileCardLinks(db)).toEqual({ cards: 1, rows: 1 });
    expect(backlinksOf(db, "target").map((r) => r.cardId)).toContain("app");
    expect(reconcileCardLinks(db)).toEqual({ cards: 0, rows: 0 });

    value.run("src-b", "f2", "plain now");
    expect(reconcileCardLinks(db)).toEqual({ cards: 1, rows: 1 });
    expect(
      db.prepare("SELECT field_id FROM card_links WHERE from_card_id = 'src-b' ORDER BY field_id").all(),
    ).toEqual([{ field_id: "f1" }]);

    expect(backlinksOf(db, "target").map((r) => r.cardId)).toContain("src-c");
    db.close();
  });
});

describe.skipIf(!haveCorpus)("what links here, over the real collection", () => {
  it("agrees with card_links row by row, and dedupes exactly where it should", () => {
    const db = openDatabase(DB, { readOnly: true });
    try {
      const targets = db
        .prepare(
          `SELECT l.to_card_id AS id, count(*) AS rows,
                  count(DISTINCT l.from_card_id) AS sources
             FROM card_links l JOIN cards c ON c.id = l.to_card_id
            GROUP BY l.to_card_id`,
        )
        .all() as readonly { id: string; rows: number; sources: number }[];
      expect(targets.length).toBeGreaterThan(2_800);

      let deduped = 0;
      let archived = 0;
      let widest = { id: "", n: 0 };
      for (const target of targets) {
        const rows = backlinksOf(db, target.id);
        expect(new Set(rows.map((row) => row.cardId)).size).toBe(rows.length);
        expect(rows.length).toBeLessThanOrEqual(target.sources);
        if (rows.length < target.rows) deduped += 1;
        if (rows.length > widest.n) widest = { id: target.id, n: rows.length };
        archived += rows.filter((row) => row.archived).length;
        for (const row of rows) {
          expect(row.cardId).not.toBe(target.id);
          expect(row.deckPath).not.toBe("");
        }
      }
      expect(deduped).toBeGreaterThan(0);
      expect(archived).toBe(264);
      expect(widest.n).toBe(37);
    } finally {
      db.close();
    }
  }, 120_000);

  it("is fast enough to ask on the heaviest card in the corpus", () => {
    const db = openDatabase(DB, { readOnly: true });
    try {
      const worst = db
        .prepare(
          `SELECT to_card_id AS id FROM card_links
            GROUP BY to_card_id ORDER BY count(*) DESC LIMIT 1`,
        )
        .get() as { id: string };
      const started = performance.now();
      for (let i = 0; i < 100; i += 1) backlinksOf(db, worst.id);
      const each = (performance.now() - started) / 100;
      expect(each).toBeLessThan(20);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!haveCorpus)("a bare wiki-link renders the target's name", () => {
  it("names the card on his screen — 施, where one link is bare and one is not", () => {
    const db = openDatabase(DB, { readOnly: true });
    try {
      const prepared = prepareCard({ db, cardId: "knvtZ4cA", direction: "forward" });
      expect(prepared).not.toBeNull();
      expect(prepared?.linkNames["tKEAH1CO"]).toBe("bestow");

      const out = renderSides(prepared!.sides, {
        document: memoryDocument(),
        resolveCardLink: (id) => {
          const name = prepared!.linkNames[id];
          return name === undefined ? {} : { name };
        },
      });
      const html = out.sides.map((side) => serialise(side.element)).join(" ");
      expect(html).toContain(">bestow<");
      expect(html).not.toContain(">tKEAH1CO<");
      expect(html).toContain(">alms<");
    } finally {
      db.close();
    }
  });

  it("names every bare link that actually reaches a side, over the whole corpus", () => {
    const db = openDatabase(DB, { readOnly: true });
    try {
      const values = db
        .prepare("SELECT DISTINCT card_id, value FROM card_field_values WHERE value LIKE '%[[%'")
        .all() as readonly { card_id: string; value: string }[];
      const cards = [
        ...new Set(
          values
            .filter((row) => /\[\[[^\]|]+\]\]/.test(String(row.value)))
            .map((row) => row.card_id),
        ),
      ].map((card_id) => ({ card_id }));
      expect(cards.length).toBeGreaterThan(20);

      let named = 0;
      let unrendered = 0;
      for (const { card_id: cardId } of cards) {
        const prepared = prepareCard({ db, cardId, direction: "forward" });
        if (prepared === null) continue;
        const bare = linkTargetsOf(prepared.sides).filter((id) => {
          let isBare = false;
          walkSides(prepared.sides, (node) => {
            if (node.kind !== "wikiLink" || node.target !== id) return;
            if (node.display === null || node.display === "") isBare = true;
          });
          return isBare;
        });
        for (const id of bare) {
          const row = db.prepare("SELECT name FROM cards WHERE id = ?").get(id) as
            | { name: string }
            | undefined;
          if (row === undefined) {
            unrendered += 1;
            continue;
          }
          expect(prepared.linkNames[id], `${cardId} -> ${id}`).toBe(row.name);
          named += 1;
        }
      }
      expect(named).toBeGreaterThanOrEqual(25);
      expect(unrendered).toBe(0);
    } finally {
      db.close();
    }
  });

  it("leaves a DEAD target exactly as it renders today — brackets are a regression", () => {
    const out = renderSides(
      [
        side(0, [
          {
            kind: "paragraph",
            children: [
              { kind: "wikiLink", display: "alms", target: "deadCard" },
              { kind: "text", text: " / " },
              { kind: "wikiLink", display: null, target: "alsoDead" },
            ],
          },
        ]),
      ],
      { document: memoryDocument(), resolveCardLink: () => ({}) },
    );
    const html = out.sides.map((rendered) => serialise(rendered.element)).join(" ");
    expect(html).toContain(">alms<");
    expect(html).not.toContain("[[");
    expect(html).toContain(">alsoDead<");
  });
});
