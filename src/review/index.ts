/**
 * Stage 7 — the review screen's card mount, and the switch that decides which
 * exercise a card runs.
 *
 *     import { mountTrack } from "hashigo/review";
 *     import { buildSession } from "hashigo/session";
 *
 *     const session = buildSession(db);
 *     const item = session.current()!;
 *     const mounted = mountTrack({ db, track: item, document, store });
 *     container.appendChild(mounted.result.root);
 *     mounted.enter(0);        // on screen — and on an `identify` card, ASKING.
 *
 * The first thing in `src/` to drive `shadowingLoop` — the reveal loop that
 * actually ships. `spike/viewer/` proved Chromium does not autoplay, but it
 * hand-rolled its own sequencing, so that evidence never covered this code.
 *
 * **Call `mounted.enter()`, not `mounted.loop.enter()`.** The loop's own `enter`
 * plays nothing, ever, which is right for the 692 `produce` cards and silently
 * wrong for the 3,177 `identify` ones where the clip is the question (decision
 * 29). `./mode.ts` is where that is decided and documents the two traps in it —
 * 漢字 declares a plain field called `Reading`, and `identify` is not simply
 * everything that is not `produce`.
 *
 * `./mount.ts`'s header carries the other sharp edge, the one worth knowing
 * before you call anything: `loadRenderedCard`, the documented entry point in
 * `src/cards/README.md`, CANNOT reach the audio, because `expandGeneratorFields`
 * needs the template fields and card values it does not return. A card mounted
 * that way renders perfectly and is silent, with no error, on all 5,664 cards
 * that carry speech.
 */

export {
  mountCard,
  mountPrepared,
  mountTrack,
  prepareCard,
  type MountOptions,
  type MountPreparedOptions,
  type MountedCard,
  type PrepareOptions,
  type PreparedCard,
} from "./mount.js";

export { fillTextSlots, textSlots, type TextSlot } from "./text.js";

export {
  ACCENT_FIELD_TYPE,
  READING_FIELD,
  cardMode,
  promptsOnEntry,
  readingSwitch,
  reviewModeFor,
  type CardMode,
  type ReviewMode,
} from "./mode.js";
