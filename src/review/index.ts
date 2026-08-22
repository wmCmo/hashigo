/**
 * Stage 7 — the review screen's card mount.
 *
 *     import { mountTrack } from "hashigo/review";
 *     import { buildSession } from "hashigo/session";
 *
 *     const session = buildSession(db);
 *     const item = session.current()!;
 *     const mounted = mountTrack({ db, track: item, document, store });
 *     container.appendChild(mounted.result.root);
 *     mounted.loop.enter(0);                 // on screen. SILENT, by design.
 *
 * The first thing in `src/` to drive `shadowingLoop` — the reveal loop that
 * actually ships. `spike/viewer/` proved Chromium does not autoplay, but it
 * hand-rolled its own sequencing, so that evidence never covered this code.
 *
 * `./mount.ts`'s header carries the sharp edge worth knowing before you call
 * anything: `loadRenderedCard`, the documented entry point in
 * `src/cards/README.md`, CANNOT reach the audio, because `expandGeneratorFields`
 * needs the template fields and card values it does not return. A card mounted
 * that way renders perfectly and is silent, with no error, on all 5,664 cards
 * that carry speech.
 */

export {
  mountCard,
  mountTrack,
  type MountOptions,
  type MountedCard,
} from "./mount.js";
