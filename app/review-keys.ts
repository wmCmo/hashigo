import { survivesTyping } from "./keys.js";

export interface KeyState {
  readonly typing: boolean;
  readonly layerOpen: boolean;
  readonly layerActs: boolean;
  readonly sidebarOpen: boolean;
  readonly reviewHidden: boolean;
  readonly revealed: boolean;
  readonly moreToReveal: boolean;
  readonly asked: boolean;
  readonly peeking: boolean;
  readonly hasCard: boolean;
  readonly hasTake: boolean;
}

export type ReviewAction =
  | "palette"
  | "undo"
  | "closeLayer"
  | "editLayer"
  | "layerPin"
  | "layerArchive"
  | "layerDelete"
  | "closeSidebar"
  | "openSidebar"
  | "edit"
  | "reveal"
  | "archive"
  | "pin"
  | "delete"
  | "next"
  | "previous"
  | "backToCard"
  | "gradeForgot"
  | "gradeRemembered"
  | "replay"
  | "toggleLoop"
  | "cycleSpeed"
  | "toggleRecord"
  | "playTake"
  | "gradeBlocked"
  | "gradeTooEarly"
  | null;

export interface KeyEventShape {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
}

export function reviewAction(event: KeyEventShape, state: KeyState): ReviewAction {
  if (event.repeat === true) return null;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey === true || event.metaKey === true;

  if (mod && key === "k") return "palette";
  if (mod && key === "z") return state.typing ? null : "undo";
  if (mod) return null;

  if (state.typing && !survivesTyping(event.key)) return null;

  if (state.layerOpen) {
    if (event.key === "Escape") return "closeLayer";
    if (state.typing) return null;
    if (key === "e") return "editLayer";
    if (!state.layerActs) return null;
    if (key === "p" && event.shiftKey === true) return "layerPin";
    if (key === "a") return "layerArchive";
    if (key === "d") return "layerDelete";
    return null;
  }

  if (state.sidebarOpen) {
    if (event.key === "Escape") return "closeSidebar";
    if (state.typing) return null;
  }
  if (event.key === "/") return "openSidebar";

  if (state.reviewHidden) return null;

  if (key === "e") return "edit";
  if (key === " " || key === "enter") return state.moreToReveal ? "reveal" : null;

  if (!state.hasCard) return null;
  if (key === "a") return "archive";
  if (key === "p" && event.shiftKey === true) return "pin";
  if (key === "d") return "delete";
  if (event.key === "ArrowRight") return "next";
  if (event.key === "ArrowLeft") return "previous";
  if (event.key === "Escape") return state.peeking ? "backToCard" : null;

  if (key === "r" && state.asked) return "replay";

  if (key === "l") return "toggleLoop";
  if (key === "s") return "cycleSpeed";
  if (key === "m" && event.shiftKey === true) return state.hasTake ? "playTake" : null;
  if (key === "m") return "toggleRecord";

  if (!state.revealed) return null;

  if (key === "f") return state.peeking ? "gradeBlocked" : "gradeForgot";
  if (key === "j") {
    if (state.peeking) return "gradeBlocked";
    return state.moreToReveal ? "gradeTooEarly" : "gradeRemembered";
  }
  if (key === "r") return "replay";
  return null;
}

export const REVIEWING: KeyState = {
  typing: false,
  layerOpen: false,
  layerActs: false,
  sidebarOpen: false,
  reviewHidden: false,
  revealed: false,
  moreToReveal: true,
  asked: false,
  peeking: false,
  hasCard: true,
  hasTake: false,
};
