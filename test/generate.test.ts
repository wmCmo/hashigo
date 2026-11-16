import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
  cleanGenerated,
  sentenceProblem,
  emojiOnly,
  isEmojiPrompt,
  resolveDescriptorText,
  storeDescriptorText,
  storeGeneratedSpeech,
  fillVoiceFor,
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
import { accentOfLabel } from "../src/accent/speech.js";
import { wordPronunciation } from "../src/review/index.js";
import { GENERATOR_FIELD_TYPES, FIELD_TYPE_BLOB_KIND } from "../src/schema/index.js";
import { orderSides, resolveCard, type TemplateInput } from "../src/template/index.js";
import { memoryDocument, renderResolvedCard, renderSides, serialise } from "../src/render/index.js";
import { alignFurigana, rubyPlainText } from "../src/render/ruby.js";

const DB = "build/hashigo.db";
const haveCorpus = existsSync(DB);

describe("the generation input transform", () => {
  it("strips cloze braces, which is what made 基本情報 miss all 471 of its cards", () => {
    expect(generationInput("{{データ}}と{{メソッド}}を1つに")).toBe("データとメソッドを1つに");
    expect(generationInput("{{1::indexed}}")).toBe("indexed");
  });

  it("reduces wiki-links to display text and drops the invisible marks", () => {
    expect(generationInput("[[引き|10PQotxm]]‎[[換え|C1p9g1mL]]")).toBe("引き換え");
  });

  it("does NOT normalise whitespace or NFC — that belongs to generationIdentity", () => {
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
    const plain = resolveCard({ id: "c", values: { word: "橋" } }, template);
    expect(plain.warnings.map((w) => w.kind)).toContain("generator-pending");
    expect(serialise(renderResolvedCard(plain, { document: memoryDocument() }).root)).not.toContain(
      "Speech",
    );
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
    expect(html).not.toContain("autoplay");
    expect(html).not.toMatch(/<audio[^>]*\ssrc=/);
    expect(result.generations).toHaveLength(1);
    expect(result.generations[0]?.request?.text).toBe("橋");
  });

  it("cannot forge markup out of a field value", () => {
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
      // eslint-disable-next-line no-console
      console.log(
        `generator field slots ${attempted}: exact ${exact}, other-voice ${otherVoice}, ` +
          `missing ${missing}, mismatch ${mismatch}, unbuildable ${unbuildable}`,
      );

      expect(attempted).toBeGreaterThan(18000);
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
      expect([...divergent]).toEqual([]);
    } finally {
      db.close();
    }
  });

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
        mounts: 6_829,
        cards: 5_665,
        expanded: 10_697,
        divergent: 0,
        noValues: 10,
      });

      expect(off.expanded).toBe(0);
      expect(off.mounts).toBe(31);

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
      expect(calls).toBe(1);

      const inline = await resolveGenerationAsync(db, { ...request, lang: "jp" }, generate);
      expect(inline.hash).toBe(first.hash);
      expect(calls).toBe(1);
    } finally {
      db.close();
    }
  });
});

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
    const db = openDatabase(MEMORY);
    const noisy = { ...DESCRIPTOR, options: { lang: "ja", voice: "x", "ai-task": "custom" } };
    storeDescriptorText(db, noisy, "🧐");
    expect(resolveDescriptorText(db, noisy)).toBe("🧐");
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
    const db = openDatabase(MEMORY);
    expect(() => storeDescriptorText(db, { ...DESCRIPTOR, kind: "speech" }, "nope")).toThrow(
      /not a text generation/,
    );
    expect(db.prepare("SELECT count(*) AS n FROM blobs").get()).toEqual({ n: 0 });
    db.close();
  });

  it("REFUSES an empty generation, which would be a permanent unreadable hit", () => {
    const db = openDatabase(MEMORY);
    expect(() => storeDescriptorText(db, DESCRIPTOR, "")).toThrow(/empty generation/);
    db.close();
  });

  it("stores text the review screen reads back through the SAME path it renders with", () => {
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

describe("a clip this project synthesised", () => {
  function speechFixture(): { db: Db; store: BlobStore } {
    const db = openDatabase(MEMORY);
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
    expect(row["voice"]).toBe(FILL_VOICE);
    expect(row["lang"]).toBe("ja-JP");
    expect(row["bytes"]).toBeNull();
    expect(store.read(hash)).toEqual(bytes);
    expect(row["refcount"]).toBe(1);
    db.close();
  });

  it("files a clip it did NOT synthesise under the voice that did", () => {
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

    expect(asked("speech", "ja-JP-NanamiNeural")).toBe(hash);
    expect(asked("speech", FILL_VOICE)).toBe(hash);
    expect(asked("ai", "ja-JP-NanamiNeural")).toBeNull();
    db.close();
  });

  it("plays the fill clip when the asked voice's ROW is there and its BYTES are not", () => {
    const { db, store } = speechFixture();
    const text = "彼の略歴を見ると、彼は多くの異なる業界で経験を積んできたことがわかります。";
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 7, 7, 7]);
    const fill = storeGeneratedSpeech(db, store, { text, lang: "ja-JP", options: {} }, bytes);

    db.prepare(
      `INSERT INTO blobs (hash, kind, mime, byte_size, source_text, voice, lang, options, refcount)
       VALUES (?, 'speech', 'audio/mpeg', 158400, ?, 'ja-JP-NanamiNeural', 'ja-JP', '{}', 1)`,
    ).run("deadbeef".repeat(8), text);

    const address = {
      origin: "generator",
      request: { kind: "speech", text, voice: "ja-JP-NanamiNeural", lang: "ja-JP", options: {} },
    } as const;

    expect(resolveAudioHash(db, "someCard", address)).toBe("deadbeef".repeat(8));
    expect(audioHashCandidates(db, "someCard", address)).toEqual(["deadbeef".repeat(8), fill]);

    const played = cardAudioResolver(db, "someCard", { store })(address);
    expect(played?.hash).toBe(fill);
    expect(played?.bytes).toEqual(bytes);
    db.close();
  });

  it("plays the second row of the SAME identity when only its bytes are on the device", () => {
    const { db, store } = speechFixture();
    const text = "浮動小数点数において、指数（**Exponent**）はその基数を何乗するかを示す数である。";
    const address = {
      origin: "generator",
      request: { kind: "speech", text, voice: null, lang: "ja-JP", options: {} },
    } as const;
    db.prepare(
      `INSERT INTO blobs (hash, kind, mime, byte_size, source_text, voice, lang, options, refcount)
       VALUES (?, 'speech', 'audio/mpeg', 167232, ?, 'ja-JP-Neural2-C', 'ja-JP', '{}', 1)`,
    ).run("0".repeat(64), text);
    expect(cardAudioResolver(db, "someCard", { store })(address)).toBeNull();

    const bytes = new Uint8Array([0x49, 0x44, 0x33, 9, 9, 9]);
    const fresh = storeGeneratedSpeech(db, store, { text, lang: "ja-JP", options: {} }, bytes);
    expect(fresh > "0".repeat(64)).toBe(true);

    expect(resolveAudioHash(db, "someCard", address)).toBe("0".repeat(64));
    expect(audioHashCandidates(db, "someCard", address)).toEqual(["0".repeat(64), fresh]);
    const played = cardAudioResolver(db, "someCard", { store })(address);
    expect(played?.hash).toBe(fresh);
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

describe("the text provider and its prompt", () => {
  it("adds NOTHING for `ai` — Mochi's prompt is already the instruction", () => {
    const prompt = systemPrompt({ kind: "ai", text: "Describe a word 疑念 using emojis only", options: {} });
    expect(prompt).not.toMatch(/translate/i);
    expect(prompt).toContain("Reply with the requested content only");
  });

  it("TELLS a translate request to translate, which is the bug it shipped without", () => {
    const prompt = systemPrompt({ kind: "translate", text: "努力してこそ", options: { from: "ja", to: "en" } });
    expect(prompt).toMatch(/Translate/);
    expect(prompt).toContain("text in ja");
    expect(prompt).toContain("into en");
  });

  it("reads the language pair from options, never from the script", () => {
    const prompt = systemPrompt({ kind: "translate", text: "hello", options: { from: "en", to: "ja" } });
    expect(prompt).toContain("text in en");
    expect(prompt).toContain("into ja");
    const bare = systemPrompt({ kind: "translate", text: "x", options: {} });
    expect(bare).toContain("text in ja");
    expect(bare).not.toContain("undefined");
  });

  it("strips a thinking block, closed or not", () => {
    expect(stripThinking("<think>hmm, 疑念 is doubt</think>🤔❓")).toBe("🤔❓");
    expect(stripThinking("<THINK>x</THINK>  📖  ")).toBe("📖");
    expect(stripThinking("<think>I should consider whether")).toBe("");
    expect(stripThinking("📖💡✨")).toBe("📖💡✨");
  });

  it("strips the long spelling, <thinking>, that leaked into 朗報's 例文", () => {
    const leaked =
      "<thinking>Create a natural example sentence using 朗報.</thinking>試験に合格したという朗報が届いた。";
    expect(stripThinking(leaked)).toBe("試験に合格したという朗報が届いた。");
    expect(stripThinking("<thinking>I should consider whether")).toBe("");
    expect(stripThinking("<think>a</thinking>📖")).toBe("");
  });

  it("strips the control tags a hosted model echoed into 左遷's emoji", () => {
    const leaked =
      "<thinking_mode>auto</thinking_mode>\n\n<reasoning_effort>medium</reasoning_effort>👔📉🏢➡️🏝️😞";
    expect(stripThinking(leaked)).toBe("👔📉🏢➡️🏝️😞");
    expect(stripThinking("<b>🙇</b>")).toBe("<b>🙇</b>");
  });

  it("the device cleans what it already holds, on read and on store", () => {
    const source = readFileSync(new URL("../app/db.worker.ts", import.meta.url), "utf8");
    const read = source.slice(source.indexOf("function generatedText("));
    expect(read.slice(0, read.indexOf("\n}\n"))).toContain("stripThinking(stored)");
    const store = source.slice(source.indexOf("function storeGeneration("));
    expect(store.slice(0, store.indexOf("\n}\n"))).toContain("stripThinking(request.text)");
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
    expect(seen["think"]).toBe(false);
    expect(seen["stream"]).toBe(false);
  });
});

describe("the Gemini provider", () => {
  const ok = (parts: unknown[], finishReason = "STOP") => async (): Promise<unknown> => ({
    ok: true,
    json: async () => ({ candidates: [{ finishReason, content: { role: "model", parts } }] }),
  });

  it("sends the raw prompt, the shared system prompt, the key, and thinking HIGH", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    let seen: Record<string, unknown> = {};
    const fake = async (u: string, init: { body: string; headers: Record<string, string> }): Promise<unknown> => {
      url = u;
      headers = init.headers;
      seen = JSON.parse(init.body) as Record<string, unknown>;
      return ok([{ text: "物語はいよいよ佳境に入った。" }])();
    };
    const descriptor = { kind: "ai", text: "Example sentence using 佳境 in Japanese (Don't translate)", options: {} };
    const out = await generateText(descriptor, {
      provider: "gemini", apiKey: "k", model: "gemini-3.6-flash", maxTokens: 256, fetch: fake as never,
    });
    expect(out).toBe("物語はいよいよ佳境に入った。");
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
    expect(headers["x-goog-api-key"]).toBe("k");
    expect(seen["contents"]).toEqual([{ role: "user", parts: [{ text: descriptor.text }] }]);
    expect(seen["systemInstruction"]).toEqual({ parts: [{ text: systemPrompt(descriptor) }] });
    const config = seen["generationConfig"] as { maxOutputTokens: number; thinkingConfig: { thinkingLevel: string } };
    expect(config.thinkingConfig.thinkingLevel).toBe("HIGH");
    expect(config.maxOutputTokens).toBeGreaterThan(2048);
  });

  it("drops thought parts and keeps the answer", async () => {
    const fake = ok([{ text: "Let me pick a context…", thought: true }, { text: "回路が異常な発振を起こしている。" }]);
    const out = await generateText(
      { kind: "ai", text: "Example sentence using 発振 in Japanese (Don't translate)", options: {} },
      { provider: "gemini", apiKey: "k", model: "gemini-3.6-flash", maxTokens: 256, fetch: fake as never },
    );
    expect(out).toBe("回路が異常な発振を起こしている。");
  });

  it("refuses an answer that did not finish, rather than returning half a sentence", async () => {
    const fake = ok([{ text: "お送りいた" }], "MAX_TOKENS");
    await expect(
      generateText(
        { kind: "ai", text: "Example sentence using 拝見 in Japanese (Don't translate)", options: {} },
        { provider: "gemini", apiKey: "k", model: "gemini-3.6-flash", maxTokens: 256, fetch: fake as never },
      ),
    ).rejects.toThrow(/finishReason=MAX_TOKENS/);
  });

  it("names a blocked prompt and a missing key", async () => {
    const blocked = async (): Promise<unknown> => ({ ok: true, json: async () => ({ promptFeedback: { blockReason: "SAFETY" } }) });
    await expect(
      generateText({ kind: "ai", text: "x", options: {} }, { provider: "gemini", apiKey: "k", model: "m", maxTokens: 256, fetch: blocked as never }),
    ).rejects.toThrow(/blockReason=SAFETY/);
    await expect(
      generateText({ kind: "ai", text: "x", options: {} }, { provider: "gemini", model: "m", maxTokens: 256 }),
    ).rejects.toThrow(/no GEMINI_API_KEY/);
  });

  it("passes a quota refusal through as the status and Google's words", async () => {
    const quota = async (): Promise<unknown> => ({ ok: false, status: 429, text: async () => "RESOURCE_EXHAUSTED" });
    await expect(
      generateText({ kind: "ai", text: "x", options: {} }, { provider: "gemini", apiKey: "k", model: "m", maxTokens: 256, fetch: quota as never }),
    ).rejects.toThrow(/gemini answered 429 — RESOURCE_EXHAUSTED/);
  });
});

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
    await expect(
      generateText(
        { kind: "ai", text: "x", options: {} },
        { provider: "ollama", model: "gpt-oss:20b", maxTokens: 256, fetch: fake as never },
      ),
    ).resolves.toBe("");
  });
});

describe("the furigana fill's bracket form", () => {
  it("annotates each kanji run and leaves the kana alone", () => {
    const stored = (base: string, reading: string): string =>
      rubyPlainText(alignFurigana(base, reading));
    expect(stored("あり得る", "ありえる")).toBe("あり得(え)る");
    expect(stored("おろし金", "おろしがね")).toBe("おろし金(がね)");
    expect(stored("お世話", "おせわ")).toBe("お世話(せわ)");
    expect(stored("試行", "しこう")).toBe("試行(しこう)");
  });

  it("leaves an all-kana base exactly as it is", () => {
    const built = alignFurigana("いたす", "いたす");
    expect(built.kind).toBe("none");
    expect(built.segments).toEqual([]);
  });

  it("REFUSES rather than annotating coarsely when the reading will not place", () => {
    const built = alignFurigana("言い渡す", "いーわたす");
    expect(built.kind).toBe("whole");
    expect(built.reason).not.toBe("");
  });
});

describe("the fill voice is per language", () => {
  it("keeps Japanese on the voice Zach chose by ear, at the SAME key", () => {
    expect(fillVoiceFor("ja-JP")).toBe(FILL_VOICE);
    expect(fillVoiceFor("ja")).toBe(FILL_VOICE);
  });

  it("gives English an English voice", () => {
    expect(fillVoiceFor("en-US")).toMatch(/^en-/);
    expect(fillVoiceFor("en-GB")).toBe(fillVoiceFor("en-US"));
    expect(fillVoiceFor("en")).toBe(fillVoiceFor("en-US"));
  });

  it("falls back to Japanese for a language nothing has chosen, and for nothing at all", () => {
    expect(fillVoiceFor(null)).toBe(FILL_VOICE);
    expect(fillVoiceFor("")).toBe(FILL_VOICE);
    expect(fillVoiceFor(undefined)).toBe(FILL_VOICE);
    expect(fillVoiceFor("ko-KR")).toBe(FILL_VOICE);
  });

  it("files an unvoiced English clip under the English voice", () => {
    const db = openDatabase(MEMORY);
    const store = new MemoryBlobStore(sha256Hex);
    const hash = storeGeneratedSpeech(
      db, store, { text: "a flock of gulls", lang: "en-US", options: {} },
      new Uint8Array([0x49, 0x44, 0x33, 4, 4]),
    );
    const voice = (db.prepare("SELECT voice FROM blobs WHERE hash = ?").get(hash) as
      { voice: string }).voice;
    expect(voice).toMatch(/^en-/);
    expect(voice).not.toBe(FILL_VOICE);
    db.close();
  });
});

describe("emoji lines are cut to their emoji", () => {
  it("drops the chatter and keeps the first run of emoji", () => {
    expect(emojiOnly("Sure! Here is the word 断片 described using emojis: 🔪🧩")).toBe("🔪🧩");
    expect(emojiOnly("🛏️➕🛞💉🏥\n\nExplanation:\n- 🛏️ (Bed): Represents the stretcher")).toBe("🛏️➕🛞💉🏥");
    expect(emojiOnly("Sure! Here's a description of \"conceit\" using emojis:\n\n🧠💭 + 🎭✨ = 🤯📚\n\nExplanation")).toBe(
      "🧠💭 + 🎭✨ = 🤯📚",
    );
    expect(emojiOnly("💇‍♀️✂️👁️➡️ Fringe (bangs) – hair cut")).toBe("💇‍♀️✂️👁️➡️");
    expect(emojiOnly("📈🏛️✨🌅")).toBe("📈🏛️✨🌅");
    expect(emojiOnly("No emoji here at all.")).toBe("");
  });

  it("applies only to an emoji prompt, and always strips thinking tags", () => {
    expect(isEmojiPrompt("Describe a word 断片 using emojis only")).toBe(true);
    expect(isEmojiPrompt("Describe gauze using emojis")).toBe(true);
    expect(isEmojiPrompt("Write an example sentence using 断片")).toBe(false);
    expect(cleanGenerated("Make a sentence with 断片", "Sure! 彼の言葉は断片的だった。")).toBe("Sure! 彼の言葉は断片的だった。");
    expect(cleanGenerated("Describe 断片 using emojis only", "<thinking>x</thinking>Here: 🔪🧩")).toBe("🔪🧩");
  });

  it("the resolver serves the cleaned line, and skips one with no emoji for a remake", () => {
    const db = openDatabase(MEMORY);
    const descriptor = { kind: "ai" as const, text: "Describe a word 断片 using emojis only", lang: null, voice: null, options: {} };
    storeDescriptorText(db, descriptor, "Sure! Here is the word 断片 described using emojis: 🔪🧩");
    expect(resolveDescriptorText(db, descriptor)).toBe("🔪🧩");

    const bare = { ...descriptor, text: "Describe a word 興隆 using emojis only" };
    storeDescriptorText(db, bare, "I'm not sure what you mean.");
    expect(resolveDescriptorText(db, bare)).toBeNull();
    storeDescriptorText(db, bare, "📈🏛️✨🌅");
    expect(resolveDescriptorText(db, bare)).toBe("📈🏛️✨🌅");
  });
});

describe("a word clip's reading and accent", () => {
  it("turns every 型 label into the position yomigana takes", () => {
    expect(accentOfLabel("平板", "とう")).toBe(0);
    expect(accentOfLabel("頭高", "とう")).toBe(1);
    expect(accentOfLabel("尾高", "はな")).toBe(2);
    expect(accentOfLabel("尾高", "しゅっぱつ")).toBe(4);
    expect(accentOfLabel("中高 (3)", "すうせきや")).toBe(3);
    expect(accentOfLabel("中高(2)", "すうせき")).toBe(2);
    expect(accentOfLabel("中高 (1)", "すうせき")).toBe(null);
    expect(accentOfLabel("中高 (4)", "すうせき")).toBe(null);
    expect(accentOfLabel("平板・頭高", "とう")).toBe(null);
    expect(accentOfLabel("", "とう")).toBe(null);
  });

  function wordDb(): ReturnType<typeof openDatabase> {
    const db = openDatabase(MEMORY);
    const at = "2026-01-01T00:00:00.000Z";
    db.prepare("INSERT INTO decks (id, name, updated_at) VALUES ('d', '日本語', ?)").run(at);
    db.prepare("INSERT INTO templates (id, name, content, updated_at) VALUES ('tango', '単語', '<<単語>>', ?)").run(at);
    db.prepare("INSERT INTO templates (id, name, content, updated_at) VALUES ('plain', 'New Vocab', '<<単語>>', ?)").run(at);
    const field = db.prepare(
      `INSERT INTO template_fields (template_id, id, name, type, source_field_id, pos, local, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    field.run("tango", "name", "単語", "plain", null, "a", 0, at);
    field.run("tango", "yomi", "読み", "plain", null, "b", 1, at);
    field.run("tango", "kata", "型", "accent", "name", "c", 1, at);
    field.run("plain", "name", "単語", "plain", null, "a", 0, at);
    const card = db.prepare("INSERT INTO cards (id, deck_id, template_id, name, updated_at) VALUES (?, 'd', ?, ?, ?)");
    const value = db.prepare("INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?)");
    const make = (id: string, template: string, name: string, yomi: string, kata: string): void => {
      card.run(id, template, name, at);
      value.run(id, "name", name);
      if (template === "tango") {
        value.run(id, "yomi", yomi);
        value.run(id, "kata", kata);
      }
    };
    make("tou-tower", "tango", "塔", "とう", "頭高");
    make("tou-ask", "tango", "問う", "とう", "平板");
    make("suuseki", "tango", "数隻", "", "");
    make("suzuran", "tango", "すずらん", "", "平板");
    make("maku", "tango", "まく", "まく", "");
    make("vocab", "plain", "ecology", "", "");
    return db;
  }

  it("塔 and 問う share とう and get their own accents", () => {
    const db = wordDb();
    expect(wordPronunciation(db, "tou-tower", "とう")).toEqual({ waiting: false, pronounce: { reading: "とう", accent: 1 } });
    expect(wordPronunciation(db, "tou-ask", "とう")).toEqual({ waiting: false, pronounce: { reading: "とう", accent: 0 } });
  });

  it("WAITS while a kanji head word has no 読み — the 数隻 → かずせき case", () => {
    expect(wordPronunciation(wordDb(), "suuseki", "数隻")).toEqual({ waiting: true });
  });

  it("a kana head word needs no 読み; a word with no 型 is made from its reading alone", () => {
    const db = wordDb();
    expect(wordPronunciation(db, "suzuran", "すずらん")).toEqual({ waiting: false, pronounce: { reading: "すずらん", accent: 0 } });
    expect(wordPronunciation(db, "maku", "まく")).toEqual({ waiting: false });
  });

  it("leaves every other clip alone: a sentence, a template with no 型", () => {
    const db = wordDb();
    expect(wordPronunciation(db, "tou-tower", "港には漁船が数隻停泊していた。")).toBe(null);
    expect(wordPronunciation(db, "vocab", "ecology")).toBe(null);
  });
});

describe("sentenceProblem", () => {
  const ask = (word: string) => `Example sentence using ${word} in Japanese (Don't translate)`;

  it("catches the word spelled another way", () => {
    expect(sentenceProblem(ask("沁み沁み"), "古い友人からの手紙を読んで、友情のありがたさをしみじみと感じた。")).toMatch(/left 沁み沁み out/);
    expect(sentenceProblem(ask("鯨"), "海でクジラが大きな潮を吹いているのを見て、とても感動しました。")).toMatch(/left 鯨 out/);
  });

  it("catches a stray English word", () => {
    expect(sentenceProblem(ask("凝る"), "彼は料理に凝っていて、毎週末new新しいレシピに挑戦している。")).toMatch(/English/);
  });

  it("passes the word however it is conjugated", () => {
    expect(sentenceProblem(ask("繕う"), "破れた服を母が丁寧に繕ってくれた。")).toBeNull();
    expect(sentenceProblem(ask("一騎討ち"), "決勝戦は、両チームのエースによる一騎討ちとなった。")).toBeNull();
    expect(sentenceProblem(ask("に対する"), "彼は上司に対して丁寧な言葉を使う。")).toBeNull();
    expect(sentenceProblem(ask("ガーゼ"), "傷口に清潔なガーゼを当てて、包帯で固定しました。")).toBeNull();
    expect(sentenceProblem(ask("沁み沁み"), "母の優しさが沁み沁みと身に染みた。")).toBeNull();
  });

  it("leaves capitals alone (SNS, AI)", () => {
    expect(sentenceProblem(ask("拡散"), "その動画はSNSで瞬く間に拡散された。")).toBeNull();
  });

  it("does not check what has no one spelling: a reading, a pattern, an English word, Mochi markup", () => {
    expect(sentenceProblem(ask("ひたい"), "額に汗がにじんだ。")).toBeNull();
    expect(sentenceProblem(ask("～てこそ"), "努力してこそ、成功をつかむことができる。")).toBeNull();
    expect(sentenceProblem("Example sentence using mouth in Japanese (Don't translate)", "口を開けてください。")).toBeNull();
    expect(sentenceProblem(ask("空気|glQvjSyNを読む"), "空気を読むのが得意な猫がいる。")).toBeNull();
  });

  it("matches a compatibility character to the one a model writes (団⼦ is the Kangxi radical)", () => {
    expect(sentenceProblem(ask("団⼦"), "団子を作るのは楽しいです。")).toBeNull();
  });

  it("checks only Japanese sentence prompts", () => {
    expect(sentenceProblem("Describe a word 鯨 using emojis only", "🐋🌊")).toBeNull();
    expect(sentenceProblem("海でクジラを見た。", "I saw a whale in the sea.")).toBeNull();
    expect(sentenceProblem("Example sentence of snare", "He set a snare.")).toBeNull();
    expect(sentenceProblem(ask("鯨"), "海で大きな鯨を見ました。")).toBeNull();
  });
});
