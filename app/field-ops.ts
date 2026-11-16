import { generationIdentity, lookupGeneration } from "../src/blobs/generation.js";
import { resolveAudioHash } from "../src/cards/audio.js";
import type { BlobKind } from "../src/schema/index.js";
import { decodeFieldOptions } from "../src/cards/index.js";
import type { SqliteHandle } from "../src/db/browser.js";
import { effectiveRole, fieldKind, ROLE_KEY, settingsOf } from "../src/fields/index.js";
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

export interface FieldState {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly sourceFieldId: string | null;
  readonly options: string;
}

export interface FieldProposal {
  readonly options?: string;
  readonly sourceFieldId?: string | null;
}

export interface PriceLine {
  readonly fieldId: string;
  readonly fieldName: string;
  readonly own: boolean;
  readonly resolvesNow: number;
  readonly resolvesAfter: number;
  readonly silenced: number;
  readonly gained: number;
  readonly unbuildableAfter: number;
  readonly stale: number;
}

export interface FieldPrice {
  readonly templateId: string;
  readonly fieldId: string;
  readonly cards: number;
  readonly checked: number;
  readonly lines: readonly PriceLine[];
  readonly defaulted: number | null;
}

const FIELDS = `
SELECT id, name, type, source_field_id AS source, options
  FROM template_fields WHERE template_id = ? ORDER BY pos, id`;

const CARD_IDS = `SELECT id FROM cards WHERE template_id = ? ORDER BY id`;

const VALUES = `SELECT field_id, value FROM card_field_values WHERE card_id = ?`;

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

export function staleDerived(fields: readonly FieldState[], fieldId: string): FieldState[] {
  return consumersOf(fields, fieldId).filter(
    (field) => fieldKind({ ...field, options: decodeFieldOptions(field.options) }).derived,
  );
}

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

function sample<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  const step = items.length / limit;
  const out: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    out.push(items[Math.floor(index * step)] as T);
  }
  return out;
}

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

export function describePrice(price: FieldPrice): string[] {
  const out: string[] = [];
  const scale = price.checked === price.cards ? "" : ` (sampled ${price.checked} of ${price.cards.toLocaleString()} cards)`;
  for (const line of price.lines) {
    const who = line.own ? line.fieldName : `${line.fieldName}, which reads from it`;
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
      `${price.defaulted.toLocaleString()} card(s) carry no value for this field, so the default decides them` +
        ` — the layout AND the drill: the body's <<#Field>> gate and the review mode read the same rule.`,
    );
  }
  if (out.length === 0) out.push("No generated field reads this one, so no clip or text moves.");
  return out;
}

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
    if (spec.control === "voice" && !/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9-]+$/.test(String(value))) {
      return `${String(value)} is not a voice name (ja-JP-Neural2-C …)`;
    }
  }
  return null;
}

export function sourceRefusal(
  fields: readonly FieldState[],
  fieldId: string,
  sourceId: string | null,
): string | null {
  const target = fields.find((field) => field.id === fieldId);
  if (target === undefined) return `no field ${fieldId}`;
  const kind = fieldKind({ ...target, options: decodeFieldOptions(target.options) });
  if (!kind.readsSource) {
    return `a ${kind.label} field does not read from another field`;
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

export function sourceChoices(fields: readonly FieldState[], fieldId: string): FieldState[] {
  return fields.filter((field) => sourceRefusal(fields, fieldId, field.id) === null);
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

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

export type PlainKind = "plain" | "reading";

export interface KindChange {
  readonly options: string;
  readonly sourceFieldId: string | null;
}

export function kindChange(
  fields: readonly FieldState[],
  fieldId: string,
  to: PlainKind,
): KindChange | string {
  const target = fields.find((field) => field.id === fieldId);
  if (target === undefined) return `no field ${fieldId}`;
  if (target.type !== "plain") return `only a Text field can become a Reading — ${target.name} is ${target.type}`;
  const options = decodeFieldOptions(target.options);
  const role = effectiveRole({ ...target, options });
  if (role !== null && role !== "reading") return `${target.name} is ${fieldKind({ ...target, options }).label}, not Text`;
  const stored = options[ROLE_KEY] === "reading";
  if (to === "reading") {
    const source =
      target.sourceFieldId ??
      fields.find(
        (field) =>
          field.id !== fieldId &&
          field.type === "plain" &&
          effectiveRole({ ...field, options: decodeFieldOptions(field.options) }) === null,
      )?.id ??
      null;
    if (source === null) return `${target.name} has no Text field on this template to read from`;
    if (stored && source === target.sourceFieldId) return `${target.name} is already a Reading`;
    return { options: JSON.stringify({ ...options, [ROLE_KEY]: "reading" }), sourceFieldId: source };
  }
  if (role === null) return `${target.name} is already Text`;
  if (!stored) return `${target.name} is a Reading because of its name — rename it to make it Text`;
  const { [ROLE_KEY]: _dropped, ...rest } = options;
  return { options: JSON.stringify(rest), sourceFieldId: null };
}

export function sameExceptRole(current: string, proposed: string): boolean {
  let next: unknown;
  try {
    next = JSON.parse(proposed);
  } catch {
    return false;
  }
  if (next === null || typeof next !== "object" || Array.isArray(next)) return false;
  const strip = (options: Readonly<Record<string, unknown>>): string => {
    const { [ROLE_KEY]: _role, ...rest } = options;
    return JSON.stringify(Object.keys(rest).sort().map((key) => [key, rest[key]]));
  };
  return strip(decodeFieldOptions(current)) === strip(next as Record<string, unknown>);
}

export function searchReach(
  fields: readonly FieldState[],
  fieldId: string,
): boolean {
  const target = fields.find((field) => field.id === fieldId);
  const reached = [...(target === undefined ? [] : [target]), ...consumersOf(fields, fieldId)];
  return reached.some((field) => field.type === "ai" || field.type === "translate");
}

export interface VoicePrice {
  readonly cards: number;
  readonly checked: number;
  readonly mounts: number;
  readonly resolvesNow: number;
  readonly resolvesAfter: number;
  readonly silenced: number;
  readonly gained: number;
}

const CARD_TEMPLATE = `SELECT template_id FROM cards WHERE id = ?`;
const CARD_VOICE = `SELECT voice FROM card_voice_resolved WHERE card_id = ?`;

export function resolvedVoices(db: SqliteHandle, cardIds: readonly string[]): Map<string, string | null> {
  const read = db.prepare(CARD_VOICE);
  const out = new Map<string, string | null>();
  for (const cardId of cardIds) {
    const voice = (read.get(cardId) as { voice: string | null } | undefined)?.voice ?? null;
    out.set(cardId, voice === null || voice.trim() === "" ? null : voice.trim());
  }
  return out;
}

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
      if (requestBefore?.voice === requestAfter?.voice) continue;
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

export interface FieldOutput {
  readonly fieldId: string;
  readonly from: readonly string[];
  readonly text: string | null;
  readonly audio: {
    readonly kind: BlobKind;
    readonly text: string;
    readonly lang: string | null;
    readonly voice: string | null;
    readonly options: Readonly<Record<string, string>>;
  } | null;
}

export function fieldOutputs(db: SqliteHandle, cardId: string): FieldOutput[] {
  const templateId = (db.prepare(CARD_TEMPLATE).get(cardId) as { template_id: string | null } | undefined)
    ?.template_id;
  if (templateId === null || templateId === undefined) return [];
  const states = templateFields(db, templateId);
  const fields = states.map(asGenerator);
  const values = new Map<string, string>();
  for (const row of db.prepare(VALUES).all(cardId) as { field_id: string; value: string }[]) {
    values.set(row.field_id, row.value);
  }
  const context: FieldContext = {
    fields,
    values,
    resolveGenerated: (request) => resolveDescriptorText(db, request),
  };
  const out: FieldOutput[] = [];
  for (const field of fields) {
    if (!isGeneratorType(field.type)) continue;
    const prompt = field.options?.["ai-custom-prompt"];
    const from =
      field.type === "ai"
        ? typeof prompt === "string"
          ? promptDependencies(prompt).map((name) => name.trim())
          : []
        : states.filter((entry) => entry.id === field.sourceFieldId).map((entry) => entry.name);
    const request = fieldGenerationRequest(field, context);
    if (request === null) {
      out.push({ fieldId: field.id, from, text: null, audio: null });
      continue;
    }
    const descriptor = {
      kind: request.kind,
      text: request.text,
      lang: request.lang,
      voice: request.voice,
      options: request.options,
    };
    if (field.type === "speech") {
      const present = resolveAudioHash(db, cardId, { origin: "generator", request: descriptor }) !== null;
      out.push({ fieldId: field.id, from, text: null, audio: present ? descriptor : null });
    } else {
      out.push({ fieldId: field.id, from, text: resolveDescriptorText(db, descriptor), audio: null });
    }
  }
  return out;
}
