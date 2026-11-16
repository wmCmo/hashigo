export const THEMES = ["system", "light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

export const THEME_KEY = "hashigo.theme";

export const CHROME = { light: "#F2F2F2", dark: "#262626" } as const;

export function readTheme(raw: string | null | undefined): Theme {
  return (THEMES as readonly string[]).includes(raw ?? "") ? (raw as Theme) : "system";
}

export function themeAttribute(theme: Theme): string | null {
  return theme === "system" ? null : theme;
}

export function forcedChrome(theme: Theme): string | null {
  return theme === "system" ? null : CHROME[theme];
}

export function themeLabel(theme: Theme): string {
  return theme === "system" ? "follow this device" : theme;
}
