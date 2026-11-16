import {
  ELEMENTS,
  elementSpec,
  isKnownElement,
  sanitiseStyle,
  type Attribute,
  type ElementNode,
  type ElementRole,
  type Interpolation,
} from "../template/index.js";

const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

function isForbiddenAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith("on") ||
    lower === "srcdoc" ||
    lower === "src" ||
    lower === "href" ||
    lower === "formaction" ||
    lower === "xlink:href"
  );
}

export function isAllowedAttribute(elementName: string, name: string): boolean {
  if (!ATTRIBUTE_NAME.test(name)) return false;
  if (isForbiddenAttribute(name)) return false;
  const spec = elementSpec(elementName);
  if (spec === null) return false;
  if (spec.attributes === "*") return true;
  const lower = name.toLowerCase();
  return spec.attributes.some((allowed) => allowed.toLowerCase() === lower);
}

function isControlChar(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

export function stripControls(text: string): string {
  let out = "";
  for (const character of text) {
    if (!isControlChar(character.codePointAt(0) ?? 0)) out += character;
  }
  return out;
}

export function attributeValue(text: string): string {
  return stripControls(text);
}

export function interpolationValue(value: Interpolation | null): string {
  if (value === null) return "";
  return value.map((part) => (part.kind === "text" ? part.text : `<<${part.name}>>`)).join("");
}

export interface SanitisedStyleAttribute {
  readonly css: string;
  readonly dropped: readonly string[];
}

export function sanitiseStyleAttribute(css: string): SanitisedStyleAttribute {
  const { declarations, dropped } = sanitiseStyle(css);
  return {
    css: declarations.map(({ property, value }) => `${property}:${value}`).join(";"),
    dropped,
  };
}

export const ALLOWED_URL_SCHEMES: readonly string[] = ["http", "https", "mailto"];

export type UrlRefusal =
  | "empty"
  | "no-scheme"
  | "scheme-not-allowed";

export interface SanitisedUrl {
  readonly href: string | null;
  readonly reason: UrlRefusal | null;
  readonly scheme: string;
}

export function sanitiseUrl(raw: string): SanitisedUrl {
  const stripped = stripControls(raw).trim();
  if (stripped === "") return { href: null, reason: "empty", scheme: "" };
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(stripped);
  if (match === null) return { href: null, reason: "no-scheme", scheme: "" };
  const scheme = (match[1] as string).toLowerCase();
  if (!ALLOWED_URL_SCHEMES.includes(scheme)) {
    return { href: null, reason: "scheme-not-allowed", scheme };
  }
  return { href: stripped.replace(/ /g, "%20"), reason: null, scheme };
}

export function cardHref(id: string): string {
  return `#/card/${encodeURIComponent(id)}`;
}

export function tagHref(path: string): string {
  return `#/tag/${encodeURIComponent(path)}`;
}

export type MediaKind = "audio" | "image" | "video" | "file";

const AUDIO_EXTENSIONS: readonly string[] = [
  "mp3",
  "m4a",
  "aac",
  "wav",
  "ogg",
  "oga",
  "opus",
  "flac",
  "weba",
];
const IMAGE_EXTENSIONS: readonly string[] = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "svg",
];
const VIDEO_EXTENSIONS: readonly string[] = ["mp4", "webm", "mov", "m4v"];

export const MEDIA_PREFIX = "@media/";

export interface MediaReference {
  readonly ref: string;
  readonly key: string | null;
  readonly kind: MediaKind;
  readonly extension: string;
  readonly refused: "absolute-url" | "path" | "empty" | null;
}

export function classifyMedia(rawRef: string): MediaReference {
  const ref = rawRef.trim();
  if (ref === "") {
    return { ref: rawRef, key: null, kind: "file", extension: "", refused: "empty" };
  }
  const extension = extensionOf(ref);
  const kind = kindFor(extension);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) || ref.startsWith("//")) {
    return { ref, key: null, kind, extension, refused: "absolute-url" };
  }
  const bare = ref.startsWith(MEDIA_PREFIX) ? ref.slice(MEDIA_PREFIX.length) : ref;
  if (bare === "" || bare.includes("/") || bare.includes("\\") || bare.includes("..")) {
    return { ref, key: null, kind, extension, refused: "path" };
  }
  return { ref, key: bare, kind, extension, refused: null };
}

function extensionOf(ref: string): string {
  const slash = Math.max(ref.lastIndexOf("/"), ref.lastIndexOf("\\"));
  const dot = ref.lastIndexOf(".");
  if (dot <= slash || dot === ref.length - 1) return "";
  return ref.slice(dot + 1).toLowerCase();
}

function kindFor(extension: string): MediaKind {
  if (AUDIO_EXTENSIONS.includes(extension)) return "audio";
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (VIDEO_EXTENSIONS.includes(extension)) return "video";
  return "file";
}

const WIDGET_VALUE: Readonly<Record<string, RegExp>> = {
  height: /^\d{1,5}(?:px|%|em|rem|vh)?$/,
  brushcolor: /^(?:#[0-9A-Fa-f]{3,8}|[A-Za-z]{3,20})$/,
  brushradius: /^\d{1,3}$/,
};

export function isValidWidgetValue(name: string, value: string): boolean {
  const pattern = WIDGET_VALUE[name.toLowerCase()];
  return pattern === undefined ? true : pattern.test(value);
}

export function dataSuffix(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
}

export interface SanitisedAttribute {
  readonly name: string;
  readonly value: string;
}

export type AttributeRefusal =
  | "not-allowed"
  | "invalid-value"
  | "style-empty";

export interface SanitisedElement {
  readonly role: ElementRole | null;
  readonly attributes: readonly SanitisedAttribute[];
  readonly dropped: readonly { readonly name: string; readonly reason: AttributeRefusal }[];
  readonly droppedStyle: readonly string[];
}

export function sanitiseElement(node: ElementNode): SanitisedElement {
  if (!isKnownElement(node.name)) {
    return { role: null, attributes: [], dropped: [], droppedStyle: [] };
  }
  const spec = ELEMENTS[node.name] as (typeof ELEMENTS)[string];
  const attributes: SanitisedAttribute[] = [];
  const dropped: { name: string; reason: AttributeRefusal }[] = [];
  const droppedStyle: string[] = [];

  for (const attribute of node.attributes as readonly Attribute[]) {
    const name = attribute.name;
    if (!isAllowedAttribute(node.name, name)) {
      dropped.push({ name, reason: "not-allowed" });
      continue;
    }
    const raw = attributeValue(interpolationValue(attribute.value));
    if (name.toLowerCase() === "style") {
      const style = sanitiseStyleAttribute(raw);
      droppedStyle.push(...style.dropped);
      if (style.css === "") dropped.push({ name, reason: "style-empty" });
      else attributes.push({ name: "style", value: style.css });
      continue;
    }
    if (spec.role === "widget" && !isValidWidgetValue(name, raw)) {
      dropped.push({ name, reason: "invalid-value" });
      continue;
    }
    attributes.push({ name, value: raw });
  }
  return { role: spec.role, attributes, dropped, droppedStyle };
}

export function inertElementText(node: ElementNode): string {
  const attributes = node.attributes
    .map((attribute) =>
      attribute.value === null
        ? ` ${attribute.name}`
        : ` ${attribute.name}="${interpolationValue(attribute.value)}"`,
    )
    .join("");
  return node.selfClosing
    ? `<${node.name}${attributes}/>`
    : `<${node.name}${attributes}>`;
}
