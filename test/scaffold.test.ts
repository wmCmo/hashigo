import { describe, expect, it } from "vitest";

import { APP_NAME, APP_NAME_JA } from "../src/index.js";

describe("scaffold", () => {
  it("runs strict TypeScript under vitest without mangling Japanese", () => {
    expect(APP_NAME).toBe("hashigo");
    expect(APP_NAME_JA).toBe("梯子");

    const decks: readonly string[] = ["単語", "漢字", "例文", "基本情報"];
    expect(decks).toEqual(["単語", "漢字", "例文", "基本情報"]);
    expect([...APP_NAME_JA]).toEqual(["梯", "子"]);
  });
});
