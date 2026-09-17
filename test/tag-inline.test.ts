import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  parseFieldValue,
  parseTemplate,
  startsTag,
  tagEnd,
  type Block,
  type Inline,
} from "../src/template/index.js";
import { stripInvisible } from "../src/text/index.js";

/**
 * `#Mathematics` STOPS BEING INERT TEXT.
 *
 * Zach, 2026-09-18: *"i want the tag to behave like hyperlink too, but looks
 * different than like hyperlink"*.
 *
 * The tag was always in two places: `card_tags` holds it as data, and Mochi ALSO
 * wrote the literal `#Mathematics` into the field — 約数's 意味 really is
 * `divisor; factor; measure #Mathematics`. Only the first half was reachable.
 *
 * THE GRAMMAR IS GENEROUS AND THE RESOLVER IS THE GUARD, which is `wikiLink`'s
 * shape and SPEC's rule: an unresolved link renders as plain text rather than
 * being dropped. A parser cannot see the tag table, so it must not be the thing
 * that decides.
 */

const CORPUS = "build/hashigo.db";

function corpus(): Database.Database | null {
  try {
    return new Database(CORPUS, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

/** Every inline node under these blocks, depth first — nested children too. */
function inlines(blocks: readonly Block[]): Inline[] {
  const out: Inline[] = [];
  const visit = (nodes: readonly unknown[]): void => {
    for (const node of nodes) {
      const record = node as { kind?: string; children?: readonly unknown[]; items?: readonly unknown[] };
      if (typeof record.kind === "string") out.push(node as Inline);
      if (record.children !== undefined) visit(record.children);
      if (record.items !== undefined) visit(record.items);
    }
  };
  visit(blocks);
  return out;
}

/** Tags in a FIELD VALUE — the place every `#` in the corpus actually lives. */
function tagsIn(value: string): { path: string; source: string }[] {
  return inlines(parseFieldValue(value))
    .filter((node): node is Inline & { kind: "tag" } => node.kind === "tag")
    .map((node) => ({ path: node.path, source: node.source }));
}

/** Tags in a TEMPLATE BODY, where the `#`s are sigils and headings instead. */
function tagsInTemplate(body: string): { path: string; source: string }[] {
  const blocks = parseTemplate(body).flatMap((side) => [...side.blocks]);
  return inlines(blocks)
    .filter((node): node is Inline & { kind: "tag" } => node.kind === "tag")
    .map((node) => ({ path: node.path, source: node.source }));
}

describe("the grammar", () => {
  it("takes a plain tag at a boundary", () => {
    expect(tagsIn("divisor; factor; measure #Mathematics")).toEqual([
      { path: "Mathematics", source: "#Mathematics" },
    ]);
  });

  it("takes the joiners the corpus actually uses", () => {
    expect(tagsIn("#Dialect/Kansai and #Stock-market")).toEqual([
      { path: "Dialect/Kansai", source: "#Dialect/Kansai" },
      { path: "Stock-market", source: "#Stock-market" },
    ]);
  });

  it("takes a tag in any script — 四字熟語 is one", () => {
    expect(tagsIn("#四字熟語")).toEqual([{ path: "四字熟語", source: "#四字熟語" }]);
  });

  it("STRIPS the zero-width space, which 11 of the corpus's 49 carry", () => {
    // `src/import/tags.ts` had to repair exactly this on the way in, where
    // `Mathematics` and `<ZWSP>Mathematics` read as two tags nobody could tell
    // apart. Refusing them here would leave those 11 inert for the same reason.
    const [tag] = tagsIn("syntax #​Computing");
    expect(tag?.path).toBe("Computing");
    // The SOURCE keeps it, because the unresolved case must render what he wrote.
    expect(tag?.source).toBe("#​Computing");
  });

  it("does NOT take a `#` glued to the end of a word — C# is a word", () => {
    expect(tagsIn("I write C# and F#")).toEqual([]);
    expect(startsTag("C#", 1)).toBe(false);
    expect(startsTag(" #x", 1)).toBe(true);
    expect(startsTag("#x", 0)).toBe(true);
  });

  it("does NOT take a bare `#`, which is how every ATX heading starts", () => {
    expect(tagsIn("# Heading\n\ntext")).toEqual([]);
    expect(tagEnd("# x", 1)).toBe(1);
  });

  it("stops at a joiner rather than ending on one — `#Dialect/` resolves Dialect", () => {
    expect(tagsIn("see #Dialect/ here")).toEqual([{ path: "Dialect", source: "#Dialect" }]);
  });

  it("stops at punctuation and whitespace", () => {
    expect(tagsIn("#Law, and #Logic.")).toEqual([
      { path: "Law", source: "#Law" },
      { path: "Logic", source: "#Logic" },
    ]);
  });

  it("leaves a code span alone — code is scanned before this", () => {
    expect(tagsIn("`#Mathematics`")).toEqual([]);
  });

  it("leaves an escaped hash alone", () => {
    expect(tagsIn("\\#Mathematics")).toEqual([]);
  });

  it("does not eat a URL fragment's meaning — it just parses and fails to resolve", () => {
    // The node is made; the RENDERER refuses it and prints the text back. This
    // test pins the parse so the renderer test can pin the refusal.
    expect(tagsIn("https://x.com/#section")).toEqual([
      { path: "section", source: "#section" },
    ]);
  });
});

describe("against every `#` in the real corpus", () => {
  it("parses all 49 of them, and every one is a known tag", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const known = new Set(
        (db.prepare("SELECT path FROM tags").all() as { path: string }[]).map((r) => r.path),
      );
      const values = db
        .prepare("SELECT value FROM card_field_values WHERE value LIKE '%#%'")
        .all() as { value: string }[];
      expect(values.length).toBe(44);

      let parsed = 0;
      const unknown: string[] = [];
      for (const row of values) {
        for (const tag of tagsIn(row.value)) {
          parsed += 1;
          if (!known.has(tag.path)) unknown.push(tag.path);
        }
      }
      // 49 `#` tokens, all tags. If a later import brings a `C#` or a colour
      // literal into a field VALUE, this is where it shows up — as a name that
      // resolves to nothing, which the renderer then prints as plain text.
      expect(parsed).toBe(49);
      expect(unknown).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("finds no tag in any template BODY — the `#`s there are sigils and headings", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const bodies = db.prepare("SELECT name, content FROM templates").all() as {
        name: string;
        content: string;
      }[];
      const found: string[] = [];
      for (const body of bodies) {
        for (const tag of tagsInTemplate(body.content)) found.push(`${body.name}:${tag.path}`);
      }
      // `<<#Reading>>` is masked to a private-use marker before inline runs, and
      // `#FF0000` lives inside a 漢字 ATTRIBUTE, which the markup parser takes
      // first. Both would be silent damage if this were ever untrue.
      expect(found).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("every parsed path survives being stripped again — it is already clean", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const values = db
        .prepare("SELECT value FROM card_field_values WHERE value LIKE '%#%'")
        .all() as { value: string }[];
      for (const row of values) {
        for (const tag of tagsIn(row.value)) expect(stripInvisible(tag.path)).toBe(tag.path);
      }
    } finally {
      db.close();
    }
  });
});
