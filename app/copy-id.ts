export interface CopyContext {
  readonly selection: string;
  readonly typing: boolean;
  readonly layerCardId: string | null;
  readonly reviewCardId: string | null;
}

export function cardIdToCopy(context: CopyContext): string | null {
  if (context.selection.trim() !== "") return null;
  if (context.typing) return null;
  if (context.layerCardId !== null) return context.layerCardId === "" ? null : context.layerCardId;
  return context.reviewCardId;
}
