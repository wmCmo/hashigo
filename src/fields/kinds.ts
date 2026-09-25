/**
 * WHAT EACH FIELD KIND IS, IN ONE PLACE — the registry.
 *
 * Zach, 2026-09-17, comparing this editor with Mochi's: *"for the `<<Example>>`
 * in my english deck, it's the speech generation right? but i can't even select
 * voice or language there, which result in it generating the japanese speech
 * instead, and i can't pipe example sentence to speech here, like it's hardcoded
 * right? … each field behavior are hardcoded, they are supposed to be module"*.
 *
 * ─── WHAT WAS ACTUALLY WRONG, MEASURED ──────────────────────────────────────
 *
 * The settings he wanted already existed and were already RIGHT. `New Vocab`'s
 * `Example` is stored as `type=speech`, `source_field_id` → `Example Sentence`,
 * `options={"gender":"male","lang":"en-US","voice":"en-US-AIGenerate1Neural"}`.
 * The pipe he said he could not make was in the database, imported from Mochi and
 * intact. Three other things were broken instead, and this file addresses the
 * first of them:
 *
 *   1. NOTHING DESCRIBED A KIND, so the editor could not render a form and five
 *      independent lists each knew a different slice of the answer.
 *   2. Generation discarded the field's voice (`vite.generate.ts`), which is why
 *      130 blobs are `voice=ja-JP-Neural2-C, lang=en-US` — a Japanese voice
 *      reading English.
 *   3. Behaviour was bound by field NAME, in literals repeated across files.
 *
 * ─── THIS FILE DESCRIBES; IT DOES NOT DECIDE ────────────────────────────────
 *
 * `SettingSpec.identity` is a STATEMENT about `keyOptions`
 * (`src/generate/fields.ts`), never a second implementation of it. `keyOptions`
 * stays the only thing that decides what is hashed, and `test/fields.test.ts`
 * asserts the two agree for every declared key. Any other direction lets the
 * cache key move as a side effect of documenting it, which is the one mistake
 * that cannot be undone — a changed identity orphans every blob it addressed.
 *
 * NO NODE IMPORTS, and nothing from `src/db` or `src/generate`: the editor runs
 * in the page, the worker runs in OPFS, the scripts run in Node, and all three
 * read this. `test/browser-portable.test.ts` pins the absence.
 *
 * NO NEW `template_fields.type` VALUES, ever — decision 43. What a kind cannot
 * express, a `hashigo-` role expresses (`./roles.ts`).
 */

import type { BlobKind, FieldType } from "../schema/index.js";
import { FIELD_TYPE_BLOB_KIND, FIELD_TYPES } from "../schema/index.js";
import { NON_KEY_OPTIONS } from "./identity.js";

/** Where a kind's generation input comes from. */
export type FieldInput =
  /** The stored value IS the content. `plain`, `boolean`, `number`, `accent`. */
  | "none"
  /** Follows `source_field_id` — `src/generate/fields.ts`'s `sourceText`. */
  | "source"
  /** `ai` only: the dependency is named inside `ai-custom-prompt`. */
  | "prompt";

export type SettingControl = "text" | "longtext" | "boolean" | "enum" | "voice" | "language";

/**
 * How a change to this key moves cached generations.
 *
 * `downstream` is the one that is easy to miss and has already cost a bug:
 * 数字's `group` is not in THIS field's identity, but `renderedValue` formats the
 * number before it becomes the speech field's source text, so changing it moved
 * 78 clips' identity and they played SILENCE (`src/generate/fields.ts`).
 */
export type IdentityReach = "own" | "downstream" | "none";

/** What changing a field's type to another one costs. */
export type ConversionCost = "free" | "priced" | "refused";

export interface SettingSpec {
  /** The `template_fields.options` key. MOCHI'S SPELLING where one exists. */
  readonly key: string;
  readonly label: string;
  readonly control: SettingControl;
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
  /**
   * What ABSENCE means, shown as a placeholder and NEVER written on save.
   *
   * 723 translate blobs and 11,508 `ai` blobs were generated with empty options.
   * A form that helpfully materialises `ja`→`en` because a select had to show
   * something orphans all 723 at once. `src/generate/llm.ts` defaults at USE
   * time, which is where a default belongs.
   */
  readonly fallback: string | boolean | null;
  readonly identity: IdentityReach;
  /** False for keys that are history rather than choices. */
  readonly editable: boolean;
  /** One line under the control. Why it earns a place, in his terms. */
  readonly note: string;
}

export interface FieldKind {
  readonly type: FieldType;
  readonly label: string;
  /** Read from `FIELD_TYPE_BLOB_KIND`, never retyped. */
  readonly blobKind: BlobKind | null;
  readonly input: FieldInput;
  readonly settings: readonly SettingSpec[];
  readonly convertsTo: Readonly<Partial<Record<FieldType, ConversionCost>>>;
  /** Offered by the add-field form. */
  readonly authorable: boolean;
  /** Can the app generate one fresh? `furigana` resolves but never regenerates. */
  readonly generatable: boolean;
}

/**
 * Fill in the derived halves so a declaration says only what is its own.
 *
 * Self-conversion is stripped here rather than avoided in each declaration:
 * `PLAIN_LIKE` is shared between `plain` and `text` precisely so the pair is
 * written once, and "plain converts to plain" is noise a caller would have to
 * filter anyway.
 */
function kind(type: FieldType, spec: Omit<FieldKind, "type" | "blobKind">): FieldKind {
  const convertsTo = { ...spec.convertsTo };
  delete convertsTo[type];
  return { ...spec, type, blobKind: FIELD_TYPE_BLOB_KIND[type] ?? null, convertsTo };
}

/** The two kinds that differ only as an editor affordance. */
const PLAIN_LIKE: Readonly<Partial<Record<FieldType, ConversionCost>>> = {
  plain: "free",
  text: "free",
};

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
    label: "Plain text",
    input: "none",
    settings: [],
    convertsTo: { ...PLAIN_LIKE, boolean: "priced", number: "priced", accent: "priced" },
    authorable: true,
    generatable: false,
  }),
  text: kind("text", {
    label: "Long text",
    input: "none",
    settings: [],
    convertsTo: PLAIN_LIKE,
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
        // READ-ONLY UNTIL SOMETHING READS IT. `truthy()` in `src/review/mode.ts`
        // and the body's `<<#Field>>` gate both treat absent as false and never
        // consult this, so a control here would save a value that changes nothing
        // on screen. It opens when the gate and the mode read it together (stage
        // G) — separately they would disagree about the same card.
        editable: false,
        note:
          "What a card with no value means. On 単語's Reading this would decide which " +
          "exercise 1,882 cards run (decision 29) — and NOTHING READS IT YET: the " +
          "review screen treats a missing value as no, whatever this says.",
      },
    ],
    convertsTo: { plain: "priced", text: "priced" },
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
    convertsTo: { plain: "priced", text: "priced" },
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
  furigana: kind("furigana", {
    label: "Furigana",
    input: "source",
    settings: [],
    convertsTo: {},
    authorable: false,
    // Decision 8: filled offline from `accents.reading`, never from a model. A
    // wrong reading drilled is worse than no reading.
    generatable: false,
  }),
  dictionary: kind("dictionary", {
    label: "Dictionary",
    input: "source",
    settings: TRANSLATE_SETTINGS,
    convertsTo: {},
    authorable: false,
    generatable: false,
  }),
  "image-search": kind("image-search", {
    label: "Image search",
    input: "source",
    settings: [],
    convertsTo: {},
    authorable: false,
    generatable: false,
  }),
};

/** The kind, or null for a type this build does not know. */
export function kindOf(type: string): FieldKind | null {
  return Object.prototype.hasOwnProperty.call(FIELD_KINDS, type)
    ? (FIELD_KINDS[type as FieldType] ?? null)
    : null;
}

/** The settings a kind declares. Empty for an unknown type, never a throw. */
export function settingsOf(type: string): readonly SettingSpec[] {
  return kindOf(type)?.settings ?? [];
}

/** The types the add-field form may offer, in `FIELD_TYPES` order. */
export const AUTHORABLE_TYPES: readonly FieldType[] = FIELD_TYPES.filter(
  (type) => FIELD_KINDS[type].authorable,
);

/** The types the app can generate fresh. `GENERATABLE` and `ALLOWED` read this. */
export const GENERATABLE_TYPES: ReadonlySet<FieldType> = new Set(
  FIELD_TYPES.filter((type) => FIELD_KINDS[type].generatable),
);

/** True when `keyOptions` would carry this key into a generation identity. */
export function keyedByGenerate(key: string): boolean {
  return !NON_KEY_OPTIONS.has(key);
}
