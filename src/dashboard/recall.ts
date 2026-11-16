export interface RecallDay {
  readonly reviews: number;
  readonly remembered: number;
  readonly firsts: number;
  readonly firstsRemembered: number;
}

export function recallOf(day: RecallDay): number | null {
  const reviews = day.reviews - day.firsts;
  return reviews <= 0 ? null : (day.remembered - day.firstsRemembered) / reviews;
}
