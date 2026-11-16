declare const __APP_VERSION__: string;
declare const __APP_BUILD__: string;

export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
export const APP_BUILD = typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "";

export function versionLabel(): string {
  return `v${APP_VERSION}${APP_BUILD === "" ? "" : ` · ${APP_BUILD}`}`;
}
