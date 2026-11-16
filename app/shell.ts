import type { PreparedCard } from "../src/review/index.js";
import type { Layer } from "./layers.js";
import type { TemplateChoice } from "./protocol.js";

export interface Shell {
  readonly showSessionCard: () => Promise<void>;
  readonly restartReview: () => Promise<void>;
  readonly repaintReviewFlags: () => Promise<void>;

  readonly openPreview: (cardId: string) => Promise<void>;
  readonly paintLayerOps: (layer: Layer, host: HTMLElement) => void;
  readonly openEditorFor: (
    card: PreparedCard,
    choices: readonly TemplateChoice[],
    options?: { readonly fromPreview?: boolean },
  ) => void;
}

let provided: Shell | null = null;

export function provideShell(shell: Shell): void {
  provided = shell;
}

export function shell(): Shell {
  if (provided === null) {
    throw new Error("a feature ran before main.ts provided the shell (app/shell.ts)");
  }
  return provided;
}
