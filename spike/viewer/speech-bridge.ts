/**
 * THROWAWAY (spike harness) — the SPEECH-FIELD BRIDGE, and the reason it exists
 * is the most load-bearing thing this harness found. Read this before judging it.
 *
 * THE FINDING. 高低アクセント shadowing is why the audio exists, and 単語 side 2
 * is where the drill lives: a cloze hides the reading, and `<< Speech >>` is the
 * clip he hears only after producing it. But `Speech` is a `template_fields` row
 * of type `speech`, and a generator field's VALUE is empty in this corpus —
 * `card_field_values` holds ZERO rows for 単語's `Speech` (6ov2HLxA) and `Audio`
 * (efJTAfzT), across all 3,456 cards that have speech blobs. So the resolver does
 * exactly what it is specified to do — substitute the value — and substitutes
 * nothing. `<< Speech >>` vanishes before the renderer ever sees it. There is no
 * element, no `MediaMount`, no `data-state="pending"` marker, nothing to hang a
 * clip on. The audio is on the card (`blob_refs`, `field_id` NULL, `ref_key` =
 * `<file>.mp3`, 10,862 rows) and unreachable from `RenderResult`.
 *
 * Measured, from the real database, by the queries in the report:
 *
 *   values on speech-typed fields ......... 0 rows
 *   MediaMounts on a real 単語 card ....... 0
 *   corpus-wide renderer <audio> elements .. 95, every one from an inline
 *                                            <speech> tag, none from a field
 *   cards with a cloze AND an inline <speech> on the SAME side .... 0
 *
 * So the drill's shape — cloze and clip together — exists ONLY through a speech
 * field, and a speech field renders to nothing. A review UI built on today's
 * `RenderResult` is silent on every 単語 card.
 *
 * WHAT THIS FILE DOES ABOUT IT, AND WHAT IT REFUSES TO DO. It does not add a
 * renderer path; `src/render` is stage 4's and is not touched. It rewrites the
 * TEMPLATE BODY before stage 3 runs, turning `<< Speech >>` into the inline form
 * that already means exactly the same thing:
 *
 *   << Speech >>   ->   <speech lang="ja-JP" voice="ja-JP-NanamiNeural"><< 単語 >></speech>
 *
 * — where `単語` is the field's own `source_field_id` and the attributes are its
 * own `options`. Everything downstream is then the real thing: the real parser,
 * the real resolver, a real `GeneratorMount` with a real silent `<audio>`, and
 * the real `src/blobs/url.ts` attach. It is a source transform, not a second
 * renderer, and it is a toggle in the UI so the current truth (silence) and the
 * intended exercise (a clip on reveal) can be seen side by side.
 *
 * It is also a concrete proposal: whoever owns stage 9 can either materialise
 * generator-field values, or make the resolver emit an element for a generator
 * field the way the template author would have written it by hand. This file is
 * the second option, applied at the last possible moment.
 *
 * ONE MEASURED LIMITATION, and it argues for the FIRST option. Wrapping a field
 * reference in an inline element only works while the field's value stays on one
 * line, and the bridge cannot see values — it runs on the template. On New Vocab,
 * `<< Example >>` sits on a blockquote line (`><< Example >>`) and its source
 * field `Example Sentence` is multi-line on four cards — `uG94X2PY`, `uynG25Ps`,
 * `RSzjH93d`, `1oehn26r`, each carrying an `<image>` on a second line. After
 * interpolation the `</speech>` lands outside the blockquote, and the renderer
 * does exactly the right thing with it: `hashigo-unknown` with
 * `data-reason="unclosed-element"` and `"mismatched-close"`, both visible, both
 * in `diagnostics`, and the freed `<image>` mounts normally. 4 cards of 7,716,
 * loudly. Materialising the value instead of rewriting the body has no such
 * failure mode, which is the finding, not the workaround.
 */

import { FIELD_TOKEN } from "../../src/template/index.js";

import type { FieldRow } from "./protocol.js";

/** Generator field types that have an equivalent inline element in `ELEMENTS`. */
const BRIDGEABLE: ReadonlyMap<string, string> = new Map([["speech", "speech"]]);

export interface Rewrite {
  /** The field reference that was rewritten, e.g. `Speech`. */
  readonly field: string;
  readonly type: string;
  /** The field whose text it says, e.g. `単語`. */
  readonly source: string | null;
  readonly lang: string | null;
  readonly voice: string | null;
  /** Why it was left alone, when it was. */
  readonly skipped: string | null;
}

export interface BridgeResult {
  readonly content: string;
  readonly rewrites: readonly Rewrite[];
  /** True when nothing was rewritten, so the caller can say "nothing to bridge". */
  readonly unchanged: boolean;
}

/** `lang` / `voice` out of `template_fields.options`, and nothing else. */
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
  // An attribute value reaches the parser as source text, so it is constrained
  // here to the shape a BCP-47 tag or an Azure voice name actually has. Anything
  // else is dropped rather than escaped: this is a harness, and a template that
  // needs escaping is a finding, not a feature.
  return /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null;
}

/**
 * Rewrite every bridgeable generator-field reference in a template body.
 *
 * Section markers (`<<#Field>>`, `<<^Field>>`, `<</Field>>`) are left strictly
 * alone: they gate lines and are not interpolations. Only the bare form is
 * touched, and only when the field's type is bridgeable AND it has a source
 * field to say — a `speech` field with no source has no text and is reported as
 * skipped rather than rewritten into an empty element.
 */
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
