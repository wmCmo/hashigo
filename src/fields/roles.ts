/**
 * A ROLE is how a locally-authored field says what it is FOR, without a new
 * `template_fields.type`.
 *
 * Decision 43 already ruled that out and gave the reason: `type` is a CHECK
 * constraint, and decision 41 made a schema bump answer for a live review history
 * that exists in two browsers' OPFS and nowhere else. `options` is a free-form
 * JSON column with no CHECK, so a role costs zero schema change.
 *
 * ─── WHY A ROLE AND NOT A NAME ──────────────────────────────────────────────
 *
 * Because a name is what `ojad` is bound by today, in three independent copies
 * inside `src/accent/marks.ts` alone, and the failure is silent: rename `例文`
 * and the pipeline reports `0 written`, which reads as success. `型` is the
 * counter-example that already works — `src/accent/store.ts` selects on
 * `type = 'accent'` and follows `source_field_id`, so it works on any template
 * that declares one. A role gives the fields that have no type of their own the
 * same property.
 *
 * ─── THE PREFIX IS LOAD-BEARING ─────────────────────────────────────────────
 *
 * `hashigo-` keeps this out of Mochi's namespace AND out of every generation
 * cache key — see `LOCAL_OPTION_PREFIX` in `./identity.ts`. Without that, putting
 * a role on a generator field would change its identity and orphan every blob it
 * has.
 */

import { LOCAL_OPTION_PREFIX } from "./identity.js";

export const ROLE_KEY = `${LOCAL_OPTION_PREFIX}role`;

/**
 * `ojad` — the per-mora accent annotation of decision 43. Its value is produced
 * from the field its `source_field_id` points at.
 *
 * `reading-switch` is decision 29's `Reading` boolean. It is DECLARED here and
 * deliberately not yet written by anything: the moment a role and the name
 * disagree, 692 cards change which exercise they run, so it ships last and behind
 * a census (`src/review/mode.ts`).
 *
 * `source` is `出典` — the card a word was found in, as a `[[link]]`, and the
 * sentence it was found in. See `src/cards/found-in.ts`.
 */
export type FieldRole = "ojad" | "reading-switch" | "source";

const ROLES: ReadonlySet<string> = new Set<FieldRole>(["ojad", "reading-switch", "source"]);

/** The shape this needs of a field. Structural, so every caller's row fits. */
export interface RoledField {
  readonly options?: Readonly<Record<string, unknown>> | undefined;
}

/** The role this field declares, or null. An unknown role reads as none. */
export function roleOf(field: RoledField): FieldRole | null {
  const raw = field.options?.[ROLE_KEY];
  return typeof raw === "string" && ROLES.has(raw) ? (raw as FieldRole) : null;
}

/** The first field carrying this role, or null. Declaration order decides. */
export function fieldWithRole<F extends RoledField>(
  fields: readonly F[],
  role: FieldRole,
): F | null {
  return fields.find((field) => roleOf(field) === role) ?? null;
}

/** The options object a field needs to carry `role`, merged over what it has. */
export function withRole(
  options: Readonly<Record<string, unknown>>,
  role: FieldRole,
): Record<string, unknown> {
  return { ...options, [ROLE_KEY]: role };
}
