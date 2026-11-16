import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/index.js";
import { importExports, readSource } from "../src/import/index.js";
import {
  resolveReverseInheritance,
  type ReverseInheritance,
} from "../src/schema/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const EXPORT_DIRS = ["日本語", "English", "基本情報"].map((n) => join(ROOT, "exports", n));
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

function nodes(...rows: readonly [string, string | null, "inherit" | "on" | "off"][]) {
  const map = new Map<string, ReverseInheritance>();
  for (const [id, parentId, reverse] of rows) map.set(id, { id, parentId, reverse });
  return map;
}

describe("resolveReverseInheritance", () => {
  it("takes the NEAREST explicit ancestor, whichever way it points", () => {
    const tree = nodes(["root", null, "on"], ["mid", "root", "off"], ["leaf", "mid", "inherit"]);
    expect(resolveReverseInheritance(tree, "leaf")).toBe("off");
    expect(resolveReverseInheritance(tree, "mid")).toBe("off");
    expect(resolveReverseInheritance(tree, "root")).toBe("on");
  });

  it("keeps looking while every ancestor says inherit", () => {
    const tree = nodes(["root", null, "on"], ["mid", "root", "inherit"], ["leaf", "mid", "inherit"]);
    expect(resolveReverseInheritance(tree, "leaf")).toBe("on");
  });

  it("bottoms out at the fallback when nothing is explicit", () => {
    const tree = nodes(["root", null, "inherit"], ["leaf", "root", "inherit"]);
    expect(resolveReverseInheritance(tree, "leaf")).toBe("off");
    expect(resolveReverseInheritance(tree, "leaf", "on")).toBe("on");
  });

  it("is cycle-safe, because malformed exports have produced exactly that", () => {
    const cyclic = nodes(["a", "b", "inherit"], ["b", "a", "inherit"]);
    expect(resolveReverseInheritance(cyclic, "a")).toBe("off");
    expect(resolveReverseInheritance(cyclic, "a", "on")).toBe("on");
  });

  it("answers the fallback for a deck it has never heard of, and for null", () => {
    const tree = nodes(["root", null, "on"]);
    expect(resolveReverseInheritance(tree, "missing")).toBe("off");
    expect(resolveReverseInheritance(tree, null)).toBe("off");
    expect(resolveReverseInheritance(tree, undefined)).toBe("off");
  });

  it("stops at a parent that is not in the map rather than throwing", () => {
    const orphan = nodes(["leaf", "gone", "inherit"]);
    expect(resolveReverseInheritance(orphan, "leaf", "on")).toBe("on");
  });
});

describe.skipIf(!HAVE_EXPORTS)("the TypeScript rule and the SQL view agree", () => {
  it("gives the same answer as `deck_reverse_resolved` for every deck", () => {
    const db = openDatabase(":memory:");
    importExports(db, EXPORT_DIRS.map(readSource), { blobs: false });

    const decks = db.prepare("SELECT id, parent_id, reverse FROM decks").all() as {
      id: string;
      parent_id: string | null;
      reverse: "inherit" | "on" | "off";
    }[];
    const fallback =
      ((db.prepare("SELECT value FROM settings WHERE key = 'reverse.default'").get() as
        | { value: string }
        | undefined)?.value as "on" | "off" | undefined) ?? "off";

    const map = new Map<string, ReverseInheritance>();
    for (const d of decks) map.set(d.id, { id: d.id, parentId: d.parent_id, reverse: d.reverse });

    const fromSql = db.prepare("SELECT deck_id, reverse FROM deck_reverse_resolved").all() as {
      deck_id: string;
      reverse: "on" | "off";
    }[];
    expect(fromSql.length, "the corpus must actually have decks").toBeGreaterThan(30);

    const disagreements: string[] = [];
    for (const row of fromSql) {
      const ts = resolveReverseInheritance(map, row.deck_id, fallback);
      if (ts !== row.reverse) disagreements.push(`${row.deck_id}: SQL ${row.reverse}, TS ${ts}`);
    }
    expect(disagreements, `the view and the function disagree:\n  ${disagreements.join("\n  ")}`)
      .toEqual([]);
    db.close();
  });

  it("agrees per CARD too, which is where the track count comes from", () => {
    const db = openDatabase(":memory:");
    importExports(db, EXPORT_DIRS.map(readSource), { blobs: false });

    const decks = db.prepare("SELECT id, parent_id, reverse FROM decks").all() as {
      id: string;
      parent_id: string | null;
      reverse: "inherit" | "on" | "off";
    }[];
    const map = new Map<string, ReverseInheritance>();
    for (const d of decks) map.set(d.id, { id: d.id, parentId: d.parent_id, reverse: d.reverse });
    const fallback =
      ((db.prepare("SELECT value FROM settings WHERE key = 'reverse.default'").get() as
        | { value: string }
        | undefined)?.value as "on" | "off" | undefined) ?? "off";

    const cards = db
      .prepare("SELECT id, deck_id, reverse FROM cards")
      .all() as { id: string; deck_id: string; reverse: "inherit" | "on" | "off" }[];
    const fromSql = new Map(
      (
        db.prepare("SELECT card_id, reverse FROM card_reverse_resolved").all() as {
          card_id: string;
          reverse: "on" | "off";
        }[]
      ).map((r) => [r.card_id, r.reverse]),
    );

    let checked = 0;
    const disagreements: string[] = [];
    for (const card of cards) {
      const ts =
        card.reverse !== "inherit"
          ? card.reverse
          : resolveReverseInheritance(map, card.deck_id, fallback);
      if (fromSql.get(card.id) !== ts) {
        disagreements.push(`${card.id}: SQL ${fromSql.get(card.id)}, TS ${ts}`);
      }
      checked += 1;
    }
    expect(checked).toBe(7716);
    expect(disagreements.slice(0, 10), `${disagreements.length} cards disagree`).toEqual([]);

    const on = [...fromSql.values()].filter((r) => r === "on").length;
    expect(on).toBe(5677);
    db.close();
  });
});
