/**
 * Renaming a field is a body edit. These tests exist because the failure mode is
 * SILENT: an unresolved `<<X>>` is not an exception, it is an empty string.
 *
 * The real 単語 body is the fixture wherever one is needed, because the shapes that
 * break a naive replace are all in it at once — `<<Kanji>>` and `<< Kanji >>` in one
 * file, `<< #Reading>>` against `<< /Reading >>`, a marker inside a URL, and a
 * marker as a bare HTML attribute value.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  countReferences,
  referencedNames,
  renameFieldEverywhere,
  renameFieldInSource,
} from "../src/template/index.js";
import { moveWithin, positionKeys } from "../src/schema/index.js";

const CORPUS = "build/hashigo.db";

function corpus(): Database.Database | null {
  try {
    return new Database(CORPUS, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

describe("renaming a field rewrites its references", () => {
  it("keeps each token's own sigil and spacing", () => {
    // Every spacing style the corpus actually uses, in one string.
    const body = "<<Reading>> << Reading >> <<#Reading>> << #Reading>> <</Reading>> << /Reading >>";
    expect(renameFieldInSource(body, "Reading", "読み")).toBe(
      "<<読み>> << 読み >> <<#読み>> << #読み>> <</読み>> << /読み >>",
    );
  });

  it("MATCHES THE NAME, NOT THE TEXT — a field can be called 型, and 型 occurs in prose", () => {
    // The reason this is not `body.replaceAll(from, to)`. `型` is a real field name
    // (decision 20) and an ordinary word; `a` would be worse.
    const body = "この語の型は平板です。<<型>> と <<型番>> は別のフィールド。";
    expect(renameFieldInSource(body, "型", "アクセント")).toBe(
      "この語の型は平板です。<<アクセント>> と <<型番>> は別のフィールド。",
    );
  });

  it("leaves a field whose name merely PREFIXES another alone", () => {
    expect(renameFieldInSource("<<Read>> <<Reading>>", "Read", "R")).toBe("<<R>> <<Reading>>");
  });

  it("rewrites generator PROMPTS too — schema.sql says 例文's only dependency is in one", () => {
    const options = [
      { fieldId: "ai-1", options: '{"ai-custom-prompt":"Example sentence using <<単語>>"}' },
      { fieldId: "sp-1", options: '{"voice":"ja-JP-Neural2-C"}' },
    ];
    const result = renameFieldEverywhere("<<単語>> の意味", options, "単語", "見出し語");
    expect(result.body).toBe("<<見出し語>> の意味");
    // Only the option that actually referenced it comes back — an untouched row
    // must not be rewritten, or every rename dirties every field.
    expect(result.options).toEqual([
      { fieldId: "ai-1", options: '{"ai-custom-prompt":"Example sentence using <<見出し語>>"}' },
    ]);
    expect(result.rewrites).toBe(2);
  });

  it("counts zero when nothing references the field, so a caller can say so", () => {
    expect(countReferences("<<Other>>", "Reading")).toBe(0);
    expect(renameFieldEverywhere("<<Other>>", [], "Reading", "読み").rewrites).toBe(0);
  });

  it("names every field the REAL 単語 body references", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const body = (
        db.prepare("SELECT content FROM templates WHERE name = '単語'").get() as {
          content: string;
        }
      ).content;
      const names = referencedNames(body);
      // Decision 29's gate and decision 20's label are both in here. If either
      // stopped being a reference, this file's whole premise would be wrong.
      expect(names.has("Reading")).toBe(true);
      expect(names.has("型")).toBe(true);
      expect(names.has("単語")).toBe(true);

      // The round trip over the real body: rename, rename back, byte-identical.
      // This is the property that makes the rewrite safe to run on his templates —
      // it proves the rewrite is not normalising spacing behind his back.
      const once = renameFieldInSource(body, "Reading", "ReadingTemporary");
      expect(once).not.toBe(body);
      expect(renameFieldInSource(once, "ReadingTemporary", "Reading")).toBe(body);
    } finally {
      db.close();
    }
  });

  it("EVERY template round-trips through a rename of every field it declares", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const templates = db
        .prepare("SELECT id, name, content FROM templates")
        .all() as { id: string; name: string; content: string }[];
      const fields = db
        .prepare("SELECT template_id, name FROM template_fields")
        .all() as { template_id: string; name: string }[];
      let renamed = 0;
      for (const template of templates) {
        for (const field of fields.filter((f) => f.template_id === template.id)) {
          const away = renameFieldInSource(template.content, field.name, "TEMP");
          expect(
            renameFieldInSource(away, "TEMP", field.name),
            `${template.name}.${field.name}`,
          ).toBe(template.content);
          if (away !== template.content) renamed += 1;
        }
      }
      // Not all 49 fields are referenced by their own body; the point is that the
      // ones that are came back byte-identical.
      expect(renamed).toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(`rename round trip: ${renamed} field(s) actually appear in a body`);
    } finally {
      db.close();
    }
  });
});

describe("position keys", () => {
  it("are ascending and fixed width", () => {
    expect(positionKeys(0)).toEqual([]);
    expect(positionKeys(3)).toEqual(["a", "b", "c"]);
    expect(positionKeys(26).at(-1)).toBe("z");
  });

  it("STAY IN ORDER PAST 26, which variable width does not", () => {
    // The whole reason for fixed width. `ORDER BY pos` is lexicographic, and with
    // variable width "aa" sorts before "b", so field 27 would jump to position 2.
    const keys = positionKeys(30);
    expect(keys[0]).toBe("aa");
    expect(keys[26]).toBe("ba");
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("holds ascending for a size well past anything a template has", () => {
    const keys = positionKeys(700);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(700);
    expect(keys.every((key) => key.length === keys[0]!.length)).toBe(true);
  });

  it("moveWithin puts an id in front of another, or at the end", () => {
    const order = ["a", "b", "c", "d"];
    expect(moveWithin(order, "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveWithin(order, "a", null)).toEqual(["b", "c", "d", "a"]);
    // A no-op move returns the same order rather than writing — otherwise every
    // drag that lands where it started fills the undo stack with nothing.
    expect(moveWithin(order, "a", "b")).toEqual(order);
    expect(moveWithin(order, "zz", "b")).toEqual(order);
  });
});
