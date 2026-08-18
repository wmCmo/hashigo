/**
 * Stage 1 — the Mochi export reader: Transit off the wire, then the deck walk.
 *
 * A `.mochi` file is a ZIP holding `data.json` (Transit-encoded JSON) plus flat
 * media files. This is a port of `tools/mochi.py`, which is the reference
 * implementation and whose docstring documents the format traps. Everything
 * below was checked against the three real exports (7,716 cards, 102,020
 * reviews); see `test/transit.test.ts`.
 *
 * THE ENCODING (verbose Transit-JSON — no cache codes appear in these exports,
 * verified: zero `"^n"` strings across all three files)
 *
 *   "~:foo"            keyword -> "foo". Applies to map KEYS and to VALUES:
 *                      ids, deck refs and field types all arrive this way, so
 *                      `"~:id":"~:KzBUXn1Q"` is the id "KzBUXn1Q".
 *   {"~#list": [...]}  list. Used for `templates` and for empty `cards`.
 *   {"~#set":  [...]}  set, decoded as an array (`tags`, `cloze/indexes`).
 *   "~t<millis>"       instant, epoch ms. 204,040 occurrences: review dates.
 *   {"~#dt": <millis>} instant, epoch ms — a DIFFERENT encoding of the same
 *                      concept, 1,022 occurrences: created-at, updated-at,
 *                      published?. Both forms appear; both must be handled.
 *   "~~x" "~`x" "~^x"  escapes for a literal leading "~", "`" or "^".
 *
 * TWO DEVIATIONS FROM tools/mochi.py, both bugs found while porting. Measured
 * counts are in the test.
 *
 *   1. Python unescapes only "~~". The exports use the "~`" escape 42 times,
 *      28 of them in card field values — dictionary glosses that begin with a
 *      markdown code span, e.g. "~`INFORMAL`\ndie." for "`INFORMAL`\ndie."
 *      Python leaves the leading "~" in place and corrupts all 28. Transit escapes
 *      "~", "^" and "`" identically, so all three are handled here.
 *   2. Python unescapes values but not map KEYS. `component-cache` is keyed by
 *      the generator's source text, and one of those keys is
 *      "~~に越したことはない {:lang \"ja-JP\", ...}". Decoding the value to
 *      "~に越したことはない" while leaving the key escaped means the cache key
 *      no longer matches the text it caches. Keys are unescaped here.
 *
 * THE WALKER TRAP. `walkCards` must dedupe by object identity. In these exports
 * `decks` is a flat array at the root and nesting is expressed by `parent-id`,
 * so a deck node has no `decks` of its own — but it does expose `cards`, and the
 * recursive walk reaches those cards twice: once from the parent's loop over
 * `deck.cards`, once from the deck's own top-level `cards`. Without the identity
 * set the naive walk returns 11,894 cards for 日本語 instead of 5,947, exactly
 * 2x, which is the documented symptom.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { TrackKind } from "../schema/index.js";

/** `version` on the export root. Both `schema/version` values observed are 35. */
export const MOCHI_FORMAT_VERSION = 2;

/** A decoded Transit map. Values stay `unknown`: the JSON is not typed. */
export type MochiRecord = Readonly<Record<string, unknown>>;

const KEYWORD_PREFIX = "~:";
const INSTANT_PREFIX = "~t";
/** Transit escapes a leading reserved character by prepending "~". */
const ESCAPED = new Set(["~~", "~`", "~^"]);
const DIGITS = /^-?\d+$/;

/**
 * Recursively strip Transit encoding. Instants become `Date`; sets become
 * arrays; keywords become plain strings.
 */
export function untransit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(untransit);
  if (typeof value === "string") return untransitString(value);
  if (typeof value !== "object" || value === null) return value;

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1) {
    const [tag, body] = entries[0] as [string, unknown];
    if (tag === "~#list" || tag === "~#set") {
      return Array.isArray(body) ? body.map(untransit) : untransit(body);
    }
    if (tag === "~#dt") {
      return typeof body === "number" ? new Date(body) : untransit(body);
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, member] of entries) out[untransitKey(key)] = untransit(member);
  return out;
}

function untransitString(text: string): string | Date {
  if (text.startsWith(KEYWORD_PREFIX)) return text.slice(2);
  if (ESCAPED.has(text.slice(0, 2))) return text.slice(1);
  if (text.startsWith(INSTANT_PREFIX)) {
    const millis = text.slice(2);
    // Python falls back to the bare remainder when the tail is not a number.
    return DIGITS.test(millis) ? new Date(Number(millis)) : millis;
  }
  return text;
}

/** Keys carry keywords and escapes, but never instants. See deviation 2 above. */
function untransitKey(key: string): string {
  if (key.startsWith(KEYWORD_PREFIX)) return key.slice(2);
  if (ESCAPED.has(key.slice(0, 2))) return key.slice(1);
  return key;
}

/** Decode the text of a `data.json`. */
export function decodeExport(json: string): MochiRecord {
  const decoded = untransit(JSON.parse(json));
  if (!isRecord(decoded)) throw new Error("data.json did not decode to a map");
  return decoded;
}

/** Read and decode `<deckDir>/data.json` from an extracted .mochi export. */
export function loadExport(deckDir: string): MochiRecord {
  return decodeExport(readFileSync(join(deckDir, "data.json"), "utf8"));
}

// ─── walking ─────────────────────────────────────────────────────────────────

/** A deck node plus where the tree put it. */
export interface WalkedDeck {
  readonly deck: MochiRecord;
  /** Slash-joined deck names down to and including this deck. */
  readonly path: string;
  /** Parent by nesting, i.e. the deck whose `decks` array held this one. */
  readonly nestedParentId: string | null;
  /** 0 for a deck directly under the export root. */
  readonly depth: number;
}

/** A card plus the deck it was found in. */
export interface WalkedCard {
  readonly card: MochiRecord;
  /** Path of the containing deck node, or "(root)" for a card on the root. */
  readonly deckPath: string;
  /** `deck-id` off the card, falling back to the containing deck node. */
  readonly deckId: string | null;
}

/**
 * Every deck in the export, exactly once, parents before children.
 *
 * Deduped by identity for the same reason `walkCards` is: a node reachable both
 * as a child and at the top level must not be emitted twice.
 */
export function walkDecks(root: MochiRecord): WalkedDeck[] {
  const out: WalkedDeck[] = [];
  const seen = new Set<object>();

  const visit = (node: MochiRecord, path: readonly string[], parentId: string | null): void => {
    for (const deck of asRecords(node["decks"])) {
      if (seen.has(deck)) continue;
      seen.add(deck);
      const here = [...path, asText(deck["name"]) || "?"];
      out.push({
        deck,
        path: here.join("/"),
        nestedParentId: parentId,
        depth: here.length - 1,
      });
      visit(deck, here, asText(deck["id"]) || null);
    }
  };

  visit(root, [], null);
  return out;
}

/**
 * Every card in the export, exactly once. Deduped by object identity — see the
 * walker trap in the header.
 */
export function walkCards(root: MochiRecord): WalkedCard[] {
  const out: WalkedCard[] = [];
  const seen = new Set<object>();

  const take = (node: MochiRecord, deckPath: string, fallbackDeckId: string | null): void => {
    for (const card of asRecords(node["cards"])) {
      if (seen.has(card)) continue;
      seen.add(card);
      out.push({ card, deckPath, deckId: asText(card["deck-id"]) || fallbackDeckId });
    }
  };

  take(root, "(root)", null);
  for (const { deck, path } of walkDecks(root)) {
    take(deck, path, asText(deck["id"]) || null);
  }
  return out;
}

// ─── card readers ────────────────────────────────────────────────────────────

/**
 * All authored text on a card: `content` plus every field value.
 *
 * `content` is "" on 4,193 of the 7,716 cards — the real text lives in
 * `fields[].value` — so a scan that reads only `content` sees almost nothing.
 * 16 cards have neither: blank "Untitled card" stubs with no reviews.
 */
export function cardText(card: MochiRecord): string {
  const parts = [asText(card["content"])];
  for (const field of Object.values(asRecord(card["fields"]))) {
    if (isRecord(field) && typeof field["value"] === "string") parts.push(field["value"]);
  }
  return parts.join("\n");
}

/**
 * Mochi's three parallel review arrays as named tracks. `reviews` /
 * `reverse-reviews` / `cloze/reviews` all map onto the one track concept; the
 * cloze array is unindexed in this corpus (`cloze/indexes` is empty on all
 * 7,716 cards), so it becomes the single track `cloze:0`.
 */
export function reviewTracks(card: MochiRecord): Map<TrackKind, MochiRecord[]> {
  const tracks = new Map<TrackKind, MochiRecord[]>();
  const add = (kind: TrackKind, raw: unknown): void => {
    const rows = asRecords(raw);
    if (rows.length > 0) tracks.set(kind, rows);
  };
  add("forward", card["reviews"]);
  add("reverse", card["reverse-reviews"]);
  add("cloze:0", card["cloze/reviews"]);
  return tracks;
}

// ─── coercion ────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is MochiRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** A map, or an empty map. Never throws: absent keys are the common case. */
export function asRecord(value: unknown): MochiRecord {
  return isRecord(value) ? value : {};
}

/** An array of maps, skipping anything that is not one. */
export function asRecords(value: unknown): MochiRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** A string, or "". Booleans and numbers are NOT coerced — see `asFieldValue`. */
export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Mochi's `?`-suffixed flags are tri-state in practice: true / false / absent. */
export function isTrue(value: unknown): boolean {
  return value === true;
}

/** An instant, whichever of the two encodings produced it, or null. */
export function asDate(value: unknown): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

/** RFC 3339 in UTC with milliseconds, matching the schema's `...Z` columns. */
export function rfc3339(date: Date): string {
  return date.toISOString();
}
