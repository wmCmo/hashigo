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

/**
 * THE REGISTRY DESCRIBES; IT MUST NOT DRIFT FROM WHAT DECIDES.
 *
 * Zach, 2026-09-17: *"each field behavior are hardcoded, they are supposed to be
 * module"*. He was right about the disease. The cure has one hazard and it is the
 * expensive kind: a registry that ends up DECIDING what goes into a generation
 * identity would move cache keys as a side effect of documenting them, and a
 * moved key orphans every blob it addressed — 11,589 speech, 17,228 ai, 7,880
 * translate.
 *
 * So these tests check agreement in one direction only. `keyOptions` in
 * `src/generate/fields.ts` remains the authority; the registry is measured
 * against it, the corpus, and the schema.
 */

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
    // And the derived set is the schema's own, not a hand-kept parallel list.
    const generating = FIELD_TYPES.filter((type) => FIELD_KINDS[type].blobKind !== null);
    expect(new Set(generating)).toEqual(new Set(GENERATOR_FIELD_TYPES));
  });

  it("only a generating kind may be generatable", () => {
    for (const type of GENERATABLE_TYPES) expect(FIELD_KINDS[type].blobKind).not.toBeNull();
  });

  it("has none of Mochi's four unused types (deleted 2026-11-05)", () => {
    // "it's not even a spark joy lol, just delete them". The `<furigana>` ELEMENT
    // and blob kind are another thing and stay; the FIELD TYPE is gone.
    for (const gone of ["text", "furigana", "dictionary", "image-search"]) {
      expect((FIELD_TYPES as readonly string[]).includes(gone), gone).toBe(false);
      expect(kindOf(gone), gone).toBeNull();
    }
  });

  it("offers only authorable types to the add-field form, and no generator", () => {
    // No `text`: Long text stores and renders exactly as Text (2026-11-05).
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
    // Scoped to generating kinds, because `keyOptions` only ever runs on one. On
    // any other kind the question is not merely unanswered, it is meaningless:
    // 数字's `group` is never in a `number` field's identity because a `number`
    // field has none. Its reach is `downstream` — the SPEECH field that consumes
    // the formatted value is what hashes it.
    //
    // AND THE IDENTITY IS NOT JUST THE OPTIONS HASH. `generationIdentity` gives
    // `voice` and `lang` their OWN columns, which is exactly why `keyOptions`
    // skips them — leaving them in the blob would hash them twice. So they are
    // the most identity-bearing keys there are and the only two that `keyOptions`
    // must NOT carry. Flattening those two facts into one rule is how a plausible
    // test would have blessed a registry that called the voice cosmetic.
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
    // `voice` has its own slot and is skipped by keyOptions; `gender` has no slot
    // and is carried by keyOptions. Both are `own`. If either mechanism were
    // removed, one of these would flip and the test above would catch it.
    expect(keyedByGenerate("voice")).toBe(false);
    expect(keyedByGenerate("gender")).toBe(true);
    const speech = new Map(settingsOf("speech").map((spec) => [spec.key, spec]));
    expect(speech.get("voice")?.identity).toBe("own");
    expect(speech.get("gender")?.identity).toBe("own");
  });

  it("never claims `own` on a kind that generates nothing", () => {
    // The mirror of the rule above, and it is the one that keeps the two apart.
    // `boolean-default` is `none` and `group` is `downstream`; either claiming
    // `own` would mean a field with no identity had one.
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
    // The point of the rule: a key nobody has invented yet is already excluded.
    expect(NON_KEY_OPTIONS.has(`${LOCAL_OPTION_PREFIX}not-invented-yet`)).toBe(true);
    expect(keyedByGenerate(ROLE_KEY)).toBe(false);
  });

  it("still excludes exactly Mochi's four, so nothing widened by accident", () => {
    expect([...MOCHI_NON_KEY_OPTIONS].sort()).toEqual(
      ["ai-custom-prompt", "lang", "randomize", "voice"].sort(),
    );
    for (const key of MOCHI_NON_KEY_OPTIONS) expect(NON_KEY_OPTIONS.has(key)).toBe(true);
    // A key that is neither Mochi's exclusions nor ours IS hashed. `gender` is
    // the one that proves it: 1,189 New Vocab clips are addressed by it.
    expect(NON_KEY_OPTIONS.has("gender")).toBe(false);
    expect(keyedByGenerate("gender")).toBe(true);
  });

  it("never offers an editable control for a key that is history", () => {
    // `lang` is derived from the voice, `gender` is Azure's, `language` cannot
    // even be carried by a generator element. Offering them invites an edit whose
    // only effect is a cache miss.
    const readOnly = ["lang", "gender", "language", "randomize"];
    for (const type of FIELD_TYPES) {
      for (const spec of FIELD_KINDS[type].settings) {
        if (readOnly.includes(spec.key)) expect(spec.editable).toBe(false);
      }
    }
  });

  it("gives every setting a fallback that is ABSENCE, never a materialised value", () => {
    // The 723 translate blobs generated with no direction at all are why. A form
    // that writes `ja`→`en` because a select had to show something orphans them.
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
    // `options` is free-form JSON with no CHECK, so a payload from a newer build
    // must degrade to "no role" — the same choice `decodeFieldOptions` makes.
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
          // A ROLE is declared too — in `src/fields/roles.ts`, not per kind,
          // because it is what a field with no type of its own is FOR.
          if (key === ROLE_KEY) continue;
          if (!declared.has(key)) unexplained.add(`${row.type}.${key}`);
        }
      }
      // Anything here would render as a read-only "this field also carries…"
      // line rather than vanishing on save. The list is asserted EMPTY so that a
      // key arriving from a future import is a failing test and not a silent
      // drop.
      expect([...unexplained].sort()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("NO generation was ever addressed by a hashigo- key", () => {
    const db = corpus();
    if (db === null) return;
    try {
      // The failure this prevents is permanent and silent: a `hashigo-` key on a
      // generator field before the exclusion knew about it would re-address every
      // clip that field has.
      const n = db
        .prepare(`SELECT count(*) AS n FROM blobs WHERE options LIKE '%${LOCAL_OPTION_PREFIX}%'`)
        .get() as { n: number };
      expect(n.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

/**
 * A FIELD'S KIND — its stored type read with its role (2026-11-05). Zach: *"the
 * `type` wouldn't be plain text, but rather something like `ふりがな`"*. The
 * `derived` flag is the card editor's whole read-only rule, so it is pinned per kind.
 */
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
    // The name alone does not make a non-plain field one.
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
