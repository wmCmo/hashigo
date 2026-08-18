import { describe, expect, it } from "vitest";

import { APP_NAME, APP_NAME_JA } from "../src/index.js";

/**
 * Stage 0 smoke test. Proves the toolchain runs end to end (ESM + strict
 * TypeScript + vitest) and that Japanese identifiers survive the source encoding
 * unmangled — this console is cp932, so a UTF-8 slip shows up as mojibake rather
 * than as an error. Deck, template and field names are identifiers; see CLAUDE.md.
 */
describe("scaffold", () => {
  it("runs strict TypeScript under vitest without mangling Japanese", () => {
    expect(APP_NAME).toBe("hashigo");
    expect(APP_NAME_JA).toBe("梯子");

    const decks: readonly string[] = ["単語", "漢字", "例文", "基本情報"];
    expect(decks).toEqual(["単語", "漢字", "例文", "基本情報"]);
    expect([...APP_NAME_JA]).toEqual(["梯", "子"]);
  });
});
