/**
 * EDITS TRAVEL AS A DELTA TOO — decision 64, 2026-11-10.
 *
 * Zach noticed that every open on the phone or tablet downloaded at least 5 MB and
 * asked whether that was really a 差分. It was not. Decision 51 made GRADES a delta
 * and left every other write — a card made, a field value, a flag — on the full
 * payload. He makes every card on the laptop, so most days the laptop pushed its
 * whole base and every other device downloaded and merged all of it: 5.31 MB of
 * JSON (1.0 MB on the wire, brotli) and ~8 s of merge on the phone, for one card.
 *
 * ─── WHAT AN EDIT DELTA IS ──────────────────────────────────────────────────
 *
 * The full payload, minus every row the mailbox already holds from this device.
 * "Already holds" is a FINGERPRINT of what this device last sent: one hash per
 * card (its flags, collection state, values and — for a card made here — its own
 * row), per template, per field row, per deck, per setting and per retired clip.
 * The next edit push exports the payload as before, hashes it the same way, and
 * sends only the groups whose hash moved.
 *
 * A fingerprint and not a clock, on purpose. `card_field_values` has no clock
 * (decision 33's known gap), and a `cards.updated_at` watermark would trust every
 * writer — the editor, the accent helper, a deck op, a script — to stamp it. A
 * write that forgot would never leave the device. Comparing what is sent with
 * what was sent needs nobody's cooperation: any change to a row the full payload
 * carries is a change in its group's hash.
 *
 * ─── WHY THE MERGE GUARANTEES ARE UNCHANGED ─────────────────────────────────
 *
 * The receiver wraps the delta as an ordinary payload (`deltaPayload`) and runs
 * the one `mergeSync`. That is only safe because absence in a payload already
 * means "I say nothing": no apply path deletes a row it was not sent (pinned by
 * the grade delta's own test). So a payload holding a subset of the rows merges
 * exactly as the full payload would have merged THOSE rows.
 *
 * Two rows depend on another row being present, and the grouping is what keeps
 * them together:
 *
 *   - A field value is kept or taken by its CARD's clock, read from `cardFlags`.
 *     A value sent without its card's flag row would compare against "no clock"
 *     and always lose — so a card's values never travel without its flag row.
 *   - `cardState` is applied with the backup's additive `max(archived, ?)`, and
 *     the merge puts the local row back only for cards in `cardFlags`. Sent alone
 *     it would re-archive a card un-archived elsewhere (the 2026-10-22 bug) — so
 *     it never travels without its flag row either.
 *
 * Grades are not in the fingerprint: they already travel by the mark
 * (`./delta.ts`), and a grade never changes a card's group (the scheduler writes
 * `card_tracks`, not `cards`).
 *
 * BROWSER-PORTABLE: pure functions over a payload, no database, no `node:`.
 */

import type {
  ArchivedCard,
  ArchivedCardState,
  ArchivedField,
  ArchivedFieldValue,
  ArchivedSetting,
  ArchivedTemplate,
} from "../backup/archive.js";
import type { CardFlags, DeckFlags, SyncPayload } from "./merge.js";

/** Group key → hash of the rows this device last sent for it. */
export type SentIndex = Readonly<Record<string, string>>;

/** The rows of a full payload whose group changed since the fingerprint. */
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

/**
 * cyrb53 — a 53-bit string hash, synchronous and the same in a worker and Node.
 *
 * Not cryptographic and does not need to be: the only failure is an edit whose
 * new rows hash the same as its old ones, ~1 in 9·10^15 per changed group. A
 * missed edit would still arrive with the next full payload.
 */
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

/** Every group of a payload, keyed and hashed. */
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

/** The fingerprint of a payload: what a peer holds once this payload has reached it. */
export function indexPayload(payload: SyncPayload): Record<string, string> {
  const index: Record<string, string> = {};
  for (const [key, group] of groupsOf(payload)) index[key] = group.hash;
  return index;
}

/**
 * The groups of `payload` that differ from `sent`, and the fingerprint to keep
 * once they have been delivered.
 *
 * A group that was sent and is now GONE is not reported: no apply path deletes,
 * so a deletion could not be carried by the full payload either.
 */
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

/** True when the edits carry nothing. */
export function noEdits(edits: SyncEdits | undefined): boolean {
  return edits === undefined || Object.values(edits).every((list) => list.length === 0);
}

/** A stored fingerprint, or null when it is missing or unreadable. */
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
