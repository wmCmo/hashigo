export const SLOT_Y = [13, 40, 57, 77, 101] as const;

export const SLOPE = 0.20909;

const NS = "http://www.w3.org/2000/svg";

export const DURATION_MS = 520;

export const railX = (y: number): [number, number] => {
  const d = (87 - y) * SLOPE;
  return [16 + d, 84 - d];
};

export const easeOutCubic = (p: number): number => 1 - (1 - p) ** 3;

interface Rung {
  slot: number;
  el: SVGPathElement;
}

function place(el: SVGPathElement, y: number, tint: number, opacity: number): void {
  const [left, right] = railX(y);
  el.setAttribute("d", `M${left.toFixed(2)} ${y.toFixed(2)}H${right.toFixed(2)}`);
  el.style.setProperty("--t", Math.min(1, Math.max(0, tint)).toFixed(3));
  el.setAttribute("opacity", opacity.toFixed(3));
}

export interface Climb {
  step(): Promise<void>;
}

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
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("class", "rung");
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
