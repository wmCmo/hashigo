import type { BlobKind, FieldType } from "../schema/index.js";
import { FIELD_TYPE_BLOB_KIND, FIELD_TYPES } from "../schema/index.js";
import { NON_KEY_OPTIONS } from "./identity.js";
import { roleOf, type FieldRole } from "./roles.js";
import { YOMI_FIELD } from "./yomi.js";

export type FieldInput =
  | "none"
  | "source"
  | "prompt";

export type SettingControl = "text" | "longtext" | "boolean" | "enum" | "voice" | "language";

export type IdentityReach = "own" | "downstream" | "none";

export type ConversionCost = "free" | "priced" | "refused";

export interface SettingSpec {
  readonly key: string;
  readonly label: string;
  readonly control: SettingControl;
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
  readonly fallback: string | boolean | null;
  readonly identity: IdentityReach;
  readonly editable: boolean;
  readonly note: string;
}

export interface FieldKind {
  readonly type: FieldType;
  readonly label: string;
  readonly blobKind: BlobKind | null;
  readonly input: FieldInput;
  readonly settings: readonly SettingSpec[];
  readonly convertsTo: Readonly<Partial<Record<FieldType, ConversionCost>>>;
  readonly authorable: boolean;
  readonly generatable: boolean;
}

function kind(type: FieldType, spec: Omit<FieldKind, "type" | "blobKind">): FieldKind {
  const convertsTo = { ...spec.convertsTo };
  delete convertsTo[type];
  return { ...spec, type, blobKind: FIELD_TYPE_BLOB_KIND[type] ?? null, convertsTo };
}

const SPEECH_SETTINGS: readonly SettingSpec[] = [
  {
    key: "voice",
    label: "Voice",
    control: "voice",
    fallback: null,
    identity: "own",
    editable: true,
    note:
      "The voice a NEW clip is made with. Existing clips are addressed by the voice " +
      "that made them, so changing this neither rewrites them nor keeps them " +
      "reachable — read the price before saving.",
  },
  {
    key: "lang",
    label: "Language",
    control: "language",
    fallback: null,
    identity: "own",
    editable: false,
    note:
      "Derived from the voice. Stored because Mochi stored it, and the 130 clips that " +
      "speak English in a Japanese voice are a disagreement between the two rather " +
      "than one wrong value.",
  },
  {
    key: "gender",
    label: "Gender",
    control: "enum",
    choices: [
      { value: "male", label: "male" },
      { value: "female", label: "female" },
    ],
    fallback: null,
    identity: "own",
    editable: false,
    note:
      "Azure's, and part of the cache key: 1,189 New Vocab clips and 90 数字 clips are " +
      "addressed by it. Google picks gender from the voice name, so editing this would " +
      "cost cache hits and buy nothing.",
  },
];

const AI_SETTINGS: readonly SettingSpec[] = [
  {
    key: "ai-custom-prompt",
    label: "Prompt",
    control: "longtext",
    fallback: null,
    identity: "downstream",
    editable: true,
    note:
      "The prompt IS this field's input; <<Field>> markers resolve against this " +
      "template. Not hashed itself — but it produces the text that is, so editing it " +
      "orphans every generation on this field.",
  },
  {
    key: "ai-task",
    label: "Task",
    control: "enum",
    choices: [{ value: "custom", label: "custom" }],
    fallback: null,
    identity: "own",
    editable: true,
    note:
      "Mochi's. 5,715 blobs carry \"custom\" and 11,508 carry nothing at all, so " +
      "flipping it orphans the field wholesale.",
  },
  {
    key: "randomize",
    label: "Randomize",
    control: "boolean",
    fallback: false,
    identity: "none",
    editable: false,
    note:
      "Mochi's, and NOTHING HERE READS IT. Shown rather than hidden because a setting " +
      "that silently does nothing is worse than one that says so.",
  },
  {
    key: "language",
    label: "Language (legacy)",
    control: "text",
    fallback: null,
    identity: "own",
    editable: false,
    note:
      "On 5 blobs, and the one key no generator element can carry — it comes back as " +
      "`divergent` from expandGeneratorFields. History, not a control.",
  },
];

const TRANSLATE_SETTINGS: readonly SettingSpec[] = [
  {
    key: "from",
    label: "From",
    control: "language",
    fallback: null,
    identity: "own",
    editable: true,
    note:
      'Absent on 3 of 5 translate fields, and absence is not the same as "ja": 723 ' +
      "blobs were generated with no direction at all. src/generate/llm.ts supplies " +
      "ja→en at use time, which is where a default belongs.",
  },
  {
    key: "to",
    label: "To",
    control: "language",
    fallback: null,
    identity: "own",
    editable: true,
    note:
      "As above. Changing it re-addresses the field's translations — and because the " +
      "store matches generated text by its input alone, cards keep showing the OLD " +
      "translation until each is generated again. The price says how many.",
  },
];

export const FIELD_KINDS: Readonly<Record<FieldType, FieldKind>> = {
  plain: kind("plain", {
    label: "Text",
    input: "none",
    settings: [],
    convertsTo: { boolean: "priced", number: "priced", accent: "priced" },
    authorable: true,
    generatable: false,
  }),
  boolean: kind("boolean", {
    label: "Yes / no",
    input: "none",
    settings: [
      {
        key: "boolean-default",
        label: "Default",
        control: "boolean",
        fallback: false,
        identity: "none",
        editable: true,
        note:
          "What a card with no value means. On 単語's Reading this decides which " +
          "exercise 1,882 cards run (decision 29) — the price says how many before " +
          "anything is saved.",
      },
    ],
    convertsTo: { plain: "priced" },
    authorable: true,
    generatable: false,
  }),
  number: kind("number", {
    label: "Number",
    input: "none",
    settings: [
      {
        key: "group",
        label: "Digit grouping",
        control: "enum",
        choices: [
          { value: "comma", label: "1,234" },
          { value: "space", label: "1 234" },
        ],
        fallback: null,
        identity: "downstream",
        editable: true,
        note:
          "Formats the value BEFORE it becomes the speech field's input, so changing " +
          "it re-addresses 数字's clips. It has done this before: 78 cards asked on " +
          "entry and played nothing.",
      },
    ],
    convertsTo: { plain: "priced" },
    authorable: true,
    generatable: false,
  }),
  accent: kind("accent", {
    label: "Pitch accent (型)",
    input: "source",
    settings: [],
    convertsTo: { plain: "priced" },
    authorable: true,
    generatable: false,
  }),
  speech: kind("speech", {
    label: "Speech",
    input: "source",
    settings: SPEECH_SETTINGS,
    convertsTo: {},
    authorable: false,
    generatable: true,
  }),
  ai: kind("ai", {
    label: "AI text",
    input: "prompt",
    settings: AI_SETTINGS,
    convertsTo: {},
    authorable: false,
    generatable: true,
  }),
  translate: kind("translate", {
    label: "Translation",
    input: "source",
    settings: TRANSLATE_SETTINGS,
    convertsTo: {},
    authorable: false,
    generatable: true,
  }),
};

export function kindOf(type: string): FieldKind | null {
  return Object.prototype.hasOwnProperty.call(FIELD_KINDS, type)
    ? (FIELD_KINDS[type as FieldType] ?? null)
    : null;
}

export function settingsOf(type: string): readonly SettingSpec[] {
  return kindOf(type)?.settings ?? [];
}

export const AUTHORABLE_TYPES: readonly FieldType[] = FIELD_TYPES.filter(
  (type) => FIELD_KINDS[type].authorable,
);

export const GENERATABLE_TYPES: ReadonlySet<FieldType> = new Set(
  FIELD_TYPES.filter((type) => FIELD_KINDS[type].generatable),
);

export interface FieldKindView {
  readonly id: FieldType | FieldRole;
  readonly label: string;
  readonly derived: boolean;
  readonly readsSource: boolean;
  readonly whenEmpty: string | null;
}

export interface KindedField {
  readonly name?: string;
  readonly type: string;
  readonly options?: Readonly<Record<string, unknown>> | undefined;
}

export function effectiveRole(field: KindedField): FieldRole | null {
  const role = roleOf(field);
  if (role !== null) return role;
  if (field.type === "plain" && field.name?.trim() === YOMI_FIELD) return "reading";
  return null;
}

const ROLE_KINDS: Readonly<Record<FieldRole, FieldKindView>> = {
  reading: {
    id: "reading",
    label: "Reading (ふりがな)",
    derived: true,
    readsSource: true,
    whenEmpty:
      "the laptop's accent helper writes it only for a word with kanji, and only when " +
      "its two readings of the word agree",
  },
  ojad: {
    id: "ojad",
    label: "Accent marks (OJAD)",
    derived: true,
    readsSource: true,
    whenEmpty:
      "`npx vite-node scripts/ojad-fill.ts -- --apply` on the laptop fills it from the " +
      "example sentence",
  },
  "reading-switch": {
    id: "reading-switch",
    label: "Exercise switch",
    derived: false,
    readsSource: false,
    whenEmpty: null,
  },
  source: { id: "source", label: "Found in (出典)", derived: false, readsSource: false, whenEmpty: null },
};

export function fieldKind(field: KindedField): FieldKindView {
  const role = effectiveRole(field);
  if (role !== null) return ROLE_KINDS[role];
  if (field.type === "accent") {
    return {
      id: "accent",
      label: FIELD_KINDS.accent.label,
      derived: true,
      readsSource: true,
      whenEmpty:
        "the laptop's accent helper leaves it empty when it is not sure of the word's " +
        "accent, rather than guess",
    };
  }
  const kind = kindOf(field.type);
  return {
    id: kind?.type ?? (field.type as FieldType),
    label: kind?.label ?? field.type,
    derived: false,
    readsSource: kind?.input === "source",
    whenEmpty: null,
  };
}

export function keyedByGenerate(key: string): boolean {
  return !NON_KEY_OPTIONS.has(key);
}
