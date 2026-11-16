import type { Theme } from "./theme.js";
import { CHROME, THEME_KEY, forcedChrome, readTheme, themeAttribute } from "./theme.js";

export let currentTheme: Theme = "system";
try {
  currentTheme = readTheme(localStorage.getItem(THEME_KEY));
} catch {
}

export function applyTheme(theme: Theme): void {
  currentTheme = theme;
  const attribute = themeAttribute(theme);
  if (attribute === null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", attribute);

  const forced = forcedChrome(theme);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (forced !== null) meta.content = forced;
    else meta.content = meta.media.includes("dark") ? CHROME.dark : CHROME.light;
  }

  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
  }
}

applyTheme(currentTheme);
