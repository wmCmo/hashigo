import type { LoadedCard } from "../cards/index.js";
import { fieldWithRole } from "../fields/index.js";
import { booleanValue } from "../template/resolve.js";
import type { RenderElement } from "../render/dom.js";
import type { ShadowingSide } from "../render/reveal.js";

export type ReviewMode =
  | "produce"
  | "identify";

export const READING_FIELD = "Reading";

export const ACCENT_FIELD_TYPE = "accent";

export interface CardMode {
  readonly mode: ReviewMode;
  readonly accentDrill: boolean;
  readonly readingFieldId: string | null;
  readonly reading: boolean;
}

export function readingSwitch<F extends { name: string; type: string; options?: Readonly<Record<string, unknown>> | undefined }>(
  fields: readonly F[],
): F | undefined {
  const byRole = fieldWithRole(fields, "reading-switch");
  if (byRole !== null && byRole.type === "boolean") return byRole;
  return fields.find((field) => field.name.trim() === READING_FIELD && field.type === "boolean");
}

export function cardMode(loaded: LoadedCard): CardMode {
  const fields = loaded.template?.fields ?? [];
  const accentDrill = fields.some((field) => field.type === ACCENT_FIELD_TYPE);
  const reading = readingSwitch(fields);
  const readingFieldId = reading === undefined ? null : reading.id;
  const isReading =
    reading === undefined ? false : booleanValue(loaded.values.get(reading.id), reading.options);
  return {
    mode: accentDrill && !isReading ? "identify" : "produce",
    accentDrill,
    readingFieldId,
    reading: isReading,
  };
}

export function reviewModeFor(loaded: LoadedCard): ReviewMode {
  return cardMode(loaded).mode;
}

export function promptsOnEntry<E extends RenderElement>(
  mode: ReviewMode,
  side: ShadowingSide<E>,
  widgets = 0,
): boolean {
  if (side.audio.length === 0) return false;
  const masked = mode === "identify" && side.trigger === "cloze";
  const producesHere = widgets > 0;
  return masked || producesHere;
}
