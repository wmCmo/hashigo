/**
 * Thousands separators as PRESENTATION — Zach, 2026-09-07: *"we can just have no
 * comma field, and the template let me choose a display type of rendering comma"*.
 *
 * The formatting lives at SUBSTITUTION (`src/template/resolve.ts`) and not in the
 * renderer, for the reason decision 20 taught the hard way: a resolved plain field is
 * substituted to text before the render, so nothing downstream knows where it came
 * from. Two consequences are tested here because both are load-bearing:
 *
 *   * the card body shows the grouped form;
 *   * a GENERATOR's input is the grouped form too (decision 7), which is what keeps
 *     数字's 89 existing clips on their original generation key.
 */

import { existsSync } from "node:fs";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { checkAnswer } from "../src/render/input.js";
import { groupDigits, resolveCard } from "../src/template/index.js";

const DB = "build/hashigo.db";

/**
 * THE MIGRATION MADE `data-expect` THE GROUPED FORM, so the answer check now has to
 * accept the bare digits he will actually type.
 *
 * `<input value=<<Number>>>` goes through the SAME substitution as the body — proven
 * by rendering a real card — so the expected answer arrives as `662,928,912`. That is
 * only safe because `normaliseAnswer` strips separators before comparing, and this is
 * where that becomes load-bearing rather than a convenience: without it the migration
 * would have made every 数字 card impossible to answer.
 */
describe("the answer check after the merge", () => {
  const expected = "662,928,912";

  it("accepts every form he can type", () => {
    for (const typed of [
      "662928912", // bare, which is what a numeric keypad gives
      "662,928,912", // as displayed
      "６６２９２８９１２", // full-width, straight out of an IME
      "６６２，９２８，９１２", // full-width with full-width commas
      "662 928 912", // spaced
    ]) {
      expect(checkAnswer(expected, typed, { foldKana: true }).ok, typed).toBe(true);
    }
  });

  it("still rejects a wrong number and an empty box", () => {
    expect(checkAnswer(expected, "66292891", { foldKana: true }).ok).toBe(false);
    expect(checkAnswer(expected, "", { foldKana: true }).ok).toBe(false);
  });
});

describe("groupDigits", () => {
  it("groups an integer from the right", () => {
    expect(groupDigits("124652706", ",")).toBe("124,652,706");
    expect(groupDigits("1", ",")).toBe("1");
    expect(groupDigits("999", ",")).toBe("999");
    expect(groupDigits("1000", ",")).toBe("1,000");
  });

  it("groups only the INTEGER part", () => {
    // `1,234.567,8` is the bug this pins. The fraction is never grouped.
    expect(groupDigits("1234.5678", ",")).toBe("1,234.5678");
    expect(groupDigits("-1234567.5", ",")).toBe("-1,234,567.5");
    expect(groupDigits("+1000", ",")).toBe("+1,000");
  });

  it("LEAVES ANYTHING THAT IS NOT A NUMBER ALONE", () => {
    // A `number` field is TEXT in the column, so it can hold whatever was typed.
    // Mangling `n/a` into something else would be worse than not formatting it.
    for (const text of ["", "n/a", "約100", "1,000", "1e6", "12 34", "١٢٣"]) {
      expect(groupDigits(text, ","), text).toBe(text);
    }
  });

  it("takes any separator", () => {
    expect(groupDigits("1234567", " ")).toBe("1 234 567");
    expect(groupDigits("1234567", "_")).toBe("1_234_567");
  });

  it("is IDEMPOTENT on already-grouped text, by refusing it", () => {
    // Guards the case where the migration runs twice, or where a value still holds
    // the old comma'd form: the regex rejects it, so nothing doubles up.
    expect(groupDigits("124,652,706", ",")).toBe("124,652,706");
  });
});

describe("a number field with `group`", () => {
  const template = {
    id: "t",
    content: "<< Voice >>\n<input value=<<Number>>>\n---\n<< Number >>",
    fields: [
      { id: "name", name: "Number", type: "number", options: { group: "comma" } },
      { id: "v", name: "Voice", type: "speech", options: {} },
    ],
  };

  it("renders grouped in the body", () => {
    const sides = resolveCard({ id: "c", values: { name: "124652706" } }, template);
    const text = JSON.stringify(sides);
    expect(text).toContain("124,652,706");
    expect(text).not.toContain('"124652706"');
  });

  it("renders BARE when `group` is absent or none — it is opt-in", () => {
    // Not automatic for every `number`: "render 1999 as 1,999" is wrong for a year,
    // and he asked to choose it in the template.
    for (const options of [{}, { group: "none" }, { group: "" }]) {
      const plain = {
        ...template,
        fields: [{ id: "name", name: "Number", type: "number", options }],
      };
      const sides = resolveCard({ id: "c", values: { name: "124652706" } }, plain);
      expect(JSON.stringify(sides), JSON.stringify(options)).toContain("124652706");
    }
  });

  it("does not touch a field of any other type", () => {
    const asText = {
      ...template,
      fields: [{ id: "name", name: "Number", type: "text", options: { group: "comma" } }],
    };
    const sides = resolveCard({ id: "c", values: { name: "124652706" } }, asText);
    expect(JSON.stringify(sides)).toContain("124652706");
  });
});

describe("against the real 数字 corpus", () => {
  it("EVERY card is losslessly mergeable — the migration's precondition", () => {
    if (!existsSync(DB)) return;
    const db = new Database(DB, { readonly: true });
    try {
      const template = db.prepare("SELECT id FROM templates WHERE name = '数字'").get() as
        | { id: string }
        | undefined;
      if (template === undefined) return;
      const second = db
        .prepare(
          "SELECT id FROM template_fields WHERE template_id = ? AND type = 'number' AND id <> 'name'",
        )
        .get(template.id) as { id: string } | undefined;
      // After the migration has been applied the second field is gone, and that is
      // the healthy state — not a reason to fail.
      if (second === undefined) {
        const primary = db
          .prepare("SELECT type, options FROM template_fields WHERE template_id = ? AND id = 'name'")
          .get(template.id) as { type: string; options: string };
        expect(primary.type).toBe("number");
        expect(primary.options).toContain("group");
        return;
      }

      const rows = db
        .prepare(
          `SELECT c.id,
                  max(CASE WHEN v.field_id = 'name' THEN v.value END) AS comma_,
                  max(CASE WHEN v.field_id = ?      THEN v.value END) AS bare
             FROM cards c LEFT JOIN card_field_values v ON v.card_id = c.id
            WHERE c.template_id = ? GROUP BY c.id`,
        )
        .all(second.id, template.id) as {
        id: string;
        comma_: string | null;
        bare: string | null;
      }[];
      expect(rows.length).toBeGreaterThan(80);
      for (const row of rows) {
        expect(row.bare, row.id).toBeTruthy();
        expect(groupDigits(row.bare as string, ","), row.id).toBe(row.comma_);
      }
    } finally {
      db.close();
    }
  });
});
