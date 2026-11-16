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
      "Text · 1 reference on side 2",
    );
    expect(factsLine(facts({ values: 1, sides: [1] }))).toBe("Text · on side 1 · 1 value");
  });

  it("names several sides in order", () => {
    expect(factsLine(facts({ references: 3, sides: [1, 2, 4] }))).toContain(
      "3 references on sides 1, 2, 4",
    );
  });

  it("says a field renders nowhere rather than printing a bare zero", () => {
    const line = factsLine(facts({ name: "かな主流", type: "boolean", values: 6 }));
    expect(line).toContain("renders nowhere in the body");
    expect(line).not.toContain("0 reference");
    expect(line).toContain("6 values");
  });

  it("keeps decision 9's local marker, which decides whether an edit survives", () => {
    const line = factsLine(facts({ local: true, sides: [1] }));
    expect(line).toContain("local · kept on re-import");
    expect(line).not.toMatch(/decision/i);
  });

  it("uses the registry's label for the kind", () => {
    expect(factsLine(facts({ type: "speech", sides: [3] }))).toMatch(/^Speech · /);
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
            expect(line.value.startsWith("not set"), `${row.type}.${line.key}`).toBe(true);
            const raw = options[line.key];
            expect(
              raw === undefined || raw === null || String(raw).trim() === "",
              `${row.type}.${line.key} says unset but carries ${String(raw)}`,
            ).toBe(true);
          } else {
            shownValues += 1;
            const raw = options[line.key];
            const expected = typeof raw === "boolean" ? (raw ? "yes" : "no") : String(raw).trim();
            expect(line.value, `${row.type}.${line.key}`).toBe(expected);
          }
        }

        const accounted = new Set([
          ...lines.map((line) => line.key),
          ...undeclaredKeys(row.type, options).map((extra) => extra.key),
          ...(roleLine(options) === null ? [] : ["hashigo-role"]),
        ]);
        for (const key of Object.keys(options)) {
          expect(accounted.has(key), `${row.type}.${key} is shown nowhere`).toBe(true);
        }
      }
      expect(shownValues).toBeGreaterThan(0);
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

describe("the facts and input lines name the KIND (2026-11-05)", () => {
  const nameOf = (id: string): string | null => (id === "head" ? "単語" : null);
  it("calls 読み a Reading and shows what it reads", () => {
    const yomi = facts({ name: "読み", type: "plain", sourceFieldId: "head" });
    expect(factsLine(yomi)).toMatch(/^Reading \(ふりがな\)/);
    expect(inputLine(yomi, nameOf)).toBe("Input: 単語");
  });
  it("calls OJAD what it is, not Plain text", () => {
    expect(factsLine(facts({ type: "plain", options: '{"hashigo-role":"ojad"}' }))).toMatch(/^Accent marks/);
  });
});
