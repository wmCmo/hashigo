import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DURATION_MS, easeOutCubic, railX, SLOPE, SLOT_Y } from "../app/climb.js";

const mark = readFileSync(new URL("../app/brand/mark.svg", import.meta.url), "utf8");

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
    expect(ys).toEqual([SLOT_Y[0], SLOT_Y[1], SLOT_Y[2], SLOT_Y[3]]);
  });

  it("the loose rung sits exactly where a fourth rung would be", () => {
    expect(SLOT_Y[3] - SLOT_Y[2]).toBe(20);
    expect(SLOT_Y[2] - SLOT_Y[1]).toBe(17);
    expect(SLOT_Y[1] - SLOT_Y[0]).toBe(27);
  });

  it("the exit slot is clear of the rail feet, so a rung leaves rather than piling up", () => {
    expect(SLOT_Y[4]).toBeGreaterThan(87);
  });

  it("the rails lean about 12 degrees, which is what SLOPE encodes", () => {
    expect(SLOPE).toBeCloseTo(11.5 / 55, 5);
    expect((Math.atan(SLOPE) * 180) / Math.PI).toBeCloseTo(11.8, 1);
  });

  it("the small-size mark is a DIFFERENT construction, not a scaled one", () => {
    const small = readFileSync(new URL("../app/brand/favicon.svg", import.meta.url), "utf8");
    expect(rungsIn(small)).toHaveLength(3);
    expect(small).toContain('stroke-width="12"');
  });
});

describe("the climb's motion is the brief's, and the brief forbids two changes", () => {
  it("runs for 520 ms — the ceiling, not a starting point", () => {
    expect(DURATION_MS).toBe(520);
  });

  it("never overshoots", () => {
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

describe("the done screen's climb takes its colours from the theme (decision 57)", () => {
  const climb = readFileSync(new URL("../app/climb.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/style.css", import.meta.url), "utf8");

  it("bakes no colour into the rungs", () => {
    const code = climb.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/rgb\(|#[0-9a-f]{6}\b|"stroke",(?!\s*"currentColor")/i);
    expect(code).toContain('setProperty("--t"');
  });

  it("is painted by the same ruri-to-ink ramp as the boot rungs", () => {
    expect(css).toMatch(
      /\.climb-mark \.rung\s*\{[^}]*color-mix\(in srgb, var\(--indigo\) calc\(var\(--t, 1\) \* 100%\), var\(--vermilion\)\)/,
    );
  });
});
