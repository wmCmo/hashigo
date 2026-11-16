import { toHiragana } from "./ruby.js";
import type { WidgetMount } from "./nodes.js";

export interface InputListenerOptions {
  readonly passive?: boolean;
  readonly capture?: boolean;
}

export interface InputKeyEvent {
  readonly key: string;
  preventDefault(): void;
}

export interface InputSurface {
  value: string;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(
    type: string,
    listener: (event: InputKeyEvent) => void,
    options?: InputListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: InputKeyEvent) => void,
    options?: InputListenerOptions,
  ): void;
}

const SEPARATORS = /[\s,、・，､_'`]/g;

export interface AnswerOptions {
  readonly foldKana?: boolean;
  readonly foldCase?: boolean;
}

export function normaliseAnswer(text: string, options: AnswerOptions = {}): string {
  let out = text.normalize("NFKC").replace(SEPARATORS, "");
  if (options.foldKana === true) out = toHiragana(out);
  if (options.foldCase !== false) out = out.toLowerCase();
  return out;
}

export interface AnswerCheck {
  readonly ok: boolean;
  readonly expected: string;
  readonly typed: string;
  readonly normalisedExpected: string;
  readonly normalisedTyped: string;
}

export function checkAnswer(
  expected: string,
  typed: string,
  options: AnswerOptions = {},
): AnswerCheck {
  const normalisedExpected = normaliseAnswer(expected, options);
  const normalisedTyped = normaliseAnswer(typed, options);
  return {
    ok: normalisedTyped !== "" && normalisedTyped === normalisedExpected,
    expected,
    typed,
    normalisedExpected,
    normalisedTyped,
  };
}

export const INPUT_DATA = {
  answer: "data-answer",
} as const;

export interface InputOptions extends AnswerOptions {
  readonly expected?: string | null;
  readonly onSubmit?: (check: AnswerCheck | null) => void;
  readonly onCheck?: (check: AnswerCheck) => void;
}

export interface InputHandle {
  readonly expected: string | null;
  readonly value: string;
  check(): AnswerCheck | null;
  reset(): void;
  detach(): void;
}

export function attachInput(
  mount: Pick<WidgetMount, "expected"> | null,
  surface: InputSurface,
  options: InputOptions = {},
): InputHandle {
  const expected =
    options.expected !== undefined ? options.expected : (mount?.expected ?? null);

  function verdict(): AnswerCheck | null {
    if (expected === null) return null;
    const result = checkAnswer(expected, surface.value, options);
    surface.setAttribute(INPUT_DATA.answer, result.ok ? "correct" : "incorrect");
    options.onCheck?.(result);
    return result;
  }

  const onKey = (event: InputKeyEvent): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    options.onSubmit?.(verdict());
  };
  const onEdit = (): void => surface.removeAttribute(INPUT_DATA.answer);

  surface.addEventListener("keydown", onKey);
  surface.addEventListener("input", onEdit);

  return {
    expected,
    get value(): string {
      return surface.value;
    },
    check: verdict,
    reset(): void {
      surface.value = "";
      surface.removeAttribute(INPUT_DATA.answer);
    },
    detach(): void {
      surface.removeEventListener("keydown", onKey);
      surface.removeEventListener("input", onEdit);
    },
  };
}
