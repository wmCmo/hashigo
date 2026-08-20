/**
 * Stage 1.5 — binding generated content to the fields that render it.
 *
 *     import { expandGeneratorFields, resolveFieldGenerations, storeTextResolver } from "hashigo/generate";
 *
 * WHY THIS EXISTS. Mochi keeps generated content in `component-cache`, keyed by
 * the generator's input text, and never in `fields[].value`. The importer landed
 * all 42,569 blobs correctly and never connected them to the fields that would
 * render them, so the renderer — which is right on all 7,716 cards — rendered
 * silence: 5,708 cards hold audio, 86 produced an `<audio>` element, and 単語
 * produced none at all across 3,456 cards with a clip.
 *
 * THE PIPELINE. Three steps, in this order, each in its own layer:
 *
 *     const card = resolveCard(cardRow, templateRow);        // template
 *     const bound = expandGeneratorFields(card.sides, ctx);  // here
 *     renderResolvedCard({ ...card, sides: bound.sides });   // render
 *
 * and then, once, per card:
 *
 *     const { diagnostics } = resolveFieldGenerations(db, bound.expanded, { cardId });
 *
 * Nothing in this module fetches a payload, decodes an mp3, or touches a media
 * element. It answers "which blob" and "how sure"; the review UI decides whether
 * to play it, and only ever on a reveal.
 */

export {
  expandGeneratorFields,
  fieldGenerationRequest,
  generationInput,
  isGeneratorType,
  FIELD_TYPE_BLOB_KIND,
  GENERATOR_FIELD_TYPES,
  type FieldContext,
  type FieldGenerationRequest,
  type GeneratorField,
} from "./fields.js";

export {
  resolveFieldGeneration,
  resolveFieldGenerations,
  storeTextResolver,
  type GenerationDiagnostics,
  type GenerationMatch,
  type ResolveOptions,
  type ResolvedFieldGeneration,
} from "./store.js";
