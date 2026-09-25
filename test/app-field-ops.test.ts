import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  consumersOf,
  describePrice,
  optionsRefusal,
  patchOptions,
  priceFieldChange,
  sourceChoices,
  sourceRefusal,
  templateFields,
  type FieldState,
} from "../app/field-ops.js";
import type { SqliteHandle } from "../src/db/browser.js";

/**
 * STAGE C OF FIELDS-AS-MODULES: what an edit to a field's settings or input costs,
 * and what it may not do.
 *
 * Over a COPY of the real database, because the price is only worth anything if it
 * is the price of HIS cards — the 数字 `group` incident that silenced 78 clips was
 * a fact about this corpus, not about a fixture. `serialize()` gives an in-memory
 * copy, so nothing here can touch `build/hashigo.db`.
 */

const CORPUS = "build/hashigo.db";
const TANGO = "oiaISYb2";
const SUUJI = "ibeOPZ1V";
const VOCAB = "Q37a0W3E";

let db: Database.Database | null = null;
const handle = (): SqliteHandle => db as unknown as SqliteHandle;

beforeAll(() => {
  try {
    const source = new Database(CORPUS, { readonly: true, fileMustExist: true });
    const bytes = source.serialize();
    // Bytes 18-19 say WAL (2) on the corpus, and a deserialised buffer cannot
    // open a WAL: "unable to open database file". 1 is the rollback journal.
    bytes[18] = 1;
    bytes[19] = 1;
    db = new Database(bytes);
    source.close();
  } catch {
    db = null;
  }
});
afterAll(() => db?.close());

const field = (over: Partial<FieldState> & { id: string }): FieldState => ({
  name: over.id,
  type: "plain",
  sourceFieldId: null,
  options: "{}",
  ...over,
});

describe("patchOptions keeps what it is not told to change", () => {
  it("keeps key order and every unnamed key", () => {
    expect(patchOptions('{"gender":"male","lang":"en-US","voice":"x"}', { voice: "y" })).toBe(
      '{"gender":"male","lang":"en-US","voice":"y"}',
    );
  });
  it("deletes on null and appends a new key at the end", () => {
    expect(patchOptions('{"from":"ja","to":"en"}', { from: null, extra: "1" })).toBe(
      '{"to":"en","extra":"1"}',
    );
  });
  it("NEVER materialises a key the patch does not name — the 723 empty translate blobs", () => {
    expect(patchOptions("{}", {})).toBe("{}");
  });
});

describe("optionsRefusal lets through only editable, declared keys", () => {
  const speech = '{"gender":"male","lang":"en-US","voice":"en-US-AIGenerate1Neural"}';

  it("allows the voice", () => {
    expect(optionsRefusal("speech", speech, patchOptions(speech, { voice: "en-US-Neural2-D" }))).toBeNull();
  });
  it("refuses gender — it addresses 1,189 New Vocab clips", () => {
    expect(optionsRefusal("speech", speech, patchOptions(speech, { gender: "female" }))).toMatch(
      /read-only/,
    );
  });
  it("refuses a change to an undeclared key rather than dropping or rewriting it", () => {
    expect(optionsRefusal("ai", '{"x":"1"}', '{"x":"2"}')).toMatch(/not a setting/);
  });
  it("accepts an unchanged undeclared key carried through", () => {
    expect(optionsRefusal("ai", '{"x":"1"}', '{"x":"1","ai-custom-prompt":"hi <<単語>>"}')).toBeNull();
  });
  it("refuses a choice that is not one", () => {
    expect(optionsRefusal("number", "{}", '{"group":"dots"}')).toMatch(/choices/);
  });
  it("refuses a language that is not a code", () => {
    expect(optionsRefusal("translate", "{}", '{"from":"Japanese"}')).toMatch(/language code/);
  });
  it("refuses something that is not an object", () => {
    expect(optionsRefusal("ai", "{}", "[1]")).toMatch(/object/);
  });
});

describe("sourceRefusal stops a loop the schema cannot see", () => {
  const fields = [
    field({ id: "a" }),
    field({ id: "b", type: "ai" }),
    field({ id: "c", type: "speech", sourceFieldId: "d" }),
    field({ id: "d", type: "translate", sourceFieldId: "c" }),
    field({ id: "e", type: "speech", sourceFieldId: "a" }),
  ];

  it("refuses a field reading itself", () => {
    expect(sourceRefusal(fields, "e", "e")).toMatch(/itself/);
  });
  it("refuses a two-field loop — the schema CHECK only stops self-reference", () => {
    expect(sourceRefusal([...fields.slice(0, 2), field({ id: "c", type: "speech" }), fields[3] as FieldState], "c", "d")).toMatch(/loop/);
  });
  it("refuses a kind with no source input — ai names its input in the prompt", () => {
    expect(sourceRefusal(fields, "b", "a")).toMatch(/does not read/);
  });
  it("allows disconnecting", () => {
    expect(sourceRefusal(fields, "e", null)).toBeNull();
  });
  it("offers only legal sources — never itself, never a field that already reads from it", () => {
    // d reads from c, so c may not read from d.
    expect(sourceChoices(fields, "c").map((entry) => entry.id)).toEqual(["a", "b", "e"]);
  });
});

describe("over the real corpus", () => {
  it("単語 feeds 例文 through its PROMPT, and 例文 feeds Translate and Audio through the column", () => {
    if (db === null) return;
    const fields = templateFields(handle(), TANGO);
    const names = consumersOf(fields, "name").map((entry) => entry.name);
    // The prompt edge is the one a column-only walk never saw.
    expect(names).toContain("例文");
    expect(names).toContain("Audio");
    expect(names).toContain("Translate");
    expect(names).toContain("Speech");
  });

  it("an unchanged proposal moves nothing", () => {
    if (db === null) return;
    const fields = templateFields(handle(), VOCAB);
    const example = fields.find((entry) => entry.name === "Example") as FieldState;
    const price = priceFieldChange(handle(), VOCAB, example.id, { options: example.options });
    for (const line of price.lines) {
      expect(line.silenced).toBe(0);
      expect(line.gained).toBe(0);
    }
  });

  it("changing 数字's digit grouping SILENCES the speech field downstream — the 78-card incident, caught first", () => {
    if (db === null) return;
    const fields = templateFields(handle(), SUUJI);
    const number = fields.find((entry) => entry.name === "Number") as FieldState;
    const price = priceFieldChange(handle(), SUUJI, number.id, {
      options: patchOptions(number.options, { group: "space" }),
    });
    const voice = price.lines.find((line) => line.fieldName === "Voice");
    expect(voice).toBeDefined();
    expect(voice?.own).toBe(false);
    expect(voice?.resolvesNow ?? 0).toBeGreaterThan(50);
    expect(voice?.silenced ?? 0).toBeGreaterThan(50);
    expect(describePrice(price).join(" ")).toMatch(/STOP/);
  });

  it("editing 例文's prompt silences the sentence AND the audio and translation made from it", () => {
    if (db === null) return;
    const fields = templateFields(handle(), TANGO);
    const example = fields.find((entry) => entry.name === "例文") as FieldState;
    const price = priceFieldChange(handle(), TANGO, example.id, {
      options: patchOptions(example.options, { "ai-custom-prompt": "A sentence with <<単語>>." }),
    });
    expect(price.checked).toBeLessThan(price.cards); // sampled, and says so
    const silenced = new Map(price.lines.map((line) => [line.fieldName, line.silenced]));
    expect(silenced.get("例文") ?? 0).toBeGreaterThan(100);
    expect(silenced.get("Audio") ?? 0).toBeGreaterThan(100);
    expect(describePrice(price).join(" ")).toMatch(/sampled/);
  });

  it("repointing New Vocab's Example onto Vocab silences its sentence clips", () => {
    if (db === null) return;
    const fields = templateFields(handle(), VOCAB);
    const example = fields.find((entry) => entry.name === "Example") as FieldState;
    const price = priceFieldChange(handle(), VOCAB, example.id, { sourceFieldId: "name" });
    const own = price.lines.find((line) => line.own);
    expect(own?.silenced ?? 0).toBeGreaterThan(100);
  });

  it("a boolean default reports how many cards it decides", () => {
    if (db === null) return;
    const fields = templateFields(handle(), TANGO);
    const reading = fields.find((entry) => entry.name === "Reading") as FieldState;
    const price = priceFieldChange(handle(), TANGO, reading.id, {
      options: patchOptions(reading.options, { "boolean-default": true }),
    });
    expect(price.defaulted ?? 0).toBeGreaterThan(1000);
  });
});

describe("a text field's price says when the change does not take effect", () => {
  it("setting 言葉 Translate's direction goes blank nowhere — and says the old text stays", () => {
    if (db === null) return;
    const fields = templateFields(handle(), "itmYDz2N");
    const translate = fields.find((entry) => entry.name === "Translate") as FieldState;
    const price = priceFieldChange(handle(), "itmYDz2N", translate.id, {
      options: patchOptions(translate.options, { from: "ja", to: "fr" }),
    });
    const own = price.lines.find((line) => line.own);
    expect(own?.silenced).toBe(0);
    expect(own?.stale ?? 0).toBeGreaterThan(300);
    expect(describePrice(price).join(" ")).toMatch(/PREVIOUS settings/);
  });
});

// ─── stage E: voice overrides ────────────────────────────────────────────────

import { fieldGenerationRequest } from "../src/generate/index.js";
import { priceVoiceChange, resolvedVoices } from "../app/field-ops.js";

describe("an override reaches speech in its OWN language only", () => {
  const fields = [
    { id: "w", name: "Word", type: "plain" },
    { id: "ja", name: "Speech", type: "speech", sourceFieldId: "w", options: { voice: "ja-JP-NanamiNeural", lang: "ja-JP" } },
    { id: "en", name: "Example", type: "speech", sourceFieldId: "w", options: { voice: "en-US-AIGenerate1Neural", lang: "en-US" } },
    { id: "nolang", name: "Mystery", type: "speech", sourceFieldId: "w", options: {} },
    { id: "tr", name: "Translate", type: "translate", sourceFieldId: "w", options: { from: "ja", to: "en" } },
  ];
  const context = (voiceOverride: string | null) => ({
    fields,
    values: new Map([["w", "橋"]]),
    voiceOverride,
  });
  const voiceOf = (id: string, override: string | null) =>
    fieldGenerationRequest(fields.find((f) => f.id === id) as never, context(override))?.voice;

  it("re-voices the Japanese field", () => {
    expect(voiceOf("ja", "ja-JP-Neural2-B")).toBe("ja-JP-Neural2-B");
  });
  it("leaves the English field on the same card alone — the 130-clip defect, by inheritance", () => {
    expect(voiceOf("en", "ja-JP-Neural2-B")).toBe("en-US-AIGenerate1Neural");
  });
  it("leaves a field with no language alone — nothing says the voice fits it", () => {
    expect(voiceOf("nolang", "ja-JP-Neural2-B")).toBeNull();
  });
  it("never touches a text kind", () => {
    expect(voiceOf("tr", "ja-JP-Neural2-B")).toBeNull();
  });
  it("with no override, the field's recorded voice stands — an untouched database is a no-op", () => {
    expect(voiceOf("ja", null)).toBe("ja-JP-NanamiNeural");
  });
});

describe("the price of a deck voice, over the real 数字 cards", () => {
  it("moving 数字 to another voice silences its clips until regenerated, and says how many", () => {
    if (db === null) return;
    const ids = (handle().prepare("SELECT id FROM cards WHERE template_id = ?").all(SUUJI) as {
      id: string;
    }[]).map((row) => row.id);
    const before = resolvedVoices(handle(), ids);
    const price = priceVoiceChange(handle(), ids, (id) => before.get(id) ?? null, () => "ja-JP-Neural2-B");
    expect(price.mounts).toBeGreaterThan(50);
    expect(price.silenced).toBeGreaterThan(50);
  });

  it("an English voice on 数字 reaches nothing — its speech is Japanese", () => {
    if (db === null) return;
    const ids = (handle().prepare("SELECT id FROM cards WHERE template_id = ?").all(SUUJI) as {
      id: string;
    }[]).map((row) => row.id);
    const price = priceVoiceChange(handle(), ids, () => null, () => "en-US-Neural2-J");
    expect(price.mounts).toBe(0);
  });
});
