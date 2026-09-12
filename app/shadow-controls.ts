/**
 * THE SHADOWING CONTROLS — loop, speed, and a recording of his own voice.
 *
 * ─── WHY THESE THREE AND NOT THE OTHER FOUR ─────────────────────────────────
 *
 * Zach handed over a card-controls mockup on 2026-09-12 and asked whether to
 * adopt it wholesale. Most of it was behind the shipping app — a single global
 * player per card is the bug he had reported that morning, and a fixed 27px
 * centred prompt undoes decisions 35 and 39. What it had and this did not was
 * controls for the drill itself, which is the one thing every clip in this
 * corpus exists for: he looks at the kanji, recalls the contour, SAYS IT ALOUD,
 * and only then listens to compare.
 *
 * Measured before choosing, from 1,200 speech blobs with their MP3 frame headers
 * parsed:
 *
 *     isolated word (source <= 8 ch)   n=551   p50 1.63s   max  2.59s
 *     example sentence (> 8 ch)        n=649   p50 4.08s   max 25.44s
 *     over 10 seconds                  12 of 1,200 — 1.0%
 *
 * A 1.63s word is a thing you loop, not a thing you seek inside. That killed the
 * mockup's scrub bar (a seek target on a clip shorter than the gesture) and made
 * the case for loop, which is the actual shape of shadowing practice.
 *
 * ─── 0.5x IS DELIBERATELY ABSENT, AND IT IS THE ONE REAL RISK HERE ──────────
 *
 * The mockup offers 0.5 / 0.75 / 1 / 1.25. Rate changes on an `<audio>` element
 * are a phase vocoder: time is stretched and pitch held. That is exactly what is
 * wanted — the accent is the F0 contour, and a rate that TRANSPOSED it would be
 * useless — but the stretching smears rapid transitions, and the downstep is a
 * rapid transition. It is the fact being trained. 0.75x is mild enough to be
 * safe; 0.5x is where the artifacts start landing on the one feature that
 * matters. So the ladder stops at 0.75.
 *
 * `preservesPitch` is set explicitly in `src/render/audio.ts` for the same
 * reason — see the note on `PlayableMediaElement`.
 *
 * ─── THE TAKE IS EPHEMERAL, AND THAT IS A DECISION NOT AN OMISSION ──────────
 *
 * A recording lives in memory and is revoked when the card changes. Nothing
 * reaches OPFS, so decision 17's backup and decision 33's sync have nothing to
 * say about it and no schema moves. Keeping takes — across cards, across
 * sessions, to compare his July self against his September self — is a real
 * feature and a separate decision, and building the storage now would be
 * answering a question he has not been asked.
 *
 * ─── WHY THIS FILE HAS NO IMPORTS ───────────────────────────────────────────
 *
 * Same reason as `app/review-steps.ts`, `app/review-boundary.ts` and
 * `app/keys.ts`: the root `tsconfig.json` EXCLUDES `app/`, so a module with no
 * imports is reachable from `test/` and one that touches the DOM is not. Every
 * rule that can be decided without a browser is decided here and pinned by
 * `test/app-logic.test.ts`; `app/main.ts` maps the result onto elements.
 */

/**
 * The rate ladder. See the header for why it stops at 0.75 rather than 0.5.
 *
 * 1 is FIRST because it is the resting state, and the cycle wraps — so one press
 * from normal gives the slow one, which is the direction he will want nine times
 * out of ten.
 */
export const SPEEDS = [1, 0.75, 1.25] as const;

export type Speed = (typeof SPEEDS)[number];

export interface Playback {
  readonly rate: number;
  readonly loop: boolean;
}

export const DEFAULT_PLAYBACK: Playback = { rate: 1, loop: false };

/** The next rate in the ladder, wrapping. An unknown rate resets to normal. */
export function nextSpeed(current: number): number {
  const at = SPEEDS.indexOf(current as Speed);
  if (at === -1) return SPEEDS[0];
  return SPEEDS[(at + 1) % SPEEDS.length] as number;
}

/**
 * How a rate is written on a button.
 *
 * `1x` rather than `1.00x`: the resting state should read as the absence of a
 * setting, and trailing zeros make normal speed look like a configuration he has
 * to think about.
 */
export function speedLabel(rate: number): string {
  return `${String(Number(rate.toFixed(2)))}×`;
}

/**
 * Read the persisted settings.
 *
 * TOLERANT ON PURPOSE — this comes out of `localStorage`, which can hold
 * anything a previous version wrote, anything a different tab wrote, or garbage
 * from a half-finished write. A rate that is not on the ladder is dropped rather
 * than honoured: an out-of-range `playbackRate` is how a clip ends up at 4x with
 * no control on screen able to explain it.
 */
export function readPlayback(raw: string | null | undefined): Playback {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_PLAYBACK;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PLAYBACK;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_PLAYBACK;
  const held = parsed as { rate?: unknown; loop?: unknown };
  const rate =
    typeof held.rate === "number" && SPEEDS.includes(held.rate as Speed)
      ? held.rate
      : DEFAULT_PLAYBACK.rate;
  return { rate, loop: held.loop === true };
}

export function writePlayback(state: Playback): string {
  return JSON.stringify({ rate: state.rate, loop: state.loop });
}

/**
 * Where a recording is in its life.
 *
 *   idle       nothing recorded, nothing running
 *   arming     the mic has been asked for and the browser has not answered
 *   recording  capturing
 *   take       a recording exists and can be played
 *   denied     permission was refused, or there is no recorder here
 *
 * `arming` is a state rather than a moment because `getUserMedia` shows a
 * permission prompt the first time and can sit there for as long as he takes to
 * answer it. A button that looks idle during that wait gets pressed again.
 */
export type TakeState = "idle" | "arming" | "recording" | "take" | "denied";

export interface TakeLabel {
  readonly record: string;
  /** Null when there is nothing to play. */
  readonly take: string | null;
  readonly recordDisabled: boolean;
}

/**
 * What the two buttons say, given the state. Pure, so the table is testable.
 *
 * `denied` DISABLES rather than hides — the same rule `.clip[data-clip="missing"]`
 * follows. A control that vanishes leaves him wondering whether the feature
 * exists; one that is visibly unavailable, with the reason in its title, has
 * answered the question.
 */
export function takeLabels(state: TakeState): TakeLabel {
  switch (state) {
    case "arming":
      return { record: "allow…", take: null, recordDisabled: true };
    case "recording":
      return { record: "stop", take: null, recordDisabled: false };
    case "take":
      return { record: "record", take: "your take", recordDisabled: false };
    case "denied":
      return { record: "record", take: null, recordDisabled: true };
    default:
      return { record: "record", take: null, recordDisabled: false };
  }
}

/**
 * May a clip be played right now?
 *
 * FALSE WHILE RECORDING, and this is not tidiness. He reviews on a phone, on its
 * own speaker; a take captured while the reference clip is sounding contains the
 * reference clip, and comparing his contour against a recording of itself mixed
 * with his own voice is worse than useless — it is confidently wrong feedback on
 * the exact thing he is trying to learn.
 */
export function mayPlayClip(state: TakeState): boolean {
  return state !== "recording" && state !== "arming";
}

/**
 * The constraints the microphone is opened with.
 *
 * `autoGainControl: false` and `noiseSuppression: false` are the load-bearing
 * pair. Both are tuned for intelligibility on a call: AGC flattens dynamics and
 * suppression reshapes the spectrum, and this recording exists to be compared
 * against a reference CONTOUR. `echoCancellation` stays on — it is the one that
 * helps here, because the speaker and the mic are eight centimetres apart on the
 * device he reviews with.
 */
export const CAPTURE: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
};

/**
 * The first container the recorder here supports.
 *
 * Chromium and Samsung Internet — the two that matter, since the phone is the
 * review surface — give `audio/webm;codecs=opus`. Safari gives `audio/mp4`. An
 * empty string is legal and means "you pick", which is the right last resort:
 * `MediaRecorder` with no type is still a recorder.
 */
export function pickRecordingType(supported: (type: string) => boolean): string {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (supported(type)) return type;
  }
  return "";
}
