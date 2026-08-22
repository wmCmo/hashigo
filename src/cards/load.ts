/**
 * Stage 7's first half, and the piece nothing in `src/` had: a card id in, a
 * renderable card out.
 *
 * `src/template` resolves a card against a template and `src/render` turns the
 * result into DOM, but both take plain objects — neither has ever seen a
 * database. The only code that assembled those objects from SQLite lived in
 * `spike/viewer/cards.worker.ts`, which is a THROWAWAY harness (`SPIKE.md`).
 * This is that assembly, in `src/`, typed against `SqliteHandle` so the review
 * screen can call it from the OPFS worker.
 *
 * IT IS AN ADAPTER, NOT A SUBSYSTEM. It runs four small queries and decodes one
 * JSON column. Everything hard is already done and tested somewhere else. What
 * it does own is the two ways that assembly goes silently wrong:
 *
 * ─── 1. `pendingGenerators` IS NOT OPTIONAL HERE ────────────────────────────
 *
 * `resolveCard` substitutes a generator-typed field's stored value, and all 19
 * generator-typed fields in the corpus store the EMPTY STRING — Mochi keeps
 * generated content in `component-cache`, never in `fields[].value`. Without
 * `pendingGenerators: true` the marker is substituted away, the reference never
 * reaches the AST as a `field` node, and `expandGeneratorFields` has nothing to
 * expand. Measured over the whole corpus by `test/generate.test.ts`, forward
 * direction, templated cards, counting `GeneratorMount.name === "speech"`:
 *
 *     pendingGenerators: true     6,855 speech mounts over 5,664 cards
 *     pendingGenerators: false       31 mounts
 *
 * 99.5% of the audio, gone, with no error raised anywhere — the page renders,
 * it is simply silent. So this module passes the flag itself and does not accept
 * an override for it: `loadRenderedCard` merges caller options UNDER its own.
 * A caller that wants the substituted form can call `renderCard` directly and
 * will have said so deliberately.
 *
 * ─── 2. IT CARRIES WHAT A RENDER NEEDS, AND MEASURABLY NOTHING ELSE ────────
 *
 * A first version also returned the resolved `reverse` and `voice`, joining
 * `card_reverse_resolved` and `card_voice_resolved` into the card query because
 * both are one-line joins and it seemed free. MEASURED over 200 real cards, it
 * was not:
 *
 *     loadCard, with both views joined      23.42 ms/card
 *     card_reverse_resolved, on its own      4.33 ms/card
 *     card_voice_resolved, on its own        0.01 ms/card
 *     deck_paths, on its own                 0.06 ms/card
 *     the cards row alone                    0.01 ms/card
 *
 * `deck_reverse_resolved` is `FROM decks d` with a correlated subquery per deck
 * over `deck_ancestry`, itself recursive — so joining it materialises the whole
 * view for every single card. Preparing the statement once instead of per call
 * changed 4.54 ms to 4.33: the prepare was never the cost, the view was.
 *
 * Neither field earns that. The renderer does not read `reverse` — the SCHEDULER
 * decides which tracks exist and which are dormant, and by the time a card
 * reaches here the direction is already chosen. `voice` is read by
 * `src/generate`. Both are still available, one query away, from `cardContext` —
 * which nothing on the render path calls.
 *
 * `deck_paths` stays: 0.06 ms for the deck name in a session header is a fair
 * trade, and it is the one of the three a screen actually shows.
 *
 * ─── 3. THE DIRECTION IS RESOLVED, NOT ASSUMED ──────────────────────────────
 *
 * A card's reverse is three-state and the card beats the deck, walking up the
 * tree — that is `card_reverse_resolved`, one view, and re-deriving it in
 * TypeScript is how a SQL definition and a code definition drift apart. So
 * `cardContext` reads the view rather than reimplementing the walk, and
 * `directionForTrackKind` covers the only other direction question there is.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 *
 * It does not resolve audio, and its sibling `./audio.ts` does — that split is
 * deliberate. This file answers "what does this card look like"; that one answers
 * "where are the bytes for this element", needs a second database handle for the
 * 617.9 MiB payload store, and is the only part that has to know
 * `blob_refs.ref_key` exists.
 *
 * It also does not play anything. Audio fires on the CLOZE REVEAL, never on
 * side entry — that is a correctness requirement about pitch-accent shadowing,
 * not a preference, and it lives in `src/render/reveal.ts`.
 */

import type { SqliteHandle } from "../db/browser.js";
import type { GeneratorField } from "../generate/fields.js";
import type {
  CardInput,
  Direction,
  RenderedCard,
  ResolveOptions,
  TemplateFieldInput,
  TemplateInput,
} from "../template/index.js";
import { renderCard } from "../template/index.js";

/**
 * A template field, in the shape BOTH consumers already take.
 *
 * Extending `GeneratorField` as well as `TemplateFieldInput` is the point, and
 * it is a `import type` so no runtime dependency on `src/generate` — which is
 * Node-bound — enters this module. The compiler now refuses to let the loader
 * hand `expandGeneratorFields` something it cannot use.
 *
 * THAT IS NOT DEFENSIVE, IT CAUGHT A LIVE BUG. A first version carried
 * `options` as the RAW JSON string and the corpus test cast it across with
 * `as unknown as GeneratorField[]`. The cast compiled; the run reported
 * **340,576 divergent** requests against an expected 0, and `expanded` fell
 * from 10,722 to 6,846 — while the headline speech-mount count stayed exactly
 * right at 6,855, so the defect was invisible in the number anyone would quote.
 * `template_fields.options` is JSON in the column and an OBJECT in the contract;
 * decoding it here means one decoder rather than one per caller.
 */
export interface LoadedField extends TemplateFieldInput, GeneratorField {
  /**
   * `template_fields.type` is NOT NULL with a CHECK, so it is always present
   * here. `TemplateFieldInput` makes it optional and `GeneratorField` requires
   * it; restating it as required is what reconciles the two, and it is the
   * honest reading of the column rather than a convenience.
   */
  readonly type: string;
  /** Mochi's `source` pointer. NULL is legitimate — see the schema. */
  readonly sourceFieldId: string | null;
  /** `template_fields.options`, DECODED: voice, lang, prompt, from, to. */
  readonly options: Readonly<Record<string, unknown>>;
  readonly pos: string;
  /** 1 when the field exists here and in no Mochi export. Decision 9. */
  readonly local: 0 | 1;
}

/**
 * Decode `template_fields.options`.
 *
 * `{}` on anything unusable, matching the column's own default. A field whose
 * options are corrupt still renders — it loses its voice, not its text — and
 * throwing here would take a whole card off the screen for it.
 */
export function decodeFieldOptions(raw: string): Readonly<Record<string, unknown>> {
  if (raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export interface LoadedTemplate extends TemplateInput {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly LoadedField[];
  readonly reversePermutation: readonly number[] | null;
}

export interface LoadedCard {
  readonly id: string;
  readonly name: string;
  readonly deckId: string;
  readonly deckPath: string;
  readonly templateId: string | null;
  readonly template: LoadedTemplate | null;
  /** field id -> value. Every row of `card_field_values` for this card. */
  readonly values: ReadonlyMap<string, string>;
  /** `cards.content` — the source of sides when there is no template. */
  readonly content: string;
  readonly archived: 0 | 1;
}

/**
 * The two inherited facts `loadCard` deliberately leaves out, because joining
 * them costs 23 ms a card against 0.1 — see note 2 in this file's header.
 *
 * Read them when something actually needs them: `reverse` for a card editor or
 * a "why is there no reverse track" answer, `voice` for the audio resolver.
 * Neither is on the render path.
 */
export interface CardContext {
  /** `card_reverse_resolved.reverse` — `'on'` or `'off'`, already inherited. */
  readonly reverse: string;
  /** `card_voice_resolved.voice` — NULL means "keep whatever the field recorded". */
  readonly voice: string | null;
}

const SELECT_CONTEXT = `
SELECT rr.reverse AS reverse, vr.voice AS voice
  FROM cards c
  LEFT JOIN card_reverse_resolved rr ON rr.card_id = c.id
  LEFT JOIN card_voice_resolved vr   ON vr.card_id = c.id
 WHERE c.id = ?`;

/** The inherited reverse and voice for a card. Null when no such card exists. */
export function cardContext(db: SqliteHandle, cardId: string): CardContext | null {
  const row = db.prepare(SELECT_CONTEXT).get(cardId) as
    | { reverse: string | null; voice: string | null }
    | undefined;
  if (row === undefined) return null;
  // The views are a LEFT JOIN away, so a card whose deck somehow has no row
  // falls back to the workspace default rather than to undefined.
  return { reverse: row.reverse ?? "off", voice: row.voice };
}

const SELECT_CARD = `
SELECT c.id            AS id,
       c.name          AS name,
       c.content       AS content,
       c.deck_id       AS deck_id,
       c.template_id   AS template_id,
       c.archived      AS archived,
       coalesce(dp.path, '(unknown)') AS deck_path
  FROM cards c
  LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id
 WHERE c.id = ?`;

const SELECT_TEMPLATE = `
SELECT id, name, content, reverse_permutation AS reverse_permutation
  FROM templates WHERE id = ?`;

const SELECT_FIELDS = `
SELECT id, name, type, source_field_id, options, pos, local
  FROM template_fields WHERE template_id = ? ORDER BY pos, id`;

const SELECT_VALUES = `
SELECT field_id, value FROM card_field_values WHERE card_id = ?`;

interface RawCard {
  id: string;
  name: string;
  content: string;
  deck_id: string;
  template_id: string | null;
  archived: number;
  deck_path: string;
}

/**
 * Decode `templates.reverse_permutation`.
 *
 * NULL means "the authored order reversed" and is the common case; a malformed
 * value means the same thing rather than throwing, because `renderCard` already
 * validates the decoded array and raises an `invalid-permutation` warning that
 * reaches the UI. Turning a bad column into an exception here would take a
 * renderable card off the screen over a cosmetic defect in its side order.
 */
export function decodeReversePermutation(raw: string | null): readonly number[] | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const numbers = parsed.filter((value): value is number => Number.isInteger(value));
  return numbers.length === parsed.length ? numbers : null;
}

/** Everything needed to render one card. Null when no such card exists. */
export function loadCard(db: SqliteHandle, cardId: string): LoadedCard | null {
  const row = db.prepare(SELECT_CARD).get(cardId) as RawCard | undefined;
  if (row === undefined) return null;

  let template: LoadedTemplate | null = null;
  if (row.template_id !== null) {
    const raw = db.prepare(SELECT_TEMPLATE).get(row.template_id) as
      | { id: string; name: string; content: string; reverse_permutation: string | null }
      | undefined;
    if (raw !== undefined) {
      const fields = (
        db.prepare(SELECT_FIELDS).all(row.template_id) as {
          id: string;
          name: string;
          type: string;
          source_field_id: string | null;
          options: string;
          pos: string;
          local: number;
        }[]
      ).map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
        sourceFieldId: field.source_field_id,
        options: decodeFieldOptions(field.options),
        pos: field.pos,
        local: (field.local === 1 ? 1 : 0) as 0 | 1,
      }));
      template = {
        id: raw.id,
        name: raw.name,
        content: raw.content,
        fields,
        reversePermutation: decodeReversePermutation(raw.reverse_permutation),
      };
    }
    // `templates` is a foreign key with ON DELETE SET NULL, so a card pointing
    // at a missing template should be impossible. If it happens, the card still
    // renders — from `cards.content`, which is what a template-less card does.
  }

  const values = new Map<string, string>();
  for (const value of db.prepare(SELECT_VALUES).all(cardId) as {
    field_id: string;
    value: string;
  }[]) {
    values.set(value.field_id, value.value);
  }

  return {
    id: row.id,
    name: row.name,
    deckId: row.deck_id,
    deckPath: row.deck_path,
    templateId: row.template_id,
    template,
    values,
    content: row.content,
    archived: (row.archived === 1 ? 1 : 0) as 0 | 1,
  };
}

/** The `CardInput` half of a loaded card, for `renderCard`. */
export function cardInputFor(loaded: LoadedCard): CardInput {
  return { id: loaded.id, content: loaded.content, values: loaded.values };
}

/**
 * Render a loaded card.
 *
 * `pendingGenerators: true` is applied AFTER the caller's options, so it cannot
 * be switched off through this door — see note 1 in this file's header. Every
 * other `ResolveOptions` member passes through untouched.
 */
export function renderLoadedCard(
  loaded: LoadedCard,
  direction: Direction,
  options: ResolveOptions = {},
): RenderedCard {
  return renderCard(cardInputFor(loaded), loaded.template, direction, {
    ...options,
    pendingGenerators: true,
  });
}

/** `loadCard` then `renderLoadedCard`. Null when no such card exists. */
export function loadRenderedCard(
  db: SqliteHandle,
  cardId: string,
  direction: Direction,
  options: ResolveOptions = {},
): RenderedCard | null {
  const loaded = loadCard(db, cardId);
  return loaded === null ? null : renderLoadedCard(loaded, direction, options);
}

/**
 * The direction a track reviews in.
 *
 * `card_tracks.kind` is `'forward' | 'reverse' | 'cloze:<n>'`. A cloze track
 * renders the card FORWARD — the cloze index selects which deletion is hidden,
 * which is `src/render`'s business and not a side ordering — so anything that
 * is not literally `'reverse'` is forward. Stated here rather than at four call
 * sites, because `kind.startsWith("reverse")` and `kind === "reverse"` differ
 * only on a string nobody has written yet.
 */
export function directionForTrackKind(kind: string): Direction {
  return kind === "reverse" ? "reverse" : "forward";
}
