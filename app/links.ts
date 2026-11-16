export interface LinkSpan {
  readonly start: number;
  readonly end: number;
  readonly display: string;
  readonly target: string;
  readonly raw: string;
}

const LINK = /\[\[([^\]\n]*)\]\]/g;

function parseBody(body: string): { display: string; target: string } {
  const pipe = body.lastIndexOf("|");
  if (pipe === -1) return { display: body, target: body };
  return { display: body.slice(0, pipe), target: body.slice(pipe + 1) };
}

export function linksIn(text: string): LinkSpan[] {
  const out: LinkSpan[] = [];
  for (const match of text.matchAll(new RegExp(LINK.source, "g"))) {
    const at = match.index;
    if (at === undefined) continue;
    const { display, target } = parseBody(match[1] ?? "");
    out.push({ start: at, end: at + match[0].length, display, target, raw: match[0] });
  }
  return out;
}

export function linkAt(text: string, offset: number): LinkSpan | null {
  for (const span of linksIn(text)) {
    if (offset >= span.start && offset <= span.end) return span;
  }
  return null;
}

export type TriggerKind = "[[" | "@";

export interface Trigger {
  readonly kind: TriggerKind;
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

const MAX_QUERY = 40;

export function triggerAt(text: string, caret: number): Trigger | null {
  if (caret < 0 || caret > text.length) return null;
  if (linkAt(text, caret) !== null) return null;

  const from = Math.max(0, caret - MAX_QUERY - 2);
  const window = text.slice(from, caret);

  const openBrackets = window.lastIndexOf("[[");
  if (openBrackets !== -1) {
    const query = window.slice(openBrackets + 2);
    if (!query.includes("]]") && !query.includes("\n") && query.length <= MAX_QUERY) {
      return { kind: "[[", start: from + openBrackets, end: caret, query };
    }
  }

  const at = window.lastIndexOf("@");
  if (at !== -1) {
    const before = from + at === 0 ? "" : text[from + at - 1] ?? "";
    if (before === "" || /\s/.test(before)) {
      const query = window.slice(at + 1);
      if (!query.includes("\n") && !query.includes("@") && query.length <= MAX_QUERY) {
        return { kind: "@", start: from + at, end: caret, query };
      }
    }
  }
  return null;
}

export function completeLink(
  text: string,
  trigger: Trigger,
  display: string,
  target: string,
): { text: string; caret: number } {
  const link = `[[${display}|${target}]]`;
  const next = text.slice(0, trigger.start) + link + text.slice(trigger.end);
  return { text: next, caret: trigger.start + link.length };
}
