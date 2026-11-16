import { decodeFieldOptions } from "../src/cards/index.js";
import { fieldKind, kindOf, roleOf, ROLE_KEY, settingsOf, type SettingSpec } from "../src/fields/index.js";
import { count } from "./plural.js";

export interface FieldFacts {
  readonly name: string;
  readonly type: string;
  readonly sourceFieldId: string | null;
  readonly local: boolean;
  readonly values: number;
  readonly references: number;
  readonly sides: readonly number[];
  readonly dependents: readonly string[];
  readonly options?: string;
}

export interface SettingLine {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly unset: boolean;
  readonly readOnly: boolean;
}

function show(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? "yes" : "no";
  const text = String(raw).trim();
  return text === "" ? null : text;
}

export function factsLine(field: FieldFacts): string {
  const sides =
    field.sides.length === 0
      ? "renders nowhere in the body"
      : field.sides.length === 1
        ? `on side ${field.sides[0]}`
        : `on sides ${field.sides.join(", ")}`;
  const references =
    field.references === 0 ? sides : `${count(field.references, "reference")} ${sides}`;
  return [
    fieldKind({ name: field.name, type: field.type, options: decodeFieldOptions(field.options ?? "{}") }).label,
    field.local ? "local · kept on re-import" : null,
    references,
    field.values === 0 ? null : count(field.values, "value"),
    field.dependents.length === 0 ? null : `feeds ${field.dependents.join(", ")}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function inputLine(field: FieldFacts, nameOfField: (id: string) => string | null): string | null {
  if (kindOf(field.type)?.input === "prompt") return "Input: the prompt below, with its <<Field>> markers";
  const view = fieldKind({ name: field.name, type: field.type, options: decodeFieldOptions(field.options ?? "{}") });
  if (!view.readsSource) return null;
  const source = field.sourceFieldId === null ? null : nameOfField(field.sourceFieldId);
  if (field.sourceFieldId === null) return "Input: not set — this field generates nothing";
  return `Input: ${source ?? field.sourceFieldId}`;
}

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

export function undeclaredKeys(
  type: string,
  options: Readonly<Record<string, unknown>>,
): { key: string; value: string }[] {
  const declared = new Set(settingsOf(type).map((spec) => spec.key));
  return Object.keys(options)
    .filter((key) => !declared.has(key) && key !== ROLE_KEY)
    .sort()
    .map((key) => ({ key, value: show(options[key]) ?? "null" }));
}

const ROLE_MEANING: Readonly<Record<string, string>> = {
  ojad:
    "the pitch accent of each mora in the sentence it reads, found by this role " +
    "rather than by the field's name",
  "reading-switch": "switches between the produce and identify drills",
  reading:
    "the kana of its input word, shown as furigana. Filled by the laptop's helper, " +
    "never typed",
};

export function roleLine(options: Readonly<Record<string, unknown>>): string | null {
  const role = roleOf({ options });
  return role === null ? null : `Role: ${role} — ${ROLE_MEANING[role] ?? "declared by this project"}`;
}
