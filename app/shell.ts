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
 * member is something a feature needs and `main.ts` still owns. When the undo
 * stack or the preview is extracted, its members leave this interface and become
 * a direct import from their new home.
 *
 * Asking before `main.ts` has provided throws, loudly, rather than returning a
 * stub — a feature that runs before boot finished is a bug worth seeing.
 */

import type { PreparedCard } from "../src/review/index.js";
import type { CardOp, DeckBrief, DeckOp, TemplateChoice } from "./protocol.js";

/** One reversible step. The WORKER computed `run` when it acted; nothing re-derives it. */
export interface UndoEntry {
  readonly describe: string;
  readonly run: () => Promise<void>;
}

export interface Shell {
  // ── the undo stack and card operations (his #7, #13) ──
  /** Put a reversal on the undo stack. */
  readonly pushUndo: (entry: UndoEntry) => void;
  /** Re-read everything an operation can have changed and repaint it. */
  readonly refreshAfterOp: () => Promise<void>;
  readonly runCardOp: (
    op: CardOp,
    cardId: string,
    extra?: { readonly templateId?: string | null },
  ) => Promise<void>;
  readonly confirmDelete: (cardId: string, name: string) => void;

  // ── the preview and the card editor (his requests 2 and 3) ──
  readonly openPreview: (cardId: string) => Promise<void>;
  readonly openEditorById: (
    cardId: string,
    options?: { readonly replacing?: HTMLElement },
  ) => Promise<void>;
  readonly openEditorFor: (
    card: PreparedCard,
    choices?: readonly TemplateChoice[],
    options?: { readonly fromPreview?: boolean },
  ) => void;

  // ── decks and settings (his #12, #14) ──
  readonly openDeckMenu: (deck: DeckBrief) => void;
  readonly openSettings: () => Promise<void>;
  readonly runDeckOp: (request: {
    op: DeckOp;
    deckId: string;
    name?: string;
    parentId?: string | null;
  }) => Promise<void>;
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
