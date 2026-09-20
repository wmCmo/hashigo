/**
 * WHAT A VOICE IS GIVEN TO READ, which is not what the field stores.
 *
 * Zach, 2026-09-20, on an English card: *"the example sentence is in Japanese
 * voice 😭"*. Fixing the voice uncovered what the wrong voice had been masking —
 * the fill path was handing Google the RAW field value, so the clips read markup
 * out loud. Of his 130 mis-voiced clips only **24 were clean**: 76 carried
 * markdown emphasis and 30 were an unfilled `<ai>` prompt recited verbatim.
 *
 * Decision 7 — *"a generator's input is the RENDERED text, never the stored
 * value"* — is the rule that was skipped, and this is it applied to speech.
 *
 * THE STRONGEST EVIDENCE THAT THE TRANSFORM IS RIGHT is that it reproduces
 * Mochi's own `source_text` for the same card: Mochi stored
 * `she was assiduous in point out every feature` where our fill stored
 * `she was **assiduous in** point out every feature`. Pinned below.
 */
import { describe, expect, it } from "vitest";

import { speakableText } from "../src/text/index.js";

describe("what gets spoken", () => {
  it("reproduces Mochi's own stored text for the card Zach reported", () => {
    // The two rows that exist in the corpus for this one sentence, and the
    // difference between them is exactly this function.
    expect(speakableText("she was **assiduous in** point out every feature")).toBe(
      "she was assiduous in point out every feature",
    );
  });

  it("removes emphasis of every marker, longest first", () => {
    expect(speakableText("**a flock of** gulls")).toBe("a flock of gulls");
    expect(speakableText("***very*** strong")).toBe("very strong");
    // The one that would leave a stray asterisk if the order were reversed.
    expect(speakableText("***x***")).toBe("x");
    expect(speakableText("__bold__ and ~~struck~~ and `code`")).toBe(
      "bold and struck and code",
    );
    expect(
      speakableText("a show which should **entice** a new audience **into** the theatre"),
    ).toBe("a show which should entice a new audience into the theatre");
  });

  it("returns the EMPTY STRING for an unfilled generator, rather than reciting it", () => {
    // 30 of the 130. There is no correct way to speak a prompt: read literally it
    // is nonsense, and stripped to its content it becomes the instruction. The
    // caller declines to synthesise instead — those cards need their sentence
    // GENERATED, which is a different repair.
    expect(speakableText("<ai>Example sentence of plectrum</ai>")).toBe("");
    expect(speakableText("<ai>Example sentence of \"dung\"</ai>")).toBe("");
  });

  it("keeps the real sentence when a generator tag merely trails it", () => {
    // These are NOT empty and must still be voiced — the sentence is authored and
    // only the image mount is unfilled. Treating any tag as "nothing to speak"
    // would have silently dropped two real sentences.
    expect(
      speakableText("I planted a beautiful flowering shrub in my garden. <image>shrub</image>"),
    ).toBe("I planted a beautiful flowering shrub in my garden.");
    expect(speakableText("a raging tempest <image>tempest</image>")).toBe("a raging tempest");
  });

  it("leaves Japanese alone", () => {
    // The corpus is 7,409 Japanese clips and this function runs over all of them
    // on any future fill. It must be the identity on ordinary Japanese text.
    expect(speakableText("普通の日本語はそのまま")).toBe("普通の日本語はそのまま");
    expect(speakableText("その提案は合理的であり、検討に値すると思います。")).toBe(
      "その提案は合理的であり、検討に値すると思います。",
    );
  });

  it("is NOT `renderPlainText` — that one must keep the markers", async () => {
    // `renderPlainText` feeds `cards.search_text`, whose contract is "markdown is
    // left readable" so a search for `entice` matches text authored `**entice**`.
    // A reader wants the asterisks and a speaker does not; two transforms, on
    // purpose. If they ever converge, search or speech is wrong.
    const { renderPlainText } = await import("../src/text/index.js");
    const authored = "a show which should **entice** a new audience";
    expect(renderPlainText(authored)).toContain("**");
    expect(speakableText(authored)).not.toContain("**");
  });

  it("collapses the whitespace a removed tag leaves behind", () => {
    // A mount removed from the middle would otherwise leave a double space, and
    // a trailing one would leave the string ending in a space — neither changes
    // the audio, but both change the IDENTITY if this were ever keyed on.
    expect(speakableText("before <image>x</image> after")).toBe("before after");
    expect(speakableText("  padded  ")).toBe("padded");
  });
});
