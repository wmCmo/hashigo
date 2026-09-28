import { describe, expect, it } from "vitest";

import { planAudioGc, type AudioReach, type AudioRow } from "../src/review/audio-reach.js";

/**
 * 2026-09-28 の片付けの規則。どこからも届かない音声だけが消え、次の四つは残る:
 * どれかの端末で届く（再生でも代替でも）、retire 済み、猶予期間内に作られた。
 *
 * 一つ目の「どれかの端末で」が要: ノートPCの行だけで測ると、スマホで編集した
 * `**Exponent**` の一枚が今鳴らしているクリップを消していた。
 */

const NOW = new Date("2026-09-28T00:00:00.000Z");
const OLD = "2026-09-08T00:47:53.614Z";

function row(hash: string, createdAt = OLD): AudioRow {
  return { hash, byteSize: 1000, voice: null, createdAt };
}

function reach(plays: string[], fallback: string[] = []): AudioReach {
  return { plays: new Set(plays), fallback: new Set(fallback), cards: 1, mounts: 1, silentMounts: 0 };
}

describe("planAudioGc", () => {
  it("removes only what no reach, no retirement and no grace period keeps", () => {
    const rows = [
      row("a-plays-on-laptop"),
      row("b-plays-only-on-a-device"),
      row("c-fallback-only"),
      row("d-retired"),
      row("e-made-yesterday", "2026-09-27T00:00:00.000Z"),
      row("f-orphan"),
    ];
    const laptop = reach(["a-plays-on-laptop"]);
    const devices = reach(["a-plays-on-laptop", "b-plays-only-on-a-device"], ["c-fallback-only"]);
    const plan = planAudioGc(rows, [laptop, devices], new Set(["d-retired"]), { now: NOW, graceDays: 14 });
    expect(plan.doomed.map((r) => r.hash)).toEqual(["f-orphan"]);
    expect(plan.kept).toEqual({ reached: 3, retired: 1, recent: 1 });
  });

  it("would remove the device-only clip if it judged by the laptop alone — which is why it never does", () => {
    const rows = [row("26a267-exponent-edit")];
    const withLaptopOnly = planAudioGc(rows, [reach([])], new Set(), { now: NOW, graceDays: 0 });
    expect(withLaptopOnly.doomed).toHaveLength(1);
    const withDevices = planAudioGc(rows, [reach([]), reach(["26a267-exponent-edit"])], new Set(), {
      now: NOW,
      graceDays: 0,
    });
    expect(withDevices.doomed).toHaveLength(0);
  });

  it("a grace period of 0 keeps nothing on age alone", () => {
    const plan = planAudioGc([row("x", "2026-09-27T23:59:00.000Z")], [reach([])], new Set(), {
      now: NOW,
      graceDays: 0,
    });
    expect(plan.doomed).toHaveLength(1);
  });
});
