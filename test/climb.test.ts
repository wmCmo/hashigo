/**
 * The mark's geometry is DERIVED, and this file is what stops it being tidied.
 *
 * The design brief (decision 32) is explicit: *"Do not 'clean up' these numbers.
 * Every one of them follows from a rule."* The committed SVGs carry the derived
 * values as literals, so nothing in the repo would notice if somebody rounded
 * `18.09` to `18` — it would still look like a ladder, and the rungs would stop
 * meeting the rails.
 *
 * So: recompute every rung endpoint from the rail equation and require the
 * committed artwork to agree, to the digit.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DURATION_MS, easeOutCubic, railX, SLOPE, SLOT_Y } from "../app/climb.js";

const mark = readFileSync(new URL("../app/brand/mark.svg", import.meta.url), "utf8");

/** Every `M<x> <y>H<x2>` in a document, which is how a rung is drawn. */
function rungsIn(svg: string): { y: number; left: number; right: number }[] {
  return [...svg.matchAll(/M([\d.]+) ([\d.]+)H([\d.]+)/g)].map((m) => ({
    left: Number(m[1]),
    y: Number(m[2]),
    right: Number(m[3]),
  }));
}

describe("the mark's geometry is derived, not authored", () => {
  it("every rung in app/brand/mark.svg lands exactly on the rail equation", () => {
    const rungs = rungsIn(mark);
    // three rungs plus the loose one
    expect(rungs).toHaveLength(4);

    for (const rung of rungs) {
      const [left, right] = railX(rung.y);
      expect(Number(left.toFixed(2)), `left end of the rung at y=${rung.y}`).toBe(rung.left);
      expect(Number(right.toFixed(2)), `right end of the rung at y=${rung.y}`).toBe(rung.right);
    }
  });

  it("the rungs sit at the slots the climb animates between", () => {
    const ys = rungsIn(mark)
      .map((r) => r.y)
      .sort((a, b) => a - b);
    // At rest the mark occupies slots 0-3. Slot 4 is off the bottom.
    expect(ys).toEqual([SLOT_Y[0], SLOT_Y[1], SLOT_Y[2], SLOT_Y[3]]);
  });

  it("the loose rung sits exactly where a fourth rung would be", () => {
    // "The loose rung sits 27 units above the top rung — exactly where a fourth
    // rung would be if the ladder went that far." The gaps foreshorten 20 then
    // 17 climbing upward, so the next gap up is the one the brief names.
    expect(SLOT_Y[3] - SLOT_Y[2]).toBe(20);
    expect(SLOT_Y[2] - SLOT_Y[1]).toBe(17);
    expect(SLOT_Y[1] - SLOT_Y[0]).toBe(27);
  });

  it("the exit slot is clear of the rail feet, so a rung leaves rather than piling up", () => {
    // Rails run to y=87. A rung exiting at 101 is fully past them.
    expect(SLOT_Y[4]).toBeGreaterThan(87);
  });

  it("the rails lean about 12 degrees, which is what SLOPE encodes", () => {
    // 11.5 units of lean over a 55-unit rise.
    expect(SLOPE).toBeCloseTo(11.5 / 55, 5);
    expect((Math.atan(SLOPE) * 180) / Math.PI).toBeCloseTo(11.8, 1);
  });

  it("the small-size mark is a DIFFERENT construction, not a scaled one", () => {
    // Below 24px the three-rung mark collapses: the rungs go sub-pixel and the
    // loose rung reads as a floating dash. The favicon is two rungs by design.
    const small = readFileSync(new URL("../app/brand/favicon.svg", import.meta.url), "utf8");
    expect(rungsIn(small)).toHaveLength(3); // two rungs + the loose one
    expect(small).toContain('stroke-width="12"'); // heavier rails than the 10 above
  });
});

describe("the climb's motion is the brief's, and the brief forbids two changes", () => {
  it("runs for 520 ms — the ceiling, not a starting point", () => {
    expect(DURATION_MS).toBe(520);
  });

  it("never overshoots", () => {
    // easeOutBack was tried and rejected: the accent travels 27 units while the
    // rung below travels 17, so it is already 1.6x faster, and overshoot closed
    // the gap to ~13 units and read as a near-collision.
    for (let p = 0; p <= 1; p += 0.001) {
      expect(easeOutCubic(p)).toBeLessThanOrEqual(1);
      expect(easeOutCubic(p)).toBeGreaterThanOrEqual(0);
    }
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("the accent really does move 1.6x faster than the rung below it", () => {
    const accent = SLOT_Y[1] - SLOT_Y[0];
    const below = SLOT_Y[2] - SLOT_Y[1];
    expect(accent / below).toBeCloseTo(1.59, 1);
  });
});
