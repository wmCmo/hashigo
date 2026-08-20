/**
 * Step 3 — 高低アクセント derivation storage and `<<型>>`.
 *
 *     import { accentFor, accentKey, loadAccents, materialiseAccents } from "hashigo/accent";
 *
 * THE DERIVATION ITSELF IS NOT HERE, and cannot be: it needs OpenJTalk, which
 * exists only as a Python wheel (`pyopenjtalk-plus`, prebuilt — upstream
 * `pyopenjtalk` needs cmake and fails on this machine). So the split is:
 *
 *     src/accent/cli.ts words   -> the normalised head words, one per line
 *     tools/accent_derive.py    -> JSONL, one derivation per word
 *     src/accent/cli.ts load    -> rows in `accents`
 *     src/accent/cli.ts write   -> the 型 label into card_field_values
 *
 * TypeScript owns the text transform and every CHECK constraint; Python owns
 * only the analyser. That boundary is not tidiness — feeding the analyser a raw
 * field value mis-read 準備 as ジュン+ソナエ and 面倒 as メン+タオセ, because
 * U+200E sits inside those compounds. `accentKey` is the fix and there is one of
 * it. See `./key.ts`.
 */

export {
  PLACEHOLDER,
  PLACEHOLDER_SPELLINGS,
  accentKey,
  hasPlaceholder,
  readingLooksUnanalysed,
} from "./key.js";

export {
  OJAD_ADJUDICATIONS,
  OJAD_AMBIGUOUS,
  applyOjadAdjudications,
  type Adjudication,
} from "./ojad.js";

export {
  accentFor,
  loadAccents,
  materialiseAccents,
  setManualAccent,
  type AccentBasis,
  type AccentRow,
  type AccentType,
  type LoadReport,
  type MaterialiseReport,
  type ResolvedAccent,
} from "./store.js";
