import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { TrackKind } from "../schema/index.js";

export const MOCHI_FORMAT_VERSION = 2;

export type MochiRecord = Readonly<Record<string, unknown>>;

const KEYWORD_PREFIX = "~:";
const INSTANT_PREFIX = "~t";
const ESCAPED = new Set(["~~", "~`", "~^"]);
const DIGITS = /^-?\d+$/;

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
    return DIGITS.test(millis) ? new Date(Number(millis)) : millis;
  }
  return text;
}

function untransitKey(key: string): string {
  if (key.startsWith(KEYWORD_PREFIX)) return key.slice(2);
  if (ESCAPED.has(key.slice(0, 2))) return key.slice(1);
  return key;
}

export function decodeExport(json: string): MochiRecord {
  const decoded = untransit(JSON.parse(json));
  if (!isRecord(decoded)) throw new Error("data.json did not decode to a map");
  return decoded;
}

export function loadExport(deckDir: string): MochiRecord {
  return decodeExport(readFileSync(join(deckDir, "data.json"), "utf8"));
}

export interface WalkedDeck {
  readonly deck: MochiRecord;
  readonly path: string;
  readonly nestedParentId: string | null;
  readonly depth: number;
}

export interface WalkedCard {
  readonly card: MochiRecord;
  readonly deckPath: string;
  readonly deckId: string | null;
}

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

export function cardText(card: MochiRecord): string {
  const parts = [asText(card["content"])];
  for (const field of Object.values(asRecord(card["fields"]))) {
    if (isRecord(field) && typeof field["value"] === "string") parts.push(field["value"]);
  }
  return parts.join("\n");
}

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

export function isRecord(value: unknown): value is MochiRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export function asRecord(value: unknown): MochiRecord {
  return isRecord(value) ? value : {};
}

export function asRecords(value: unknown): MochiRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isTrue(value: unknown): boolean {
  return value === true;
}

export function asDate(value: unknown): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

export function rfc3339(date: Date): string {
  return date.toISOString();
}
