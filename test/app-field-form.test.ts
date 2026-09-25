import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  factsLine,
  inputLine,
  roleLine,
  settingLines,
  undeclaredKeys,
  type FieldFacts,
} from "../app/field-form.js";
import { decodeFieldOptions } from "../src/cards/index.js";

/**
 * WHAT THE EDITOR SAYS A FIELD CARRIES.
 *
 * In `app/` over structural inputs, for `app/deck-scope.ts`'s reason: `test/`
 * cannot import the worker, and UI logic nobody can test is how the deck archive
 * shipped inverted. These functions take plain data and return plain strings, so
 * the corpus can be run through them without a DOM.
 *
 * THE PROPERTY THAT MATTERS is that absence is reported as absence. 723 translate
 * blobs and 11,508 `ai` blobs were generated with empty options; a panel that
 * shows what the code WOULD default to teaches him the field carries a value it
 * does not, and the editable version of this would then write it and orphan them.
 */

const CORPUS = "build/hashigo.db";

function corpus(): Database.Database | null {
  try {
    return new Database(CORPUS, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function facts(over: Partial<FieldFacts> = {}): FieldFacts {
  return {
    name: "Example",
    type: "plain",
    sourceFieldId: null,
    local: false,
    values: 0,
    references: 0,
    sides: [],
    dependents: [],
    ...over,
  };
}

describe("the facts line answers WHERE, not just how many", () => {
  it("names the one side a field is on", () => {
    expect(factsLine(facts({ type: "plain", references: 1, sides: [2] }))).toBe(
      "Plain text · 1 reference(s) on side 2",
    );
  });

  it("names several sides in order", () => {
    expect(factsLine(facts({ references: 3, sides: [1, 2, 4] }))).toContain(
      "3 reference(s) on sides 1, 2, 4",
    );
  });

  it("says a field renders nowhere rather than printing a bare zero", () => {
    // `言葉`'s かな主流 holds all six values and its body never names them. "0
    // reference(s)" states the same fact and buries it.
    const line = factsLine(facts({ name: "かな主流", type: "boolean", values: 6 }));
    expect(line).toContain("renders nowhere in the body");
    expect(line).not.toContain("0 reference(s)");
    expect(line).toContain("6 value(s)");
  });

  it("keeps decision 9's local marker, which decides whether an edit survives", () => {
    expect(factsLine(facts({ local: true, sides: [1] }))).toContain(
      "local (decision 9 — protected from re-import)",
    );
  });

  it("uses the registry's label for the kind", () => {
    expect(factsLine(facts({ type: "speech", sides: [3] }))).toMatch(/^Speech · /);
    // An unknown type falls back to its own name rather than vanishing.
    expect(factsLine(facts({ type: "from-the-future", sides: [1] }))).toMatch(/^from-the-future · /);
  });
});

describe("the input line is the pipe he said he could not make", () => {
  const nameOf = (id: string): string | null => (id === "src-1" ? "Example Sentence" : null);

  it("names the field a generator reads from", () => {
    expect(inputLine(facts({ type: "speech", sourceFieldId: "src-1" }), nameOf)).toBe(
      "Input: Example Sentence",
    );
  });

  it("says so when a generator has no source at all", () => {
    expect(inputLine(facts({ type: "speech" }), nameOf)).toBe(
      "Input: not set — this field generates nothing",
    );
  });

  it("explains that an ai field's input is its prompt, not a column", () => {
    // `source_field_id` is legitimately NULL on four fields of this corpus for
    // exactly this reason, and `schema.sql` says so at the column.
    expect(inputLine(facts({ type: "ai" }), nameOf)).toBe(
      "Input: the prompt below, with its <<Field>> markers",
    );
  });

  it("is silent for a kind that has no input", () => {
    expect(inputLine(facts({ type: "plain" }), nameOf)).toBeNull();
    expect(inputLine(facts({ type: "boolean" }), nameOf)).toBeNull();
  });

  it("prints the raw id rather than `null` if a source ever dangles", () => {
    expect(inputLine(facts({ type: "speech", sourceFieldId: "gone" }), nameOf)).toBe("Input: gone");
  });
});

describe("settings are shown as they ARE", () => {
  it("prints a value that is set", () => {
    const lines = settingLines("speech", { voice: "ja-JP-NanamiNeural", lang: "ja-JP" });
    expect(lines.find((line) => line.label === "Voice")).toMatchObject({
      value: "ja-JP-NanamiNeural",
      unset: false,
    });
  });

  it("prints ABSENCE as absence, never as the default the code would use", () => {
    // This is the whole safety argument. `src/generate/llm.ts` supplies ja→en at
    // USE time; a panel that shows "ja" here would be describing a value the
    // field does not carry, and the editable version would then write it.
    const lines = settingLines("translate", {});
    expect(lines.map((line) => [line.label, line.value, line.unset])).toEqual([
      ["From", "not set", true],
      ["To", "not set", true],
    ]);
  });

  it("names a boolean's meaning when it is unset, because absence IS the answer", () => {
    const [line] = settingLines("boolean", {});
    expect(line).toMatchObject({ label: "Default", value: "not set (no)", unset: true });
  });

  it("marks the keys the editor will never offer to change", () => {
    const lines = settingLines("speech", { voice: "x", lang: "ja-JP", gender: "male" });
    const readOnly = lines.filter((line) => line.readOnly).map((line) => line.label);
    // `lang` is derived from the voice and `gender` is Azure's — both are part of
    // the cache key, so offering an edit invites a miss and buys nothing.
    expect(readOnly.sort()).toEqual(["Gender", "Language"]);
  });

  it("renders booleans as words rather than as `true`", () => {
    const lines = settingLines("ai", { randomize: true });
    expect(lines.find((line) => line.label === "Randomize")?.value).toBe("yes");
  });

  it("treats an empty string as unset, because Mochi writes both", () => {
    const lines = settingLines("speech", { voice: "  " });
    expect(lines.find((line) => line.label === "Voice")?.unset).toBe(true);
  });

  it("keeps a key the kind does not declare, instead of dropping it", () => {
    expect(undeclaredKeys("speech", { voice: "x", "some-mochi-key": "v" })).toEqual([
      { key: "some-mochi-key", value: "v" },
    ]);
    expect(undeclaredKeys("speech", { voice: "x" })).toEqual([]);
  });
});

describe("over the real 48 fields", () => {
  it("describes every one of them without inventing a value", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const rows = db
        .prepare("SELECT type, options FROM template_fields")
        .all() as { type: string; options: string }[];
      expect(rows.length).toBe(48);

      let unset = 0;
      let shownValues = 0;
      for (const row of rows) {
        const options = decodeFieldOptions(row.options);
        const lines = settingLines(row.type, options);
        for (const line of lines) {
          if (line.unset) {
            unset += 1;
            // An unset line must READ as unset. Anything else is the form
            // teaching him a value that is not in the database.
            expect(line.value.startsWith("not set"), `${row.type}.${line.key}`).toBe(true);
            // And it must really be absent in the row, not merely rendered as
            // absent — `null` counts, because Mochi writes `"gender": null`.
            const raw = options[line.key];
            expect(
              raw === undefined || raw === null || String(raw).trim() === "",
              `${row.type}.${line.key} says unset but carries ${String(raw)}`,
            ).toBe(true);
          } else {
            shownValues += 1;
            // The value shown is the value stored, for the key this line claims.
            const raw = options[line.key];
            const expected = typeof raw === "boolean" ? (raw ? "yes" : "no") : String(raw).trim();
            expect(line.value, `${row.type}.${line.key}`).toBe(expected);
          }
        }

        // NOTHING IS DROPPED on the way to the screen. Every key the row carries
        // is either a declared setting or an undeclared one that is shown as it
        // is; a key appearing in neither would vanish silently, which is exactly
        // what a save would then erase.
        const accounted = new Set([
          ...lines.map((line) => line.key),
          ...undeclaredKeys(row.type, options).map((extra) => extra.key),
          // The role is shown on its own line (stage F), so it is accounted for
          // exactly when that line exists.
          ...(roleLine(options) === null ? [] : ["hashigo-role"]),
        ]);
        for (const key of Object.keys(options)) {
          expect(accounted.has(key), `${row.type}.${key} is shown nowhere`).toBe(true);
        }
      }
      expect(shownValues).toBeGreaterThan(0);
      // 基本情報's Audio carries a lang and no voice; 数字's Voice carries a gender
      // and no voice; Polysemy's Example-sound carries nothing at all. If this
      // ever reached zero the corpus would have changed, not the code.
      expect(unset).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("gives 数字's Number the grouping that makes its clips addressable", () => {
    const db = corpus();
    if (db === null) return;
    try {
      const row = db
        .prepare(
          `SELECT f.type AS type, f.options AS options FROM template_fields f
             JOIN templates t ON t.id = f.template_id
            WHERE t.name = '数字' AND f.name = 'Number'`,
        )
        .get() as { type: string; options: string } | undefined;
      expect(row).toBeDefined();
      const [line] = settingLines(row?.type ?? "", decodeFieldOptions(row?.options ?? "{}"));
      expect(line).toMatchObject({ label: "Digit grouping", value: "comma", unset: false });
    } finally {
      db.close();
    }
  });
});

describe("a role is shown as what it is FOR, never as a stranger (stage F)", () => {
  it("names the ojad role", () => {
    expect(roleLine({ "hashigo-role": "ojad" })).toMatch(/^Role: ojad — /);
    expect(roleLine({})).toBeNull();
  });
  it("does not list the role key as undeclared", () => {
    expect(undeclaredKeys("plain", { "hashigo-role": "ojad" })).toEqual([]);
  });
});
