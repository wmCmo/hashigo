import { describe, expect, it } from "vitest";

import { speakableText } from "../src/text/index.js";

describe("what gets spoken", () => {
  it("reproduces Mochi's own stored text for the card Zach reported", () => {
    expect(speakableText("she was **assiduous in** point out every feature")).toBe(
      "she was assiduous in point out every feature",
    );
  });

  it("removes emphasis of every marker, longest first", () => {
    expect(speakableText("**a flock of** gulls")).toBe("a flock of gulls");
    expect(speakableText("***very*** strong")).toBe("very strong");
    expect(speakableText("***x***")).toBe("x");
    expect(speakableText("__bold__ and ~~struck~~ and `code`")).toBe(
      "bold and struck and code",
    );
    expect(
      speakableText("a show which should **entice** a new audience **into** the theatre"),
    ).toBe("a show which should entice a new audience into the theatre");
  });

  it("returns the EMPTY STRING for an unfilled generator, rather than reciting it", () => {
    expect(speakableText("<ai>Example sentence of plectrum</ai>")).toBe("");
    expect(speakableText("<ai>Example sentence of \"dung\"</ai>")).toBe("");
  });

  it("keeps the real sentence when a generator tag merely trails it", () => {
    expect(
      speakableText("I planted a beautiful flowering shrub in my garden. <image>shrub</image>"),
    ).toBe("I planted a beautiful flowering shrub in my garden.");
    expect(speakableText("a raging tempest <image>tempest</image>")).toBe("a raging tempest");
  });

  it("leaves Japanese alone", () => {
    expect(speakableText("普通の日本語はそのまま")).toBe("普通の日本語はそのまま");
    expect(speakableText("その提案は合理的であり、検討に値すると思います。")).toBe(
      "その提案は合理的であり、検討に値すると思います。",
    );
  });

  it("is NOT `renderPlainText` — that one must keep the markers", async () => {
    const { renderPlainText } = await import("../src/text/index.js");
    const authored = "a show which should **entice** a new audience";
    expect(renderPlainText(authored)).toContain("**");
    expect(speakableText(authored)).not.toContain("**");
  });

  it("collapses the whitespace a removed tag leaves behind", () => {
    expect(speakableText("before <image>x</image> after")).toBe("before after");
    expect(speakableText("  padded  ")).toBe("padded");
  });
});
