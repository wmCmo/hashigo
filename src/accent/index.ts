export {
  PLACEHOLDER,
  PLACEHOLDER_SPELLINGS,
  accentKey,
  hasPlaceholder,
  readingLooksUnanalysed,
} from "./key.js";

export {
  ENDPOINT,
  NotKanaError,
  VOICE,
  isKana,
  speechSsml,
  splitMoras,
  synthesise,
  yomigana,
  type SpeechRequest,
  type SynthesiseOptions,
} from "./speech.js";

export {
  applyAccentFill,
  planAccentFill,
  type DeriveResult,
  type DerivedLine,
  type FillItem,
  type FillReport,
} from "./fill.js";

export {
  CARD_ADJUDICATIONS,
  DICTIONARY_ADJUDICATIONS,
  OJAD_ADJUDICATIONS,
  OJAD_AMBIGUOUS,
  applyOjadAdjudications,
  cardAccentOverrides,
  type Adjudication,
  type CardAdjudication,
  type CitedAdjudication,
} from "./ojad.js";

export {
  accentFor,
  accentLabel,
  loadAccents,
  materialiseAccents,
  primaryLabelFor,
  setManualAccent,
  type AccentBasis,
  type AccentRow,
  type AccentType,
  type LoadReport,
  type MaterialiseReport,
  type ResolvedAccent,
} from "./store.js";
