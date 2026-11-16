import { LOCAL_OPTION_PREFIX } from "./identity.js";

export const ROLE_KEY = `${LOCAL_OPTION_PREFIX}role`;

export type FieldRole = "ojad" | "reading-switch" | "source" | "reading";

const ROLES: ReadonlySet<string> = new Set<FieldRole>(["ojad", "reading-switch", "source", "reading"]);

export interface RoledField {
  readonly options?: Readonly<Record<string, unknown>> | undefined;
}

export function roleOf(field: RoledField): FieldRole | null {
  const raw = field.options?.[ROLE_KEY];
  return typeof raw === "string" && ROLES.has(raw) ? (raw as FieldRole) : null;
}

export function fieldWithRole<F extends RoledField>(
  fields: readonly F[],
  role: FieldRole,
): F | null {
  return fields.find((field) => roleOf(field) === role) ?? null;
}

export function withRole(
  options: Readonly<Record<string, unknown>>,
  role: FieldRole,
): Record<string, unknown> {
  return { ...options, [ROLE_KEY]: role };
}
