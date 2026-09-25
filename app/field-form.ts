/**
 * A FIELD'S SETTINGS, RENDERED FROM THE REGISTRY RATHER THAN FROM A SWITCH.
 *
 * Zach, 2026-09-17: *"in mochi flashcard, you can customize your own field …
 * kind type, input and output like pipeline, and other settings that are
 * appropriate with that field … everything here is hardcoded"*.
 *
 * The editor showed a name box and three buttons. Everything else a field
 * carries — its pipe, its voice, its prompt, its direction — was in the database
 * and on no screen. This walks `settingsOf(type)` and prints what is there, so
 * the editor never learns what "speech" means and a new setting is one registry
 * entry rather than a branch here.
 *
 * ─── THE WORDS, NOT THE WRITES ──────────────────────────────────────────────
 *
 * This file says what a field carries. Changing it is `./field-ops.ts` (the
 * price and the refusals) and `./template-editor.ts` (the controls), added in
 * stage C. They were kept apart on purpose: an options write is the second most
 * destructive thing in this app after a deck archive, and the deck archive
 * shipped INVERTED because worker SQL nobody could test went out unread.
 *
 * ─── ABSENCE IS A VALUE, AND IT IS SHOWN AS ONE ─────────────────────────────
 *
 * 723 translate blobs were generated with NO direction at all, and 11,508 `ai`
 * blobs with no options at all. So "not set" is printed as itself, never quietly
 * replaced by what the code would default to at use time. The same rule is what
 * stops the editable version materialising `ja`→`en` onto those 723 and orphaning
 * every one of them.
 */

import { kindOf, settingsOf, type SettingSpec } from "../src/fields/index.js";

/** What this needs of a field row. Structural, so `TemplateFieldRow` fits. */
export interface FieldFacts {
  readonly name: string;
  readonly type: string;
  readonly sourceFieldId: string | null;
  readonly local: boolean;
  readonly values: number;
  readonly references: number;
  readonly sides: readonly number[];
  readonly dependents: readonly string[];
}

/** One line of a settings panel: a label, what it says, and why it is there. */
export interface SettingLine {
  /** The `options` key this line reads. The writer needs it; so does a test. */
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly note: string;
  /** True when the value is absent and `value` is therefore a description. */
  readonly unset: boolean;
  /** True when the editor will never offer to change it. */
  readonly readOnly: boolean;
}

function show(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? "yes" : "no";
  const text = String(raw).trim();
  return text === "" ? null : text;
}

/**
 * The facts line under a field's name.
 *
 * `references` alone was the old answer and it is the one he did not ask for —
 * *"the field name that will be used in the body below"* is a question about
 * WHERE. So the count keeps its place only when there is a side to attach it to,
 * and a field the body never names says so outright.
 */
export function factsLine(field: FieldFacts): string {
  const sides =
    field.sides.length === 0
      ? "renders nowhere in the body"
      : field.sides.length === 1
        ? `on side ${field.sides[0]}`
        : `on sides ${field.sides.join(", ")}`;
  const references =
    field.references === 0 ? sides : `${field.references} reference(s) ${sides}`;
  return [
    kindOf(field.type)?.label ?? field.type,
    field.local ? "local (decision 9 — protected from re-import)" : null,
    references,
    field.values === 0 ? null : `${field.values.toLocaleString()} value(s)`,
    field.dependents.length === 0 ? null : `feeds ${field.dependents.join(", ")}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * The pipe line, or null when this kind has no input.
 *
 * `prompt` kinds get their own sentence because their dependency is not a column
 * at all — an `ai` field names its input inside `ai-custom-prompt`, which is why
 * `source_field_id` is legitimately NULL on four fields of this corpus.
 */
export function inputLine(field: FieldFacts, nameOfField: (id: string) => string | null): string | null {
  const kind = kindOf(field.type);
  if (kind === null || kind.input === "none") return null;
  if (kind.input === "prompt") return "Input: the prompt below, with its <<Field>> markers";
  const source = field.sourceFieldId === null ? null : nameOfField(field.sourceFieldId);
  if (field.sourceFieldId === null) return "Input: not set — this field generates nothing";
  // A source that resolves to no name is a dangling pointer. The composite
  // foreign key is ON DELETE SET NULL so this should be unreachable; printing the
  // raw id beats printing "null" if it ever is reached.
  return `Input: ${source ?? field.sourceFieldId}`;
}

/** Every declared setting of this kind, in declaration order. */
export function settingLines(
  type: string,
  options: Readonly<Record<string, unknown>>,
): SettingLine[] {
  return settingsOf(type).map((spec: SettingSpec): SettingLine => {
    const value = show(options[spec.key]);
    return {
      key: spec.key,
      label: spec.label,
      value: value ?? describeAbsence(spec),
      note: spec.note,
      unset: value === null,
      readOnly: !spec.editable,
    };
  });
}

function describeAbsence(spec: SettingSpec): string {
  if (spec.fallback === null) return "not set";
  return typeof spec.fallback === "boolean"
    ? `not set (${spec.fallback ? "yes" : "no"})`
    : `not set (${spec.fallback})`;
}

/**
 * Keys the field carries that its kind does not declare.
 *
 * Shown rather than dropped. `options` is free-form JSON that survived one
 * import and will survive a sync, and a key this build does not recognise is
 * more likely to be something real than something wrong — `language`, on five
 * blobs, is exactly that. A save must carry them through untouched.
 */
export function undeclaredKeys(
  type: string,
  options: Readonly<Record<string, unknown>>,
): { key: string; value: string }[] {
  const declared = new Set(settingsOf(type).map((spec) => spec.key));
  return Object.keys(options)
    .filter((key) => !declared.has(key))
    .sort()
    .map((key) => ({ key, value: show(options[key]) ?? "null" }));
}
