/**
 * Wiki-links in the editor — the offsets and the triggers.
 *
 * The fixtures here are the REAL authored forms, taken out of `card_links` rather
 * than invented, because the shapes that break a naive implementation are all his:
 * an inflected display text pointing at a dictionary form, two links butted
 * together with a zero-width mark between them, and a markdown image path whose
 * `@` must not open a menu.
 */

import { existsSync } from "node:fs";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { completeLink, linkAt, linksIn, triggerAt } from "../app/links.js";

const DB = "build/hashigo.db";

describe("finding a link", () => {
  it("reads display and target out of `[[display|id]]`", () => {
    const found = linksIn("見る [[越|4nKAg2kH]] だけ");
    expect(found).toHaveLength(1);
    // start 3 = after "見る ". end = 3 + "[[越|4nKAg2kH]]".length = 3 + 14 = 17.
    expect(found[0]).toMatchObject({ display: "越", target: "4nKAg2kH", start: 3, end: 17 });
  });

  it("HANDLES THE INFLECTION FORM, which is 6% of his links and the whole point", () => {
    // `[[越|4nKAg2kH]]` targets 越す; the display is the conjugated text he wrote.
    // A completion that assumed display === name would make these impossible.
    for (const [raw, display, target] of [
      ["[[越|4nKAg2kH]]", "越", "4nKAg2kH"],
      ["[[引き|10PQotxm]]", "引き", "10PQotxm"],
      ["[[換え|C1p9g1mL]]", "換え", "C1p9g1mL"],
      ["[[smeared|dR6e9MiL]]", "smeared", "dR6e9MiL"],
    ] as const) {
      expect(linksIn(raw)[0]).toMatchObject({ display, target });
    }
  });

  it("finds BOTH halves of a word written as two links", () => {
    // `引き換え` is authored as two links with U+200E between them — the corpus case
    // `src/render/nodes.ts` documents. Both must be addressable independently.
    const text = "[[引き|10PQotxm]]‎[[換え|C1p9g1mL]]";
    const found = linksIn(text);
    expect(found).toHaveLength(2);
    expect(found.map((l) => l.target)).toEqual(["10PQotxm", "C1p9g1mL"]);
    // A click on the second must not resolve to the first.
    expect(linkAt(text, found[1]!.start + 3)?.target).toBe("C1p9g1mL");
    expect(linkAt(text, found[0]!.start + 3)?.target).toBe("10PQotxm");
  });

  it("takes the LAST pipe, so a display text may contain one", () => {
    expect(linksIn("[[a|b|zNZIrcM3]]")[0]).toMatchObject({ display: "a|b", target: "zNZIrcM3" });
  });

  it("treats `[[id]]` with no pipe as its own target — 18 dead links look like this", () => {
    expect(linksIn("[[pvtj9W17]]")[0]).toMatchObject({ display: "pvtj9W17", target: "pvtj9W17" });
  });

  it("never spans a newline, so an unclosed `[[` cannot swallow the field", () => {
    expect(linksIn("[[unclosed\nnext line [[越|4nKAg2kH]]")).toHaveLength(1);
    expect(linksIn("[[unclosed\nnext line [[越|4nKAg2kH]]")[0]!.target).toBe("4nKAg2kH");
  });

  it("is inclusive of the brackets at both ends", () => {
    const text = "x [[越|4nKAg2kH]] y";
    // A ctrl+click lands where the pointer was, and the brackets are part of what
    // he sees. `end` counts too: a click at the right edge must not do nothing.
    expect(linkAt(text, 2)?.target).toBe("4nKAg2kH");
    expect(linkAt(text, 15)?.target).toBe("4nKAg2kH");
    expect(linkAt(text, 1)).toBeNull();
    expect(linkAt(text, 17)).toBeNull();
  });
});

describe("the trigger", () => {
  it("fires on `[[` and carries what has been typed", () => {
    expect(triggerAt("見る [[越", 6)).toMatchObject({ kind: "[[", query: "越", start: 3 });
    expect(triggerAt("[[", 2)).toMatchObject({ kind: "[[", query: "" });
  });

  it("fires on `@` at the start of the text or after whitespace", () => {
    expect(triggerAt("@越", 2)).toMatchObject({ kind: "@", query: "越", start: 0 });
    expect(triggerAt("see @越", 6)).toMatchObject({ kind: "@", query: "越", start: 4 });
    expect(triggerAt("a;\n@x", 5)).toMatchObject({ kind: "@", query: "x" });
  });

  it("DOES NOT fire on `](@media/…)` — three of the four literal @ in the corpus", () => {
    // The measured reason for the whitespace rule. These are markdown image paths
    // and a menu opening over them would be noise on every one.
    for (const text of [
      "![OIG (1).jpeg](@media/mxkKeDnY.jpeg)",
      "![image.png](@media/VCCbIE4c.png)",
      "![20231228.jpg](@media/VTT1PaxL.jpg)",
    ]) {
      const at = text.indexOf("@");
      expect(triggerAt(text, at + 4), text).toBeNull();
    }
  });

  it("allows spaces, because his card names have them", () => {
    // `a ball is in one's court` is a real card name, so a query that stops at the
    // first space could never reach it.
    expect(triggerAt("[[a ball is in", 14)).toMatchObject({ query: "a ball is in" });
    expect(triggerAt("see @a ball is", 14)).toMatchObject({ query: "a ball is" });
  });

  it("STOPS INSIDE A FINISHED LINK — editing one must not reopen the menu", () => {
    const text = "[[越|4nKAg2kH]]";
    for (let caret = 0; caret <= text.length; caret += 1) {
      expect(triggerAt(text, caret), `caret ${caret}`).toBeNull();
    }
  });

  it("gives up on a newline and on an over-long query", () => {
    expect(triggerAt("[[越\nmore", 8)).toBeNull();
    expect(triggerAt(`[[${"あ".repeat(41)}`, 43)).toBeNull();
    expect(triggerAt(`[[${"あ".repeat(40)}`, 42)).not.toBeNull();
  });

  it("prefers the nearer opener when both are present", () => {
    // `@` typed after an abandoned `[[` on the same line: the `[[` is still unclosed,
    // so both match. The one he is typing in is the later one.
    const text = "[[abandoned @越";
    expect(triggerAt(text, text.length)?.kind).toBe("[[");
    // …and with the brackets closed, only the `@` remains live.
    const closed = "[[done|x]] @越";
    expect(triggerAt(closed, closed.length)?.kind).toBe("@");
  });
});

describe("completing a link", () => {
  it("replaces the trigger and lands the caret on the display text", () => {
    const text = "見る [[越";
    const trigger = triggerAt(text, text.length)!;
    const out = completeLink(text, trigger, "越す", "4nKAg2kH");
    expect(out.text).toBe("見る [[越す|4nKAg2kH]]");
    // Just after the display text, before the pipe — the only part worth editing,
    // which is what makes an inflection link one keystroke instead of four.
    expect(out.text.slice(0, out.caret)).toBe("見る [[越す");
  });

  it("works for `@` and removes the `@` itself", () => {
    const text = "see @extol";
    const out = completeLink(text, triggerAt(text, text.length)!, "extol", "rhX2sKTs");
    expect(out.text).toBe("see [[extol|rhX2sKTs]]");
  });

  it("keeps the text after the caret", () => {
    // Caret 5, immediately after 越 — not 6, which is past the space and would make
    // the space part of the query, since spaces are deliberately allowed. Caught by
    // this test on the first run, which is the whole reason it exists.
    const text = "a [[越 trailing";
    const trigger = triggerAt(text, 5)!;
    expect(trigger.query).toBe("越");
    expect(completeLink(text, trigger, "越す", "X").text).toBe("a [[越す|X]] trailing");

    // And at caret 6 the space IS the query's, which is correct and worth pinning
    // so nobody "fixes" it back: `a ball is in one's court` is a real card name.
    expect(triggerAt(text, 6)!.query).toBe("越 ");
  });

  it("round-trips: what it writes is what `linkAt` reads back", () => {
    const out = completeLink("[[q", triggerAt("[[q", 3)!, "引き", "10PQotxm");
    expect(linkAt(out.text, 3)).toMatchObject({ display: "引き", target: "10PQotxm" });
  });
});

describe("against the real corpus", () => {
  it("parses every authored link back to the id `card_links` recorded", () => {
    if (!existsSync(DB)) return;
    const db = new Database(DB, { readonly: true });
    try {
      // Reconstruct each link exactly as `src/render/nodes.ts` does, then parse it.
      // Agreement over all 8,744 is the check: the lexer here and the renderer's
      // must not disagree about what a link is.
      const rows = db
        .prepare("SELECT display_text, to_card_id FROM card_links")
        .all() as { display_text: string; to_card_id: string }[];
      expect(rows.length).toBeGreaterThan(8_000);
      let checked = 0;
      for (const row of rows) {
        // A display text containing a newline or `]]` cannot be represented and does
        // not occur; assert that rather than skipping silently.
        expect(row.display_text).not.toMatch(/[\n\]]/);
        const raw = `[[${row.display_text}|${row.to_card_id}]]`;
        const parsed = linksIn(raw);
        expect(parsed, raw).toHaveLength(1);
        expect(parsed[0]!.target, raw).toBe(row.to_card_id);
        expect(parsed[0]!.display, raw).toBe(row.display_text);
        checked += 1;
      }
      // eslint-disable-next-line no-console
      console.log(`links round-tripped: ${checked}`);
    } finally {
      db.close();
    }
  });
});
