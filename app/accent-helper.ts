/**
 * THE PAGE'S HALF OF THE LAPTOP ACCENT HELPER (`tools/accent_helper.py`).
 *
 * Zach, 2026-10-26: cards he makes in the app came out with no reading and no
 * `型`, and he makes them at the laptop — *"can't it just use my laptop
 * automatically?"*. The worker says what is missing (`accentPlan`), this asks the
 * helper on 127.0.0.1, and the worker writes the answers (`accentFill`,
 * `src/accent/fill.ts`). The values then travel to the phone by ordinary sync.
 *
 * ─── NEVER ON THE PHONE ─────────────────────────────────────────────────────
 *
 * 127.0.0.1 on a phone is the phone, where nothing listens — and asking would put
 * the browser's "access devices on your network" prompt in front of him for
 * nothing. So a touch-first device never asks. Cards made there are filled the
 * next time the laptop opens the app, by the boot sweep.
 *
 * ─── NOT SILENT ANY MORE WHEN IT IS DOWN — 2026-11-05 ───────────────────────
 *
 * It used to be: a refused connection was logged to the boot log and nothing
 * else. Then the helper stopped some time on 2026-11-05 and nobody knew until
 * 興隆 came up with no OJAD — 58 cards had gone without (*"ojad is not here"*,
 * *"will it happen again tho"*). So when there IS something to fill and the
 * helper does not answer, `warn` says so where he looks (a toast), on the laptop
 * only. It restarts itself now: a scheduled task, "Hashigo accent helper", starts
 * it at logon and every 30 minutes (ignored while it runs).
 */
import { ask } from "./worker-client.js";
import type { DeriveResult } from "../src/accent/fill.js";
import type { AnnotatedLine } from "../src/accent/marks.js";

const HELPER = "http://127.0.0.1:47474";

/** A laptop or desktop: a fine pointer and not a phone or tablet OS. */
function onLaptop(): boolean {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return !mobile && window.matchMedia("(pointer: fine)").matches;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${HELPER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`helper ${path}: ${response.status}`);
  return (await response.json()) as T;
}

let running: Promise<unknown> = Promise.resolve();

/**
 * Fill what the helper can on `cardIds`, or on every card made in the app. Calls
 * are queued one after another, so a boot sweep and an editor close never write
 * the same card at once. Resolves to what was written, or null when nothing ran.
 */
export function fillAccents(
  cardIds?: readonly string[],
  log: (text: string) => void = () => undefined,
  warn: (text: string) => void = () => undefined,
): Promise<{ labels: number; yomi: number; ojad: number } | null> {
  const next = running.then(async () => {
    if (!onLaptop()) return null;
    const plan = await ask<"accentPlan">({ kind: "accentPlan", ...(cardIds === undefined ? {} : { cardIds }) });
    if (plan.items.length === 0) return null;
    const keys = [...new Set(plan.items.filter((i) => i.labelField !== null || i.yomiField !== null).map((i) => i.key))];
    const texts = [...new Set(plan.items.flatMap((i) => (i.ojad === null ? [] : [i.ojad.sentence])))];
    let derived: DeriveResult[] = [];
    let lines: AnnotatedLine[] = [];
    try {
      if (keys.length > 0) derived = (await post<{ results: DeriveResult[] }>("/derive", { values: keys })).results;
      if (texts.length > 0) lines = (await post<{ lines: AnnotatedLine[] }>("/sentences", { texts })).lines;
    } catch {
      log("accent helper not running — reading, 型 and OJAD left for later");
      const cards = new Set(plan.items.map((item) => item.cardId)).size;
      warn(
        `the accent helper isn't running on this laptop — 読み, 型 and OJAD stay empty on ` +
          `${cards} card${cards === 1 ? "" : "s"} until it is (it restarts itself within 30 minutes)`,
      );
      return null;
    }
    const { report } = await ask<"accentFill">({
      kind: "accentFill",
      items: plan.items,
      derived: keys.map((key, index) => [key, derived[index] as DeriveResult] as const),
      lines,
    });
    if (report.labels + report.yomi + report.ojad > 0) {
      log(`accent helper: ${report.labels} 型 · ${report.yomi} 読み · ${report.ojad} OJAD filled`);
    }
    return report;
  });
  running = next.catch(() => undefined);
  return next.catch(() => null);
}
