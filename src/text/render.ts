export const INVISIBLE_MARKS = /[\u200B-\u200F\uFEFF]/g;

export const WIKI_LINK = /\[\[([^[\]]*)\]\]/g;

export type WikiLinkForm = "piped" | "bare" | "empty-display";

export interface WikiLink {
  readonly display: string;
  readonly target: string;
  readonly form: WikiLinkForm;
  readonly raw: string;
  readonly index: number;
}

export type ResolveName = (targetId: string) => string | null | undefined;

export interface RenderOptions {
  readonly resolveName?: ResolveName;
}

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_MARKS, "");
}

export function parseWikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  const pattern = new RegExp(WIKI_LINK.source, "g");
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const inner = match[1] as string;
    const pipe = inner.indexOf("|");
    const display = pipe === -1 ? "" : inner.slice(0, pipe);
    const target = pipe === -1 ? inner : inner.slice(pipe + 1);
    if (target === "") continue;
    out.push({
      display,
      target,
      form: pipe === -1 ? "bare" : display === "" ? "empty-display" : "piped",
      raw: match[0] as string,
      index: match.index,
    });
  }
  return out;
}

export function linkDisplayText(link: WikiLink, resolveName?: ResolveName): string {
  if (link.display !== "") return link.display;
  return resolveName?.(link.target) ?? "";
}

export function renderPlainText(text: string, options: RenderOptions = {}): string {
  if (text === "") return "";
  const links = parseWikiLinks(text);
  if (links.length === 0) return stripInvisible(text).normalize("NFC");

  let out = "";
  let cursor = 0;
  for (const link of links) {
    out += text.slice(cursor, link.index);
    out += linkDisplayText(link, options.resolveName);
    cursor = link.index + link.raw.length;
  }
  out += text.slice(cursor);
  return stripInvisible(out).normalize("NFC");
}

export function speakableText(text: string, options: RenderOptions = {}): string {
  const plain = renderPlainText(text, options);
  const withoutMounts = plain
    .replace(/<([a-z][a-z0-9-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi, "");
  const spoken = withoutMounts
    .replace(/\*\*\*(.+?)\*\*\*/gs, "$1")
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/\*(.+?)\*/gs, "$1")
    .replace(/__(.+?)__/gs, "$1")
    .replace(/~~(.+?)~~/gs, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return spoken;
}

export function renderPlainTextParts(
  parts: readonly (string | null | undefined)[],
  options: RenderOptions = {},
): string {
  const joined = parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
  return renderPlainText(joined, options);
}
