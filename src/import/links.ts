/**
 * Stage 1 — card-to-card wiki-links.
 *
 * SPEC: 8,690 links across 4,323 cards, 56% of the corpus, and the pattern is
 * morphological decomposition — a compound points at its components
 * (`～に引き換え` links to both 引く and 換える). Two links per card is the
 * commonest case. This is also the half of the "@ reference" request that
 * already exists in the data, so it is stage-1 work, not editor work.
 *
 * THREE FORMS, NOT ONE. This parser used to require the pipe, which silently
 * dropped 54 real links. Measured over the three exports:
 *
 *   [[display|card-id]]   8,690   piped
 *   [[card-id]]              46   bare           <- was dropped
 *   [[|card-id]]              8   empty display  <- was dropped
 *   ------------------------------
 *                         8,744   all 54 recovered links resolve to real cards
 *
 * `[[display|]]` has no target and is NOT a link — 0 in the corpus, and
 * `tools/mochi.py` agrees (its target class is one-or-more). The grammar itself
 * lives in `src/text/render.ts`, which is the single definition; this file maps
 * it onto rows. See that module for the U+200E adjacency story.
 *
 * DISPLAY TEXT FOR THE TWO RECOVERED FORMS. Neither carries authored display
 * text, so it falls back to the target card's name — 何 for `[[pvtj9W17]]`,
 * covetousness for `[[|YGaSlUTe]]`. All 54 targets exist, so `display_text` is
 * never empty on the real corpus. `notes.displayFromTargetName` counts the rows
 * that took the fallback so the number cannot drift unnoticed.
 *
 * WHERE THE LINKS ARE. Both surfaces, not one: 1,011 of the 8,690 piped links
 * are in `content` and 7,679 are inside field values. `content` is "" on 4,193
 * of the 7,716 cards, so a parser that reads only `content` finds 12% of the
 * links and renders over half the corpus with broken text.
 *
 * UNRESOLVED TARGETS MUST SURVIVE THE IMPORT. `card_links.to_card_id` carries no
 * foreign key on purpose, and `card_links_resolved` reports `resolved = 0` for a
 * target that is not in `cards`. Such a link renders as its plain display text;
 * dropping the row would silently delete authored text.
 *
 * AND NEITHER MUST LINKS WHOSE SOURCE TEXT WAS DISCARDED — but they must be
 * COUNTED. Links are parsed from the export, which still carries the stale
 * pre-template `content` the importer throws away on 3,159 cards. 889 rows on
 * 510 cards therefore say `field_id IS NULL` while `cards.content` is now '':
 * a real edge into text the database no longer holds. They stay (66 of them are
 * the only carrier of their edge) and they are reported as
 * `inDiscardedContent`, with `card_links_resolved.text_present = 0` marking
 * each row so a backlink panel can filter them out instead of offering a link
 * to nothing. Counting 8,744 against the export while the database disagreed
 * about 889 of them was the actual defect; the row count was never the problem.
 *
 * TWO DIFFERENT DENOMINATORS, AND SPEC USES THE OTHER ONE (both measured below,
 * both asserted in test/tags-links.test.ts):
 *
 *   * Parsed from text: 8,744 link rows -> 2,895 distinct targets, of which 15
 *     are outside the three exports, accounting for 18 rows. The 18 and the 15
 *     are unchanged by the three-form fix: every one of the 54 recovered links
 *     resolves.
 *   * Mochi's own derived `references` array on each card: 7,771 entries, of
 *     which 8 do not resolve. That 8-of-7,771 is the figure SPEC quotes.
 *     `references` is deduped per card and is NOT the same set as the parsed
 *     links — 97 parsed (from, to) pairs are missing from it, and 1 of its
 *     entries has no `[[...]]` in the card's text at all. That 1 was 41 before
 *     the three-form fix: Mochi's own derived array already knew about 40 of
 *     the links the pipe-only parser was blind to, which is independent
 *     corroboration that the recovered edges are real.
 *
 *   The parse is the authority, because it is what renders. `references` is
 *   carried in the report only so the two numbers can be told apart instead of
 *   one silently "disagreeing" with SPEC. See `reconcileReferences`.
 */

import type { Db } from "../db/index.js";
import {
  linkDisplayText,
  parseWikiLinks,
  type ResolveName,
  type WikiLinkForm,
} from "../text/index.js";

/**
 * The link grammar, re-exported so there is exactly one copy of it. Matches all
 * three forms; see `src/text/render.ts`.
 */
export { WIKI_LINK, type WikiLink } from "../text/index.js";

/** Every `[[...]]` in one string, in order. The shared parser, not a second one. */
export { parseWikiLinks as wikiLinks } from "../text/index.js";

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

/** A row plus what the parse knew about it. Not stored; reported. */
export interface LinkOccurrence extends CardLinkRow {
  readonly form: WikiLinkForm;
  /** `display_text` came from the target card's name, not from the text. */
  readonly displayFromName: boolean;
}

/** A card, as far as linking is concerned. */
export interface MochiLinkedCard {
  readonly id: string;
  /** Supplies the display text for a bare or empty-display link to this card. */
  readonly name?: string | null;
  /** "" on 4,193 cards; the text is then entirely in `fields`. */
  readonly content?: string | null;
  /** field id -> `{ id, value }`. Values are not all strings. */
  readonly fields?: Readonly<Record<string, unknown>> | null;
  /** Mochi's derived outbound reference list. See the header. */
  readonly references?: readonly unknown[] | null;
}

/** How many rows each authored form produced. Sums to `links`. */
export interface LinkFormCounts {
  readonly piped: number;
  readonly bare: number;
  readonly emptyDisplay: number;
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
  /** 8,690 / 46 / 8 on the corpus. */
  readonly byForm: LinkFormCounts;
  /** Rows whose display text came from the target's name. 54 on the corpus. */
  readonly displayFromTargetName: number;
  /** Rows with neither authored display text nor a resolvable name. 0 on the corpus. */
  readonly displayMissing: number;
}

export interface MappedLinks {
  readonly links: readonly LinkOccurrence[];
  readonly notes: LinkNotes;
}

export interface MapLinksOptions {
  /**
   * Ids that count as resolvable. Omit to use the ids of the cards being
   * mapped, which is the right answer when every export is mapped at once.
   */
  readonly knownCardIds?: ReadonlySet<string>;
  /**
   * Names for the display-text fallback. Omit and the names of the cards being
   * mapped are used, which is again right when everything is mapped at once.
   * Consulted before the in-memory names, so a database can override.
   */
  readonly resolveName?: ResolveName;
}

// ─── parsing ─────────────────────────────────────────────────────────────────

/** Card id -> non-empty name, for the display-text fallback. */
function nameIndex(cards: readonly MochiLinkedCard[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const card of cards) {
    if (card.id && typeof card.name === "string" && card.name !== "") {
      names.set(card.id, card.name);
    }
  }
  return names;
}

/** The option's resolver first, then the cards being mapped. */
function nameResolver(
  cards: readonly MochiLinkedCard[],
  options: MapLinksOptions,
): ResolveName {
  const names = nameIndex(cards);
  const explicit = options.resolveName;
  return (id) => explicit?.(id) || names.get(id) || "";
}

/**
 * Every link on a card, tagged with the scope it came from: `content` first
 * (`fieldId` null), then each field value in the export's own field order.
 *
 * The ordinal is per scope, so it does not depend on how many links a sibling
 * field holds — an edit to one field cannot renumber another's rows.
 *
 * `resolveName` supplies `display_text` for the bare and empty-display forms.
 * Without it those rows carry `""`, which is a legal row (the link still exists
 * and still resolves) but is not what the corpus should produce.
 */
export function cardLinks(card: MochiLinkedCard, resolveName?: ResolveName): LinkOccurrence[] {
  const rows: LinkOccurrence[] = [];
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
    for (const link of parseWikiLinks(text)) {
      const display = linkDisplayText(link, resolveName);
      rows.push({
        from_card_id: card.id,
        to_card_id: link.target,
        display_text: display,
        field_id: fieldId,
        ordinal: ordinal++,
        form: link.form,
        displayFromName: link.display === "" && display !== "",
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
  const resolveName = nameResolver(all, options);

  const links: LinkOccurrence[] = [];
  const targets = new Set<string>();
  const unresolved = new Set<string>();
  const byForm = { piped: 0, bare: 0, emptyDisplay: 0 };
  let cardsWithLinks = 0;
  let unresolvedRows = 0;
  let linksInContent = 0;
  let linksInFields = 0;
  let displayFromTargetName = 0;
  let displayMissing = 0;

  for (const card of all) {
    if (!card.id) continue;
    const rows = cardLinks(card, resolveName);
    if (rows.length > 0) cardsWithLinks += 1;
    for (const row of rows) {
      links.push(row);
      targets.add(row.to_card_id);
      if (row.field_id === null) linksInContent += 1;
      else linksInFields += 1;
      if (row.form === "piped") byForm.piped += 1;
      else if (row.form === "bare") byForm.bare += 1;
      else byForm.emptyDisplay += 1;
      if (row.displayFromName) displayFromTargetName += 1;
      else if (row.display_text === "") displayMissing += 1;
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
      byForm,
      displayFromTargetName,
      displayMissing,
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
/**
 * Separator for a (from, to) pair key. NUL cannot occur in a Mochi id, so two
 * different pairs cannot produce the same key.
 */
const PAIR_SEPARATOR = String.fromCharCode(0);

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
    for (const row of cardLinks(card)) {
      parsedPairs.add(`${card.id}${PAIR_SEPARATOR}${row.to_card_id}`);
    }
    for (const target of declaredReferences(card)) {
      declared += 1;
      declaredPairs.add(`${card.id}${PAIR_SEPARATOR}${target}`);
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
  /**
   * Rows whose source text is no longer in the database: 889 on the corpus,
   * across 510 cards.
   *
   * Links are parsed from the EXPORT, which still has the stale pre-template
   * `content` the importer discards (`MappingNotes.staleContentCardIds`). So a
   * row can say `field_id IS NULL` — "this link is in cards.content" — while
   * `cards.content` is now ''. The link is real, it is just no longer visible.
   *
   * The rows are kept. 823 of the 889 duplicate an edge that also exists via a
   * field value, but 66 do not, and dropping them would silently delete edges
   * Zach authored — the same mistake as discarding the content silently. What
   * was actually wrong was that nothing counted them: `card_links` reported
   * 8,744 against the export while 889 of those rows pointed into text the
   * database no longer stored, and no test looked at both sides.
   *
   * `card_links_resolved.text_present` is the same fact per row, for consumers.
   * A backlink panel or an `@` picker should filter on it; a "what did the old
   * text say" view is the one place that wants these.
   */
  readonly inDiscardedContent: number;
}

/**
 * Write `card_links`. Cards must already be in the database — `from_card_id` is
 * a foreign key — but targets need not exist, which is the whole point.
 *
 * The database supplies both halves of resolution: which ids exist, and their
 * names for the display-text fallback. Both come from one query, so a bare link
 * cannot be counted as resolved and then rendered as nothing.
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
  const stored = db.prepare("SELECT id, name FROM cards").all() as {
    id: string;
    name: string;
  }[];
  const storedNames = new Map(stored.map((row) => [row.id, row.name]));
  const known =
    options.knownCardIds ??
    new Set([...storedNames.keys(), ...all.map((card) => card.id)]);
  const resolveName: ResolveName = (id) => options.resolveName?.(id) || storedNames.get(id) || "";
  const mapped = mapCardLinks(all, { knownCardIds: known, resolveName });

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

  // Asked of the DATABASE, after the write, not of the export: the whole point
  // is to compare the rows against the text that actually landed.
  const inDiscardedContent = db
    .prepare("SELECT count(*) FROM card_links_resolved WHERE text_present = 0")
    .pluck()
    .get() as number;

  return { ...mapped.notes, links, replaced, inDiscardedContent };
}
