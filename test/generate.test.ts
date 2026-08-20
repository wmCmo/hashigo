/**
 * Stage 1.5 — the field binding, against the real export.
 *
 * THE POINT OF THIS FILE. The app was silent and every layer was individually
 * correct: the importer landed 42,569 blobs, the renderer rendered all 7,716
 * cards, and nothing connected the two. A unit test over a fixture would have
 * passed throughout. So the load-bearing assertions here are corpus sweeps with
 * numbers in them, and the numbers are stated as MEASURED RANGES or exact counts
 * from `build/step1/probe.ts`, never as "> 0".
 *
 * The no-autoplay rule is tested too, and it has to be: the whole reason to
 * expand a field into a synthetic `<speech>` element rather than a new render
 * path is that the existing path is the one with the guarantees. If that reuse
 * ever breaks, an `<audio src=…>` appears here first.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { openDatabase } from "../src/db/index.js";
import { MEMORY } from "../src/db/index.js";
import { resolveGenerationAsync } from "../src/import/blobs.js";
import {
  setCardVoice,
  setDeckVoice,
  setDefaultVoice,
  voiceFor,
} from "../src/generate/voice.js";
import {
  expandGeneratorFields,
  fieldGenerationRequest,
  generationInput,
  isGeneratorType,
  resolveFieldGeneration,
  resolveFieldGenerations,
  storeTextResolver,
  type FieldContext,
  type GeneratorField,
} from "../src/generate/index.js";
import { GENERATOR_FIELD_TYPES, FIELD_TYPE_BLOB_KIND } from "../src/schema/index.js";
import { resolveCard } from "../src/template/index.js";
import { memoryDocument, renderResolvedCard, serialise } from "../src/render/index.js";

const DB = "build/hashigo.db";
const haveCorpus = existsSync(DB);

describe("the generation input transform", () => {
  it("strips cloze braces, which is what made 基本情報 miss all 471 of its cards", () => {
    // The value; Mochi's cache key was `データとメソッドを1つに`.
    expect(generationInput("{{データ}}と{{メソッド}}を1つに")).toBe("データとメソッドを1つに");
    expect(generationInput("{{1::indexed}}")).toBe("indexed");
  });

  it("reduces wiki-links to display text and drops the invisible marks", () => {
    // 3,016 U+200E on 2,504 cards join split compounds. Both links AND the mark
    // have to go or the key carries an 8-character opaque id.
    expect(generationInput("[[引き|10PQotxm]]‎[[換え|C1p9g1mL]]")).toBe("引き換え");
  });

  it("does NOT normalise whitespace or NFC — that belongs to generationIdentity", () => {
    // Two definitions of one normalisation is how two spellings of one key
    // appear. This asserts the split is real, not incidental.
    expect(generationInput("a  b")).toBe("a  b");
  });

  it("agrees with the schema about which field types generate", () => {
    expect([...GENERATOR_FIELD_TYPES].sort()).toEqual(Object.keys(FIELD_TYPE_BLOB_KIND).sort());
    expect(isGeneratorType("speech")).toBe(true);
    expect(isGeneratorType("plain")).toBe(false);
    expect(isGeneratorType(undefined)).toBe(false);
  });
});

describe("building a request from a field", () => {
  const speech: GeneratorField = {
    id: "spk",
    name: "Speech",
    type: "speech",
    sourceFieldId: "word",
    options: { lang: "ja-JP", voice: "ja-JP-NanamiNeural" },
  };
  const word: GeneratorField = { id: "word", name: "単語", type: "plain" };

  it("reads the source field, rendered", () => {
    const context: FieldContext = {
      fields: [word, speech],
      values: new Map([["word", "{{橋}}"]]),
    };
    const request = fieldGenerationRequest(speech, context);
    expect(request).not.toBeNull();
    expect(request?.text).toBe("橋");
    expect(request?.voice).toBe("ja-JP-NanamiNeural");
    expect(request?.options).toEqual({});
  });

  it("refuses to build a request on empty input rather than hashing nothing", () => {
    const context: FieldContext = { fields: [word, speech], values: new Map([["word", ""]]) };
    expect(fieldGenerationRequest(speech, context)).toBeNull();
  });

  it("substitutes a prompt marker WITH SPACES — Polysemy's prompt has them", () => {
    const ai: GeneratorField = {
      id: "ex",
      name: "Example",
      type: "ai",
      options: { "ai-custom-prompt": "Sentence using << 単語 >> please", "ai-task": "custom" },
    };
    const request = fieldGenerationRequest(ai, { fields: [word, ai], values: new Map([["word", "橋"]]) });
    expect(request?.text).toBe("Sentence using 橋 please");
  });

  it("keeps ai-task in the key and drops the prompt and randomize", () => {
    const ai: GeneratorField = {
      id: "ex",
      name: "Example",
      type: "ai",
      options: { "ai-custom-prompt": "X", "ai-task": "custom", randomize: false },
    };
    const request = fieldGenerationRequest(ai, { fields: [ai], values: new Map() });
    // Not one of the corpus's 42,569 blob identities carries a prompt.
    expect(request?.options).toEqual({ "ai-task": "custom" });
  });

  it("treats a null option as absent, because New Vocab's gender is literally null", () => {
    const field: GeneratorField = {
      id: "p",
      name: "Pronunciation",
      type: "speech",
      sourceFieldId: "word",
      options: { gender: null, lang: "en-US", voice: "en-US-AIGenerate1Neural" },
    };
    const request = fieldGenerationRequest(field, {
      fields: [word, field],
      values: new Map([["word", "spindle"]]),
    });
    expect(request?.options).toEqual({});
  });

  it("follows the DAG one hop: 単語's Audio reads the sentence 例文 generated", () => {
    const example: GeneratorField = {
      id: "ex",
      name: "例文",
      type: "ai",
      options: { "ai-custom-prompt": "Example sentence using <<単語>>", "ai-task": "custom" },
    };
    const audio: GeneratorField = {
      id: "au",
      name: "Audio",
      type: "speech",
      sourceFieldId: "ex",
      options: { lang: "ja-JP" },
    };
    const fields = [word, example, audio];
    const values = new Map([["word", "橋"]]);

    // Without a resolver the upstream generation is unavailable, so the request
    // is unbuildable rather than built on the prompt text by mistake.
    expect(fieldGenerationRequest(audio, { fields, values })).toBeNull();

    const request = fieldGenerationRequest(audio, {
      fields,
      values,
      resolveGenerated: (r) => (r.kind === "ai" ? "橋を渡る。" : null),
    });
    expect(request?.text).toBe("橋を渡る。");
  });

  it("stops rather than recursing forever on a source cycle", () => {
    const a: GeneratorField = { id: "a", name: "A", type: "speech", sourceFieldId: "b" };
    const b: GeneratorField = { id: "b", name: "B", type: "speech", sourceFieldId: "a" };
    // The schema's CHECK only forbids self-reference, so a two-field cycle is
    // representable and has to terminate here.
    expect(
      fieldGenerationRequest(a, {
        fields: [a, b],
        values: new Map(),
        resolveGenerated: () => null,
      }),
    ).toBeNull();
  });
});

describe("expanding a valueless generator field into the AST", () => {
  const template = {
    id: "t",
    content: "<<単語>>\n---\n<<Speech>>",
    fields: [
      { id: "word", name: "単語", type: "plain" },
      { id: "spk", name: "Speech", type: "speech" },
    ],
  };
  const fields: GeneratorField[] = [
    { id: "word", name: "単語", type: "plain" },
    {
      id: "spk",
      name: "Speech",
      type: "speech",
      sourceFieldId: "word",
      options: { lang: "ja-JP", voice: "ja-JP-NanamiNeural" },
    },
  ];

  it("keeps the reference standing instead of resolving it to nothing", () => {
    // The warning fires either way: the debt is real whether or not the caller
    // intends to settle it. That is the whole defect in one assertion - the
    // marker used to be substituted with "" and reported nothing at all.
    const plain = resolveCard({ id: "c", values: { word: "橋" } }, template);
    expect(plain.warnings.map((w) => w.kind)).toContain("generator-pending");
    // Default: substituted away, so an unexpanded render shows no junk on screen.
    expect(serialise(renderResolvedCard(plain, { document: memoryDocument() }).root)).not.toContain(
      "Speech",
    );
    // Opted in: the marker stands, for the expansion to pick up.
    const pending = resolveCard({ id: "c", values: { word: "橋" } }, template, {
      pendingGenerators: true,
    });
    expect(pending.warnings.map((w) => w.kind)).toContain("generator-pending");
  });

  it("renders a silent <audio> — no src, no autoplay, preload none", () => {
    const card = resolveCard({ id: "c", values: { word: "橋" } }, template, {
      pendingGenerators: true,
    });
    const bound = expandGeneratorFields(card.sides, { fields, values: new Map([["word", "橋"]]) });
    expect(bound.expanded).toHaveLength(1);
    expect(bound.expanded[0]?.text).toBe("橋");
    expect(bound.divergent).toEqual([]);

    const result = renderResolvedCard({ ...card, sides: bound.sides }, { document: memoryDocument() });
    const html = serialise(result.root);
    expect(html).toContain("<audio");
    expect(html).toContain('preload="none"');
    // THE RULE. Reuse of the element path is what guarantees these; if the
    // expansion ever grows its own media code, this is where it shows.
    expect(html).not.toContain("autoplay");
    expect(html).not.toMatch(/<audio[^>]*\ssrc=/);
    expect(result.generations).toHaveLength(1);
    expect(result.generations[0]?.request?.text).toBe("橋");
  });

  it("cannot forge markup out of a field value", () => {
    // The reason this is an AST transform and not a string splice. A value of
    // `</speech><img src=x>` through the lexer would escape the element.
    const values = new Map([["word", "</speech><script>alert(1)</script>"]]);
    const card = resolveCard({ id: "c", values: Object.fromEntries(values) }, template, {
      pendingGenerators: true,
    });
    const bound = expandGeneratorFields(card.sides, { fields, values });
    const html = serialise(
      renderResolvedCard({ ...card, sides: bound.sides }, { document: memoryDocument() }).root,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });

  it("leaves an AST with no generator field reference-identical", () => {
    const plain = { id: "t2", content: "<<単語>>", fields: [{ id: "word", name: "単語", type: "plain" }] };
    const card = resolveCard({ id: "c", values: { word: "橋" } }, plain, {
      pendingGenerators: true,
    });
    const bound = expandGeneratorFields(card.sides, { fields: [fields[0]!], values: new Map() });
    expect(bound.expanded).toEqual([]);
    expect(bound.sides[0]?.blocks[0]).toBe(card.sides[0]?.blocks[0]);
  });
});

describe.runIf(haveCorpus)("the real export", () => {
  interface Row {
    template_id: string;
    id: string;
    name: string;
    type: string;
    source_field_id: string | null;
    options: string;
  }

  const load = () => {
    const db = openDatabase(DB, { readOnly: true });
    const byTemplate = new Map<string, GeneratorField[]>();
    for (const row of db
      .prepare("SELECT template_id, id, name, type, source_field_id, options FROM template_fields")
      .all() as Row[]) {
      const list = byTemplate.get(row.template_id) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        type: row.type,
        sourceFieldId: row.source_field_id,
        options: JSON.parse(row.options) as Record<string, unknown>,
      });
      byTemplate.set(row.template_id, list);
    }
    return { db, byTemplate };
  };

  it("resolves 98% of every generator field slot in the corpus", () => {
    const { db, byTemplate } = load();
    try {
      const cards = db
        .prepare("SELECT id, template_id FROM cards WHERE template_id IS NOT NULL")
        .all() as { id: string; template_id: string }[];
      const valuesOf = db.prepare("SELECT field_id, value FROM card_field_values WHERE card_id = ?");
      const resolver = storeTextResolver(db);

      let exact = 0;
      let otherVoice = 0;
      let missing = 0;
      let mismatch = 0;
      let unbuildable = 0;

      for (const card of cards) {
        const fields = byTemplate.get(card.template_id) ?? [];
        if (!fields.some((f) => isGeneratorType(f.type))) continue;
        const values = new Map<string, string>();
        for (const v of valuesOf.all(card.id) as { field_id: string; value: string }[]) {
          values.set(v.field_id, v.value);
        }
        const context: FieldContext = { fields, values, resolveGenerated: resolver };
        for (const field of fields) {
          if (!isGeneratorType(field.type)) continue;
          const request = fieldGenerationRequest(field, context);
          if (request === null) {
            unbuildable += 1;
            continue;
          }
          const found = resolveFieldGeneration(db, request, { cardId: card.id });
          if (found.match === "exact") exact += 1;
          else if (found.match === "other-voice") otherVoice += 1;
          else if (found.match === "missing") missing += 1;
          else mismatch += 1;
        }
      }

      const attempted = exact + otherVoice + missing + mismatch;
      // Field SLOTS — one per generator field per card. Not cards, not blobs;
      // three different numbers and the basis has to be named.
      // eslint-disable-next-line no-console
      console.log(
        `generator field slots ${attempted}: exact ${exact}, other-voice ${otherVoice}, ` +
          `missing ${missing}, mismatch ${mismatch}, unbuildable ${unbuildable}`,
      );

      expect(attempted).toBeGreaterThan(18000);
      // The measured figures are 17,502 / 507 / 35 / 312 / 159 over this export.
      // Bounded rather than pinned exactly: the corpus is regenerated by an
      // import and a re-import must not need a test edit to pass.
      expect(exact).toBeGreaterThan(17000);
      expect(exact + otherVoice).toBeGreaterThan(attempted * 0.97);
      expect(missing).toBeLessThan(100);
      expect(unbuildable).toBeLessThan(250);
    } finally {
      db.close();
    }
  });

  it("finds the 単語 audio that renders as silence today", () => {
    const { db, byTemplate } = load();
    try {
      const template = db.prepare("SELECT id FROM templates WHERE name = ?").get("単語") as
        | { id: string }
        | undefined;
      expect(template).toBeDefined();
      const fields = byTemplate.get(template!.id) ?? [];
      const speech = fields.find((f) => f.name === "Speech");
      expect(speech?.type).toBe("speech");

      const cards = db
        .prepare("SELECT id FROM cards WHERE template_id = ?")
        .all(template!.id) as { id: string }[];
      const valuesOf = db.prepare("SELECT field_id, value FROM card_field_values WHERE card_id = ?");

      const requests = [];
      for (const card of cards) {
        const values = new Map<string, string>();
        for (const v of valuesOf.all(card.id) as { field_id: string; value: string }[]) {
          values.set(v.field_id, v.value);
        }
        const request = fieldGenerationRequest(speech!, { fields, values });
        if (request !== null) requests.push(request);
      }

      const { diagnostics } = resolveFieldGenerations(db, requests);
      // eslint-disable-next-line no-console
      console.log(`単語 Speech: ${JSON.stringify(diagnostics)} over ${requests.length} requests`);
      // CLAUDE.md: "単語: 3,477 cards, 3,456 with clips, renders NONE". These are
      // the ones that stop being silent.
      expect(diagnostics.exact).toBeGreaterThan(3200);
      expect(diagnostics.exact + diagnostics.otherVoice).toBeGreaterThan(3350);
    } finally {
      db.close();
    }
  });

  it("carries every key option on the synthetic element: zero divergence", () => {
    const { db, byTemplate } = load();
    try {
      const cards = db
        .prepare("SELECT id, template_id FROM cards WHERE template_id IS NOT NULL LIMIT 2000")
        .all() as { id: string; template_id: string }[];
      const templates = db.prepare("SELECT id, content, reverse_permutation FROM templates").all() as {
        id: string;
        content: string;
        reverse_permutation: string | null;
      }[];
      const byId = new Map(templates.map((t) => [t.id, t]));
      const valuesOf = db.prepare("SELECT field_id, value FROM card_field_values WHERE card_id = ?");
      const resolver = storeTextResolver(db);

      const divergent = new Set<string>();
      for (const card of cards) {
        const template = byId.get(card.template_id);
        const fields = byTemplate.get(card.template_id);
        if (template === undefined || fields === undefined) continue;
        const values = new Map<string, string>();
        for (const v of valuesOf.all(card.id) as { field_id: string; value: string }[]) {
          values.set(v.field_id, v.value);
        }
        const resolved = resolveCard(
          { id: card.id, values: Object.fromEntries(values) },
          { id: template.id, content: template.content, fields },
          { pendingGenerators: true },
        );
        const bound = expandGeneratorFields(resolved.sides, {
          fields,
          values,
          resolveGenerated: resolver,
        });
        for (const d of bound.divergent) divergent.add(d);
      }
      // If this ever fails it names the field and the option, and it means the
      // request and the renderer's own descriptor would hash differently.
      expect([...divergent]).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("voice — pain point #5, in code", () => {
  const scratch = () => {
    const db = openDatabase(MEMORY);
    db.prepare("INSERT INTO decks (id, name) VALUES ('root', '日本語')").run();
    db.prepare("INSERT INTO decks (id, parent_id, name) VALUES ('kid', 'root', '単語')").run();
    db.prepare("INSERT INTO cards (id, deck_id, name) VALUES ('c1', 'kid', '橋')").run();
    return db;
  };

  it("leaves the field's own voice alone by default — the only safe default", () => {
    const db = scratch();
    try {
      // Every one of the 10,791 speech blobs is addressed by the voice Mochi
      // recorded. A non-empty default would miss all of them at once and re-bill
      // the corpus, so shipping `voice.default` empty is load-bearing.
      const resolved = voiceFor(db, "c1", "ja-JP-NanamiNeural");
      expect(resolved).toEqual({ voice: "ja-JP-NanamiNeural", source: "field" });
    } finally {
      db.close();
    }
  });

  it("resolves card over deck over parent deck over workspace", () => {
    const db = scratch();
    try {
      setDefaultVoice(db, "workspace-voice");
      expect(voiceFor(db, "c1", "field-voice")).toMatchObject({
        voice: "workspace-voice",
        source: "workspace",
      });

      setDeckVoice(db, "root", "root-voice");
      expect(voiceFor(db, "c1", "field-voice")).toMatchObject({
        voice: "root-voice",
        source: "deck",
        deckId: "root",
      });

      // The nearer deck wins, which is what makes "単語 gets the male voice,
      // everything else does not" expressible at all.
      setDeckVoice(db, "kid", "kid-voice");
      expect(voiceFor(db, "c1", "field-voice")).toMatchObject({
        voice: "kid-voice",
        source: "deck",
        deckId: "kid",
      });

      setCardVoice(db, "c1", "ja-JP-Neural2-C");
      expect(voiceFor(db, "c1", "field-voice")).toEqual({
        voice: "ja-JP-Neural2-C",
        source: "card",
      });

      // Clearing goes back to inherit rather than to null-as-provider-default.
      setCardVoice(db, "c1", null);
      expect(voiceFor(db, "c1", "field-voice")).toMatchObject({ source: "deck" });
    } finally {
      db.close();
    }
  });

  it("treats whitespace as unset, so a stray space is not a voice name", () => {
    const db = scratch();
    try {
      setCardVoice(db, "c1", "   ");
      expect(voiceFor(db, "c1", "field-voice")).toEqual({
        voice: "field-voice",
        source: "field",
      });
    } finally {
      db.close();
    }
  });

  it("answers for a card that does not exist rather than throwing", () => {
    const db = scratch();
    try {
      expect(voiceFor(db, "nope", "field-voice")).toEqual({
        voice: "field-voice",
        source: "field",
      });
    } finally {
      db.close();
    }
  });
});

describe("resolveGenerationAsync — an HTTP call could not be passed to the sync form", () => {
  it("bills nothing on a hit, and the cache check happens before the await", async () => {
    const db = openDatabase(MEMORY);
    try {
      db.prepare("INSERT INTO decks (id, name) VALUES ('d', 'd')").run();
      db.prepare("INSERT INTO cards (id, deck_id) VALUES ('c', 'd')").run();
      let calls = 0;
      const generate = async () => {
        calls += 1;
        return { bytes: new TextEncoder().encode("audio bytes"), mime: "audio/mpeg" };
      };
      const request = { kind: "speech" as const, text: "橋", lang: "ja-JP", voice: "v" };

      const first = await resolveGenerationAsync(db, request, generate);
      expect(first.hit).toBe(false);
      expect(calls).toBe(1);

      const second = await resolveGenerationAsync(db, request, generate);
      expect(second.hit).toBe(true);
      expect(second.hash).toBe(first.hash);
      // The point: a hit must not cost a request. The synchronous form could not
      // express this at all, so the only way to use it was fetch-then-resolve,
      // which billed on every hit.
      expect(calls).toBe(1);

      // Same identity spelled differently is still one blob and one bill.
      const inline = await resolveGenerationAsync(db, { ...request, lang: "jp" }, generate);
      expect(inline.hash).toBe(first.hash);
      expect(calls).toBe(1);
    } finally {
      db.close();
    }
  });
});
