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
 * So `main.ts` PROVIDES these once, at boot, and a feature asks for them when it
 * runs. **This interface is a to-do list that should only ever get shorter**: each
 * member is something a feature needs and `main.ts` still owns. When the undo
 * stack or the sidebar is extracted, its members leave this interface and become
 * a direct import from their new home.
 *
 * Asking before `main.ts` has provided throws, loudly, rather than returning a
 * stub — a feature that runs before boot finished is a bug worth seeing.
 */

/** One reversible step. The WORKER computed `run` when it acted; nothing re-derives it. */
export interface UndoEntry {
  readonly describe: string;
  readonly run: () => Promise<void>;
}

export interface Shell {
  /** Reload the deck tree, templates and new-card choices. `force` bypasses the cache. */
  readonly loadDecks: (force?: boolean) => Promise<void>;
  /** Close the drawer on a phone; a no-op where the rail is standing. */
  readonly closeSidebar: () => void;
  /** Put a reversal on the undo stack. */
  readonly pushUndo: (entry: UndoEntry) => void;
  /** Re-read everything an operation can have changed and repaint it. */
  readonly refreshAfterOp: () => Promise<void>;
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
