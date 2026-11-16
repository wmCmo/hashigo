import type { Db } from "../db/index.js";

export interface TagRow {
  readonly path: string;
  readonly parent_path: string | null;
  readonly name: string;
}

export interface CardTagRow {
  readonly card_id: string;
  readonly tag_path: string;
  readonly manual: 0 | 1;
}

export interface MochiTaggedCard {
  readonly id: string;
  readonly tags?: readonly unknown[] | null;
  readonly "manual-tags"?: readonly unknown[] | null;
}

export interface TagMerge {
  readonly path: string;
  readonly variants: readonly string[];
}

export interface TagNotes {
  readonly rawTags: number;
  readonly normalisedTags: number;
  readonly merged: readonly TagMerge[];
  readonly dropped: readonly string[];
  readonly ancestorsSynthesised: readonly string[];
  readonly duplicatePairsMerged: number;
}

export interface MappedTags {
  readonly tags: readonly TagRow[];
  readonly cardTags: readonly CardTagRow[];
  readonly cardIds: readonly string[];
  readonly notes: TagNotes;
}

const FORMAT_CHARS = /\p{Cf}/gu;

export function normaliseTagPath(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(FORMAT_CHARS, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .join("/");
}

export function tagSegments(path: string): string[] {
  return path === "" ? [] : path.split("/");
}

export function tagPrefixes(path: string): string[] {
  const segments = tagSegments(path);
  return segments.map((_segment, index) => segments.slice(0, index + 1).join("/"));
}

export function tagRow(path: string): TagRow {
  const segments = tagSegments(path);
  const name = segments[segments.length - 1] ?? "";
  return {
    path,
    parent_path: segments.length > 1 ? segments.slice(0, -1).join("/") : null,
    name,
  };
}

export function mapCardTags(cards: Iterable<MochiTaggedCard>): MappedTags {
  const variants = new Map<string, string[]>();
  const dropped: string[] = [];
  const rawTags = new Set<string>();
  const perCard = new Map<string, Map<string, 0 | 1>>();
  let rawPairs = 0;

  const cardIds: string[] = [];

  for (const card of cards) {
    if (!card.id) continue;
    cardIds.push(card.id);
    for (const [manual, list] of [
      [0, card.tags],
      [1, card["manual-tags"]],
    ] as const) {
      for (const entry of list ?? []) {
        if (typeof entry !== "string") continue;
        rawTags.add(entry);
        const path = normaliseTagPath(entry);
        if (path === "") {
          if (!dropped.includes(entry)) dropped.push(entry);
          continue;
        }
        const seen = variants.get(path) ?? [];
        if (!seen.includes(entry)) seen.push(entry);
        variants.set(path, seen);

        rawPairs += 1;
        const onCard = perCard.get(card.id) ?? new Map<string, 0 | 1>();
        onCard.set(path, (onCard.get(path) === 1 || manual === 1 ? 1 : 0) as 0 | 1);
        perCard.set(card.id, onCard);
      }
    }
  }

  const cardTags: CardTagRow[] = [];
  for (const [cardId, paths] of perCard) {
    for (const [path, manual] of paths) {
      cardTags.push({ card_id: cardId, tag_path: path, manual });
    }
  }

  const used = new Set(variants.keys());
  const paths = new Set<string>();
  const ancestorsSynthesised: string[] = [];
  for (const path of used) {
    for (const prefix of tagPrefixes(path)) {
      if (paths.has(prefix)) continue;
      paths.add(prefix);
      if (!used.has(prefix)) ancestorsSynthesised.push(prefix);
    }
  }

  return {
    tags: orderTags([...paths].map(tagRow)),
    cardTags,
    cardIds,
    notes: {
      rawTags: rawTags.size,
      normalisedTags: used.size,
      merged: [...variants]
        .filter(([, spellings]) => spellings.length > 1)
        .map(([path, spellings]) => ({ path, variants: spellings })),
      dropped,
      ancestorsSynthesised,
      duplicatePairsMerged: rawPairs - cardTags.length,
    },
  };
}

export function orderTags(rows: readonly TagRow[]): TagRow[] {
  return [...rows].sort((a, b) => {
    const depth = tagSegments(a.path).length - tagSegments(b.path).length;
    return depth !== 0 ? depth : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

const INSERT_TAG = `
INSERT INTO tags (path, parent_path, name) VALUES (?, ?, ?)
ON CONFLICT (path) DO NOTHING`;

const INSERT_CARD_TAG = `
INSERT INTO card_tags (card_id, tag_path, manual) VALUES (?, ?, ?)
ON CONFLICT (card_id, tag_path) DO UPDATE SET manual = max(manual, excluded.manual)`;

const DELETE_CARD_TAGS = "DELETE FROM card_tags WHERE card_id = ?";

export interface ImportTagsResult extends TagNotes {
  readonly tags: number;
  readonly cardTags: number;
  readonly cardTagsReplaced: number;
}

export function importTags(db: Db, cards: Iterable<MochiTaggedCard>): ImportTagsResult {
  const mapped = mapCardTags(cards);
  const insertTag = db.prepare(INSERT_TAG);
  const insertCardTag = db.prepare(INSERT_CARD_TAG);
  const deleteCardTags = db.prepare(DELETE_CARD_TAGS);

  const cardIds = new Set(mapped.cardIds);

  let cardTagsReplaced = 0;
  db.transaction(() => {
    for (const id of cardIds) cardTagsReplaced += deleteCardTags.run(id).changes;
    for (const tag of mapped.tags) insertTag.run(tag.path, tag.parent_path, tag.name);
    for (const link of mapped.cardTags) {
      insertCardTag.run(link.card_id, link.tag_path, link.manual);
    }
  })();

  return {
    ...mapped.notes,
    tags: mapped.tags.length,
    cardTags: mapped.cardTags.length,
    cardTagsReplaced,
  };
}
