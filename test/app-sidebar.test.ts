import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../app/sidebar.ts", import.meta.url), "utf8");
const body = (name: string): string => {
  const from = source.indexOf(`function ${name}(`);
  return source.slice(from, source.indexOf("\n}\n", from));
};

describe("the deck tree after a failed load", () => {
  it("sets decksLoaded only AFTER the request answered — a failure must leave it down", () => {
    const load = body("loadDecks");
    const asked = load.indexOf('ask<"decks">');
    const loaded = load.indexOf("decksLoaded = true");
    expect(asked).toBeGreaterThan(-1);
    expect(loaded).toBeGreaterThan(asked);
    expect(load.slice(0, asked)).not.toContain("decksLoaded = true");
  });

  it("the rail's fill does not leave a rejected load unhandled", () => {
    expect(body("fillSidebar")).toContain("loadDecks().catch(");
  });
});
