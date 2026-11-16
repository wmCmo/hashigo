export const SPEEDS = [1, 0.75, 1.25] as const;

export type Speed = (typeof SPEEDS)[number];

export interface Playback {
  readonly rate: number;
  readonly loop: boolean;
}

export const DEFAULT_PLAYBACK: Playback = { rate: 1, loop: false };

export function nextSpeed(current: number): number {
  const at = SPEEDS.indexOf(current as Speed);
  if (at === -1) return SPEEDS[0];
  return SPEEDS[(at + 1) % SPEEDS.length] as number;
}

export function speedLabel(rate: number): string {
  return `${String(Number(rate.toFixed(2)))}×`;
}

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

export type TakeState = "idle" | "arming" | "recording" | "take" | "denied";

export interface TakeLabel {
  readonly record: string;
  readonly take: string | null;
  readonly recordDisabled: boolean;
}

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

export function mayPlayClip(state: TakeState): boolean {
  return state !== "recording" && state !== "arming";
}

export const CAPTURE: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
};

export function pickRecordingType(supported: (type: string) => boolean): string {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (supported(type)) return type;
  }
  return "";
}
