/**
 * Stage 7 — the card loader. A card id in, a renderable card out.
 *
 *     import { loadRenderedCard, directionForTrackKind } from "hashigo/cards";
 *
 *     const [next] = dueTracks(db, { limit: 1 });
 *     const card = loadRenderedCard(db, next.cardId, directionForTrackKind(next.kind));
 *
 * That is the join between `hashigo/scheduler` (what to review) and
 * `hashigo/render` (how to draw it), and until now it existed only inside
 * `spike/viewer/`, which is a throwaway harness.
 *
 * BROWSER-PORTABLE, and pinned as such: typed against `SqliteHandle`, reaching no
 * `node:` import, walked by `test/browser-portable.test.ts`. The review screen
 * runs in an OPFS worker, so that is a requirement rather than a nicety — and as
 * of 2026-08-22 `src/generate` clears the same bar, which is what let `./audio.ts`
 * live here at all.
 *
 * The one thing to know before calling anything: `renderLoadedCard` forces
 * `pendingGenerators: true` and will not let a caller turn it off. Without it
 * 99.5% of the audio disappears with no error — measured, 6,855 speech mounts
 * against 31. `./load.ts`'s header has the numbers and the mechanism.
 */

export {
  cardAudioResolver,
  resolveAudioHash,
  type CardAudioOptions,
} from "./audio.js";

export { backlinksOf, type Backlink } from "./backlinks.js";

export { linkNamesFor, linkTargetsOf, type LinkNames } from "./link-names.js";

export {
  cardContext,
  cardInputFor,
  decodeFieldOptions,
  decodeReversePermutation,
  directionForTrackKind,
  loadCard,
  loadRenderedCard,
  renderLoadedCard,
  type CardContext,
  type LoadedCard,
  type LoadedField,
  type LoadedTemplate,
} from "./load.js";
