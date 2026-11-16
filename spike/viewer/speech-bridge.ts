import { FIELD_TOKEN } from "../../src/template/index.js";

import type { FieldRow } from "./protocol.js";

const BRIDGEABLE: ReadonlyMap<string, string> = new Map([["speech", "speech"]]);

export interface Rewrite {
  readonly field: string;
  readonly type: string;
  readonly source: string | null;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly skipped: string | null;
}

export interface BridgeResult {
  readonly content: string;
  readonly rewrites: readonly Rewrite[];
  readonly unchanged: boolean;
}

function option(options: string, key: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(options);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = (parsed as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  return /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null;
}

export function bridgeSpeechFields(content: string, fields: readonly FieldRow[]): BridgeResult {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const byId = new Map(fields.map((field) => [field.id, field]));
  const rewrites: Rewrite[] = [];

  const rewritten = content.replace(
    new RegExp(FIELD_TOKEN.source, "g"),
    (whole: string, sigil: string, rawName: string): string => {
      if (sigil !== "") return whole;
      const name = rawName.trim();
      const field = byName.get(name) ?? byId.get(name);
      if (field === undefined) return whole;
      const element = BRIDGEABLE.get(field.type);
      if (element === undefined) return whole;
      const source = field.sourceFieldId === null ? null : (byId.get(field.sourceFieldId) ?? null);
      const lang = option(field.options, "lang");
      const voice = option(field.options, "voice");
      if (source === null) {
        rewrites.push({
          field: name,
          type: field.type,
          source: null,
          lang,
          voice,
          skipped: field.sourceFieldId === null ? "no source_field_id" : "source field is gone",
        });
        return whole;
      }
      rewrites.push({ field: name, type: field.type, source: source.name, lang, voice, skipped: null });
      const attributes =
        (lang === null ? "" : ` lang="${lang}"`) + (voice === null ? "" : ` voice="${voice}"`);
      return `<${element}${attributes}><<${source.name}>></${element}>`;
    },
  );

  return { content: rewritten, rewrites, unchanged: rewritten === content };
}
