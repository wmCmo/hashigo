/**
 * THE one place that turns authored card text into plain display text.
 *
 * Everything that needs to know "what does this card actually say" goes through
 * `renderPlainText`: the search index (`cards.search_text`), the `@` picker, the
 * reviewer, and any future export. There is deliberately no second copy of the
 * link grammar or the invisible-character list anywhere in the codebase — two
 * copies drift, and the symptom of drift here is a card that can be seen but
 * not found.
 *
 * THE STORED VALUE IS NEVER TOUCHED. `cards.content` and
 * `card_field_values.value` keep the link syntax and every invisible mark
 * verbatim; round-trip fidelity against the raw export is non-negotiable and is
 * asserted in test/roundtrip.test.ts. Rendering is a read-time projection.
 *
 * ── THE LINK GRAMMAR ────────────────────────────────────────────────────────
 * Three forms occur in the corpus, all three of them real links:
 *
 *   [[display|card-id]]   8,690   piped
 *   [[card-id]]              46   bare           <- was silently dropped
 *   [[|card-id]]              8   empty display  <- was silently dropped
 *   ------------------------------
 *                         8,744   of which 8,726 resolve. The 18 that do not
 *                                 point at 15 ids in decks that were never
 *                                 exported, and are exactly the 18 the
 *                                 piped-only parser already reported: every
 *                                 one of the 54 recovered links resolves.
 *
 * A fourth shape, `[[display|]]`, has no target and is therefore NOT a link —
 * it renders as the literal text the author typed. There are 0 of them in the
 * corpus, and `tools/mochi.py` (the reference implementation) agrees: its
 * target class is `[^\]]+`, one-or-more.
 *
 * ── ADJACENCY, AND THE MARK ZACH HAD TO TYPE ────────────────────────────────
 * Zach writes a multi-kanji compound as one linked card per morpheme, joined by
 * an invisible U+200E LEFT-TO-RIGHT MARK:
 *
 *   [[引き|10PQotxm]]<U+200E>[[換え|C1p9g1mL]]
 *
 * He added the mark by hand because Mochi's parser could not tell where one
 * link ended and the next began. Measured over the three exports: 3,016 U+200E
 * on 2,504 cards; 2,911 of them sit exactly between `]]` and `[[`, on 2,478
 * cards — about a third of the corpus. Only 4 link pairs are directly adjacent
 * with no mark, which is the measure of how reliably he had to type it.
 *
 * This parser handles bracket adjacency natively — the inner character class
 * excludes both brackets, so one match physically cannot span two links — so he
 * never has to type the mark again. The existing marks are PRESERVED in the
 * stored value and removed only from the rendered projection. They are his
 * data, not noise: deleting them from storage would rewrite 2,504 cards to fix
 * a parser bug that is already fixed.
 *
 * ── WHAT IS AND IS NOT NORMALISED ───────────────────────────────────────────
 * Invisible marks go (U+200B..U+200F and U+FEFF: zero-width space, ZWNJ, ZWJ,
 * LRM, RLM, BOM), and the result is NFC. NFC is canonical equivalence only —
 * text that *is* the same text compares equal. NFKC is deliberately not
 * applied: it would fold the 464 cards using `～` (U+FF5E) onto ASCII `~`,
 * which is a search-relevance decision that is only correct if the query is
 * folded identically, and that belongs to whoever owns the query box.
 *
 * Markdown is left exactly as written. `[[**enactment**|zeeUDLTL]]` renders as
 * `**enactment**`, not `enactment`: the display half is authored text, and
 * stripping emphasis here would make the search index disagree with the card.
 */

/**
 * Zero-width and bidi format characters, stripped from every rendered
 * projection. U+200E is the mark described in the header; U+200B is the one
 * that also corrupted the tag list (see `src/import/tags.ts`). Measured:
 * 3,016 U+200E, 2,321 U+200B, 1 U+FEFF.
 */
export const INVISIBLE_MARKS = /[\u200B-\u200F\uFEFF]/g;

/**
 * One `[[...]]` occurrence, of any of the three forms.
 *
 * The inner class excludes `[` and `]`, which is what makes bracket adjacency
 * work without a lookahead: a match cannot run past the first closing pair.
 * Splitting the inner text on its FIRST `|` reproduces `tools/mochi.py`'s
 * two-group regex exactly (display `[^\]|]`, target `[^\]]`), so the piped
 * count is unchanged at 8,690.
 */
export const WIKI_LINK = /\[\[([^[\]]*)\]\]/g;

/** Which of the three shapes was authored. */
export type WikiLinkForm = "piped" | "bare" | "empty-display";

/** One parsed link, with enough position to splice the source string. */
export interface WikiLink {
  /** Authored display text. `""` for the bare and empty-display forms. */
  readonly display: string;
  /** The target card id. Never `""` — a targetless `[[a|]]` is not a link. */
  readonly target: string;
  readonly form: WikiLinkForm;
  /** Exactly as authored, brackets included. */
  readonly raw: string;
  /** Offset of `raw` in the string it was parsed from. */
  readonly index: number;
}

/** Look up a card's name by id. Returns null/undefined when it does not exist. */
export type ResolveName = (targetId: string) => string | null | undefined;

export interface RenderOptions {
  /**
   * Supplies the display text for the bare and empty-display forms. Omit it and
   * those links render as nothing — see `linkDisplayText`.
   */
  readonly resolveName?: ResolveName;
}

/** Drop every zero-width / bidi format character. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_MARKS, "");
}

/**
 * Every link in `text`, in order of appearance.
 *
 * A fresh regex per call: `WIKI_LINK` is global, and sharing `lastIndex` across
 * calls skips links non-deterministically.
 */
export function parseWikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  const pattern = new RegExp(WIKI_LINK.source, "g");
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const inner = match[1] as string;
    const pipe = inner.indexOf("|");
    const display = pipe === -1 ? "" : inner.slice(0, pipe);
    const target = pipe === -1 ? inner : inner.slice(pipe + 1);
    // No target, no link: `[[a|]]` and `[[]]` are literal text, as in Mochi.
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

/**
 * The text a link shows: what was authored, else the target card's name.
 *
 * When neither exists the answer is the empty string, NOT the target id. An id
 * is an opaque 8-character handle — `pvtj9W17` — and putting it on screen or
 * into the search index is worse than showing nothing, because it matches
 * trigram queries that have nothing to do with the card. Nothing is lost by it:
 * the raw text still holds the link verbatim, `card_links` still holds the row,
 * and `card_links_resolved.resolved = 0` is how a broken target is surfaced.
 *
 * All 54 bare and empty-display links in the corpus resolve, so this fallback
 * is exercised by tests rather than by Zach's data.
 */
export function linkDisplayText(link: WikiLink, resolveName?: ResolveName): string {
  if (link.display !== "") return link.display;
  return resolveName?.(link.target) ?? "";
}

/**
 * Authored text -> plain display text. Links reduce to their display text,
 * invisible marks go, markdown is left readable, and the result is NFC.
 *
 * This is the single definition of the transform. `cards.search_text` is this
 * function's output over `content` plus every field value.
 */
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

/**
 * The same transform over several pieces of authored text, joined by newlines.
 *
 * This is the shape a card has: `content` plus one value per field. Empty and
 * absent parts are dropped rather than producing blank lines, so a card's
 * rendered text does not change shape when an optional field is left blank.
 */
export function renderPlainTextParts(
  parts: readonly (string | null | undefined)[],
  options: RenderOptions = {},
): string {
  const joined = parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
  return renderPlainText(joined, options);
}
