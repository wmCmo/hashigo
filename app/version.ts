/**
 * どのビルドか — 起動画面と設定に出す。Zach, 2026-09-27: *"i want the app version to
 * be visible on the loading screen and on setting page"*。
 *
 * 版は package.json の `version`（NEXT.md の VERSION 節が決める）、その後ろに
 * ビルドした commit の短い hash。版だけでは「再読み込みで新しいデプロイを拾ったか」が
 * 分からない — 0.5.0 のまま何度もデプロイしているので。作業ツリーに未コミットの
 * 変更があれば `-dirty` が付く。
 *
 * 値は `vite.app.config.ts` の `define` がビルド時に埋める。vitest では埋まらない
 * ので `typeof` で守り、"dev" と空を返す。
 */

declare const __APP_VERSION__: string;
declare const __APP_BUILD__: string;

export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
export const APP_BUILD = typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "";

/** `v0.5.0 · 37f766a` — the version, and the commit it was built from. */
export function versionLabel(): string {
  return `v${APP_VERSION}${APP_BUILD === "" ? "" : ` · ${APP_BUILD}`}`;
}
