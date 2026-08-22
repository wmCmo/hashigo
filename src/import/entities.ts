/**
 * Stage 1 — the structural half of the import: decks, templates, template
 * fields, and cards with their field values.
 *
 * Every function here is pure. It turns a decoded export (see `transit.ts`)
 * into rows shaped exactly like the columns in `src/schema/schema.sql`, in an
 * order the foreign keys accept: templates, then decks parents-before-children,
 * then cards. Nothing here touches SQLite, so the mapping is testable against
 * the real corpus without a database.
 *
 * Reviews, tags, wiki-links and blobs are the other half of stage 1 and are not
 * mapped here.
 *
 * WHAT THE REAL EXPORTS FORCE (all measured, see test/transit.test.ts)
 *
 *   * `content` is "" on 4,193 of 7,716 cards. The authored text is in
 *     `fields[].value`, which is why `cardFieldValues` is not an optional extra.
 *     Of the cards where it is NOT empty, 3,159 are templated, and on those the
 *     template decides every side — so that text has never been rendered by
 *     Mochi and is not rendered by Hashigo either. It is discarded here and
 *     reported in `MappingNotes.staleContentCardIds`; see that field.
 *   * TEMPLATE IDS COLLIDE ACROSS EXPORTS. `oiaISYb2` (単語) appears in both
 *     日本語 and 基本情報 — 11 template rows, 10 distinct templates. The two
 *     definitions are byte-identical, but the mapper must upsert by id rather
 *     than insert, or the primary key rejects the second export.
 *   * `type` is absent on 22 of the 49 fields. Absent means plain; NULL would
 *     mean two different things, so it is defaulted here and not in SQL.
 *   * Field values are not all strings: 1,599 are booleans and 12 are null.
 *   * 143 card field values name a field id that is not on the card's template.
 *     They are emitted anyway — `card_field_values` has no foreign key to
 *     `template_fields` precisely so authored text outlives a deleted field.
 *   * Decks carry an integer `sort`, not the lexicographic `pos` string that
 *     cards, templates and fields carry. `pos` is TEXT, so the integer is
 *     zero-padded to keep lexicographic order equal to numeric order.
 *   * SIX CARDS WOULD LOSE THEIR REVERSE HISTORY without SPEC's enforcement
 *     rule. Five in English/Vocabulary and one in 基本情報/第15章 hold a
 *     non-empty `reverse-reviews` array while inheritance resolves to `off`
 *     (their root deck's `review-reverse?` is null, not true). SPEC: "any card
 *     with a non-empty reverse-reviews array must resolve to on, or 43,083
 *     review records lose their track." Those six are forced to `on`; the other
 *     3,772 keep `inherit` and reverse by deck inheritance, which is the
 *     behaviour SPEC wants preserved.
 */

import {
  FIELD_TYPES,
  type FieldType,
  type ReverseMode,
  isFieldType,
} from "../schema/index.js";
import {
  type MochiRecord,
  type WalkedCard,
  asDate,
  asRecord,
  asRecords,
  asText,
  isRecord,
  rfc3339,
  walkCards,
  walkDecks,
} from "./transit.js";

// ─── row shapes ──────────────────────────────────────────────────────────────

/** Columns of `decks`. Decks carry no timestamps in the export, so none here. */
export interface DeckRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly reverse: ReverseMode;
  readonly target_retention: number | null;
  readonly default_template_id: string | null;
  readonly archived: 0 | 1;
  readonly pos: string;
}

/** Columns of `templates`. `reverse_permutation` NULL = the authored order reversed. */
export interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly reverse_permutation: string | null;
  readonly pos: string;
}

/** Columns of `template_fields`. `options` is canonical JSON. */
export interface TemplateFieldRow {
  readonly template_id: string;
  readonly id: string;
  readonly name: string;
  readonly type: FieldType;
  readonly source_field_id: string | null;
  readonly options: string;
  readonly pos: string;
}

/** Columns of `cards`, minus `seq`, which SQLite assigns. */
export interface CardRow {
  readonly id: string;
  readonly deck_id: string;
  readonly template_id: string | null;
  readonly name: string;
  readonly content: string;
  readonly reverse: ReverseMode;
  readonly pinned: 0 | 1;
  readonly archived: 0 | 1;
  readonly needs_rereview: 0 | 1;
  readonly pos: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Columns of `card_field_values`. */
export interface CardFieldValueRow {
  readonly card_id: string;
  readonly field_id: string;
  readonly value: string;
}

/** Everything the mapper noticed and the importer should log rather than guess at. */
export interface MappingNotes {
  /** Template ids seen more than once across the mapped exports. */
  readonly templateIdCollisions: readonly string[];
  /** Template id collisions whose definitions were not identical. */
  readonly templateIdConflicts: readonly string[];
  /** Card ids forced to reverse `on` to keep a reverse track (SPEC's rule). */
  readonly reverseForcedCardIds: readonly string[];
  /**
   * Field values that no template field claims — `card_id/field_id` pairs.
   *
   * **235, not 143.** WIDENED 2026-08-22, per CLAUDE.md's ratified treatment.
   * The old definition was guarded by `row.template_id &&`, so it counted only
   * cards that HAVE a template and silently skipped the 92 values sitting on
   * cards with no template at all. Those are orphans by the same definition —
   * nothing renders them, nothing can find them through a field — and the guard
   * excluded exactly the harder half. Measured on the corpus:
   *
   *     143   field is not on the card's template
   *      92   the card has no template (370 such cards; 92 carry values)
   *     ---
   *     235   of which 137 carry real text
   *
   * WHY THE BREAKOUT MATTERS. 98 of the 235 are empty strings, which are debris
   * and not lost authoring. The 137 that carry text are the ones a person might
   * want back, and collapsing them into one number is what made this look
   * ignorable. Same treatment as `staleContentCardIds`: every id is listed, the
   * real-text count is separate, and nothing is discarded — these values are
   * IMPORTED, they simply have no field to render them.
   */
  readonly orphanFieldValues: readonly string[];
  /**
   * Of `orphanFieldValues`, how many carry a non-blank value. 137 on the corpus.
   *
   * A count with no basis is not a fact (decision 6): "235 orphans" and "137
   * orphans with text" are both true and answer different questions.
   */
  readonly orphanFieldValuesWithText: number;
  /**
   * Of `orphanFieldValues`, how many are on a card with NO template. 92.
   *
   * Broken out because it is the half the old definition could not see, and
   * because it has a different cause: a template-less card is a Mochi state, not
   * a field that was deleted.
   */
  readonly orphanFieldValuesTemplateless: number;
  /** Cards whose `deck-id` names a deck absent from the export. */
  readonly unknownDeckCardIds: readonly string[];
  /** Field `type` values the schema's CHECK would reject; mapped to plain. */
  readonly unknownFieldTypes: readonly string[];
  /**
   * STALE PRE-TEMPLATE CONTENT, discarded rather than imported.
   *
   * 3,159 templated cards carry hand-written text in `content` that the
   * template overrides and that Mochi has therefore never shown. Stage 3
   * checked all 3,159 against what their template renders: none match. It is
   * text from before the card was put on a template, left behind by Mochi and
   * invisible ever since.
   *
   * Zach's decision is to discard it on import, so `cards.content` is '' on
   * those cards and the card's real text is exactly its field values — which is
   * also what makes `search_text` honest. Discarding silently is the part that
   * would be wrong, so every id is listed here, the total size is counted, and
   * a sample carries the actual text into the import report.
   *
   * RECOVERY: the export is not modified by an import, so the authoritative
   * copy of all of it is still in each export's own `data.json` under these
   * ids, and re-importing with the discard removed would bring it back. The
   * sample exists to make a spot check possible without going back there.
   */
  readonly staleContentCardIds: readonly string[];
  /**
   * Total characters discarded, across every card in `staleContentCardIds`.
   *
   * CODE POINTS, not UTF-16 code units — `[...text].length`, not `text.length`.
   * The corpus contains exactly one astral character in this text (U+1F347
   * GRAPES, on card `lWDwKxNL`), so the two definitions differ by exactly 1 and
   * the naive `.length` reports 79,176 where `tools/mochi.py` and every other
   * measurement of the corpus report 79,175. Counting the way Python does keeps
   * this number comparable with the oracle.
   */
  readonly staleContentChars: number;
  /** The first `STALE_CONTENT_SAMPLE_SIZE` of them, with their text. */
  readonly staleContentSample: readonly StaleContent[];
}

/** One discarded `content`, kept whole so the report can show it. */
export interface StaleContent {
  readonly cardId: string;
  readonly templateId: string;
  readonly content: string;
}

/**
 * How many discarded values carry their text into `MappingNotes`. The ids are
 * all kept regardless; this only bounds the size of the report itself.
 */
export const STALE_CONTENT_SAMPLE_SIZE = 20;

export interface MappedExport {
  readonly decks: readonly DeckRow[];
  readonly templates: readonly TemplateRow[];
  readonly templateFields: readonly TemplateFieldRow[];
  readonly cards: readonly CardRow[];
  readonly cardFieldValues: readonly CardFieldValueRow[];
  readonly notes: MappingNotes;
}

export interface MapOptions {
  /**
   * SPEC "Settled", and Zach's decision: the six empty leaf decks — 副詞, 名詞,
   * 形容動詞, 一段動詞, 形容詞, 五段動詞 — are dropped. DEFAULT TRUE, so 45 decks
   * become 39.
   *
   * Stage 1 originally defaulted this off, reasoning that a lossless import can
   * be filtered later while a filtered one cannot be un-filtered. That argument
   * is sound and it is not what was chosen: the decks hold no cards and no
   * children, they are noise in every deck picker, and the export itself
   * remains the lossless copy. Pass `false` to opt back in — nothing else about
   * the import changes, and in particular no card or review moves, because the
   * six decks contain none.
   *
   * `emptyLeafDeckIds` names exactly which decks the rule catches, computed
   * from the data rather than from a hardcoded list of the six.
   */
  readonly dropEmptyLeafDecks?: boolean;
  /**
   * Where `inherit` bottoms out, i.e. `settings['reverse.default']`. SPEC:
   * "workspace default off".
   */
  readonly reverseDefault?: Extract<ReverseMode, "on" | "off">;
}

// ─── mapping ─────────────────────────────────────────────────────────────────

/** Map one decoded export. */
export function mapExport(root: MochiRecord, options: MapOptions = {}): MappedExport {
  return mapExports([root], options);
}

/**
 * Map several decoded exports into one set of rows.
 *
 * Templates are upserted by id, because `oiaISYb2` really does appear in two of
 * the three exports. Decks and cards are keyed by id too, so re-mapping the same
 * export is idempotent.
 */
export function mapExports(
  roots: readonly MochiRecord[],
  options: MapOptions = {},
): MappedExport {
  const reverseDefault = options.reverseDefault ?? "off";

  const templates = new Map<string, TemplateRow>();
  const templateFields = new Map<string, TemplateFieldRow[]>();
  const decks = new Map<string, DeckRow>();
  const cards = new Map<string, CardRow>();
  const cardFieldValues: CardFieldValueRow[] = [];

  const templateIdCollisions: string[] = [];
  const templateIdConflicts: string[] = [];
  const reverseForcedCardIds: string[] = [];
  const orphanFieldValues: string[] = [];
  let orphanFieldValuesWithText = 0;
  let orphanFieldValuesTemplateless = 0;
  const unknownDeckCardIds: string[] = [];
  const unknownFieldTypes = new Set<string>();
  const staleContent: StaleContent[] = [];

  // Templates first: cards and decks both point at them.
  for (const root of roots) {
    for (const template of asRecords(root["templates"])) {
      const id = asText(template["id"]);
      if (!id) continue;
      const row = mapTemplate(id, template);
      const fields = mapTemplateFields(id, template, unknownFieldTypes);
      const previous = templates.get(id);
      if (previous) {
        templateIdCollisions.push(id);
        if (!sameTemplate(previous, templateFields.get(id) ?? [], row, fields)) {
          templateIdConflicts.push(id);
        }
      }
      templates.set(id, row);
      templateFields.set(id, fields);
    }
  }

  // Decks. `parent-id` is the authority — in these exports `decks` is a flat
  // array at the root and every parent reference resolves inside its own export
  // — but a nested `decks` array is legal, so nesting is the fallback.
  const walkedDecks = roots.flatMap((root) => walkDecks(root));
  const rawDecks = new Map<string, MochiRecord>();
  for (const { deck, nestedParentId } of walkedDecks) {
    const id = asText(deck["id"]);
    if (!id) continue;
    rawDecks.set(id, deck);
    const parentId = asText(deck["parent-id"]) || nestedParentId;
    decks.set(id, {
      id,
      parent_id: parentId && parentId !== id ? parentId : null,
      name: asText(deck["name"]),
      reverse: reverseFlag(deck["review-reverse?"]),
      target_retention: null, // no per-deck target in Mochi; SPEC makes it a setting
      default_template_id: asText(deck["template-id"]) || null,
      archived: 0, // Mochi has no deck-level archive flag
      pos: deckPos(deck["sort"]),
    });
  }

  const resolvedDeckReverse = resolveDeckReverse(decks, reverseDefault);

  // Cards.
  const walkedCards = roots.flatMap((root) => walkCards(root));
  for (const walked of walkedCards) {
    const row = mapCard(walked, {
      decks,
      resolvedDeckReverse,
      reverseForcedCardIds,
      unknownDeckCardIds,
      staleContent,
    });
    if (!row) continue;
    cards.set(row.id, row);

    const templateFieldIds = new Set(
      (row.template_id ? templateFields.get(row.template_id) : undefined)?.map((f) => f.id),
    );
    for (const [fieldId, field] of Object.entries(asRecord(walked.card["fields"]))) {
      if (!fieldId) continue;
      const value = fieldValueText(isRecord(field) ? field["value"] : field);
      // NO `row.template_id &&` GUARD. A value on a template-less card is an
      // orphan by the same definition and used to be invisible here; see
      // MappingNotes.orphanFieldValues.
      if (!row.template_id || !templateFieldIds.has(fieldId)) {
        orphanFieldValues.push(`${row.id}/${fieldId}`);
        if (value.trim() !== "") orphanFieldValuesWithText += 1;
        if (!row.template_id) orphanFieldValuesTemplateless += 1;
      }
      cardFieldValues.push({ card_id: row.id, field_id: fieldId, value });
    }
  }

  // Default ON: `!== false` rather than `=== true`. The six empty leaf decks go
  // unless the caller asks to keep them.
  let deckRows = orderDecks([...decks.values()]);
  if (options.dropEmptyLeafDecks !== false) {
    const drop = new Set(emptyLeafDeckIds(deckRows, [...cards.values()]));
    deckRows = deckRows.filter((deck) => !drop.has(deck.id));
  }

  return {
    decks: deckRows,
    templates: [...templates.values()],
    templateFields: [...templateFields.values()].flat(),
    cards: [...cards.values()],
    cardFieldValues,
    notes: {
      templateIdCollisions,
      templateIdConflicts,
      reverseForcedCardIds,
      orphanFieldValues,
      orphanFieldValuesWithText,
      orphanFieldValuesTemplateless,
      unknownDeckCardIds,
      unknownFieldTypes: [...unknownFieldTypes],
      staleContentCardIds: staleContent.map((entry) => entry.cardId),
      // Code points, not UTF-16 code units. See `staleContentChars`.
      staleContentChars: staleContent.reduce((n, entry) => n + [...entry.content].length, 0),
      staleContentSample: staleContent.slice(0, STALE_CONTENT_SAMPLE_SIZE),
    },
  };
}

// ─── pieces ──────────────────────────────────────────────────────────────────

function mapTemplate(id: string, template: MochiRecord): TemplateRow {
  return {
    id,
    name: asText(template["name"]),
    content: asText(template["content"]),
    reverse_permutation: null, // NULL = the authored side order, reversed
    pos: asText(template["pos"]),
  };
}

function mapTemplateFields(
  templateId: string,
  template: MochiRecord,
  unknownFieldTypes: Set<string>,
): TemplateFieldRow[] {
  const rows: TemplateFieldRow[] = [];
  for (const [fieldId, raw] of Object.entries(asRecord(template["fields"]))) {
    if (!isRecord(raw)) continue;
    const id = asText(raw["id"]) || fieldId;
    const declared = asText(raw["type"]);
    if (declared && !isFieldType(declared)) unknownFieldTypes.add(declared);
    const source = asText(raw["source"]);
    rows.push({
      template_id: templateId,
      id,
      name: asText(raw["name"]),
      // Absent on 22 of 49 fields. Absent means plain.
      type: declared && isFieldType(declared) ? declared : "plain",
      // Legitimately null: 例文 is an ai field whose dependency is named only
      // inside its prompt text, so the generation DAG must also parse
      // <<field>> out of options["ai-custom-prompt"].
      source_field_id: source && source !== id ? source : null,
      options: canonicalJson(normaliseOptions(asRecord(raw["options"]))),
      pos: asText(raw["pos"]),
    });
  }
  return orderTemplateFields(rows);
}

/**
 * Sources before dependents. `template_fields` carries a self-referential
 * foreign key — (template_id, source_field_id) -> (template_id, id) — so a
 * field must be inserted after the field it reads. Mochi's `fields` map is in no
 * particular order, and 単語's `Speech` really does precede its source `name`,
 * so inserting in map order fails with FOREIGN KEY constraint failed. Cycles
 * (impossible in the corpus, not impossible in principle) fall through in
 * their original order rather than being dropped.
 */
export function orderTemplateFields(rows: readonly TemplateFieldRow[]): TemplateFieldRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: TemplateFieldRow[] = [];
  const placed = new Set<string>();

  const place = (row: TemplateFieldRow, guard: Set<string>): void => {
    if (placed.has(row.id) || guard.has(row.id)) return;
    guard.add(row.id);
    const source = row.source_field_id ? byId.get(row.source_field_id) : undefined;
    if (source) place(source, guard);
    if (placed.has(row.id)) return;
    placed.add(row.id);
    out.push(row);
  };

  for (const row of rows) place(row, new Set());
  return out;
}

function mapCard(
  walked: WalkedCard,
  context: {
    readonly decks: Map<string, DeckRow>;
    readonly resolvedDeckReverse: Map<string, "on" | "off">;
    readonly reverseForcedCardIds: string[];
    readonly unknownDeckCardIds: string[];
    readonly staleContent: StaleContent[];
  },
): CardRow | null {
  const { card } = walked;
  const id = asText(card["id"]);
  const deckId = walked.deckId ?? "";
  if (!id || !deckId) return null;
  if (!context.decks.has(deckId)) context.unknownDeckCardIds.push(id);

  const created = asDate(card["created-at"]);
  const updated = asDate(card["updated-at"]);
  const createdAt = created ? rfc3339(created) : rfc3339(updated ?? new Date(0));

  let reverse = reverseFlag(card["review-reverse?"]);
  const hasReverseHistory = asRecords(card["reverse-reviews"]).length > 0;
  if (hasReverseHistory && reverse === "inherit") {
    // SPEC, "Importer rule — do not orphan history".
    if ((context.resolvedDeckReverse.get(deckId) ?? "off") !== "on") {
      reverse = "on";
      context.reverseForcedCardIds.push(id);
    }
  }

  // STALE PRE-TEMPLATE CONTENT. On a templated card the template decides every
  // side, so a non-empty `content` is text Mochi has never rendered. Discard it
  // and record it; see MappingNotes.staleContentCardIds for why, and for how to
  // get it back. Template-less cards (1,140 of them) define their own sides
  // with `---` in exactly this column, so they keep it untouched.
  const templateId = asText(card["template-id"]) || null;
  const rawContent = asText(card["content"]);
  const stale = templateId !== null && rawContent !== "";
  if (stale) {
    context.staleContent.push({ cardId: id, templateId, content: rawContent });
  }

  return {
    id,
    deck_id: deckId,
    template_id: templateId,
    name: asText(card["name"]),
    content: stale ? "" : rawContent,
    reverse,
    pinned: card["pinned?"] === true ? 1 : 0,
    archived: card["archived?"] === true ? 1 : 0,
    needs_rereview: card["needs-rereview?"] === true ? 1 : 0,
    pos: asText(card["pos"]),
    created_at: createdAt,
    updated_at: updated ? rfc3339(updated) : createdAt,
  };
}

/**
 * SPEC's reverse-review resolution: `true` -> `on`; absent OR `false` ->
 * `inherit`, because Mochi's two-state boolean cannot tell "never set" from
 * "deliberately off" and the deck setting therefore has to win.
 */
export function reverseFlag(raw: unknown): ReverseMode {
  return raw === true ? "on" : "inherit";
}

/**
 * Walk each deck's ancestors until something is not `inherit`, bottoming out at
 * the workspace default. Cycle-safe: a cycle resolves to the default.
 */
export function resolveDeckReverse(
  decks: ReadonlyMap<string, DeckRow>,
  fallback: "on" | "off" = "off",
): Map<string, "on" | "off"> {
  const resolved = new Map<string, "on" | "off">();
  for (const deck of decks.values()) {
    const seen = new Set<string>();
    let current: DeckRow | undefined = deck;
    let answer: "on" | "off" = fallback;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.reverse !== "inherit") {
        answer = current.reverse;
        break;
      }
      current = current.parent_id ? decks.get(current.parent_id) : undefined;
    }
    resolved.set(deck.id, answer);
  }
  return resolved;
}

/** Parents before children, so `decks.parent_id` can be inserted in one pass. */
export function orderDecks(rows: readonly DeckRow[]): DeckRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: DeckRow[] = [];
  const placed = new Set<string>();

  const place = (row: DeckRow, guard: Set<string>): void => {
    if (placed.has(row.id) || guard.has(row.id)) return;
    guard.add(row.id);
    const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
    if (parent) place(parent, guard);
    if (placed.has(row.id)) return;
    placed.add(row.id);
    out.push(row);
  };

  for (const row of rows) place(row, new Set());
  return out;
}

/**
 * The decks SPEC drops: no cards of their own and no children. Measured against
 * the corpus this is exactly 副詞, 名詞, 形容動詞, 一段動詞, 形容詞, 五段動詞.
 */
export function emptyLeafDeckIds(
  decks: readonly DeckRow[],
  cards: readonly CardRow[],
): string[] {
  const withCards = new Set(cards.map((card) => card.deck_id));
  const withChildren = new Set(
    decks.map((deck) => deck.parent_id).filter((id): id is string => id !== null),
  );
  return decks
    .filter((deck) => !withCards.has(deck.id) && !withChildren.has(deck.id))
    .map((deck) => deck.id);
}

/**
 * Field values are `string | boolean | null` in the export: 20,708 strings,
 * 1,599 booleans (checkbox fields, plus four written into untyped fields) and 12
 * nulls. The column is TEXT NOT NULL, so booleans keep their JSON spelling
 * rather than being flattened to ""/"1" — the template engine's truthiness test
 * for `<<#Field>>` is field-type-aware, and "false" must not read as authored
 * text. null becomes "", which is what an unset field is.
 */
export function fieldValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return "";
}

/**
 * Decks are ordered by an integer `sort` (0–21 in the corpus) while `pos` is
 * TEXT. Zero-padding keeps lexicographic order equal to numeric order; an
 * absent `sort` sorts first, as Mochi shows it.
 */
export function deckPos(sort: unknown): string {
  if (typeof sort !== "number" || !Number.isFinite(sort)) return "";
  const rounded = Math.trunc(sort);
  return rounded < 0 ? "" : String(rounded).padStart(6, "0");
}

/**
 * BCP-47 on the way in, never Mochi's inline `jp`. Field options in these
 * exports are already well-formed (`lang` ja-JP/en-US, `from`/`to` ja/en), so
 * this changes nothing today; it exists because the inline `<speech lang="jp">`
 * tags in card content are not, and both surfaces must agree.
 */
export function normaliseLang(code: string): string {
  const trimmed = code.trim();
  if (trimmed === "") return trimmed;
  const alias = LANG_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  const [language, region, ...rest] = trimmed.split("-");
  const head = (language ?? "").toLowerCase();
  if (region === undefined) return head;
  return [head, region.toUpperCase(), ...rest].join("-");
}

const LANG_ALIASES: Readonly<Record<string, string>> = {
  jp: "ja-JP",
  jpn: "ja-JP",
  "ja-jp": "ja-JP",
  en: "en",
  ja: "ja",
};

/** Language-bearing option keys. `from`/`to` are bare tags, `lang` is regioned. */
const LANG_OPTION_KEYS = new Set(["lang", "from", "to"]);

function normaliseOptions(options: MochiRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    out[key] =
      LANG_OPTION_KEYS.has(key) && typeof value === "string" ? normaliseLang(value) : value;
  }
  return out;
}

/** Stable JSON: keys sorted, so a stored `options` string compares by value. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

function sameTemplate(
  a: TemplateRow,
  aFields: readonly TemplateFieldRow[],
  b: TemplateRow,
  bFields: readonly TemplateFieldRow[],
): boolean {
  return (
    canonicalJson(a) === canonicalJson(b) &&
    canonicalJson([...aFields].sort(byFieldId)) === canonicalJson([...bFields].sort(byFieldId))
  );
}

function byFieldId(a: TemplateFieldRow, b: TemplateFieldRow): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Re-exported so a caller can enumerate the types the schema CHECK allows. */
export { FIELD_TYPES };
