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
import { MEMORY, type Db } from "../src/db/index.js";
import { MemoryBlobStore, type BlobStore } from "../src/blobs/store.js";
import { sha256Hex } from "../src/blobs/sha256.js";
import { audioHashCandidates, cardAudioResolver, resolveAudioHash } from "../src/cards/index.js";
import { resolveGenerationAsync } from "../src/import/blobs.js";
import {
  FILL_VOICE,
  generateText,
  ollamaReachable,
  OLLAMA_MIN_PREDICT,
  stripThinking,
  systemPrompt,
  resolveDescriptorText,
  storeDescriptorText,
  storeGeneratedSpeech,
} from "../src/generate/index.js";
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
import { orderSides, resolveCard, type TemplateInput } from "../src/template/index.js";
import { memoryDocument, renderResolvedCard, renderSides, serialise } from "../src/render/index.js";
import { alignFurigana, rubyPlainText } from "../src/render/ruby.js";

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

  /**
   * THE COMPOSED PIPELINE, AT CORPUS SCALE. resolve -> expand -> render, which is
   * the exact path stage 7 walks for every card, and which nothing tested end to
   * end: the sweep above stops at the field-slot level and never renders, and
   * `test/render.test.ts`'s 7,716-card sweep never calls `expandGeneratorFields`.
   *
   * BASIS, because three different numbers are available and only one is meant:
   * forward direction only, the cards that HAVE a template, counting
   * `GeneratorMount.name === "speech"` from `renderSides` after expansion. Not
   * field slots (18,356), not blobs (10,791), not media mounts.
   *
   * A NOTE ON HOW THESE FIGURES WERE ARRIVED AT, because it nearly went wrong. A
   * first attempt reported `expanded: 0` on a real card and I nearly recorded that
   * as a finding. It was an artifact of probing ONE arbitrary card with `LIMIT 1`:
   * exactly 10 of the 7,716 templated cards carry no field values at all, and that
   * was one of them. Over the corpus the expansion fires 10,722 times. A count
   * taken from a single row is not a measurement.
   */
  it("expands and renders every speech slot in the corpus, and diverges on none", () => {
    const { db, byTemplate } = load();
    try {
      const templates = new Map<string, TemplateInput>();
      for (const t of db
        .prepare("SELECT id, content, reverse_permutation FROM templates")
        .all() as { id: string; content: string; reverse_permutation: string | null }[]) {
        templates.set(t.id, {
          id: t.id,
          content: t.content,
          fields: (byTemplate.get(t.id) ?? []).map((f) => ({
            id: f.id,
            name: f.name,
            type: f.type,
          })),
          reversePermutation:
            t.reverse_permutation === null
              ? null
              : (JSON.parse(t.reverse_permutation) as number[]),
        });
      }
      const cards = db
        .prepare("SELECT id, content, template_id FROM cards WHERE template_id IS NOT NULL")
        .all() as { id: string; content: string; template_id: string }[];
      const valuesOf = db.prepare(
        "SELECT field_id, value FROM card_field_values WHERE card_id = ?",
      );

      const sweep = (pendingGenerators: boolean) => {
        let mounts = 0;
        let expanded = 0;
        let divergent = 0;
        let noValues = 0;
        const cardsWithMounts = new Set<string>();
        for (const card of cards) {
          const template = templates.get(card.template_id);
          if (template === undefined) continue;
          const values: Record<string, string> = {};
          for (const row of valuesOf.all(card.id) as { field_id: string; value: string }[]) {
            values[row.field_id] = row.value;
          }
          if (Object.keys(values).length === 0) noValues += 1;
          const resolved = resolveCard(
            { id: card.id, content: card.content, values },
            template,
            { pendingGenerators },
          );
          // The list `load()` already built — reusing it rather than re-shaping
          // it keeps this sweep on the same field data as the slot sweep above.
          const fields = byTemplate.get(card.template_id) ?? [];
          const bound = expandGeneratorFields(resolved.sides, {
            fields,
            values: new Map(Object.entries(values)),
          });
          expanded += bound.expanded.length;
          divergent += bound.divergent.length;
          const out = renderSides(
            orderSides(bound.sides, "forward", template.reversePermutation ?? null),
            { document: memoryDocument() },
          );
          const speech = out.generations.filter((g) => g.name === "speech").length;
          mounts += speech;
          if (speech > 0) cardsWithMounts.add(card.id);
        }
        return { mounts, expanded, divergent, noValues, cards: cardsWithMounts.size };
      };

      const on = sweep(true);
      const off = sweep(false);
      // eslint-disable-next-line no-console
      console.log(
        `composed pipeline: pending=true ${on.mounts} speech mounts over ${on.cards} cards ` +
          `(expanded ${on.expanded}) · pending=false ${off.mounts} over ${off.cards} ` +
          `(expanded ${off.expanded})`,
      );

      expect(on).toEqual({
        mounts: 6_857,
        cards: 5_665,
        expanded: 10_725,
        divergent: 0,
        noValues: 10,
      });

      // `pendingGenerators` IS LOAD-BEARING, and this is the number that says so.
      // With it off the markers are substituted away, so the expansion has nothing
      // to rewrite and the only speech left is the handful authored as inline
      // `<speech>` elements. 31 against 6,855 — a caller that forgets the flag
      // loses 99.5% of the audio and sees no error.
      expect(off.expanded).toBe(0);
      expect(off.mounts).toBe(31);

      // DIVERGENT IS THE ONE THAT MATTERS MOST. `expandGeneratorFields` documents
      // it as "the ONE way this module can go quietly wrong": a key option that
      // cannot ride on the synthetic element makes the renderer hash a different
      // key than the request beside it, and the two disagree with nothing to show.
      // The module claims zero over the corpus; asserted here rather than claimed.
      expect(on.divergent).toBe(0);
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

// ─── generating what Mochi never generated (Zach, 2026-09-14) ────────────────

/**
 * `storeDescriptorText` — the write side, and the only one in `src/generate`.
 *
 * The claim worth pinning is CLOSURE: whatever the renderer computed as a
 * descriptor, storing under it must make `resolveDescriptorText` find it with the
 * same descriptor. That round trip is the entire contract, and it is exactly what
 * `scripts/generate-examples.ts` once got wrong — it passed an options bag of
 * `{}` instead of the field's own subset and filed all 67 sentences under a
 * near-miss, where they resolved as `other-voice` rather than `exact`.
 */
const DESCRIPTOR = {
  kind: "ai" as const,
  text: "Describe a word 疑念 using emojis only",
  lang: null,
  voice: null,
  options: {} as Readonly<Record<string, string>>,
};

describe("storing a generation made on demand", () => {
  it("closes the round trip: what it stores, the resolver finds", () => {
    const db = openDatabase(MEMORY);
    expect(resolveDescriptorText(db, DESCRIPTOR)).toBeNull();
    storeDescriptorText(db, DESCRIPTOR, "🤔❓💭🚫🤝");
    expect(resolveDescriptorText(db, DESCRIPTOR)).toBe("🤔❓💭🚫🤝");
    db.close();
  });

  it("derives the identity rather than trusting the caller's option bag", () => {
    // `generationIdentity` normalises the text and strips lang/voice OUT of the
    // options. A caller that passed those through would file the blob under a key
    // the resolver never builds — which is the bug that put 67 sentences at
    // `other-voice`. Storing with them present and resolving with them present
    // must still be an EXACT hit, because both go through the same derivation.
    const db = openDatabase(MEMORY);
    const noisy = { ...DESCRIPTOR, options: { lang: "ja", voice: "x", "ai-task": "custom" } };
    storeDescriptorText(db, noisy, "🧐");
    expect(resolveDescriptorText(db, noisy)).toBe("🧐");
    // And the row it wrote carries the canonical subset, not what was handed in.
    const row = db
      .prepare("SELECT options FROM blobs WHERE kind = 'ai'")
      .get() as { options: string };
    expect(row.options).toBe('{"ai-task":"custom"}');
    db.close();
  });

  it("is idempotent — the same text is the same blob, decision 4", () => {
    const db = openDatabase(MEMORY);
    const first = storeDescriptorText(db, DESCRIPTOR, "🤔❓");
    const again = storeDescriptorText(db, DESCRIPTOR, "🤔❓");
    expect(again).toBe(first);
    const { n } = db.prepare("SELECT count(*) AS n FROM blobs").get() as { n: number };
    expect(n).toBe(1);
    db.close();
  });

  it("leaves refcount at 1, because nothing in the schema can point at an inline generator", () => {
    // 575 of these are `{{<ai>…</ai>}}` in a TEMPLATE BODY. `blob_refs` keys on a
    // field, so there is no row to hold this down — and a blob at refcount 0 is
    // what `sweepUnreferenced` collects.
    const db = openDatabase(MEMORY);
    storeDescriptorText(db, DESCRIPTOR, "🤔");
    const row = db.prepare("SELECT refcount, byte_size FROM blobs").get() as {
      refcount: number;
      byte_size: number;
    };
    expect(row.refcount).toBe(1);
    expect(row.byte_size).toBeGreaterThan(0);
    db.close();
  });

  it("REFUSES a speech kind — nothing here may write audio", () => {
    // Decision 18 (the TTS key never reaches a client) and the deferral repeated
    // to five agents. The endpoint refuses earlier so nothing is billed; this is
    // the second gate, and it is the one a future caller will meet.
    const db = openDatabase(MEMORY);
    expect(() => storeDescriptorText(db, { ...DESCRIPTOR, kind: "speech" }, "nope")).toThrow(
      /not a text generation/,
    );
    expect(db.prepare("SELECT count(*) AS n FROM blobs").get()).toEqual({ n: 0 });
    db.close();
  });

  it("REFUSES an empty generation, which would be a permanent unreadable hit", () => {
    // `lookupGeneration` filters `byte_size > 0` to keep Mochi's 10 zero-byte
    // failures from becoming cache hits. A zero-byte row written here could never
    // be read AND could never be replaced, because the hash would be taken.
    const db = openDatabase(MEMORY);
    expect(() => storeDescriptorText(db, DESCRIPTOR, "")).toThrow(/empty generation/);
    db.close();
  });

  it("stores text the review screen reads back through the SAME path it renders with", () => {
    // Not a second resolver: `resolveDescriptorText` is what `db.worker.ts`'s
    // `generatedText` calls for every slot on every card, so a hit here is a hit
    // on screen.
    const db = openDatabase(MEMORY);
    storeDescriptorText(db, DESCRIPTOR, "🤔❓💭🚫🤝");
    const asTheWorkerAsks = resolveDescriptorText(db, {
      kind: "ai",
      text: "Describe a word 疑念 using emojis only",
      lang: null,
      voice: null,
      options: {},
    });
    expect(asTheWorkerAsks).toBe("🤔❓💭🚫🤝");
    db.close();
  });
});

/**
 * ─── FILLING A CLIP THAT WAS NEVER MADE ─────────────────────────────────────
 *
 * Zach, 2026-09-15, on a 合理 card: *"it won't let me play the audio of the
 * example sentence — do you think because it's missing?"* It was. 785 of 10,420
 * mounts resolve to nothing.
 *
 * The delicate part is not the synthesis, it is the IDENTITY. The card asks for
 * `ja-JP-NanamiNeural` because the voice lives on the field; the bytes come from
 * Google `ja-JP-Neural2-C`. The row must say Neural2-C — anything else makes 785
 * rows claim a provenance they do not have — so the RESOLVER bridges the gap,
 * and only for speech, and only to that one named voice.
 */
describe("a clip this project synthesised", () => {
  function speechFixture(): { db: Db; store: BlobStore } {
    const db = openDatabase(MEMORY);
    // The digest is injected so `src/blobs/store.ts` stays free of `node:crypto`
    // — and it must be the SAME one `storeGeneratedSpeech` uses, or the store
    // rejects the write as an address that does not match its bytes.
    const store = new MemoryBlobStore(sha256Hex);
    return { db, store };
  }

  it("records the voice that actually spoke, not the one the card asked for", () => {
    const { db, store } = speechFixture();
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]);
    const hash = storeGeneratedSpeech(db, store, { text: "こんにちは", lang: "ja-JP", options: {} }, bytes);

    const row = db
      .prepare("SELECT kind, mime, byte_size, voice, lang, options, refcount, bytes FROM blobs WHERE hash = ?")
      .get(hash) as Record<string, unknown>;
    expect(row["kind"]).toBe("speech");
    expect(row["mime"]).toBe("audio/mpeg");
    expect(row["byte_size"]).toBe(bytes.length);
    // THE CLAIM. Nanami never touched these bytes.
    expect(row["voice"]).toBe(FILL_VOICE);
    expect(row["lang"]).toBe("ja-JP");
    // The payload is in the STORE, never inline — `blobs.bytes` is for text.
    expect(row["bytes"]).toBeNull();
    expect(store.read(hash)).toEqual(bytes);
    // Refcount 1: a generator mount has no `blob_refs` row, so nothing else will
    // ever count this reference and a 0 is one sweep away from deletion.
    expect(row["refcount"]).toBe(1);
    db.close();
  });

  it("files a clip it did NOT synthesise under the voice that did", () => {
    // The endpoint can now answer a "generate audio" press from a clip already on
    // the laptop — Mochi's own `en-US-AIGenerate1Neural`, say — and the device
    // caches whatever came back. Filing those bytes at `FILL_VOICE` would claim
    // this project spoke them, which is the same false provenance the test above
    // refuses in the other direction, and would corrupt the voice survey.
    const { db, store } = speechFixture();
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 7, 7, 7]);
    const text = "she was assiduous in point out every feature";
    const hash = storeGeneratedSpeech(
      db,
      store,
      { text, lang: "en-US", voice: "en-US-AIGenerate1Neural", options: { gender: "male" } },
      bytes,
    );
    const row = db.prepare("SELECT voice, lang FROM blobs WHERE hash = ?").get(hash) as
      Record<string, unknown>;
    expect(row["voice"]).toBe("en-US-AIGenerate1Neural");
    expect(row["lang"]).toBe("en-US");

    // AND IT RESOLVES ON THE FIRST LOOKUP, not through the fill-voice fallback —
    // which is the other half of why the producing voice is the right key.
    expect(
      resolveAudioHash(db, "someCard", {
        origin: "generator",
        request: {
          kind: "speech",
          text,
          lang: "en-US",
          voice: "en-US-AIGenerate1Neural",
          options: { gender: "male" },
        },
      }),
    ).toBe(hash);
    db.close();
  });

  it("still defaults to the fill voice when no producing voice is given", () => {
    // Every existing caller omits it, and the key scheme must not move for them:
    // `../src/blobs/generation.ts` spells out what one changed bit costs.
    const { db, store } = speechFixture();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const withOut = storeGeneratedSpeech(db, store, { text: "いぬ", lang: "ja-JP", options: {} }, bytes);
    const withNull = storeGeneratedSpeech(
      db, store, { text: "いぬ", lang: "ja-JP", voice: null, options: {} }, bytes,
    );
    const withFill = storeGeneratedSpeech(
      db, store, { text: "いぬ", lang: "ja-JP", voice: FILL_VOICE, options: {} }, bytes,
    );
    expect(withNull).toBe(withOut);
    expect(withFill).toBe(withOut);
    expect(
      (db.prepare("SELECT voice FROM blobs WHERE hash = ?").get(withOut) as { voice: string }).voice,
    ).toBe(FILL_VOICE);
    db.close();
  });

  it("is idempotent in both halves — a second tap is not a second row", () => {
    const { db, store } = speechFixture();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const a = storeGeneratedSpeech(db, store, { text: "ねこ", lang: "ja-JP", options: {} }, bytes);
    const b = storeGeneratedSpeech(db, store, { text: "ねこ", lang: "ja-JP", options: {} }, bytes);
    expect(a).toBe(b);
    expect(
      (db.prepare("SELECT count(*) AS n FROM blobs").get() as { n: number }).n,
    ).toBe(1);
    db.close();
  });

  it("refuses an empty clip, which could never be read back", () => {
    const { db, store } = speechFixture();
    expect(() =>
      storeGeneratedSpeech(db, store, { text: "むおん", lang: "ja-JP", options: {} }, new Uint8Array()),
    ).toThrow(/empty clip/);
    db.close();
  });

  it("is found by a card asking for a DIFFERENT voice — and only for speech", () => {
    const { db, store } = speechFixture();
    const text = "その提案は合理的であり、検討に値すると思います。";
    const hash = storeGeneratedSpeech(db, store, { text, lang: "ja-JP", options: {} }, new Uint8Array([9, 9, 9]));

    const asked = (kind: string, voice: string | null): string | null =>
      resolveAudioHash(db, "someCard", {
        origin: "generator",
        request: { kind: kind as never, text, voice, lang: "ja-JP", options: {} },
      });

    // The card's own request. Misses on the exact identity, then finds the fill.
    expect(asked("speech", "ja-JP-NanamiNeural")).toBe(hash);
    // Already asking for the fill voice: a direct hit, no fallback needed.
    expect(asked("speech", FILL_VOICE)).toBe(hash);
    // NOT A GENERAL "any voice will do". A text kind never falls back — its
    // identity is the whole cache and a wrong hit there is a wrong answer.
    expect(asked("ai", "ja-JP-NanamiNeural")).toBeNull();
    db.close();
  });

  /**
   * ─── THE ROW IS NOT THE CLIP, AND THAT MADE THE GAP UNREPAIRABLE ──────────
   *
   * Zach, 2026-09-16, on a 略歴 card: *"is it just me or nothing happens when
   * you click the generate buttons"*. Reproduced in the Browser pane: the
   * button said `speaking…`, the laptop answered, the worker filed the bytes —
   * and a fresh `generate audio` button took its place. For ever.
   *
   * A device carries every `blobs` ROW (the card seed is whole) and only the
   * payloads `app-bootstrap` had budget for, which is each card's CHEAPEST clip
   * first (decision 34). The 2026-09-16 fill gave that sentence a second,
   * smaller `ja-JP-Neural2-C` row, so the seed shipped the 50 KB Neural2-C
   * payload and left the 158 KB Nanami one behind — measured in the shipped
   * seed, 139 speech rows there have no payload.
   *
   * The card asks Nanami. The Nanami ROW hits. The fallback never ran, and one
   * `BlobMissingError` became `null`.
   */
  it("plays the fill clip when the asked voice's ROW is there and its BYTES are not", () => {
    const { db, store } = speechFixture();
    const text = "彼の略歴を見ると、彼は多くの異なる業界で経験を積んできたことがわかります。";
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 7, 7, 7]);
    const fill = storeGeneratedSpeech(db, store, { text, lang: "ja-JP", options: {} }, bytes);

    // The Mochi-era row, present with its byte_size and WITHOUT its payload —
    // exactly what a seed rebuild leaves on the device. Written by hand because
    // nothing in this project can produce that state on purpose.
    db.prepare(
      `INSERT INTO blobs (hash, kind, mime, byte_size, source_text, voice, lang, options, refcount)
       VALUES (?, 'speech', 'audio/mpeg', 158400, ?, 'ja-JP-NanamiNeural', 'ja-JP', '{}', 1)`,
    ).run("deadbeef".repeat(8), text);

    const address = {
      origin: "generator",
      request: { kind: "speech", text, voice: "ja-JP-NanamiNeural", lang: "ja-JP", options: {} },
    } as const;

    // The PREFERRED hash is still the row the card asked for — this does not
    // quietly re-rank provenance, and `fill-generations` still reads it that way.
    expect(resolveAudioHash(db, "someCard", address)).toBe("deadbeef".repeat(8));
    expect(audioHashCandidates(db, "someCard", address)).toEqual(["deadbeef".repeat(8), fill]);

    // But the resolver, which is the half that holds the store, plays the clip
    // that exists. Before this it returned null and the card was mute.
    const played = cardAudioResolver(db, "someCard", { store })(address);
    expect(played?.hash).toBe(fill);
    expect(played?.bytes).toEqual(bytes);
    db.close();
  });

  it("is still silent, loudly, when NEITHER hash has bytes", () => {
    const { db } = speechFixture();
    const text = "どこにも音がない";
    db.prepare(
      `INSERT INTO blobs (hash, kind, mime, byte_size, source_text, voice, lang, options, refcount)
       VALUES (?, 'speech', 'audio/mpeg', 1200, ?, 'ja-JP-NanamiNeural', 'ja-JP', '{}', 1)`,
    ).run("f0".repeat(32), text);
    // An empty store, not a missing one: the walk must exhaust its candidates
    // and return null rather than throw the first `BlobMissingError` at the page.
    const resolver = cardAudioResolver(db, "someCard", { store: new MemoryBlobStore(sha256Hex) });
    expect(
      resolver({
        origin: "generator",
        request: { kind: "speech", text, voice: "ja-JP-NanamiNeural", lang: "ja-JP", options: {} },
      }),
    ).toBeNull();
    db.close();
  });

  it("does NOT rescue a card whose text differs — the fallback is voice only", () => {
    const { db, store } = speechFixture();
    storeGeneratedSpeech(db, store, { text: "ねこ", lang: "ja-JP", options: {} }, new Uint8Array([1]));
    const other = resolveAudioHash(db, "someCard", {
      origin: "generator",
      request: { kind: "speech", text: "いぬ", voice: "ja-JP-NanamiNeural", lang: "ja-JP", options: {} },
    });
    expect(other).toBeNull();
    db.close();
  });
});

/**
 * ─── WHICH MODEL, AND WHAT IT IS ACTUALLY ASKED ─────────────────────────────
 *
 * Zach, 2026-09-15: *"instead of a couple $, can we use ollama instead? i have
 * qwen ready on my machine lol"*
 *
 * Two things got pinned here, and the second is a defect that shipped.
 */
describe("the text provider and its prompt", () => {
  it("adds NOTHING for `ai` — Mochi's prompt is already the instruction", () => {
    const prompt = systemPrompt({ kind: "ai", text: "Describe a word 疑念 using emojis only", options: {} });
    // Decision 7: the user message is the identity's source_text. A second
    // opinion about the task would be the renderer arguing with the corpus.
    expect(prompt).not.toMatch(/translate/i);
    expect(prompt).toContain("Reply with the requested content only");
  });

  it("TELLS a translate request to translate, which is the bug it shipped without", () => {
    // ─── MEASURED THE DAY IT WAS FOUND, qwen3:8b, a real corpus sentence ───
    //
    //   sent as the endpoint sent it   努力してこそ、成功をつかむことができる。
    //   came back                      努力してこそ、成功をつかむことができる。
    //   with the instruction below     Only through effort can one grasp success.
    //
    // `vite.generate.ts` sent `descriptor.text` alone under one generic system
    // prompt. Right for `ai`, where the text IS the instruction; for translate
    // the text is only a sentence and nothing said what to do with it. Never
    // caught because the button was tested on emoji and translate is 129 of
    // 2,446 gaps.
    const prompt = systemPrompt({ kind: "translate", text: "努力してこそ", options: { from: "ja", to: "en" } });
    expect(prompt).toMatch(/Translate/);
    expect(prompt).toContain("text in ja");
    expect(prompt).toContain("into en");
  });

  it("reads the language pair from options, never from the script", () => {
    const prompt = systemPrompt({ kind: "translate", text: "hello", options: { from: "en", to: "ja" } });
    expect(prompt).toContain("text in en");
    expect(prompt).toContain("into ja");
    // Absent options still produce a usable instruction rather than `undefined`.
    const bare = systemPrompt({ kind: "translate", text: "x", options: {} });
    expect(bare).toContain("text in ja");
    expect(bare).not.toContain("undefined");
  });

  it("strips a thinking block, closed or not", () => {
    // `think: false` is set on every Ollama request, but the flag is a REQUEST
    // and the tag is a fact — another model or another daemon version can emit
    // one anyway, and a card whose emoji line is a paragraph of deliberation is
    // worse than an empty one.
    expect(stripThinking("<think>hmm, 疑念 is doubt</think>🤔❓")).toBe("🤔❓");
    expect(stripThinking("<THINK>x</THINK>  📖  ")).toBe("📖");
    // TRUNCATED AT THE TOKEN LIMIT mid-thought. Taking everything after an
    // unclosed tag is deliberate: half a monologue stored in a field is the
    // worst of the three outcomes.
    expect(stripThinking("<think>I should consider whether")).toBe("");
    expect(stripThinking("📖💡✨")).toBe("📖💡✨");
  });

  it("says a daemon that is not there is not there, rather than throwing", async () => {
    const refused = (): never => {
      throw new Error("ECONNREFUSED");
    };
    await expect(ollamaReachable("http://127.0.0.1:1", refused as never)).resolves.toBe(false);
    const ok = async (): Promise<{ ok: boolean }> => ({ ok: true });
    await expect(ollamaReachable("http://127.0.0.1:11434", ok as never)).resolves.toBe(true);
  });

  it("sends the RAW text as the user message, and `think: false`", async () => {
    let seen: Record<string, unknown> = {};
    const fake = async (_url: string, init: { body: string }): Promise<unknown> => {
      seen = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true, json: async () => ({ response: "<think>a</think>🐢🍃" }) };
    };
    const out = await generateText(
      { kind: "ai", text: "Describe a word おっとり using emojis only", options: {} },
      { provider: "ollama", model: "qwen3:8b", maxTokens: 256, fetch: fake as never },
    );
    expect(out).toBe("🐢🍃");
    expect(seen["prompt"]).toBe("Describe a word おっとり using emojis only");
    // Qwen3 is a thinking model and Ollama returns the reasoning without this.
    expect(seen["think"]).toBe(false);
    expect(seen["stream"]).toBe(false);
  });
});

/**
 * ─── THE TOKEN BUDGET IS SHARED WITH THE THINKING ───────────────────────────
 *
 * Two of the first three sentences in a real batch run came back empty, and
 * "the model returned nothing" pointed at the model. It was the budget: Ollama
 * counts reasoning against `num_predict` and returns the reasoning in a separate
 * `thinking` field, so a long deliberation stops at `done_reason: "length"` with
 * `response` empty. Measured on gpt-oss:20b:
 *
 *     num_predict=256   eval=256  done=length  response=""
 *     num_predict=2048  eval=421  done=stop    response="When it comes to him…"
 */
describe("a local reasoning model's token budget", () => {
  it("gives the thinking headroom the caller's answer budget does not have", async () => {
    let seen: Record<string, unknown> = {};
    const fake = async (_url: string, init: { body: string }): Promise<unknown> => {
      seen = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true, json: async () => ({ response: "ok", done_reason: "stop" }) };
    };
    await generateText(
      { kind: "ai", text: "x", options: {} },
      { provider: "ollama", model: "gpt-oss:20b", maxTokens: 256, fetch: fake as never },
    );
    // The caller asked for 256 — that is the ANSWER budget, and it must not be
    // what bounds the reasoning that shares it.
    expect((seen["options"] as { num_predict: number }).num_predict).toBe(OLLAMA_MIN_PREDICT);
    expect(OLLAMA_MIN_PREDICT).toBeGreaterThan(256);
  });

  it("names the budget rather than blaming the model when it runs out", async () => {
    const fake = async (): Promise<unknown> => ({
      ok: true,
      json: async () => ({ response: "", thinking: "We need to translate…", done_reason: "length" }),
    });
    await expect(
      generateText(
        { kind: "translate", text: "彼なら彼で", options: { from: "ja", to: "en" } },
        { provider: "ollama", model: "gpt-oss:20b", maxTokens: 256, fetch: fake as never },
      ),
    ).rejects.toThrow(/token budget thinking/);
  });

  it("still reports a genuinely empty answer, with no thinking, as empty", async () => {
    const fake = async (): Promise<unknown> => ({
      ok: true,
      json: async () => ({ response: "  ", done_reason: "stop" }),
    });
    // Not an error here: the caller decides what an empty field means, and
    // `vite.generate.ts` already refuses to store one.
    await expect(
      generateText(
        { kind: "ai", text: "x", options: {} },
        { provider: "ollama", model: "gpt-oss:20b", maxTokens: 256, fetch: fake as never },
      ),
    ).resolves.toBe("");
  });
});

/**
 * ─── THE FURIGANA FILL'S OUTPUT FORMAT, AGAINST THE REAL CORPUS ─────────────
 *
 * A furigana generation does NOT hold a reading. It holds the INPUT with a
 * `(reading)` after each KANJI RUN — which is why decision 37's `readingOf()`
 * has to unwrap it, and why dumping the whole reading after a mixed base would
 * put `あり得る(ありえる)` on 350 cards instead of `あり得(え)る`.
 *
 * These cases are lifted from rows that already exist in `build/hashigo.db`, so
 * the test is "does the fill produce what Mochi produced" rather than "does it
 * produce what I expected".
 */
describe("the furigana fill's bracket form", () => {
  it("annotates each kanji run and leaves the kana alone", () => {
    // Real rows: "あり得る" -> "あり得(え)る", "おろし金" -> "おろし金(がね)".
    const stored = (base: string, reading: string): string =>
      rubyPlainText(alignFurigana(base, reading));
    expect(stored("あり得る", "ありえる")).toBe("あり得(え)る");
    expect(stored("おろし金", "おろしがね")).toBe("おろし金(がね)");
    expect(stored("お世話", "おせわ")).toBe("お世話(せわ)");
    // A base that is all kanji takes one bracket over the whole of it.
    expect(stored("試行", "しこう")).toBe("試行(しこう)");
  });

  it("leaves an all-kana base exactly as it is", () => {
    // Real rows: "いたす" -> "いたす", "おっしゃる" -> "おっしゃる". Annotating
    // すずらん with すずらん is noise on the card.
    const built = alignFurigana("いたす", "いたす");
    expect(built.kind).toBe("none");
    // `none` carries no segments — the script writes the base through unchanged,
    // which is exactly the row the corpus holds.
    expect(built.segments).toEqual([]);
  });

  it("REFUSES rather than annotating coarsely when the reading will not place", () => {
    // `alignFurigana` falls back to one reading over the whole base when it
    // cannot match the kana runs. The corpus holds no such row for a mixed base,
    // and writing one would put a coarse annotation on exactly the cards where
    // the reading is the answer being drilled.
    const built = alignFurigana("言い渡す", "いーわたす");
    expect(built.kind).toBe("whole");
    expect(built.reason).not.toBe("");
  });
});
