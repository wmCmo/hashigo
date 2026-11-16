import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  AUTHORABLE_TYPES,
  effectiveRole,
  fieldKind,
  FIELD_KINDS,
  GENERATABLE_TYPES,
  keyedByGenerate,
  kindOf,
  LOCAL_OPTION_PREFIX,
  MOCHI_NON_KEY_OPTIONS,
  NON_KEY_OPTIONS,
  ROLE_KEY,
  fieldWithRole,
  roleOf,
  settingsOf,
  withRole,
} from "../src/fields/index.js";
import { FIELD_TYPES, FIELD_TYPE_BLOB_KIND, GENERATOR_FIELD_TYPES } from "../src/schema/index.js";
import { decodeFieldOptions } from "../src/cards/index.js";
import { yomiFieldId } from "../src/fields/yomi.js";

const CORPUS = "build/hashigo.db";

function corpus(): Database.Database | null {
  try {
    return new Database(CORPUS, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

describe("the registry agrees with the schema", () => {
  it("declares every field type, and invents none", () => {
    expect(Object.keys(FIELD_KINDS).sort()).toEqual([...FIELD_TYPES].sort());
  });

  it("carries each type's own name, so a lookup cannot be off by one key", () => {
    for (const type of FIELD_TYPES) expect(FIELD_KINDS[type].type).toBe(type);
  });

  it("reads blob kinds from FIELD_TYPE_BLOB_KIND rather than restating them", () => {
    for (const type of FIELD_TYPES) {
      expect(FIELD_KINDS[type].blobKind).toBe(FIELD_TYPE_BLOB_KIND[type] ?? null);
    }
    const generating = FIELD_TYPES.filter((type) => FIELD_KINDS[type].blobKind !== null);
    expect(new Set(generating)).toEqual(new Set(GENERATOR_FIELD_TYPES));
  });

  it("only a generating kind may be generatable", () => {
    for (const type of GENERATABLE_TYPES) expect(FIELD_KINDS[type].blobKind).not.toBeNull();
  });

  it("has none of Mochi's four unused types (deleted 2026-11-05)", () => {
    for (const gone of ["text", "furigana", "dictionary", "image-search"]) {
      expect((FIELD_TYPES as readonly string[]).includes(gone), gone).toBe(false);
      expect(kindOf(gone), gone).toBeNull();
    }
  });

  it("offers only authorable types to the add-field form, and no generator", () => {
    expect([...AUTHORABLE_TYPES]).toEqual(["plain", "boolean", "number", "accent"]);
    for (const type of AUTHORABLE_TYPES) expect(FIELD_KINDS[type].blobKind).toBeNull();
  });

  it("converts only to a declared type, and never to itself", () => {
    for (const type of FIELD_TYPES) {
      for (const target of Object.keys(FIELD_KINDS[type].convertsTo)) {
        expect(FIELD_TYPES).toContain(target);
        expect(target).not.toBe(type);
      }
    }
  });
});

describe("the registry agrees with what actually decides the cache key", () => {
  it("says `own` for exactly the keys a generation is addressed by", () => {
    const OWN_SLOT: ReadonlySet<string> = new Set(["voice", "lang"]);
    for (const type of FIELD_TYPES) {
      if (FIELD_KINDS[type].blobKind === null) continue;
      for (const spec of FIELD_KINDS[type].settings) {
        const addressedBy = OWN_SLOT.has(spec.key) || keyedByGenerate(spec.key);
        expect(
          spec.identity === "own",
          `${type}.${spec.key} claims identity "${spec.identity}"`,
        ).toBe(addressedBy);
      }
    }
  });

  it("proves the two halves of that rule are really different", () => {
    expect(keyedByGenerate("voice")).toBe(false);
    expect(keyedByGenerate("gender")).toBe(true);
    const speech = new Map(settingsOf("speech").map((spec) => [spec.key, spec]));
    expect(speech.get("voice")?.identity).toBe("own");
    expect(speech.get("gender")?.identity).toBe("own");
  });

  it("never claims `own` on a kind that generates nothing", () => {
    for (const type of FIELD_TYPES) {
      if (FIELD_KINDS[type].blobKind !== null) continue;
      for (const spec of FIELD_KINDS[type].settings) {
        expect(spec.identity, `${type}.${spec.key}`).not.toBe("own");
      }
    }
    expect(settingsOf("number")[0]?.identity).toBe("downstream");
    expect(settingsOf("boolean")[0]?.identity).toBe("none");
  });

  it("keeps every `hashigo-` key out of the key, by RULE and not by listing", () => {
    expect(NON_KEY_OPTIONS.has(ROLE_KEY)).toBe(true);
    expect(NON_KEY_OPTIONS.has(`${LOCAL_OPTION_PREFIX}not-invented-yet`)).toBe(true);
    expect(keyedByGenerate(ROLE_KEY)).toBe(false);
  });

  it("still excludes exactly Mochi's four, so nothing widened by accident", () => {
    expect([...MOCHI_NON_KEY_OPTIONS].sort()).toEqual(
      ["ai-custom-prompt", "lang", "randomize", "voice"].sort(),
    );
    for (const key of MOCHI_NON_KEY_OPTIONS) expect(NON_KEY_OPTIONS.has(key)).toBe(true);
    expect(NON_KEY_OPTIONS.has("gender")).toBe(false);
    expect(keyedByGenerate("gender")).toBe(true);
  });

  it("never offers an editable control for a key that is history", () => {
    const readOnly = ["lang", "gender", "language", "randomize"];
    for (const type of FIELD_TYPES) {
      for (const spec of FIELD_KINDS[type].settings) {
        if (readOnly.includes(spec.key)) expect(spec.editable).toBe(false);
      }
    }
  });

  it("gives every setting a fallback that is ABSENCE, never a materialised value", () => {
    for (const spec of [...settingsOf("translate"), ...settingsOf("speech")]) {
      expect(spec.fallback, `${spec.key} would be materialised`).toBeNull();
    }
  });

  it("explains itself — every setting carries a note", () => {
    for (const type of FIELD_TYPES) {
      for (const spec of FIELD_KINDS[type].settings) {
        expect(spec.note.length, `${type}.${spec.key}`).toBeGreaterThan(20);
      }
    }
  });
});

describe("roles bind behaviour to data instead of to a name", () => {
  const ojad = { options: { [ROLE_KEY]: "ojad" } };
  const plain = { options: {} };

  it("finds a field by role and ignores one that declares none", () => {
    expect(roleOf(ojad)).toBe("ojad");
    expect(roleOf(plain)).toBeNull();
    expect(fieldWithRole([plain, ojad], "ojad")).toBe(ojad);
    expect(fieldWithRole([plain], "ojad")).toBeNull();
  });

  it("treats an unknown role as none rather than throwing", () => {
    expect(roleOf({ options: { [ROLE_KEY]: "from-the-future" } })).toBeNull();
    expect(roleOf({ options: undefined })).toBeNull();
    expect(roleOf({})).toBeNull();
  });

  it("merges a role over existing options without dropping any", () => {
    const merged = withRole({ voice: "ja-JP-Neural2-C" }, "ojad");
    expect(merged).toEqual({ voice: "ja-JP-Neural2-C", [ROLE_KEY]: "ojad" });
  });
});

describe("the registry against the real corpus", () => {
  it("knows the type of all 48 fields, and names no key it cannot explain", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const rows = db
        .prepare("SELECT type, options FROM template_fields")
        .all() as { type: string; options: string }[];
      expect(rows.length).toBeGreaterThan(0);

      const unexplained = new Set<string>();
      for (const row of rows) {
        expect(kindOf(row.type), `unknown field type ${row.type}`).not.toBeNull();
        const declared = new Set(settingsOf(row.type).map((spec) => spec.key));
        for (const key of Object.keys(decodeFieldOptions(row.options))) {
          if (key === ROLE_KEY) continue;
          if (!declared.has(key)) unexplained.add(`${row.type}.${key}`);
        }
      }
      expect([...unexplained].sort()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("NO generation was ever addressed by a hashigo- key", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const n = db
        .prepare(`SELECT count(*) AS n FROM blobs WHERE options LIKE '%${LOCAL_OPTION_PREFIX}%'`)
        .get() as { n: number };
      expect(n.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("fieldKind names what a field IS", () => {
  it("reads the role before the stored type", () => {
    expect(fieldKind({ type: "plain", options: { [ROLE_KEY]: "ojad" } })).toMatchObject({
      id: "ojad",
      derived: true,
      readsSource: true,
    });
    expect(fieldKind({ type: "plain", options: { [ROLE_KEY]: "reading" } })).toMatchObject({
      id: "reading",
      label: "Reading (ふりがな)",
      derived: true,
    });
    expect(fieldKind({ type: "boolean", options: { [ROLE_KEY]: "reading-switch" } })).toMatchObject({
      label: "Exercise switch",
      derived: false,
    });
  });

  it("treats a plain 読み with no role as the reading, until the role is written", () => {
    expect(effectiveRole({ name: " 読み ", type: "plain" })).toBe("reading");
    expect(fieldKind({ name: "読み", type: "plain" }).derived).toBe(true);
    expect(effectiveRole({ name: "読み", type: "boolean" })).toBeNull();
  });

  it("makes 型 derived and every authored kind editable", () => {
    expect(fieldKind({ type: "accent" })).toMatchObject({ derived: true, readsSource: true });
    for (const type of ["plain", "text", "boolean", "number"]) {
      expect(fieldKind({ name: "単語", type }).derived).toBe(false);
    }
    expect(fieldKind({ type: "plain" }).label).toBe("Text");
  });

  it("explains every derived kind's empty value", () => {
    for (const field of [
      { type: "accent" },
      { type: "plain", options: { [ROLE_KEY]: "reading" } },
      { type: "plain", options: { [ROLE_KEY]: "ojad" } },
    ]) {
      expect(fieldKind(field).whenEmpty).not.toBeNull();
    }
  });
});

describe("yomiFieldId finds the reading by role first, then by name", () => {
  const tiny = (): Database.Database => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE template_fields (template_id TEXT, id TEXT, name TEXT, type TEXT, options TEXT, pos TEXT)",
    );
    return db;
  };
  it("takes the role over a field that only shares the name", () => {
    const db = tiny();
    try {
      db.prepare("INSERT INTO template_fields VALUES ('t', 'byname', '読み', 'plain', '{}', 'a')").run();
      db.prepare(
        `INSERT INTO template_fields VALUES ('t', 'byrole', 'かな', 'plain', '{"${ROLE_KEY}":"reading"}', 'b')`,
      ).run();
      expect(yomiFieldId(db, "t")).toBe("byrole");
    } finally {
      db.close();
    }
  });
  it("still finds a role-less 読み, and survives options that are not JSON", () => {
    const db = tiny();
    try {
      db.prepare("INSERT INTO template_fields VALUES ('t', 'junk', 'x', 'plain', 'not json', 'a')").run();
      db.prepare("INSERT INTO template_fields VALUES ('t', 'byname', '読み', 'plain', NULL, 'b')").run();
      expect(yomiFieldId(db, "t")).toBe("byname");
      expect(yomiFieldId(db, "other")).toBeNull();
    } finally {
      db.close();
    }
  });
});
