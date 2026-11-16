export function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface NewDayState {
  readonly plannedOn: string;
  readonly today: string;
  readonly onDone: boolean;
  readonly layered: boolean;
  readonly typing: boolean;
}

export function shouldStartNewDay(state: NewDayState): boolean {
  return state.today !== state.plannedOn && state.onDone && !state.layered && !state.typing;
}
