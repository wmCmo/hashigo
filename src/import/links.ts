/**
 * Stage 1 — card-to-card wiki-links, `[[display|card-id]]`.
 *
 * SPEC: 8,690 links across 4,323 cards, 56% of the corpus, and the pattern is
 * morphological decomposition — a compound points at its components
 * (`～に引き換え` links to both 引く and 換える). Two links per card is the
 * commonest case. This is also the half of the "@ reference" request that
 * already exists in the data, so it is stage-1 work, not editor work.
 *
 * WHERE THE LINKS ARE. Both surfaces, not one: 1,011 of the 8,690 are in
 * `content` and 7,679 are inside field values. `content` is "" on 4,193 of the
 * 7,716 cards, so a parser that reads only `content` finds 12% of the links and
 * renders over half the corpus with broken text.
 *
 * UNRESOLVED TARGETS MUST SURVIVE THE IMPORT. `card_links.to_card_id` carries no
 * foreign key on purpose, and `card_links_resolved` reports `resolved = 0` for a
 * target that is not in `cards`. Such a link renders as its plain display text;
 * dropping the row would silently delete authored text.
 *
 * TWO DIFFERENT DENOMINATORS, AND SPEC USES THE OTHER ONE (both measured below,
 * both asserted in test/tags-links.test.ts):
 *
 *   * Parsed from text: 8,690 link rows -> 2,881 distinct targets, of which 15
 *     are outside the three exports, accounting for 18 rows.
 *   * Mochi's own derived `references` array on each card: 7,771 entries, of
 *     which 8 do not resolve. That 8-of-7,771 is the figure SPEC quotes.
 *     `references` is deduped per card and is NOT the same set as the parsed
 *     links — 41 of its entries have no `[[...]]` in the card's text at all
 *     (edits that left the derived array behind), and 92 parsed (from, to)
 *     pairs are missing from it.
 *
 *   The parse is the authority, because it is what renders. `references` is
 *   carried in the report only so the two numbers can be told apart instead of
 *   one silently "disagreeing" with SPEC. See `reconcileReferences`.
 */

import type { Db } from "../db/index.js";

/**
 * `[[display|card-id]]`. Display text stops at `]` or `|`, the target at `]`,
 * which is exactly the reference implementation's rule (tools/mochi.py,
 * WIKI_LINK) and reproduces the 8,690 figure.
 */
export const WIKI_LINK = /\[\[([^\]|]+)\|([^\]]+)\]\]/g;

// ─── row shapes ──────────────────────────────────────────────────────────────

/** Columns of `card_links`. */
export interface CardLinkRow {
  readonly from_card_id: string;
  readonly to_card_id: string;
  readonly display_text: string;
  /** NULL = the link is in `cards.content`; otherwise the field it is in. */
  readonly field_id: string | null;
  /** nth link within that one scope. Unique with (from_card_id, field_id). */
  readonly ordinal: number;
}

/** One `[[...]]` occurrence. */
export interface WikiLink {
  readonly display: string;
  readonly target: string;
}

/** A card, as far as linking is concerned. */
export interface MochiLinkedCard {
  readonly id: string;
  /** "" on 4,193 cards; the text is then entirely in `fields`. */
  readonly content?: string | null;
  /** field id -> `{ id, value }`. Values are not all strings. */
  readonly fields?: Readonly<Record<string, unknown>> | null;
  /** Mochi's derived outbound reference list. See the header. */
  readonly references?: readonly unknown[] | null;
}

export interface LinkNotes {
  readonly cardsWithLinks: number;
  readonly distinctTargets: number;
  /** Rows whose target is not among the known card ids. Stored, never dropped. */
  readonly unresolvedRows: number;
  /** Distinct unresolved target ids, sorted. */
  readonly unresolvedTargets: readonly string[];
  readonly linksInContent: number;
  readonly linksInFields: number;
}

export interface MappedLinks {
  readonly links: readonly CardLinkRow[];
  readonly notes: LinkNotes;
}

export interface MapLinksOptions {
  /**
   * Ids that count as resolvable. Omit to use the ids of the cards being
   * mapped, which is the right answer when every export is mapped at once.
   */
  readonly knownCardIds?: ReadonlySet<string>;
}

// ─── parsing ─────────────────────────────────────────────────────────────────

/** Every `[[display|card-id]]` in one string, in order of appearance. */
export function wikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  // A fresh regex per call: WIKI_LINK is global, and sharing lastIndex across
  // calls would skip links non-deterministically.
  const pattern = new RegExp(WIKI_LINK.source, "g");
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    out.push({ display: match[1] as string, target: match[2] as string });
  }
  return out;
}

/**
 * Every link on a card, tagged with the scope it came from: `content` first
 * (`fieldId` null), then each field value in the export's own field order.
 *
 * The ordinal is per scope, so it does not depend on how many links a sibling
 * field holds — an edit to one field cannot renumber another's rows.
 */
export function cardLinks(card: MochiLinkedCard): CardLinkRow[] {
  const rows: CardLinkRow[] = [];
  const scopes: (readonly [string | null, string])[] = [[null, card.content ?? ""]];
  for (const [fieldId, field] of Object.entries(card.fields ?? {})) {
    const value =
      typeof field === "object" && field !== null
        ? (field as Record<string, unknown>)["value"]
        : field;
    if (typeof value === "string") scopes.push([fieldId, value]);
  }

  for (const [fieldId, text] of scopes) {
    let ordinal = 0;
    for (const link of wikiLinks(text)) {
      rows.push({
        from_card_id: card.id,
        to_card_id: link.target,
        display_text: link.display,
        field_id: fieldId,
        ordinal: ordinal++,
      });
    }
  }
  return rows;
}

/** Mochi's derived `references`, as strings. Not what renders — see the header. */
export function declaredReferences(card: MochiLinkedCard): string[] {
  return (card.references ?? []).filter((entry): entry is string => typeof entry === "string");
}

// ─── mapping ─────────────────────────────────────────────────────────────────

/** Map every card's links. Pure; no database. */
export function mapCardLinks(
  cards: Iterable<MochiLinkedCard>,
  options: MapLinksOptions = {},
): MappedLinks {
  const all = [...cards];
  const known = options.knownCardIds ?? new Set(all.map((card) => card.id));

  const links: CardLinkRow[] = [];
  const targets = new Set<string>();
  const unresolved = new Set<string>();
  let cardsWithLinks = 0;
  let unresolvedRows = 0;
  let linksInContent = 0;
  let linksInFields = 0;

  for (const card of all) {
    if (!card.id) continue;
    const rows = cardLinks(card);
    if (rows.length > 0) cardsWithLinks += 1;
    for (const row of rows) {
      links.push(row);
      targets.add(row.to_card_id);
      if (row.field_id === null) linksInContent += 1;
      else linksInFields += 1;
      if (!known.has(row.to_card_id)) {
        unresolvedRows += 1;
        unresolved.add(row.to_card_id);
      }
    }
  }

  return {
    links,
    notes: {
      cardsWithLinks,
      distinctTargets: targets.size,
      unresolvedRows,
      unresolvedTargets: [...unresolved].sort(),
      linksInContent,
      linksInFields,
    },
  };
}

export interface ReferenceReconciliation {
  /** Entries in every card's `references` array. 7,771 in the corpus. */
  readonly declared: number;
  /** Declared entries pointing outside the known ids. SPEC's 8. */
  readonly declaredUnresolved: number;
  readonly declaredUnresolvedTargets: readonly string[];
  /** Declared (from, to) pairs with no `[[...]]` anywhere in the card's text. */
  readonly declaredOnly: number;
  /** Parsed (from, to) pairs absent from the card's `references`. */
  readonly parsedOnly: number;
}

/**
 * Compare the parsed links with Mochi's derived `references` array. Nothing
 * here changes what is imported; it exists so the two numbers SPEC and the
 * parser produce can be reported side by side.
 */
export function reconcileReferences(
  cards: Iterable<MochiLinkedCard>,
  options: MapLinksOptions = {},
): ReferenceReconciliation {
  const all = [...cards];
  const known = options.knownCardIds ?? new Set(all.map((card) => card.id));
  const parsedPairs = new Set<string>();
  const declaredPairs = new Set<string>();
  const declaredUnresolved = new Set<string>();
  let declared = 0;
  let declaredUnresolvedRows = 0;

  for (const card of all) {
    for (const row of cardLinks(card)) parsedPairs.add(`${card.id}\u0000${row.to_card_id}`);
    for (const target of declaredReferences(card)) {
      declared += 1;
      declaredPairs.add(`${card.id}\u0000${target}`);
      if (!known.has(target)) {
        declaredUnresolvedRows += 1;
        declaredUnresolved.add(target);
      }
    }
  }

  return {
    declared,
    declaredUnresolved: declaredUnresolvedRows,
    declaredUnresolvedTargets: [...declaredUnresolved].sort(),
    declaredOnly: [...declaredPairs].filter((pair) => !parsedPairs.has(pair)).length,
    parsedOnly: [...parsedPairs].filter((pair) => !declaredPairs.has(pair)).length,
  };
}

// ─── writing ─────────────────────────────────────────────────────────────────

const INSERT_LINK = `
INSERT INTO card_links (from_card_id, to_card_id, display_text, field_id, ordinal)
VALUES (?, ?, ?, ?, ?)`;

const DELETE_CARD_LINKS = "DELETE FROM card_links WHERE from_card_id = ?";

export interface ImportLinksResult extends LinkNotes {
  /** Rows written to `card_links`. */
  readonly links: number;
  /** Rows deleted first, i.e. what a re-import replaced. 0 on a fresh database. */
  readonly replaced: number;
}

/**
 * Write `card_links`. Cards must already be in the database — `from_card_id` is
 * a foreign key — but targets need not exist, which is the whole point.
 *
 * A card's links are replaced wholesale: delete every row for that card, then
 * insert the parse. Editing text renumbers ordinals and can drop links, and an
 * upsert keyed on ordinal would leave the tail of a previously longer scope
 * behind as a ghost. Re-importing the same export is therefore a no-op in
 * effect, and `replaced` says how many rows were rewritten.
 */
export function importLinks(
  db: Db,
  cards: Iterable<MochiLinkedCard>,
  options: MapLinksOptions = {},
): ImportLinksResult {
  const all = [...cards];
  const known =
    options.knownCardIds ??
    new Set(
      (db.prepare("SELECT id FROM cards").pluck().all() as string[]).concat(
        all.map((card) => card.id),
      ),
    );
  const mapped = mapCardLinks(all, { knownCardIds: known });

  const insert = db.prepare(INSERT_LINK);
  const clear = db.prepare(DELETE_CARD_LINKS);
  let links = 0;
  let replaced = 0;

  db.transaction(() => {
    for (const card of all) {
      if (card.id) replaced += clear.run(card.id).changes;
    }
    for (const row of mapped.links) {
      insert.run(row.from_card_id, row.to_card_id, row.display_text, row.field_id, row.ordinal);
      links += 1;
    }
  })();

  return { ...mapped.notes, links, replaced };
}
