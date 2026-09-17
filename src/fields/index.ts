/**
 * The field-kind registry — one description of every `template_fields.type`, read
 * by the editor, the worker, the generation path and the scripts.
 *
 * `./kinds.ts` carries the reasoning. The short version is that five independent
 * lists each knew a different slice of "what is this kind": `NON_KEY_OPTIONS`,
 * `FIELD_TYPE_BLOB_KIND`, the add-field form's five types, `GENERATABLE` in the
 * page and `ALLOWED` in the middleware. They are projections of one thing now.
 *
 * Node-free by rule, because all three runtimes read it.
 */

export {
  AUTHORABLE_TYPES,
  FIELD_KINDS,
  GENERATABLE_TYPES,
  keyedByGenerate,
  kindOf,
  settingsOf,
  type ConversionCost,
  type FieldInput,
  type FieldKind,
  type IdentityReach,
  type SettingControl,
  type SettingSpec,
} from "./kinds.js";

export {
  LOCAL_OPTION_PREFIX,
  MOCHI_NON_KEY_OPTIONS,
  NON_KEY_OPTIONS,
} from "./identity.js";

export {
  fieldWithRole,
  roleOf,
  withRole,
  ROLE_KEY,
  type FieldRole,
  type RoledField,
} from "./roles.js";
