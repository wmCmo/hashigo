import type { Db } from "../db/index.js";
import {
  linkDisplayText,
  parseWikiLinks,
  type ResolveName,
  type WikiLinkForm,
} from "../text/index.js";

export { WIKI_LINK, type WikiLink } from "../text/index.js";

export { parseWikiLinks as wikiLinks } from "../text/index.js";

export interface CardLinkRow {
  readonly from_card_id: string;
  readonly to_card_id: string;
  readonly display_text: string;
  readonly field_id: string | null;
  readonly ordinal: number;
}

export interface LinkOccurrence extends CardLinkRow {
  readonly form: WikiLinkForm;
  readonly displayFromName: boolean;
}

export interface MochiLinkedCard {
  readonly id: string;
  readonly name?: string | null;
  readonly content?: string | null;
  readonly fields?: Readonly<Record<string, unknown>> | null;
  readonly references?: readonly unknown[] | null;
}

export interface LinkFormCounts {
  readonly piped: number;
  readonly bare: number;
  readonly emptyDisplay: number;
}

export interface LinkNotes {
  readonly cardsWithLinks: number;
  readonly distinctTargets: number;
  readonly unresolvedRows: number;
  readonly unresolvedTargets: readonly string[];
  readonly linksInContent: number;
  readonly linksInFields: number;
  readonly byForm: LinkFormCounts;
  readonly displayFromTargetName: number;
  readonly displayMissing: number;
}

export interface MappedLinks {
  readonly links: readonly LinkOccurrence[];
  readonly notes: LinkNotes;
}

export interface MapLinksOptions {
  readonly knownCardIds?: ReadonlySet<string>;
  readonly resolveName?: ResolveName;
}

function nameIndex(cards: readonly MochiLinkedCard[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const card of cards) {
    if (card.id && typeof card.name === "string" && card.name !== "") {
      names.set(card.id, card.name);
    }
  }
  return names;
}

function nameResolver(
  cards: readonly MochiLinkedCard[],
  options: MapLinksOptions,
): ResolveName {
  const names = nameIndex(cards);
  const explicit = options.resolveName;
  return (id) => explicit?.(id) || names.get(id) || "";
}

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

export function declaredReferences(card: MochiLinkedCard): string[] {
  return (card.references ?? []).filter((entry): entry is string => typeof entry === "string");
}

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
  readonly declared: number;
  readonly declaredUnresolved: number;
  readonly declaredUnresolvedTargets: readonly string[];
  readonly declaredOnly: number;
  readonly parsedOnly: number;
}

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

const INSERT_LINK = `
INSERT INTO card_links (from_card_id, to_card_id, display_text, field_id, ordinal)
VALUES (?, ?, ?, ?, ?)`;

const DELETE_CARD_LINKS = "DELETE FROM card_links WHERE from_card_id = ?";

export interface ImportLinksResult extends LinkNotes {
  readonly links: number;
  readonly replaced: number;
  readonly inDiscardedContent: number;
}

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

  const inDiscardedContent = db
    .prepare("SELECT count(*) FROM card_links_resolved WHERE text_present = 0")
    .pluck()
    .get() as number;

  return { ...mapped.notes, links, replaced, inDiscardedContent };
}
