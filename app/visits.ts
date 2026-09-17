/**
 * THE ACCESS LOG — cards he deliberately opened, newest first.
 *
 * This is the Notion mechanism, and it is the whole answer to "how does it know
 * what's relevant before I type": it does not predict, it remembers. See
 * `app/recent.ts` for what the empty palette does with this.
 *
 * ── WHAT COUNTS AS A VISIT, AND WHY GRADING DOES NOT ──
 *
 * A card he OPENED — a preview, a card link, the editor. Not a card the scheduler put
 * in front of him: a session grades dozens, so logging reviews would push every
 * deliberate open off the list within one sitting and the palette would just mirror
 * the queue, which he can already see. Notion logs the page you navigated to, not the
 * feed that scrolled past.
 *
 * ── WHY `localStorage` AND NOT THE DATABASE ──
 *
 * Same reason as the theme, the playback rate, the deck tree's open rows, the device
 * id and the eviction receipt: it is a per-device convenience, and a table for it
 * would be a schema bump, which decision 41 made expensive — a bump now has to answer
 * for a live review history that exists in OPFS and nowhere else. It is deliberately
 * NOT in decision 33's sync payload: "what I looked at on my phone" is not something
 * the laptop needs, and the `updated_at` tier below it already syncs for free.
 *
 * Every accessor is guarded. A private window, blocked site data or a full quota
 * costs the suggestions, never the session.
 */

const KEY = "hashigo.visits";

/**
 * 50, and the cap is what makes this self-expiring — there is no timestamp here and
 * so no expiry rule to get wrong. The palette asks for 40, so the tail exists only to
 * survive a handful of dead ids (a card deleted, or one that never reached this
 * device) without the list going short.
 */
export const VISIT_LIMIT = 50;

/** TOLERANT ON PURPOSE — this comes out of `localStorage`, which can hold anything. */
export function readVisits(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string").slice(0, VISIT_LIMIT);
  } catch {
    return [];
  }
}

/** Newest first, no duplicates: re-opening a card moves it up rather than repeating. */
export function noteVisit(cardId: string): void {
  if (cardId === "") return;
  const next = [cardId, ...readVisits().filter((id) => id !== cardId)].slice(0, VISIT_LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* a full or disabled localStorage costs the memory, not the session */
  }
}

/** Behind the same "forget this device" gesture that clears everything else local. */
export function clearVisits(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do and nothing to report */
  }
}
