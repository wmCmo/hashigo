import type {
  ArchivedCard,
  ArchivedCardState,
  ArchivedField,
  ArchivedFieldValue,
  ArchivedSetting,
  ArchivedTemplate,
} from "../backup/archive.js";
import type { CardFlags, DeckFlags, SyncPayload } from "./merge.js";

export type SentIndex = Readonly<Record<string, string>>;

export interface SyncEdits {
  readonly cardFlags: readonly CardFlags[];
  readonly cardState: readonly ArchivedCardState[];
  readonly fieldValues: readonly ArchivedFieldValue[];
  readonly localCards: readonly ArchivedCard[];
  readonly deckFlags: readonly DeckFlags[];
  readonly templates: readonly ArchivedTemplate[];
  readonly localFields: readonly ArchivedField[];
  readonly settings: readonly ArchivedSetting[];
  readonly retiredClips: readonly string[];
}

export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

interface CardGroup {
  flags?: CardFlags;
  state?: ArchivedCardState;
  card?: ArchivedCard;
  values: ArchivedFieldValue[];
}

function cardGroups(payload: SyncPayload): Map<string, CardGroup> {
  const groups = new Map<string, CardGroup>();
  const group = (id: string): CardGroup => {
    let found = groups.get(id);
    if (found === undefined) {
      found = { values: [] };
      groups.set(id, found);
    }
    return found;
  };
  for (const row of payload.cardFlags) group(row.cardId).flags = row;
  for (const row of payload.archive.cardState ?? []) group(row.cardId).state = row;
  for (const row of payload.archive.localCards ?? []) group(row.id).card = row;
  for (const row of payload.archive.fieldValues) group(row.cardId).values.push(row);
  return groups;
}

const cardHash = (g: CardGroup): string =>
  hashText(JSON.stringify([g.flags ?? null, g.state ?? null, g.card ?? null, g.values]));

const fieldKey = (row: ArchivedField): string => `f:${row.templateId}\u0000${row.id}`;

function groupsOf(payload: SyncPayload): Map<string, { hash: string; take: (edits: MutableEdits) => void }> {
  const out = new Map<string, { hash: string; take: (edits: MutableEdits) => void }>();
  for (const [id, g] of cardGroups(payload)) {
    out.set(`c:${id}`, {
      hash: cardHash(g),
      take: (e) => {
        if (g.flags !== undefined) e.cardFlags.push(g.flags);
        if (g.state !== undefined) e.cardState.push(g.state);
        if (g.card !== undefined) e.localCards.push(g.card);
        e.fieldValues.push(...g.values);
      },
    });
  }
  for (const row of payload.deckFlags ?? []) {
    out.set(`d:${row.deckId}`, { hash: hashText(JSON.stringify(row)), take: (e) => e.deckFlags.push(row) });
  }
  for (const row of payload.archive.templates ?? []) {
    out.set(`t:${row.id}`, { hash: hashText(JSON.stringify(row)), take: (e) => e.templates.push(row) });
  }
  for (const row of payload.archive.localFields) {
    out.set(fieldKey(row), { hash: hashText(JSON.stringify(row)), take: (e) => e.localFields.push(row) });
  }
  for (const row of payload.archive.settings) {
    out.set(`s:${row.key}`, { hash: hashText(JSON.stringify(row)), take: (e) => e.settings.push(row) });
  }
  for (const clip of payload.retiredClips ?? []) {
    out.set(`r:${clip}`, { hash: "1", take: (e) => e.retiredClips.push(clip) });
  }
  return out;
}

type MutableEdits = { -readonly [K in keyof SyncEdits]: SyncEdits[K][number][] };

export function indexPayload(payload: SyncPayload): Record<string, string> {
  const index: Record<string, string> = {};
  for (const [key, group] of groupsOf(payload)) index[key] = group.hash;
  return index;
}

export function editsSince(
  payload: SyncPayload,
  sent: SentIndex,
): { readonly edits: SyncEdits; readonly rows: number; readonly index: Record<string, string> } {
  const edits: MutableEdits = {
    cardFlags: [],
    cardState: [],
    fieldValues: [],
    localCards: [],
    deckFlags: [],
    templates: [],
    localFields: [],
    settings: [],
    retiredClips: [],
  };
  const index: Record<string, string> = {};
  for (const [key, group] of groupsOf(payload)) {
    index[key] = group.hash;
    if (sent[key] !== group.hash) group.take(edits);
  }
  const rows = Object.values(edits).reduce((sum, list) => sum + list.length, 0);
  return { edits, rows, index };
}

export function noEdits(edits: SyncEdits | undefined): boolean {
  return edits === undefined || Object.values(edits).every((list) => list.length === 0);
}

export function parseSentIndex(text: string | null): SentIndex | null {
  if (text === null || text === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SentIndex)
      : null;
  } catch {
    return null;
  }
}
