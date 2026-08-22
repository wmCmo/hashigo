/**
 * Text rendering. One module, one definition of what a card says in plain text.
 *
 * See `render.ts` for the link grammar, the U+200E story, and the reasoning
 * about what is and is not normalised. Import from here, not from `render.js`.
 */

export {
  INVISIBLE_MARKS,
  WIKI_LINK,
  linkDisplayText,
  parseWikiLinks,
  renderPlainText,
  renderPlainTextParts,
  stripInvisible,
  type RenderOptions,
  type ResolveName,
  type WikiLink,
  type WikiLinkForm,
} from "./render.js";

export {
  PARENTHESIS,
  READING_OVERRIDES,
  classifyParenthesis,
  hasParenthesis,
  parseReading,
  type ParsedReading,
  type ReadingVerdict,
} from "./parenthesis.js";
