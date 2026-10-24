/**
 * The sidebar's deck tree records "loaded" only once it has loaded.
 *
 * `app/sidebar.ts` touches the DOM at import, so this reads the source the way
 * `test/sync.test.ts` reads the worker's — the property is an ordering, and an
 * ordering is what a structural test can pin.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../app/sidebar.ts", import.meta.url), "utf8");
const body = (name: string): string => {
  const from = source.indexOf(`function ${name}(`);
  return source.slice(from, source.indexOf("\n}\n", from));
};

describe("the deck tree after a failed load", () => {
  it("sets decksLoaded only AFTER the request answered — a failure must leave it down", () => {
    // 2026-09-18: the flag was set before `ask`, so a request made while the
    // worker was still opening the database left the tree empty until `/`.
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
