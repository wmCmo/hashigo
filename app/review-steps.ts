export interface StepSide {
  readonly position: number;
  readonly clozes: number;
  readonly audio: number;
  readonly prompt: boolean;
}

export interface RevealStep {
  readonly position: number;
  readonly cloze: number | null;
  readonly show: boolean;
}

export function revealSteps(sides: readonly StepSide[]): RevealStep[] {
  const steps: RevealStep[] = [];
  for (const side of sides) {
    const show = !side.prompt;
    if (side.clozes === 0) {
      if (show || side.audio > 0) steps.push({ position: side.position, cloze: null, show });
      continue;
    }
    for (let index = 0; index < side.clozes; index += 1) {
      steps.push({ position: side.position, cloze: index, show: show && index === 0 });
    }
  }
  return steps;
}
