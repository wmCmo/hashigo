/**
 * 型 is picked, not typed (`app/accent-picker.ts`).
 */
import { describe, expect, it } from "vitest";

import { formatAccent, parseAccent } from "../app/accent-picker.js";
import { accentLabel } from "../src/accent/store.js";

describe("the 型 picker", () => {
  it("reads every label the pipeline writes", () => {
    expect(parseAccent("平板")).toEqual({ type: "平板", mora: null });
    expect(parseAccent("頭高")).toEqual({ type: "頭高", mora: null });
    expect(parseAccent("尾高")).toEqual({ type: "尾高", mora: null });
    expect(parseAccent("中高 (4)")).toEqual({ type: "中高", mora: 4 });
    expect(parseAccent(accentLabel("中高", 3))).toEqual({ type: "中高", mora: 3 });
  });

  it("writes exactly what the pipeline writes, so a hand pick and a derived one match", () => {
    expect(formatAccent("中高", 4)).toBe(accentLabel("中高", 4));
    expect(formatAccent("平板", 4)).toBe("平板"); // the number is noise outside 中高
    expect(formatAccent("中高", null)).toBe("中高");
  });

  it("round-trips: what it writes, it reads back as the same choice", () => {
    for (const [type, mora] of [["平板", null], ["頭高", null], ["中高", 2], ["中高", 5], ["尾高", null]] as const) {
      expect(parseAccent(formatAccent(type, mora))).toEqual({ type, mora });
    }
  });

  it("does not pretend to read a value that is not a label — the editor keeps it as stored", () => {
    expect(parseAccent("平坂")).toBeNull();
    expect(parseAccent("")).toBeNull();
  });
});
