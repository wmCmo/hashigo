/**
 * Stage 4 — THE SANITISER POLICY, written down and enforced in one file.
 *
 * WHY A SANITISER AT ALL, when the parser already refuses unknown tags. Because
 * an AST is not only ever produced by `parseContent` on this device. SPEC's
 * stage 11 is sync: a `Side[]` will arrive as JSON from another device, and a
 * card's text is authored data that Zach pastes into from dictionaries. The
 * parser is a *lexer* — it decides what a construct is. This file decides what a
 * construct is ALLOWED to become in the DOM, and it re-checks everything the
 * parser already checked, because "the parser would never emit that" stops being
 * true the moment a node arrives over the wire.
 *
 * THE POLICY, in full. Everything not listed is dropped, and every drop is
 * counted into `RenderResult.diagnostics` rather than being silent.
 *
 *   1. ELEMENTS — exactly `ELEMENTS` in `src/template/ast.ts`, no second list.
 *      13 names: speech, ai, translate, furigana, image, pinyin (generators);
 *      draw, input (widgets); span, b, i, u, br (markup). An `element` node
 *      whose name is not there renders as INERT TEXT (its tag written back
 *      verbatim), never as an element and never dropped.
 *   2. ATTRIBUTES — per element, exactly `ELEMENTS[name].attributes`. Measured
 *      over the corpus that is: `lang`/`voice`/`gender` on speech,
 *      `ai-task`/`ai-custom-prompt`/`randomize` on ai, `from`/`to` on translate,
 *      `height`/`brushColor`/`brushRadius` on draw, `value`/`placeholder` on
 *      input, `style` on span. Any name outside that set is dropped even if the
 *      allowlist says `"*"`, when it starts with `on` or is not
 *      `[A-Za-z][A-Za-z0-9-]*` — an event handler must not be expressible.
 *   3. STYLE — through `sanitiseStyle` from ast.ts and nowhere else: five
 *      properties (color, background-color, font-weight, font-style,
 *      text-decoration), and any value containing a paren, a brace, `url`,
 *      `expression` or `/*` is dropped. The corpus has exactly one styled
 *      element, `<span style="color:yellow">` on card QnHb5aT2.
 *   4. URLS — scheme allowlist http / https / mailto, applied AFTER stripping
 *      the C0 control characters and tab/LF/CR that browsers strip when they
 *      parse a URL. `java\nscript:alert(1)` is a `javascript:` URL to Chrome and
 *      must be one to us too. A blocked URL drops the ANCHOR, never the link
 *      text. Relative and protocol-relative URLs are also refused: this is a
 *      hash-routed offline app, so a relative URL from a synced card would
 *      address the app itself. Measured: all 15,589 markdown links in the corpus
 *      are `https`, so nothing real is lost.
 *   5. MEDIA — the renderer NEVER sets `src`. It creates the element, records
 *      the store key, and the caller attaches bytes through
 *      `src/blobs/url.ts`. Two authored reference forms exist, both measured:
 *      `@media/mxkKeDnY.jpeg` (4 uses) and a bare `uVQp0iMb.mp3` (2 uses); both
 *      reduce to the bare filename, which is exactly `blob_refs.ref_key`. An
 *      absolute-URL media reference is refused rather than fetched: Hashigo is
 *      offline-first and card content must not be able to make a network
 *      request. Measured 0 in the corpus.
 *   6. CARD-LINK HREFS ARE MINTED HERE, never taken from content. A wiki-link
 *      carries a card id, and the id is percent-encoded into the href, so a
 *      target that is not an id cannot become a URL.
 *
 * WHAT MAKES THE QUESTION ANSWERABLE AT ALL: `src/render/nodes.ts` puts text
 * into the DOM through `createTextNode` and attributes through `setAttribute`.
 * There is no `innerHTML`, no `insertAdjacentHTML`, no `srcdoc`, no string
 * concatenation into markup anywhere in `src/render/`. Markup injection is not
 * blocked by a filter here; it is unrepresentable there. This file's job is the
 * narrower one of deciding which *elements and attributes* a card may ask for.
 */

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

// ─── attribute names ─────────────────────────────────────────────────────────

/**
 * A syntactically acceptable attribute name. Deliberately narrower than HTML's
 * grammar: no colons (namespaces), no underscores, nothing that could be read as
 * `on…`. Checked even when an element's allowlist is `"*"`.
 */
const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/** Attribute names that are never allowed, whatever an allowlist says. */
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

/**
 * Is `name` allowed on `element`?
 *
 * `src` and `href` are refused on every element on purpose: the renderer mints
 * those two itself (rules 5 and 6) and an authored one would bypass both the
 * scheme allowlist and the blob store.
 */
export function isAllowedAttribute(elementName: string, name: string): boolean {
  if (!ATTRIBUTE_NAME.test(name)) return false;
  if (isForbiddenAttribute(name)) return false;
  const spec = elementSpec(elementName);
  if (spec === null) return false;
  if (spec.attributes === "*") return true;
  const lower = name.toLowerCase();
  return spec.attributes.some((allowed) => allowed.toLowerCase() === lower);
}

// ─── attribute values ────────────────────────────────────────────────────────

/**
 * Control characters, stripped from every attribute value the renderer writes.
 *
 * Not a security boundary — `setAttribute` cannot inject markup — but a NUL or a
 * bare CR inside an attribute is invisible in the DOM inspector and shows up
 * later as a value that "looks identical" and compares unequal. U+0009/A/D are
 * included because they are also the characters HTML's URL parser removes, and
 * having one rule for all attribute values is one fewer thing to remember.
 */
function isControlChar(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

/** Drop every C0 control character, tab, LF and CR. No regex: see CLAUDE.md. */
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

/** The text of an `Interpolation`, with unresolved fields written back. */
export function interpolationValue(value: Interpolation | null): string {
  if (value === null) return "";
  return value.map((part) => (part.kind === "text" ? part.text : `<<${part.name}>>`)).join("");
}

// ─── style ───────────────────────────────────────────────────────────────────

export interface SanitisedStyleAttribute {
  /** `"color:yellow"`, ready for `setAttribute("style", …)`. `""` if nothing survived. */
  readonly css: string;
  /** Declarations the policy refused, verbatim, for the diagnostics. */
  readonly dropped: readonly string[];
}

/**
 * A `style` attribute reduced to the five allowed properties.
 *
 * The reconstruction is deliberate: the string written into the DOM is built
 * from parsed `property: value` pairs that each passed `STYLE_PROPERTIES` and
 * the value filter, so it cannot carry a declaration that was not individually
 * approved. Echoing the authored string back would trust its punctuation.
 */
export function sanitiseStyleAttribute(css: string): SanitisedStyleAttribute {
  const { declarations, dropped } = sanitiseStyle(css);
  return {
    css: declarations.map(({ property, value }) => `${property}:${value}`).join(";"),
    dropped,
  };
}

// ─── URLs ────────────────────────────────────────────────────────────────────

/** Schemes a card may link to. */
export const ALLOWED_URL_SCHEMES: readonly string[] = ["http", "https", "mailto"];

export type UrlRefusal =
  /** Nothing but whitespace. */
  | "empty"
  /** No `scheme:` at all — relative, protocol-relative, or a bare fragment. */
  | "no-scheme"
  /** A scheme outside `ALLOWED_URL_SCHEMES`. */
  | "scheme-not-allowed";

export interface SanitisedUrl {
  /** The href to write, or null when the anchor must be dropped. */
  readonly href: string | null;
  readonly reason: UrlRefusal | null;
  /** The scheme found, lowercased, or `""`. Reported even when refused. */
  readonly scheme: string;
}

/**
 * Apply rule 4.
 *
 * Two normalisations happen before the scheme is read, both of them copies of
 * what a browser's URL parser does, because a check that disagrees with the
 * parser is not a check:
 *
 *   * C0 controls, tab, LF and CR are REMOVED (not rejected). This is the
 *     `java&#10;script:` bypass; HTML says these characters are stripped from a
 *     URL before parsing, so `javascript:` is what the browser sees.
 *   * The remainder is trimmed, and any interior space becomes `%20` — which is
 *     also what the parser does, and matters here because
 *     `https://youglish.com/pronounce/<< Vocab >>/english` interpolates field
 *     values that really do contain spaces ("give up").
 */
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

/**
 * The in-app href for a card id (rule 6). Minted, not authored.
 *
 * `encodeURIComponent` is what makes this safe without an allowlist on the id:
 * every character a scheme, a query or a path traversal would need is escaped,
 * so the worst a hostile target can do is address a card that does not exist.
 */
export function cardHref(id: string): string {
  return `#/card/${encodeURIComponent(id)}`;
}

/**
 * The in-app href for a tag path. Minted, not authored, for `cardHref`'s reason.
 *
 * `encodeURIComponent` matters more here than it does for a card id, because a
 * tag path legitimately contains `/` — `Dialect/Kansai` — and leaving it raw
 * would mint a two-segment route out of one tag.
 */
export function tagHref(path: string): string {
  return `#/tag/${encodeURIComponent(path)}`;
}

// ─── media references ────────────────────────────────────────────────────────

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

/** Mochi's own prefix for an attachment reference; 4 of the corpus's 6 use it. */
export const MEDIA_PREFIX = "@media/";

export interface MediaReference {
  /** Exactly as authored, `@media/` and all. */
  readonly ref: string;
  /**
   * `blob_refs.ref_key` — the bare filename. Null when the reference is not a
   * store key at all (an absolute URL, or a path), in which case nothing is
   * fetched and the alt text renders instead.
   */
  readonly key: string | null;
  readonly kind: MediaKind;
  /** Lowercased, without the dot. `""` when there is none. */
  readonly extension: string;
  readonly refused: "absolute-url" | "path" | "empty" | null;
}

/**
 * Classify an authored media reference.
 *
 * The extension decides the element, because that is the only signal available
 * at render time: `blobs.mime` lives in the database and the renderer is
 * deliberately synchronous and database-free. A `.mp3` therefore becomes
 * `<audio>` before anybody has read a byte — which is exactly the ordering the
 * autoplay rule needs, since the element must exist, silent, from the first
 * paint.
 */
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

// ─── widget attributes ───────────────────────────────────────────────────────

/**
 * Value filters for the two widgets, because a widget attribute is read by code
 * rather than by a person. `<draw height="400px" brushColor="#FF0000"
 * brushRadius="4"/>` is the corpus's only widget with attributes at all, and
 * these patterns are the smallest thing that accepts it.
 *
 * `brushColor` accepts a hex triple/quad or a bare CSS keyword — never a
 * function, because a parenthesis is how `url(...)` gets in.
 */
const WIDGET_VALUE: Readonly<Record<string, RegExp>> = {
  height: /^\d{1,5}(?:px|%|em|rem|vh)?$/,
  brushcolor: /^(?:#[0-9A-Fa-f]{3,8}|[A-Za-z]{3,20})$/,
  brushradius: /^\d{1,3}$/,
};

/** True when a widget attribute's value is acceptable. Free-text ones pass. */
export function isValidWidgetValue(name: string, value: string): boolean {
  const pattern = WIDGET_VALUE[name.toLowerCase()];
  return pattern === undefined ? true : pattern.test(value);
}

/**
 * `brushColor` -> `brush-color`. Authored camelCase becomes a `data-` suffix,
 * which is the only spelling `dataset` and CSS selectors can both address.
 */
export function dataSuffix(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
}

// ─── the whole element ───────────────────────────────────────────────────────

export interface SanitisedAttribute {
  readonly name: string;
  readonly value: string;
}

export type AttributeRefusal =
  | "not-allowed"
  | "invalid-value"
  /** A `style` whose every declaration was refused. */
  | "style-empty";

export interface SanitisedElement {
  /** Null when the element name itself is not in `ELEMENTS` (rule 1). */
  readonly role: ElementRole | null;
  readonly attributes: readonly SanitisedAttribute[];
  readonly dropped: readonly { readonly name: string; readonly reason: AttributeRefusal }[];
  /** Individual `style` declarations the policy refused. */
  readonly droppedStyle: readonly string[];
}

/**
 * Run rules 1–3 over one element node.
 *
 * Returns `role: null` for an unknown name rather than throwing, so the caller
 * can render it inert. Note that this re-derives the role from `ELEMENTS`
 * instead of trusting `node.role`: the node's own `role` field is data, and data
 * that says `role: "markup"` on a name spelled `script` must not be believed.
 */
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

/**
 * An unknown element written back as the text it was, so nothing authored
 * vanishes (rule 1). `<script>x</script>` renders as the visible characters
 * `<script>x</script>`, which is both harmless and obvious.
 */
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
