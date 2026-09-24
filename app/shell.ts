/**
 * WHAT STILL LIVES IN `main.ts` — the one port every extracted feature reaches
 * back through.
 *
 * `main.ts` is the entry point and the review screen, and NOTHING IMPORTS IT. That
 * rule is the reason this file exists. The features are genuinely entangled — the
 * sidebar opens the template editor, the editor reloads the sidebar and pushes an
 * undo, undo repaints the review card — so a feature moved out cannot simply
 * import what it needs back from the entry module: that is a cycle through the
 * one module with side effects at load, and it works only while nothing reads an
 * import during evaluation.
 *
 * Features MAY import each other (`sidebar.ts` ↔ `palette.ts` ↔ `gallery.ts`).
 * They only ever call each other's functions after load, which ES modules handle;
 * what they may not do is import the entry point.
 *
 * So `main.ts` PROVIDES these once, at boot, and a feature asks for them when it
 * runs. **This interface is a to-do list that should only ever get shorter**: each
 * member is something a feature needs and `main.ts` still owns. When a feature is
 * extracted, its members leave this interface and become a direct import from
 * their new home — `loadDecks` and `closeSidebar` left for `./sidebar.ts`, and
 * the undo stack and card operations for `./ops.ts`, the deck menus and settings for
 * `./deck-menu.ts` and `./settings.ts`, the same day.
 *
 * Asking before `main.ts` has provided throws, loudly, rather than returning a
 * stub — a feature that runs before boot finished is a bug worth seeing.
 */

import type { PreparedCard } from "../src/review/index.js";
import type { Layer } from "./layers.js";
import type { TemplateChoice } from "./protocol.js";

export interface Shell {
  // ── the review screen ──
  /** Move the session on to its next card. */
  readonly showSessionCard: () => Promise<void>;
  /** Re-read the review card's pin/archive flags and repaint its handle. */
  readonly repaintReviewFlags: () => Promise<void>;

  // ── the preview and the card editor (his requests 2 and 3) ──
  readonly openPreview: (cardId: string) => Promise<void>;
  /** Repaint a preview layer's pin/archive/… buttons after its card changed. */
  readonly paintLayerOps: (layer: Layer, host: HTMLElement) => void;
  readonly openEditorFor: (
    card: PreparedCard,
    choices?: readonly TemplateChoice[],
    options?: { readonly fromPreview?: boolean },
  ) => void;
}

let provided: Shell | null = null;

/** Called once by `main.ts`, before anything can open a feature. */
export function provideShell(shell: Shell): void {
  provided = shell;
}

export function shell(): Shell {
  if (provided === null) {
    throw new Error("a feature ran before main.ts provided the shell (app/shell.ts)");
  }
  return provided;
}
