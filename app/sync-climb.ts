/**
 * THE LADDER CLIMBING, WHILE THE SEED DOWNLOADS.
 *
 * Zach's design, 2026-09-16, handed over as a working prototype with dials on it
 * — presets for a fast / typical / post-rebuild fetch, a stall simulator, and
 * sliders for every stage. The numbers below are his, read off that file.
 *
 * ─── WHAT THIS IS ACTUALLY FOR, WHICH THE DRAFT NAMED WRONGLY ──────────────
 *
 * The draft called it "the sync screen". **In this repo `sync` means decision 33**
 * — the mailbox, device-to-device, ~1 MB of JSON, and since 2026-09-14 it pushes
 * in the background. This is the other thing: the SEED FETCH in `app/db.worker.ts`,
 * which is 74 MB of cards + 9 MB of text + up to 643 MB of audio and cannot run in
 * the background because the app has nothing to open until it lands.
 *
 * The design survives the rename; the premises had to be re-attached. In
 * particular **the gate is right for a different reason than the draft gives**:
 * there is no "fast seed fetch". Either every file is already in OPFS and nothing
 * is fetched at all, or it is hundreds of megabytes. The gate exists so a boot
 * that fetches NOTHING never flashes a full-screen download UI.
 *
 * ─── PRINCIPLE: CHANGE IS REASSURANCE, MOTION IS NOT ───────────────────────
 *
 * His line, and it is the strongest thing in the design. A spinner looks the same
 * whether the transfer is healthy or hung, so after ninety seconds it reads as
 * frozen. A byte counter going up is evidence. That is why the screen is mostly
 * numbers and the climb is the slow part.
 *
 * It is also already half-true here: `showFetchProgress` was built on 2026-09-08
 * after *"frozen on this page for like 5 mins"* and has carried a real per-file
 * bar since. This adds the mark, the phases and the stall notice to that.
 *
 * ─── THE GEOMETRY IS THE SHIPPED MARK, NOT A COPY OF IT ────────────────────
 *
 * `railX` and `SLOT_Y` reproduce `app/index.html`'s authored rungs exactly —
 * `railX(77)` is `[18.09, 81.91]`, which is the `d` attribute already in the
 * file, to the digit. `test/app-logic.test.ts` pins that, so a change to the mark
 * that forgets the animation fails rather than drifting.
 *
 * NO IMPORTS — the same rule as `./review-boundary.ts` and `./review-steps.ts`:
 * the root `tsconfig.json` excludes `app/`, so an import-free module is reachable
 * from `test/` and one that touches the DOM is not.
 */

/** One rung: `s` is its slot position (fractional while moving), `op` its opacity. */
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

/** Slot 0 is the accent at the top; slot 4 is below the lowest rung, off the mark. */
export const SLOT_Y = [13, 40, 57, 77, 101] as const;

/** The rails' gradient. `(87 - y) * SLOPE` is each rung's inset from the edge. */
export const SLOPE = 0.20909;

/**
 * Below this, the screen is never built — not hidden, never created.
 *
 * A full-frame blocking view that flashes for 400 ms reads as a glitch and makes
 * a fast boot feel slower than it was. **500 is his figure and it is a guess**,
 * which is worth saying out loud: the honest tuning target is "just above a boot
 * that fetches nothing", and that is a measurement nobody has taken on his phone.
 */
export const GATE_MS = 500;

/**
 * Tuned by eye, on the prototype. Slow on purpose.
 *
 * An earlier version used 520/260 — correct for a one-shot reward, too urgent for
 * an idle loop. With `easeOutCubic` peak velocity is 3× average, so 520 ms puts
 * the accent near 96 px/s inside a 62 px mark and 800 ms puts it near 63 px/s.
 * Slow reads as breathing; fast reads as working.
 *
 * **The beat is load-bearing.** Without it the new accent fades in under cover of
 * the drop and is never seen to arrive — the defect in his first version. Do not
 * remove it to save 200 ms.
 */
export const SYNC_STAGES: Stages = { drop: 800, beat: 200, fade: 500, hold: 600 };

/**
 * Deck completion, if it ever ships: one pass, starting ON the drop, no loop.
 *
 * Falls out of the phasing for free — with `hold: 0` the offset equals the cycle,
 * so `t = 0` lands on the drop instead of on the rest. One implementation, two
 * timings, which is what makes "re-evaluate if deck completion ships" a one-line
 * change rather than a rewrite.
 */
export const REWARD_STAGES: Stages = { drop: 520, beat: 150, fade: 260, hold: 0 };

const easeOut = (p: number): number => 1 - Math.pow(1 - p, 3);

/**
 * The rungs at `t` ms since the screen mounted.
 *
 * PHASED so `t = 0` is the start of `hold`: a fetch that clears the gate but ends
 * inside one cycle shows the complete mark at rest and no motion at all. That is
 * the right result — the resting form is the thing worth seeing, and the whole
 * animation was tuned around it.
 */
export function climbFrame(t: number, stages: Stages = SYNC_STAGES): Rung[] {
  const cycle = stages.drop + stages.beat + stages.fade + stages.hold;
  const offset = stages.drop + stages.beat + stages.fade;
  const u = (((t + offset) % cycle) + cycle) % cycle;

  if (u < stages.drop) {
    const o = easeOut(u / stages.drop);
    return [0, 1, 2, 3].map((s) => {
      const cur = s + o;
      // The bottom rung leaves the mark rather than piling up at the foot.
      return { s: cur, op: cur > 3.4 ? Math.max(0, (4.05 - cur) / 0.65) : 1 };
    });
  }
  if (u < stages.drop + stages.beat) {
    // THE BEAT: three rungs, nothing at slot 0. Nothing on screen is vermilion.
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

/** The still frame: the complete mark, for reduced motion and for a finished fetch. */
export function restFrame(): Rung[] {
  return [
    { s: 0, op: 1 },
    { s: 1, op: 1 },
    { s: 2, op: 1 },
    { s: 3, op: 1 },
  ];
}

/** Vertical position of a fractional slot, linear between the authored rungs. */
export function slotY(s: number): number {
  const c = Math.max(0, Math.min(s, SLOT_Y.length - 1));
  const i = Math.floor(c);
  const a = SLOT_Y[i] ?? 0;
  const b = SLOT_Y[Math.min(i + 1, SLOT_Y.length - 1)] ?? a;
  return a + (b - a) * (c - i);
}

/** Where the rails are at height `y` — the rung's two end points. */
export function railX(y: number): readonly [number, number] {
  const d = (87 - y) * SLOPE;
  return [16 + d, 84 - d];
}

/**
 * How far along vermilion → indigo a rung at slot `s` is, 0..1.
 *
 * **A NUMBER, NOT A COLOUR, AND THAT IS THE WHOLE POINT.** His prototype lerps
 * `[224,69,29] → [27,59,111]` in JavaScript, which are the LIGHT theme's
 * `--vermilion` and `--indigo`. Dark overrides both (`#f05a2e`, `#7fa4e1`), and
 * measured against the dark ground `#1B3B6F` is **1.60:1** — the landed rungs
 * would be invisible on the screen he actually reviews on, every screenshot he
 * has ever sent being dark.
 *
 * So the mix happens in CSS, where the tokens already know about the theme, and
 * this returns only the position along it.
 */
export function rungMix(s: number): number {
  return Math.max(0, Math.min(1, s));
}

// ─── the download, as the screen describes it ────────────────────────────────

export type Phase = "connecting" | "downloading" | "saving" | "ready";

/** No bytes for this long → say so. The only question a long fetch raises. */
export const STALL_AFTER_MS = 8_000;

/**
 * Before this, no estimate at all.
 *
 * An ETA that appears instantly and then swings from 2 minutes to 11 is worse
 * than none; a stable rate sample has to exist first.
 */
export const ETA_AFTER_MS = 15_000;

export interface Readout {
  readonly phase: Phase;
  /** 0..1, or null when the server sent no `Content-Length` and the bar sweeps. */
  readonly fraction: number | null;
  readonly stalled: boolean;
  /** Seconds remaining, or null while it would be a guess. */
  readonly etaSeconds: number | null;
}

export interface Sample {
  readonly at: number;
  readonly received: number;
}

/**
 * What the screen should say, from the progress the worker has posted.
 *
 * Pure so the thresholds are testable without a download: `now` and the samples
 * come from the caller.
 *
 * `bytesPerSecond` is measured over the WHOLE window it is given rather than the
 * last two samples — an instantaneous rate on a mobile link swings by an order of
 * magnitude, and an ETA built on it is the swinging number this defers for 15
 * seconds precisely to avoid.
 */
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

  // STALLED IS ABOUT BYTES, NOT ABOUT TIME. A slow link is not a stall, and
  // calling it one on a 2G train would cry wolf on every commute.
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

/** "less than a minute" / "about 4 minutes" — never a false 03:47. */
export function etaLabel(seconds: number | null): string {
  if (seconds === null) return "";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return "less than a minute left";
  const m = Math.round(s / 60);
  return `about ${m} minute${m === 1 ? "" : "s"} left`;
}
