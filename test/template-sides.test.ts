import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { promptDependencies, sideIndex, sidesReferencing } from "../src/template/index.js";

const CORPUS = "build/hashigo.db";

function corpus(): Database.Database | null {
  try {
    return new Database(CORPUS, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function body(db: Database.Database, name: string): string {
  return (db.prepare("SELECT content FROM templates WHERE name = ?").get(name) as {
    content: string;
  }).content;
}

describe("which side a field is on", () => {
  it("counts sides from 1, and reports each side once however many markers it holds", () => {
    const source = "<<A>>\n---\n<<B>> and <<B>> again\n---\n<<A>>";
    expect(sidesReferencing(source, "A")).toEqual([1, 3]);
    expect(sidesReferencing(source, "B")).toEqual([2]);
  });

  it("answers EMPTY for a field the body never names", () => {
    expect(sidesReferencing("<<A>>\n---\n<<B>>", "かな主流")).toEqual([]);
    expect(sidesReferencing("", "A")).toEqual([]);
    expect(sidesReferencing("<<A>>", "  ")).toEqual([]);
  });

  it("matches the NAME and not the text — 型 is a field AND an ordinary word", () => {
    const source = "この語の型は平板です。\n---\n<<型>> と <<型番>>";
    expect(sidesReferencing(source, "型")).toEqual([2]);
    expect(sidesReferencing(source, "型番")).toEqual([2]);
  });

  it("finds a field behind every sigil, because a gate is a reference too", () => {
    expect(sidesReferencing("<<#Reading>>x<</Reading>>\n---\n<< Reading >>", "Reading")).toEqual([
      1, 2,
    ]);
  });

  it("does NOT treat a `---` inside a marker as a side break", () => {
    expect(sidesReferencing("<<A\n---\n>>", "A\n---")).toEqual([1]);
  });

  it("builds the whole index in one pass, agreeing with the per-field answer", () => {
    const source = "<<A>>\n---\n<<B>> <<A>>\n---\n<<C>>";
    const index = sideIndex(source);
    expect(index.get("A")).toEqual([1, 2]);
    expect(index.get("B")).toEqual([2]);
    expect(index.get("C")).toEqual([3]);
    for (const name of ["A", "B", "C"]) {
      expect(index.get(name)).toEqual(sidesReferencing(source, name));
    }
  });
});

describe("an ai field's prompt is a dependency nothing recorded", () => {
  it("names the fields a prompt interpolates, in order, without repeats", () => {
    expect(promptDependencies("Example sentence using <<単語>> in Japanese")).toEqual(["単語"]);
    expect(promptDependencies("<<A>> then <<B>> then <<A>>")).toEqual(["A", "B"]);
    expect(promptDependencies("no markers here")).toEqual([]);
  });

  it("tolerates Polysemy's spaces, which are really in the corpus", () => {
    expect(promptDependencies("Funny sentence using << 言葉 >> in Japanese")).toEqual(["言葉"]);
  });
});

describe("against the real templates", () => {
  it("puts 単語's fields on the sides the template actually declares", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const source = body(db, "単語");
      expect(sidesReferencing(source, "Reading")).toContain(1);
      expect(sidesReferencing(source, "型")).toEqual([2]);
      const index = sideIndex(source);
      for (const [name, sides] of index) {
        expect(sides.length, `${name} indexed with no side`).toBeGreaterThan(0);
        expect(sidesReferencing(source, name)).toEqual(sides);
      }
    } finally {
      db.close();
    }
  });

  it("finds 例文's prompt dependency on 単語, which no column records", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const row = db
        .prepare(
          `SELECT f.options AS options FROM template_fields f
             JOIN templates t ON t.id = f.template_id
            WHERE t.name = '単語' AND f.name = '例文'`,
        )
        .get() as { options: string } | undefined;
      expect(row, "単語 has no 例文 field").toBeDefined();
      const prompt = String(
        (JSON.parse(row?.options ?? "{}") as Record<string, unknown>)["ai-custom-prompt"] ?? "",
      );
      expect(promptDependencies(prompt)).toEqual(["単語"]);
      const source = db
        .prepare(
          `SELECT f.source_field_id AS source FROM template_fields f
             JOIN templates t ON t.id = f.template_id
            WHERE t.name = '単語' AND f.name = '例文'`,
        )
        .get() as { source: string | null };
      expect(source.source).toBeNull();
    } finally {
      db.close();
    }
  });

  it("names a side for every field of every template, or says none deliberately", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const templates = db.prepare("SELECT id, name, content FROM templates").all() as {
        id: string;
        name: string;
        content: string;
      }[];
      const unreferenced: string[] = [];
      for (const template of templates) {
        const fields = db
          .prepare("SELECT name FROM template_fields WHERE template_id = ?")
          .all(template.id) as { name: string }[];
        for (const field of fields) {
          if (sidesReferencing(template.content, field.name).length === 0) {
            unreferenced.push(`${template.name}.${field.name}`);
          }
        }
      }
      expect(unreferenced.sort()).toEqual(
        [
          "単語.OJAD",
          "単語.読み",
          "敬語.Kanji",
          "文法.Speech",
          "言葉.OJAD",
          "言葉.かな主流",
          "言葉.読み",
        ].sort(),
      );
    } finally {
      db.close();
    }
  });
});
