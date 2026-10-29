/**
 * "% REMEMBERED" COUNTS ONLY CARDS HE HAD ALREADY LEARNED.
 *
 * Zach, 2026-10-29: *"for a new card, if you never know what it means, you can't
 * actually forget them right...?"* A track's first press tests no memory — it
 * only picks the first gap (forgot → 1 day, remembered → 3) — yet it counted as
 * a miss in the day's retention. Measured over 10-16..10-29 on his devices: 4 of
 * his 6 days under 85% were under it only because of new cards; 10-29 was 92.3%
 * without them and showed 76.6%.
 *
 * Its own module, with no imports, so the page can use it without bundling the
 * scheduler code `./glance.ts` brings.
 */

/** The shape this needs of a day: `GlanceDay` fits. */
export interface RecallDay {
  readonly reviews: number;
  readonly remembered: number;
  /** Of `reviews`, a track's FIRST press. */
  readonly firsts: number;
  /** Of `firsts`, the ones pressed "remembered". */
  readonly firstsRemembered: number;
}

/** Remembered ÷ reviews, leaving out first presses. Null when nothing else was reviewed. */
export function recallOf(day: RecallDay): number | null {
  const reviews = day.reviews - day.firsts;
  return reviews <= 0 ? null : (day.remembered - day.firstsRemembered) / reviews;
}
