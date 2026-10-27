/**
 * THE THEME, APPLIED — the live half of `./theme.ts`, which holds the pure rules.
 *
 * Moved out of `main.ts` on 2026-09-25. `currentTheme` is owned here and written
 * only by `applyTheme`; everything else reads it as a live binding.
 */

import type { Theme } from "./theme.js";
import { CHROME, THEME_KEY, forcedChrome, readTheme, themeAttribute } from "./theme.js";

/**
 * Zach, 2026-09-13: *"where do i change light dark theme?"* He could not — the
 * app followed `prefers-color-scheme` and had no control at all, even though
 * `style.css` has carried `[data-theme]` for both directions since decision 32.
 *
 * The attribute is applied twice on purpose: once by four inline lines in
 * `index.html`'s `<head>`, before anything paints, and once here. This module
 * runs after the document is parsed, which is too late to stop the boot screen
 * flashing the wrong ground — and the boot screen is up for as long as the
 * database takes to fetch. `app/theme.ts` owns the key both of them read.
 */
export let currentTheme: Theme = "system";
try {
  currentTheme = readTheme(localStorage.getItem(THEME_KEY));
} catch {
  /* a disabled localStorage costs the preference, not the session */
}

export function applyTheme(theme: Theme): void {
  currentTheme = theme;
  const attribute = themeAttribute(theme);
  if (attribute === null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", attribute);

  // THE PHONE'S OWN CHROME HAS TO FOLLOW, or a forced-light app sits in a black
  // status bar. `index.html` ships two media-scoped `theme-color` tags; forcing
  // a theme means overriding BOTH, because either may be the one that matches.
  const forced = forcedChrome(theme);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (forced !== null) meta.content = forced;
    else meta.content = meta.media.includes("dark") ? CHROME.dark : CHROME.light;
  }

  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* full or disabled: it still applies for this session */
  }
}

applyTheme(currentTheme);
