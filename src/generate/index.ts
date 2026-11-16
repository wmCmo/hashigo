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
  setCardVoice,
  setDeckVoice,
  setDefaultVoice,
  voiceFor,
  type VoiceResolution,
} from "./voice.js";

export {
  resolveDescriptorText,
  resolveFieldGeneration,
  resolveFieldGenerations,
  storeDescriptorText,
  storeTextResolver,
  type GenerationDiagnostics,
  type GenerationMatch,
  type ResolveOptions,
  type ResolvedFieldGeneration,
} from "./store.js";

export { storeGeneratedSpeech, FILL_VOICE, fillVoiceFor, type SpeechDescriptor } from "./speech.js";
export {
  catalogueVoice,
  GOOGLE_VOICES,
  isCatalogueVoice,
  sampleLine,
  synthesisVoice,
  voicesFor,
  type CatalogueVoice,
} from "./voices.js";

export {
  generateText,
  ollamaReachable,
  stripThinking,
  cleanGenerated,
  sentenceProblem,
  emojiOnly,
  isEmojiPrompt,
  systemPrompt,
  OLLAMA_HOST,
  OLLAMA_MIN_PREDICT,
  OLLAMA_MODEL,
  type LlmDescriptor,
  type LlmOptions,
  type LlmProvider,
} from "./llm.js";
export { cardSearchText, refreshSearchText } from "./search-text.js";
