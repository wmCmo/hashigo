/**
 * "generate" under an English example sentence (`app/example-sentence.ts`).
 * The fields are New Vocab's and 文法's as they stand in `build/hashigo.db`.
 */
import { describe, expect, it } from "vitest";

import { exampleSentencePrompt, isEnglishSentenceField, type SentenceField } from "../app/example-sentence.js";

const en = { lang: "en-US", voice: "en-US-AIGenerate1Neural" };
const NEW_VOCAB: SentenceField[] = [
  { id: "name", type: "plain", pos: "a", sourceFieldId: null, options: {} },
  { id: "ixENyvSH", type: "plain", pos: "m", sourceFieldId: null, options: {} },
  { id: "HgZKuNXJ", type: "plain", pos: "s", sourceFieldId: null, options: {} },
  { id: "voFs0qJ5", type: "speech", pos: "v", sourceFieldId: "HgZKuNXJ", options: en },
  { id: "KVfc8fnc", type: "speech", pos: "t", sourceFieldId: "name", options: en },
];
const GRAMMAR: SentenceField[] = [
  { id: "name", type: "plain", pos: "a", sourceFieldId: null, options: {} },
  { id: "sp", type: "plain", pos: "m", sourceFieldId: null, options: {} },
  { id: "out", type: "speech", pos: "n", sourceFieldId: "sp", options: { lang: "ja-JP" } },
];

describe("which field gets the button", () => {
  it("is New Vocab's Example Sentence and nothing else on that template", () => {
    const offered = NEW_VOCAB.filter((f) => isEnglishSentenceField(f, NEW_VOCAB)).map((f) => f.id);
    expect(offered).toEqual(["HgZKuNXJ"]);
  });

  it("is not the head word, though an English voice reads it too", () => {
    expect(isEnglishSentenceField(NEW_VOCAB[0]!, NEW_VOCAB)).toBe(false);
  });

  it("is not a Japanese spoken field", () => {
    expect(GRAMMAR.some((f) => isEnglishSentenceField(f, GRAMMAR))).toBe(false);
  });
});

describe("the prompt", () => {
  it("is his own Mochi phrasing, over the head word as typed", () => {
    expect(exampleSentencePrompt(NEW_VOCAB, new Map([["name", " substrate "]]))).toBe(
      "Example sentence using substrate in English",
    );
  });

  it("asks about the word, not its link or cloze markup", () => {
    expect(exampleSentencePrompt(NEW_VOCAB, new Map([["name", "[[stagnant|PaaW2o7t]]"]]))).toBe(
      "Example sentence using stagnant in English",
    );
    expect(exampleSentencePrompt(NEW_VOCAB, new Map([["name", "{{duvet}}"]]))).toBe("Example sentence using duvet in English");
  });

  it("is null with no word yet", () => {
    expect(exampleSentencePrompt(NEW_VOCAB, new Map([["name", "  "]]))).toBeNull();
  });
});
