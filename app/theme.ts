/**
 * LIGHT, DARK, OR WHATEVER THE DEVICE SAYS.
 *
 * Zach, 2026-09-13: *"where do i change light dark theme?"* The honest answer
 * was that he could not — the app followed `prefers-color-scheme` and offered no
 * control at all.
 *
 * ─── THE STYLESHEET HAS BEEN READY THE WHOLE TIME ───────────────────────────
 *
 * `app/style.css` already carries all three states and always has:
 *
 *     @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }
 *     :root[data-theme="dark"]
 *
 * The first is "the device says dark, and he has not overruled it"; the second
 * is "he asked for dark on a device that says light". Nothing in the app ever
 * set `data-theme`, so the second block was unreachable and the `:not()` in the
 * first guarded against a value that could not occur. This module is the missing
 * half, and it writes exactly one attribute.
 *
 * ─── WHY THIS IS DEVICE-LOCAL AND NOT A `settings` ROW ──────────────────────
 *
 * Decision 33 syncs the `settings` table between his laptop and his phone. A
 * theme must not travel: he reviews on the laptop at home during the day and on
 * the phone in bed, and those are different answers to the same question. So it
 * lives in `localStorage` beside `hashigo.playback` and the deck tree's expanded
 * set, and no schema moves.
 *
 * ─── `system` IS A REAL CHOICE, NOT THE ABSENCE OF ONE ──────────────────────
 *
 * Three states rather than a two-way switch. A phone that flips to dark at
 * sunset is a feature he already has, and a binary toggle silently takes it away
 * the first time he touches it — with no way back short of clearing site data.
 *
 * ─── NO IMPORTS ─────────────────────────────────────────────────────────────
 *
 * Same reason as `app/keys.ts` and `app/shadow-controls.ts`: the root
 * `tsconfig.json` excludes `app/`, so an import-free module is reachable from
 * `test/` and one that touches the DOM is not.
 */

export const THEMES = ["system", "light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

/**
 * Shared with the inline script in `index.html`'s `<head>`.
 *
 * THAT DUPLICATION IS DELIBERATE AND IS THE POINT OF THE KEY BEING EXPORTED.
 * `main.ts` is a module script, so it runs after the document is parsed — too
 * late to stop a forced-light user seeing a dark boot screen flash white, and
 * the boot screen is on display for as long as the database takes to fetch. The
 * four lines in the head apply the attribute before anything paints; everything
 * else about the theme lives here. `test/app-logic.test.ts` pins that the two
 * still name the same key.
 */
export const THEME_KEY = "hashigo.theme";

/**
 * The `theme-color` values, which are `--paper` in each theme.
 *
 * Duplicated from the stylesheet because `<meta>` cannot read a custom property
 * — the phone's browser chrome is painted before any CSS is resolved. Pinned
 * against the stylesheet by a test rather than trusted.
 */
export const CHROME = { light: "#F2F2F2", dark: "#262626" } as const;

/** Tolerant: anything unrecognised is `system`, which is the shipped default. */
export function readTheme(raw: string | null | undefined): Theme {
  return (THEMES as readonly string[]).includes(raw ?? "") ? (raw as Theme) : "system";
}

/**
 * What `data-theme` should be, or `null` when the attribute must come OFF.
 *
 * Null rather than `"system"`: the stylesheet's media block is guarded with
 * `:not([data-theme="light"])`, so any value at all in that attribute is a
 * statement. "Follow the device" is the absence of the attribute, and writing
 * the string `system` into it would leave the `:not()` matching and the
 * `[data-theme="dark"]` block not — which is light, permanently, on a dark
 * phone.
 */
export function themeAttribute(theme: Theme): string | null {
  return theme === "system" ? null : theme;
}

/**
 * The colour the phone's chrome should be forced to, or null to let the two
 * media-scoped `<meta>` tags in `index.html` answer for themselves.
 */
export function forcedChrome(theme: Theme): string | null {
  return theme === "system" ? null : CHROME[theme];
}

/** How the choice is written in the settings screen. */
export function themeLabel(theme: Theme): string {
  return theme === "system" ? "follow this device" : theme;
}
