/**
 * The climb — decision 32 / the design brief §5.
 *
 * THE LADDER DOES NOT GROW, THE CAMERA CLIMBS. Every rung slides down one slot,
 * the bottom one exits, and a new loose rung fades in at the top. So the mark is
 * IDENTICAL at rest, forever, and the user has just watched themselves move.
 * That property is the whole point and it is asserted in `test/climb.test.ts`:
 * after a full cycle every path `d`, stroke and opacity matches the static mark
 * byte for byte.
 *
 * ─── TWO THINGS THE BRIEF SAYS NOT TO CHANGE, WITH ITS REASONS ──────────────
 *
 * NO OVERSHOOT ON THE ACCENT. An earlier version used `easeOutBack`. The loose
 * rung travels 27 units while the rung below it travels 17, so it is already
 * moving 1.6x faster; overshoot closed the gap between them to ~13 units and
 * read as a near-collision. Do not add "bounce".
 *
 * 520 ms IS THE CEILING. A slower version that let the accent settle last was
 * tested and rejected — more physically correct, too slow to be good per-action
 * feedback.
 *
 * ─── REDUCED MOTION IS A CROSS-FADE, NOT A SNAP ─────────────────────────────
 *
 * The brief flags the snap as an open item and asks for this instead: the new
 * rung positions fade in over the old ones with NO translation. A snap
 * technically complies with `prefers-reduced-motion` and throws the feedback
 * away entirely, which is the thing the animation existed to give.
 */

/** Slot 0 is the loose rung; slot 4 is off the bottom, where a rung exits. */
export const SLOT_Y = [13, 40, 57, 77, 101] as const;

/** The rails lean 11.5 units over a 55-unit rise. Rung ends are COMPUTED from
 *  this, never authored, so they always land exactly on the rails. */
export const SLOPE = 0.20909;

const NS = "http://www.w3.org/2000/svg";

/** The brief's ceiling, not a starting point. A slower version that let the
 *  accent settle last was tested and rejected as poor per-action feedback. */
export const DURATION_MS = 520;

const VERMILION = [0xe0, 0x45, 0x1d] as const;
const INDIGO = [0x1b, 0x3b, 0x6f] as const;

/** Exported so `test/climb.test.ts` can re-derive the committed mark from it —
 *  the brief says these numbers are derived and must not be "cleaned up". */
export const railX = (y: number): [number, number] => {
  const d = (87 - y) * SLOPE;
  return [16 + d, 84 - d];
};

/** No overshoot, deliberately. See the header. */
export const easeOutCubic = (p: number): number => 1 - (1 - p) ** 3;

const mix = (t: number): string => {
  const clamped = Math.min(1, Math.max(0, t));
  const c = VERMILION.map((v, i) => Math.round(v + ((INDIGO[i] as number) - v) * clamped));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

interface Rung {
  slot: number;
  el: SVGPathElement;
}

/**
 * Paint one rung. `tint` is the slot-space position used for the colour ramp —
 * vermilion at slot 0, indigo from slot 1 on — so a rung crossing 0 -> 1 during
 * a climb lerps rather than switching.
 */
function place(el: SVGPathElement, y: number, tint: number, opacity: number): void {
  const [left, right] = railX(y);
  el.setAttribute("d", `M${left.toFixed(2)} ${y.toFixed(2)}H${right.toFixed(2)}`);
  el.setAttribute("stroke", mix(tint));
  el.setAttribute("opacity", opacity.toFixed(3));
}

export interface Climb {
  /** Advance one rung. Resolves when the mark is back at rest. */
  step(): Promise<void>;
}

/**
 * Build the mark into `host` and return a handle that can advance it.
 *
 * `host` must be an empty `<svg viewBox="0 0 100 100">`. The rails are drawn
 * once and never move — only rungs animate.
 */
export function mountClimb(host: SVGSVGElement): Climb {
  host.replaceChildren();

  const rails = document.createElementNS(NS, "g");
  rails.setAttribute("fill", "none");
  rails.setAttribute("stroke", "currentColor");
  rails.setAttribute("stroke-width", "10");
  rails.setAttribute("stroke-linecap", "round");
  for (const d of ["M16 87L27.5 32", "M84 87L72.5 32"]) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    rails.appendChild(path);
  }
  host.appendChild(rails);

  const newRung = (): SVGPathElement => {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-width", "9");
    // Round caps are load-bearing — they are why the wordmark is set at maximum
    // softness. Never butt or square.
    path.setAttribute("stroke-linecap", "round");
    host.appendChild(path);
    return path;
  };

  let rungs: Rung[] = [0, 1, 2, 3].map((slot) => ({ slot, el: newRung() }));
  const rest = (): void => {
    for (const r of rungs) place(r.el, SLOT_Y[r.slot] as number, r.slot, 1);
  };
  rest();

  let busy = false;

  const step = (): Promise<void> => {
    if (busy) return Promise.resolve();
    busy = true;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = rungs.map((r) => r.slot);
    const fresh: Rung = { slot: 0, el: newRung() };

    return new Promise<void>((resolve) => {
      const t0 = performance.now();
      const frame = (now: number): void => {
        const raw = Math.min(1, (now - t0) / DURATION_MS);
        const p = reduced ? raw : easeOutCubic(raw);

        rungs.forEach((r, i) => {
          const a = from[i] as number;
          const b = a + 1;
          const ya = SLOT_Y[a] as number;
          const yb = SLOT_Y[b] as number;
          // Reduced motion: no translation at all. The rung is simply drawn at
          // its destination and cross-faded in.
          const y = reduced ? yb : ya + (yb - ya) * p;
          const tint = reduced ? b : a + p;
          let opacity = 1;
          if (b === 4) opacity = reduced ? 1 - raw : p < 0.45 ? 1 : 1 - (p - 0.45) / 0.55;
          else if (reduced) opacity = raw;
          place(r.el, y, tint, opacity);
        });

        place(
          fresh.el,
          SLOT_Y[0] as number,
          0,
          reduced ? raw : p < 0.55 ? 0 : (p - 0.55) / 0.45,
        );

        if (raw < 1) {
          requestAnimationFrame(frame);
          return;
        }

        // Land exactly on the static mark. Nothing here is interpolated, so a
        // dropped frame cannot leave the mark a fraction of a unit off.
        rungs.forEach((r, i) => {
          r.slot = (from[i] as number) + 1;
        });
        for (const r of rungs) if (r.slot === 4) r.el.remove();
        rungs = rungs.filter((r) => r.slot !== 4);
        rungs.unshift(fresh);
        rest();
        busy = false;
        resolve();
      };
      requestAnimationFrame(frame);
    });
  };

  return { step };
}
