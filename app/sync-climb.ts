export interface Rung {
  readonly s: number;
  readonly op: number;
}

export interface Stages {
  readonly drop: number;
  readonly beat: number;
  readonly fade: number;
  readonly hold: number;
}

export const SLOT_Y = [13, 40, 57, 77, 101] as const;

export const SLOPE = 0.20909;

export const GATE_MS = 500;

export const SYNC_STAGES: Stages = { drop: 800, beat: 200, fade: 500, hold: 600 };

export const REWARD_STAGES: Stages = { drop: 520, beat: 150, fade: 260, hold: 0 };

const easeOut = (p: number): number => 1 - Math.pow(1 - p, 3);

export function climbFrame(t: number, stages: Stages = SYNC_STAGES): Rung[] {
  const cycle = stages.drop + stages.beat + stages.fade + stages.hold;
  const offset = stages.drop + stages.beat + stages.fade;
  const u = (((t + offset) % cycle) + cycle) % cycle;

  if (u < stages.drop) {
    const o = easeOut(u / stages.drop);
    return [0, 1, 2, 3].map((s) => {
      const cur = s + o;
      return { s: cur, op: cur > 3.4 ? Math.max(0, (4.05 - cur) / 0.65) : 1 };
    });
  }
  if (u < stages.drop + stages.beat) {
    return [
      { s: 1, op: 1 },
      { s: 2, op: 1 },
      { s: 3, op: 1 },
    ];
  }
  if (u < stages.drop + stages.beat + stages.fade) {
    const f = (u - stages.drop - stages.beat) / stages.fade;
    return [
      { s: 0, op: f },
      { s: 1, op: 1 },
      { s: 2, op: 1 },
      { s: 3, op: 1 },
    ];
  }
  return [
    { s: 0, op: 1 },
    { s: 1, op: 1 },
    { s: 2, op: 1 },
    { s: 3, op: 1 },
  ];
}

export function restFrame(): Rung[] {
  return [
    { s: 0, op: 1 },
    { s: 1, op: 1 },
    { s: 2, op: 1 },
    { s: 3, op: 1 },
  ];
}

export function slotY(s: number): number {
  const c = Math.max(0, Math.min(s, SLOT_Y.length - 1));
  const i = Math.floor(c);
  const a = SLOT_Y[i] ?? 0;
  const b = SLOT_Y[Math.min(i + 1, SLOT_Y.length - 1)] ?? a;
  return a + (b - a) * (c - i);
}

export function railX(y: number): readonly [number, number] {
  const d = (87 - y) * SLOPE;
  return [16 + d, 84 - d];
}

export function rungMix(s: number): number {
  return Math.max(0, Math.min(1, s));
}

export type Phase = "connecting" | "downloading" | "saving" | "ready";

export const STALL_AFTER_MS = 8_000;

export const ETA_AFTER_MS = 15_000;

export interface Readout {
  readonly phase: Phase;
  readonly fraction: number | null;
  readonly stalled: boolean;
  readonly etaSeconds: number | null;
}

export interface Sample {
  readonly at: number;
  readonly received: number;
}

export function readout(
  phase: Phase,
  samples: readonly Sample[],
  total: number | null,
  now: number,
  startedAt: number,
): Readout {
  const latest = samples[samples.length - 1];
  const received = latest?.received ?? 0;
  const fraction = total === null || total <= 0 ? null : Math.min(1, received / total);

  const lastChange = [...samples].reverse().find((s) => s.received < received)?.at ?? startedAt;
  const since = latest === undefined ? now - startedAt : now - Math.max(lastChange, latest.at);
  const stalled = phase === "downloading" && since >= STALL_AFTER_MS;

  let etaSeconds: number | null = null;
  const first = samples[0];
  if (
    phase === "downloading" &&
    !stalled &&
    total !== null &&
    first !== undefined &&
    latest !== undefined &&
    now - startedAt >= ETA_AFTER_MS
  ) {
    const seconds = (latest.at - first.at) / 1000;
    const rate = seconds > 0 ? (latest.received - first.received) / seconds : 0;
    if (rate > 0) etaSeconds = Math.max(0, (total - received) / rate);
  }
  return { phase, fraction, stalled, etaSeconds };
}

export function etaLabel(seconds: number | null): string {
  if (seconds === null) return "";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return "less than a minute left";
  const m = Math.round(s / 60);
  return `about ${m} minute${m === 1 ? "" : "s"} left`;
}
