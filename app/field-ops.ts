/**
 * CHANGING WHAT A FIELD CARRIES — its settings and its input — AND WHAT THAT COSTS.
 *
 * Zach, 2026-09-17, his third call on the field editor: *"allow type change and
 * source repointing, with the cost shown"*. Stage B showed every setting read-only;
 * this is the write half, and the price is the half that makes it safe.
 *
 * ─── WHY THE PRICE IS NOT A NICETY ──────────────────────────────────────────
 *
 * A generated clip is addressed by the identity of the request that made it —
 * text, voice, language, the keyed options. Change any of those on the field and
 * every card asks for a DIFFERENT address, and the clip it used to play is still
 * in the store under the old one, unreachable. `src/cards/audio.ts` refuses to
 * paper over that with an "any voice" fallback, on purpose: a silenced card is
 * how a bad voice migration gets noticed. So the only honest place to say
 * "7,409 clips stop playing" is BEFORE the save, and this computes it.
 *
 * It has happened already, with nobody told: 数字's `group` formatting moved 78
 * clips' identity and those cards asked on entry and played nothing. `group` is
 * not in 数字/Number's own identity at all — it changes the TEXT the speech field
 * downstream hashes. So the price follows the field's consumers too, by both
 * kinds of dependency: `source_field_id`, and `<<Field>>` markers in a prompt.
 *
 * ─── WHAT "RESOLVES" MEANS HERE ─────────────────────────────────────────────
 *
 * What the card would actually PLAY or SHOW, per consumer, and not a looser
 * question. Speech follows `audioHashCandidates`: the asked voice, then the
 * per-language fill voice, never any voice. Text kinds follow the store's text
 * resolver, which does accept another voice (a text blob has none that matters).
 * Measuring either more generously would print a price that is lower than the
 * silence he then hears.
 *
 * ─── A SEAM, NOT A CONVENIENCE ──────────────────────────────────────────────
 *
 * Import-free of the worker, over `SqliteHandle`, for `app/deck-scope.ts`'s
 * reason: `test/` cannot import `app/db.worker.ts`, and worker SQL nobody could
 * test is how the deck archive shipped inverted. An options write is the second
 * most destructive thing in this app after that one.
 */

import { generationIdentity, lookupGeneration } from "../src/blobs/generation.js";
import { decodeFieldOptions } from "../src/cards/index.js";
import type { SqliteHandle } from "../src/db/browser.js";
import { kindOf, settingsOf } from "../src/fields/index.js";
import {
  fieldGenerationRequest,
  fillVoiceFor,
  isGeneratorType,
  resolveDescriptorText,
  resolveFieldGeneration,
  type FieldContext,
  type FieldGenerationRequest,
  type GeneratorField,
} from "../src/generate/index.js";
import { promptDependencies } from "../src/template/index.js";

/** A field as the price and the checks need it. */
export interface FieldState {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly sourceFieldId: string | null;
  /** The raw column, so an unchanged field compares byte for byte. */
  readonly options: string;
}

/** What is being proposed. Absent means "unchanged". */
export interface FieldProposal {
  readonly options?: string;
  readonly sourceFieldId?: string | null;
}

/** One generator field's before/after, over the cards that were looked at. */
export interface PriceLine {
  readonly fieldId: string;
  readonly fieldName: string;
  /** True for the field being edited; false for a consumer that moves with it. */
  readonly own: boolean;
  readonly resolvesNow: number;
  readonly resolvesAfter: number;
  /** Played or showed something before, will not after. The number that matters. */
  readonly silenced: number;
  /** Did not before, will after — a repoint onto a field that has clips. */
  readonly gained: number;
  /** Cards whose request cannot be built at all after the change. */
  readonly unbuildableAfter: number;
  /**
   * Text kinds only: matched exactly before, and after the change only by input
   * text — so the card keeps showing what the OLD settings made. Not silent, and
   * not the change either.
   */
  readonly stale: number;
}

export interface FieldPrice {
  readonly templateId: string;
  readonly fieldId: string;
  /** Cards on the template. */
  readonly cards: number;
  /** Cards actually priced. Equal to `cards` unless the template is large. */
  readonly checked: number;
  readonly lines: readonly PriceLine[];
  /**
   * Cards with no stored value for this field, when the change touches a
   * boolean's `boolean-default` — those are the cards the default decides.
   * Null when the change has nothing to do with a default.
   */
  readonly defaulted: number | null;
}

const FIELDS = `
SELECT id, name, type, source_field_id AS source, options
  FROM template_fields WHERE template_id = ? ORDER BY pos, id`;

const CARD_IDS = `SELECT id FROM cards WHERE template_id = ? ORDER BY id`;

const VALUES = `SELECT field_id, value FROM card_field_values WHERE card_id = ?`;

/** Every field on a template, in display order. */
export function templateFields(db: SqliteHandle, templateId: string): FieldState[] {
  return (
    db.prepare(FIELDS).all(templateId) as {
      id: string;
      name: string;
      type: string;
      source: string | null;
      options: string | null;
    }[]
  ).map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    sourceFieldId: row.source,
    options: row.options ?? "{}",
  }));
}

function asGenerator(field: FieldState): GeneratorField {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    sourceFieldId: field.sourceFieldId,
    options: decodeFieldOptions(field.options),
  };
}

/**
 * The fields that consume `fieldId`, transitively, by BOTH kinds of dependency.
 *
 * The prompt kind is the one a column-only walk misses, and it is the one that
 * matters most on this corpus: 単語 feeds 例文 through a `<<単語>>` marker, and
 * 例文 feeds `Audio` through the column.
 */
export function consumersOf(fields: readonly FieldState[], fieldId: string): FieldState[] {
  const found: FieldState[] = [];
  const seen = new Set<string>([fieldId]);
  const queue = [fieldId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const currentName = fields.find((field) => field.id === current)?.name.trim();
    for (const field of fields) {
      if (seen.has(field.id)) continue;
      const bySource = field.sourceFieldId === current;
      const prompt = decodeFieldOptions(field.options)["ai-custom-prompt"];
      const byPrompt =
        currentName !== undefined &&
        typeof prompt === "string" &&
        promptDependencies(prompt).some((name) => name.trim() === currentName);
      if (!bySource && !byPrompt) continue;
      seen.add(field.id);
      found.push(field);
      queue.push(field.id);
    }
  }
  return found;
}

/**
 * Would the card actually play or show this, and how exactly? See the header.
 *
 * `loose` is the text kinds' second answer and the reason this is not a boolean.
 * The store's text resolver falls back to ANY generation of the same kind over
 * the same input, ignoring the keyed options — so after a translation's `to`
 * changes, the card keeps showing the old translation rather than going blank.
 * That is "nothing went silent", and it is also "the change did not take effect",
 * and the price has to say the second half or it reads as free.
 */
type Resolution = "exact" | "loose" | "none";

function resolution(db: SqliteHandle, request: FieldGenerationRequest | null): Resolution {
  if (request === null) return "none";
  if (request.kind !== "speech") {
    const match = resolveFieldGeneration(db, request).match;
    return match === "exact" ? "exact" : match === "other-voice" ? "loose" : "none";
  }
  const asked = generationIdentity({
    kind: request.kind,
    text: request.text,
    voice: request.voice,
    lang: request.lang,
    options: request.options,
  });
  if (lookupGeneration(db, asked) !== null) return "exact";
  const fill = fillVoiceFor(asked.lang);
  return asked.voice !== fill && lookupGeneration(db, { ...asked, voice: fill }) !== null
    ? "exact"
    : "none";
}

/**
 * Evenly spaced, deterministic. A price over 600 of 単語's 3,742 cards is a
 * sampled number labelled as one, and costs a fifth of the time.
 */
function sample<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  const step = items.length / limit;
  const out: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    out.push(items[Math.floor(index * step)] as T);
  }
  return out;
}

/** The template's fields as they WOULD stand after the proposal. */
export function proposedFields(
  fields: readonly FieldState[],
  fieldId: string,
  proposal: FieldProposal,
): FieldState[] {
  return fields.map((field) =>
    field.id !== fieldId
      ? field
      : {
          ...field,
          options: proposal.options ?? field.options,
          sourceFieldId:
            proposal.sourceFieldId === undefined ? field.sourceFieldId : proposal.sourceFieldId,
        },
  );
}

/**
 * What a proposed change to one field does to every card that renders it.
 *
 * Writes nothing. It is not a `TemplateOp` for that reason: a read on the undo
 * channel puts a no-op on the undo stack.
 */
export function priceFieldChange(
  db: SqliteHandle,
  templateId: string,
  fieldId: string,
  proposal: FieldProposal,
  limit = 600,
): FieldPrice {
  const before = templateFields(db, templateId);
  const target = before.find((field) => field.id === fieldId);
  if (target === undefined) throw new Error(`no field ${fieldId} on template ${templateId}`);
  const after = proposedFields(before, fieldId, proposal);

  const affected = [target, ...consumersOf(before, fieldId), ...consumersOf(after, fieldId)]
    .filter((field, index, all) => all.findIndex((other) => other.id === field.id) === index)
    .filter((field) => isGeneratorType(field.type));

  const allCards = (db.prepare(CARD_IDS).all(templateId) as { id: string }[]).map((r) => r.id);
  const cards = sample(allCards, limit);

  const beforeGen = before.map(asGenerator);
  const afterGen = after.map(asGenerator);
  const resolveGenerated = (request: FieldGenerationRequest): string | null =>
    resolveDescriptorText(db, request);

  interface Tally {
    now: number;
    after: number;
    lost: number;
    won: number;
    broken: number;
    stale: number;
  }
  const tally = new Map<string, Tally>();
  for (const field of affected) {
    tally.set(field.id, { now: 0, after: 0, lost: 0, won: 0, broken: 0, stale: 0 });
  }

  const readValues = db.prepare(VALUES);
  for (const cardId of cards) {
    const values = new Map<string, string>();
    for (const row of readValues.all(cardId) as { field_id: string; value: string }[]) {
      values.set(row.field_id, row.value);
    }
    const contextBefore: FieldContext = { fields: beforeGen, values, resolveGenerated };
    const contextAfter: FieldContext = { fields: afterGen, values, resolveGenerated };
    for (const field of affected) {
      const counts = tally.get(field.id) as Tally;
      const was = beforeGen.find((entry) => entry.id === field.id);
      const will = afterGen.find((entry) => entry.id === field.id);
      const requestBefore = was === undefined ? null : fieldGenerationRequest(was, contextBefore);
      const requestAfter = will === undefined ? null : fieldGenerationRequest(will, contextAfter);
      const nowIs = resolution(db, requestBefore);
      const laterIs = resolution(db, requestAfter);
      const now = nowIs !== "none";
      const later = laterIs !== "none";
      if (now) counts.now += 1;
      if (later) counts.after += 1;
      if (now && !later) counts.lost += 1;
      if (!now && later) counts.won += 1;
      if (requestAfter === null) counts.broken += 1;
      if (nowIs === "exact" && laterIs === "loose") counts.stale += 1;
    }
  }

  const lines = affected.map((field): PriceLine => {
    const counts = tally.get(field.id) as Tally;
    return {
      fieldId: field.id,
      fieldName: field.name,
      own: field.id === fieldId,
      resolvesNow: counts.now,
      resolvesAfter: counts.after,
      silenced: counts.lost,
      gained: counts.won,
      unbuildableAfter: counts.broken,
      stale: counts.stale,
    };
  });

  let defaulted: number | null = null;
  if (target.type === "boolean" && proposal.options !== undefined) {
    const was = decodeFieldOptions(target.options)["boolean-default"];
    const will = decodeFieldOptions(proposal.options)["boolean-default"];
    if (was !== will) {
      defaulted = Number(
        (
          db
            .prepare(
              `SELECT count(*) AS n FROM cards c
                WHERE c.template_id = ?
                  AND NOT EXISTS (SELECT 1 FROM card_field_values v
                                   WHERE v.card_id = c.id AND v.field_id = ?
                                     AND trim(v.value) <> '')`,
            )
            .get(templateId, fieldId) as { n: number }
        ).n,
      );
    }
  }

  return { templateId, fieldId, cards: allCards.length, checked: cards.length, lines, defaulted };
}

/** The price as sentences, for the confirm dialog. Pure, so a test can read it. */
export function describePrice(price: FieldPrice): string[] {
  const out: string[] = [];
  const scale = price.checked === price.cards ? "" : ` (sampled ${price.checked} of ${price.cards.toLocaleString()} cards)`;
  for (const line of price.lines) {
    const who = line.own ? line.fieldName : `${line.fieldName}, which reads from it`;
    // Said whenever it is true, silent or not: "nothing went blank" and "the
    // change took effect" are different claims, and the text kinds make the
    // first one without the second.
    const stale =
      line.stale === 0
        ? null
        : `${line.stale} keep showing text made under the PREVIOUS settings — the store matches ` +
          `generated text by its input alone, so this only reaches cards generated after it`;
    if (line.silenced === 0 && line.gained === 0) {
      out.push(
        `${who}: nothing goes blank — ${line.resolvesNow} of ${price.checked} resolve before and after${scale}` +
          (stale === null ? "." : `; ${stale}.`),
      );
      continue;
    }
    const parts = [`${who}: ${line.resolvesNow} → ${line.resolvesAfter} of ${price.checked} resolve${scale}`];
    if (line.silenced > 0) {
      parts.push(
        `${line.silenced} STOP playing or showing until regenerated — the old clips stay in the store under the old address`,
      );
    }
    if (line.gained > 0) parts.push(`${line.gained} start resolving`);
    if (stale !== null) parts.push(stale);
    out.push(`${parts.join("; ")}.`);
  }
  if (price.defaulted !== null) {
    out.push(
      `${price.defaulted.toLocaleString()} card(s) carry no value for this field, so the default decides them.`,
    );
  }
  if (out.length === 0) out.push("No generated field reads this one, so no clip or text moves.");
  return out;
}

/**
 * Merge a patch into a field's options, keeping key order and every key the
 * patch does not name. `null` deletes. Returns the new JSON text.
 *
 * Key order is kept because the column is compared byte for byte elsewhere, and
 * a save that reorders keys would read as a change nobody made.
 */
export function patchOptions(
  raw: string,
  patch: Readonly<Record<string, string | boolean | null>>,
): string {
  const current = decodeFieldOptions(raw);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) {
      out[key] = value;
      continue;
    }
    const next = patch[key];
    if (next !== null && next !== undefined) out[key] = next;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (Object.prototype.hasOwnProperty.call(current, key)) continue;
    if (value !== null && value !== undefined) out[key] = value;
  }
  return JSON.stringify(out);
}

/**
 * Why a proposed options value may not be written, or null when it may.
 *
 * The rule is narrow on purpose: a save may change only keys its kind declares
 * as editable. Read-only keys (`gender`, `lang`, `randomize`, `language`) are
 * history that addresses real clips, and undeclared keys are carried through
 * untouched — they survived an import and a sync, and are more likely real than
 * wrong.
 */
export function optionsRefusal(type: string, raw: string, proposed: string): string | null {
  let next: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(proposed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "options must be a JSON object";
    }
    next = parsed as Record<string, unknown>;
  } catch {
    return "options are not valid JSON";
  }
  const current = decodeFieldOptions(raw);
  const specs = new Map(settingsOf(type).map((spec) => [spec.key, spec]));
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  for (const key of keys) {
    const same = JSON.stringify(current[key]) === JSON.stringify(next[key]);
    if (same) continue;
    const spec = specs.get(key);
    if (spec === undefined) return `${key} is not a setting of a ${type} field, and is kept as it is`;
    if (!spec.editable) return `${spec.label} is read-only — ${spec.note}`;
    const value = next[key];
    if (value === undefined) continue;
    if (spec.control === "boolean" && typeof value !== "boolean") return `${spec.label} is yes or no`;
    if (spec.control !== "boolean" && typeof value !== "string") return `${spec.label} is text`;
    if (spec.choices !== undefined && !spec.choices.some((choice) => choice.value === value)) {
      return `${String(value)} is not one of ${spec.label}'s choices`;
    }
    if (spec.control === "language" && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(value))) {
      return `${String(value)} is not a language code (ja, en, en-US …)`;
    }
    // A voice is a NAME SHAPE check, not a catalogue check, on purpose. The picker
    // offers only catalogue voices, but UNDO writes the previous options back —
    // which is an Azure name Mochi stored — and refusing it would make every voice
    // change irreversible. An off-catalogue name is harmless where it lands:
    // `synthesisVoice` makes new clips in the fill voice for it, as before stage D.
    if (spec.control === "voice" && !/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9-]+$/.test(String(value))) {
      return `${String(value)} is not a voice name (ja-JP-Neural2-C …)`;
    }
  }
  return null;
}

/**
 * Why a field may not read from `sourceId`, or null when it may.
 *
 * A cycle is refused here and not only by the schema: the schema's CHECK stops a
 * field reading ITSELF and nothing longer, and `fieldText` would walk a longer
 * loop until its depth limit and then return nothing — silence, in green.
 */
export function sourceRefusal(
  fields: readonly FieldState[],
  fieldId: string,
  sourceId: string | null,
): string | null {
  const target = fields.find((field) => field.id === fieldId);
  if (target === undefined) return `no field ${fieldId}`;
  const kind = kindOf(target.type);
  if (kind === null || kind.input !== "source") {
    return `a ${target.type} field does not read from another field`;
  }
  if (sourceId === null) return null;
  if (sourceId === fieldId) return "a field cannot read from itself";
  const source = fields.find((field) => field.id === sourceId);
  if (source === undefined) return `no field ${sourceId} on this template`;
  let cursor: string | null = sourceId;
  for (let hops = 0; cursor !== null && hops <= fields.length; hops += 1) {
    if (cursor === fieldId) {
      return `${source.name} already reads from ${target.name}, so this would be a loop`;
    }
    cursor = fields.find((field) => field.id === cursor)?.sourceFieldId ?? null;
  }
  return null;
}

/** Fields `fieldId` may read from, in display order. For the picker. */
export function sourceChoices(fields: readonly FieldState[], fieldId: string): FieldState[] {
  return fields.filter((field) => sourceRefusal(fields, fieldId, field.id) === null);
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Write a field's options. The caller owns the transaction and the refusal check.
 *
 * `updated_at` moves with it because decision 33's merge compares that clock — a
 * voice set on the laptop must not be taken back by the phone's older row.
 */
export function writeFieldOptions(
  db: SqliteHandle,
  templateId: string,
  fieldId: string,
  options: string,
): void {
  db.prepare(
    `UPDATE template_fields SET options = ?, updated_at = ${NOW} WHERE template_id = ? AND id = ?`,
  ).run(options, templateId, fieldId);
}

/** Write a field's input. Same contract as `writeFieldOptions`. */
export function writeFieldSource(
  db: SqliteHandle,
  templateId: string,
  fieldId: string,
  sourceId: string | null,
): void {
  db.prepare(
    `UPDATE template_fields SET source_field_id = ?, updated_at = ${NOW} WHERE template_id = ? AND id = ?`,
  ).run(sourceId, templateId, fieldId);
}

/**
 * Card ids whose SEARCH TEXT can move with this change, or empty.
 *
 * `cards.search_text` holds the resolved text of `ai` and `translate` fields, so
 * a change that re-addresses one of those changes what a card is found by.
 */
export function searchReach(
  fields: readonly FieldState[],
  fieldId: string,
): boolean {
  const target = fields.find((field) => field.id === fieldId);
  const reached = [...(target === undefined ? [] : [target]), ...consumersOf(fields, fieldId)];
  return reached.some((field) => field.type === "ai" || field.type === "translate");
}

// ─── stage E: a voice override on a card or a deck ───────────────────────────

/** What moving these cards to another voice costs, over their speech fields. */
export interface VoicePrice {
  /** Cards the override would cover. */
  readonly cards: number;
  /** Cards actually priced (sampled above the limit). */
  readonly checked: number;
  /** Speech mounts on the checked cards whose language the voice matches. */
  readonly mounts: number;
  readonly resolvesNow: number;
  readonly resolvesAfter: number;
  readonly silenced: number;
  readonly gained: number;
}

const CARD_TEMPLATE = `SELECT template_id FROM cards WHERE id = ?`;
const CARD_VOICE = `SELECT voice FROM card_voice_resolved WHERE card_id = ?`;

/** The voice each card resolves to through the views, right now. */
export function resolvedVoices(db: SqliteHandle, cardIds: readonly string[]): Map<string, string | null> {
  const read = db.prepare(CARD_VOICE);
  const out = new Map<string, string | null>();
  for (const cardId of cardIds) {
    const voice = (read.get(cardId) as { voice: string | null } | undefined)?.voice ?? null;
    out.set(cardId, voice === null || voice.trim() === "" ? null : voice.trim());
  }
  return out;
}

/**
 * What an override costs, before it is set. `before` and `after` are the voice
 * each card RESOLVES to through the inheritance views on either side of the
 * change — the worker measures `after` by making the write inside a savepoint and
 * rolling it back, so a clear that lets a grandparent deck's voice through is
 * priced as exactly that.
 *
 * A clip is addressed by the voice that made it, so moving a card's speech to a
 * new voice silences every clip it has in the old one until each is generated
 * again — deliberately, see `src/cards/audio.ts`. This counts that first.
 */
export function priceVoiceChange(
  db: SqliteHandle,
  cardIds: readonly string[],
  before: (cardId: string) => string | null,
  after: (cardId: string) => string | null,
  limit = 600,
): VoicePrice {
  const cards = sample(cardIds, limit);
  const fieldsOf = new Map<string, GeneratorField[]>();
  const readTemplate = db.prepare(CARD_TEMPLATE);
  const readValues = db.prepare(VALUES);
  const resolveGenerated = (request: FieldGenerationRequest): string | null =>
    resolveDescriptorText(db, request);

  let mounts = 0;
  let now = 0;
  let later = 0;
  let lost = 0;
  let won = 0;
  for (const cardId of cards) {
    const templateId = (readTemplate.get(cardId) as { template_id: string | null } | undefined)
      ?.template_id;
    if (templateId === null || templateId === undefined) continue;
    let fields = fieldsOf.get(templateId);
    if (fields === undefined) {
      fields = templateFields(db, templateId).map(asGenerator);
      fieldsOf.set(templateId, fields);
    }
    const speech = fields.filter((field) => field.type === "speech");
    if (speech.length === 0) continue;
    const values = new Map<string, string>();
    for (const row of readValues.all(cardId) as { field_id: string; value: string }[]) {
      values.set(row.field_id, row.value);
    }
    const current = before(cardId);
    const next = after(cardId);
    const beforeContext: FieldContext = { fields, values, resolveGenerated, voiceOverride: current };
    const afterContext: FieldContext = { fields, values, resolveGenerated, voiceOverride: next };
    for (const field of speech) {
      const requestBefore = fieldGenerationRequest(field, beforeContext);
      const requestAfter = fieldGenerationRequest(field, afterContext);
      if (requestBefore?.voice === requestAfter?.voice) continue; // the override does not reach it
      mounts += 1;
      const wasOk = resolution(db, requestBefore) !== "none";
      const isOk = resolution(db, requestAfter) !== "none";
      if (wasOk) now += 1;
      if (isOk) later += 1;
      if (wasOk && !isOk) lost += 1;
      if (!wasOk && isOk) won += 1;
    }
  }
  return {
    cards: cardIds.length,
    checked: cards.length,
    mounts,
    resolvesNow: now,
    resolvesAfter: later,
    silenced: lost,
    gained: won,
  };
}

/** The voice price as sentences. Pure, so a test can read it. */
export function describeVoicePrice(price: VoicePrice, voice: string | null): string[] {
  const scale =
    price.checked === price.cards ? "" : ` (sampled ${price.checked} of ${price.cards.toLocaleString()} cards)`;
  if (price.mounts === 0) {
    return [
      voice === null
        ? `Nothing changes: no speech on these cards was using this override${scale}.`
        : `Nothing changes: no speech field on these cards is in ${voice.slice(0, 5)}${scale}. ` +
          `An override only reaches speech in its own language.`,
    ];
  }
  const lines = [
    `${price.mounts.toLocaleString()} speech clip(s) would be asked for in ${voice ?? "the voice above"}${scale}: ` +
      `${price.resolvesNow} → ${price.resolvesAfter} play.`,
  ];
  if (price.silenced > 0) {
    lines.push(
      `${price.silenced} STOP playing until each is generated again — the old clips stay in the ` +
        `store under the voice that made them, and "generate audio" on the card fills it in the new one.`,
    );
  }
  if (price.gained > 0) lines.push(`${price.gained} start playing: clips in that voice already exist.`);
  return lines;
}
